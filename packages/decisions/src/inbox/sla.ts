import {
  CARD_EVENT,
  CardEscalatedPayload,
  cardStream,
  gatePolicy,
  type InboxCard,
  type InboxEntryReason,
  type JsonObject,
  type PrincipalId,
  type RoleSlot,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { PendingConfirm } from '@aisdlc/ledger';
import { appendEvents, runProjection } from '@aisdlc/record';
import { decisionError, type DecisionError } from '../errors.js';
import {
  clockOf,
  enterLedger,
  inDecisionTx,
  inMaintenance,
  lockKey,
  type DecisionDeps,
} from '../internal.js';
import { gateInstanceProjection } from '../projection.js';
import { gateIdsOf, readCardOpened, readCardState } from './state.js';
import { inboxProjection, readCardViews } from './projection.js';

/** Brings the inbox and the gate read models up to date. */
async function catchUp(deps: DecisionDeps): Promise<Result<true, DecisionError>> {
  for (const p of [gateInstanceProjection, inboxProjection]) {
    const r = await runProjection(deps.pool, p);
    if (!r.ok) return err(decisionError('database', JSON.stringify(r.error)));
  }
  return ok(true);
}

// ---------------------------------------------------------------- B21 SLA sweep

export interface SlaReport {
  readonly escalated: ReadonlyArray<{
    card_id: string;
    gate_instance_id: string;
    /** Who got an inbox entry. Empty: nobody outside the approvers holds the backup slot. */
    backup: readonly PrincipalId[];
  }>;
  /** Candidates that were not escalated, and why. */
  readonly skipped: ReadonlyArray<{ card_id: string; reason: string }>;
  readonly failed: ReadonlyArray<{ card_id: string; error: DecisionError }>;
}

/**
 * B21: a gate pending past its SLA (one business day by the calendar in force when its card opened)
 * escalates to the backup slot (`deps.backupSlot`, default `admin`). The sweep writes a
 * `card.escalated` record event per pending gate and nothing else: NO ledger entry, no vote, no
 * status change. Escalation gives the backup an inbox entry (and a signal to chase the approver); it
 * grants no right to decide, which stays with the gate's slot (OB §1B, M6). It never approves,
 * rejects or expires anything, and a repeat sweep finds the escalation already recorded and does
 * nothing. Candidates come from the read model; each is re-read from the record and the ledger
 * under the card and gate locks, so a gate decided meanwhile (even by a stranded Notary entry just
 * imported) is left alone.
 */
export async function sweepSla(deps: DecisionDeps): Promise<Result<SlaReport, DecisionError>> {
  // MM-2: timers are frozen, nothing escalates until the maintenance ends.
  if (await inMaintenance(deps)) return ok({ escalated: [], skipped: [], failed: [] });
  const caught = await catchUp(deps);
  if (!caught.ok) return caught;
  const due = await deps.pool.query<{ card_id: string }>(
    `SELECT c.card_id FROM decisions.inbox_card c
      WHERE c.escalated_at IS NULL AND c.sla_due_at <= $1
        AND EXISTS (SELECT 1 FROM decisions.inbox_card_gate g
                      LEFT JOIN decisions.gate_instance i USING (gate_instance_id)
                     WHERE g.card_id = c.card_id AND (i.status = 'pending' OR i.status IS NULL))
      ORDER BY c.sla_due_at, c.card_id`,
    [clockOf(deps).now()],
  );
  const escalated: Array<SlaReport['escalated'][number]> = [];
  const skipped: Array<{ card_id: string; reason: string }> = [];
  const failed: Array<{ card_id: string; error: DecisionError }> = [];
  for (const { card_id } of due.rows) {
    const r = await escalateOne(deps, card_id);
    if (!r.ok) failed.push({ card_id, error: r.error });
    else if (r.value.length > 0) escalated.push(...r.value);
    else skipped.push({ card_id, reason: 'not_due_or_not_pending' });
  }
  return ok({ escalated, skipped, failed });
}

async function escalateOne(
  deps: DecisionDeps,
  cardId: string,
): Promise<Result<SlaReport['escalated'][number][], DecisionError>> {
  const clock = clockOf(deps);
  const done = await inDecisionTx<{ list: SlaReport['escalated'][number][] }>(deps, async (tx) => {
    const opened = await readCardOpened(tx, cardId);
    if (!opened) return err(decisionError('gate_not_found', `no card ${cardId}`));
    await lockKey(tx, `card:${cardId}`);
    for (const id of [...gateIdsOf(opened.open)].sort()) await lockKey(tx, `gate:${id}`);
    // Gate and card locks, then the ledger lock (and an import of stranded entries), then the append.
    const entered = await enterLedger(tx, deps);
    if (!entered.ok) return entered;
    const pending: readonly PendingConfirm[] = entered.value;
    const state = await readCardState(tx, cardId);
    if (!state) return err(decisionError('gate_not_found', `no card ${cardId}`));
    const nothing = ok({ value: { list: [] }, pending });
    if (state.status !== 'open' || !(clock.nowMs() >= Date.parse(state.open.sla_due_at))) {
      return nothing;
    }
    const already = new Set<string>(state.escalations.map((e) => e.gate_instance_id));
    const waiting = state.gates.filter(
      (g) => g.state.status === 'pending' && !already.has(g.gate_instance_id),
    );
    if (waiting.length === 0) return nothing;

    const project = state.open.project_id;
    const eligible = new Set<string>();
    for (const slot of new Set(waiting.map((g) => gatePolicy(g.state.open.payload.gate_id).slot))) {
      const h = await deps.eligibility.holders(project, slot);
      if (!h.ok) return err(decisionError('eligibility_unavailable', h.error.message));
      for (const p of h.value) eligible.add(p);
    }
    const backupSlot: RoleSlot = deps.backupSlot ?? 'admin';
    const b = await deps.eligibility.holders(project, backupSlot);
    if (!b.ok) return err(decisionError('eligibility_unavailable', b.error.message));
    const backup = [...new Set(b.value)]
      .filter(
        (p) =>
          !eligible.has(p) &&
          p !== state.open.requester &&
          // the author of what a waiting gate decides (B5 plan author) is no backup approver either
          !waiting.some((g) => g.state.open.payload.authors?.includes(p as never)),
      )
      .sort();

    const at = clock.now().toISOString();
    const events = waiting.map((g) => ({
      type: CARD_EVENT.escalated,
      actor: 'system.sla',
      idempotency_key: `escalated:${cardId}:${g.gate_instance_id}:1`,
      body: CardEscalatedPayload.parse({
        card_id: cardId,
        gate_instance_id: g.gate_instance_id,
        level: 1,
        reason: 'sla_b21',
        due_at: state.open.sla_due_at,
        escalated_at: at,
        backup_slot: backupSlot,
        backup,
      }) as unknown as JsonObject,
    }));
    const head = await tx.query<{ seq: string }>(
      'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
      [cardStream(cardId)],
    );
    const w = await appendEvents(tx, cardStream(cardId), Number(head.rows[0]?.seq), events, {
      clock,
    });
    if (!w.ok) return err(decisionError('conflict', JSON.stringify(w.error)));
    return ok({
      value: {
        list: waiting.map((g) => ({
          card_id: cardId,
          gate_instance_id: g.gate_instance_id,
          backup: backup as PrincipalId[],
        })),
      },
      pending,
    });
  });
  return done.ok ? ok(done.value.list) : done;
}

// ---------------------------------------------------------------- The inbox of a principal

export interface InboxItem {
  readonly card: InboxCard;
  readonly reason: InboxEntryReason;
  /** `sla_due_at` has passed (the sweep may not have run yet). */
  readonly overdue: boolean;
}

/**
 * Open cards for `principal`, oldest due first: cards with a pending gate whose slot the principal
 * holds now (resolved through the `EligibilityPort`, so a change of holders applies at once), and
 * cards escalated to them as backup. An identity error hides the cards of that project: unknown
 * means not eligible.
 */
export async function listInbox(
  deps: DecisionDeps,
  principal: PrincipalId,
): Promise<Result<InboxItem[], DecisionError>> {
  const caught = await catchUp(deps);
  if (!caught.ok) return caught;
  const cards = await readCardViews(deps.pool, { open_only: true });
  const entries = await deps.pool.query<{ card_id: string }>(
    `SELECT DISTINCT card_id FROM decisions.inbox_entry WHERE principal = $1`,
    [principal],
  );
  const backupFor = new Set(entries.rows.map((r) => r.card_id));
  const holders = new Map<string, readonly PrincipalId[] | null>();
  const holdersOf = async (project: string, slot: RoleSlot) => {
    const key = `${project}/${slot}`;
    if (!holders.has(key)) {
      const h = await deps.eligibility.holders(project as never, slot);
      holders.set(key, h.ok ? h.value : null);
    }
    return holders.get(key) ?? null;
  };
  const items: InboxItem[] = [];
  const now = clockOf(deps).nowMs();
  for (const card of cards) {
    let eligible = false;
    for (const g of card.gates) {
      if (g.status !== 'pending') continue;
      const h = await holdersOf(card.project_id, gatePolicy(g.gate_id).slot);
      if (h?.includes(principal)) eligible = true;
    }
    // A card without a gate (an S0 step card) is the inbox of the slot it was opened for.
    if (card.gates.length === 0 && card.status === 'open') {
      const h = await holdersOf(card.project_id, card.role);
      if (h?.includes(principal)) eligible = true;
    }
    if (!eligible && !backupFor.has(card.card_id)) continue;
    items.push({
      card,
      reason: eligible ? 'eligible' : 'escalated_backup',
      overdue: now >= Date.parse(card.sla_due_at),
    });
  }
  return ok(
    items.sort(
      (a, b) =>
        Date.parse(a.card.sla_due_at) - Date.parse(b.card.sla_due_at) ||
        a.card.card_id.localeCompare(b.card.card_id),
    ),
  );
}
