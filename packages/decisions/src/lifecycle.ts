import {
  GATE_EVENT,
  GateOpenedPayload,
  gatePolicy,
  type GateId,
  type JsonObject,
  type PrincipalId,
  type ProjectId,
  type SubjectKind,
} from '@aisdlc/contracts';
import { err, newId, ok, type Result } from '@aisdlc/kernel';
import type { PendingConfirm } from '@aisdlc/ledger';
import { runProjection, type Tx } from '@aisdlc/record';
import { decisionError, type DecisionError } from './errors.js';
import {
  DEFAULT_GATE_TTL_MS,
  appendGateEvents,
  clockOf,
  decisionDraft,
  enterLedger,
  inDecisionTx,
  inMaintenance,
  lockKey,
  newEntryId,
  writeDecision,
  type DecisionDeps,
  type Written,
} from './internal.js';
import { planQuorum } from './policy.js';
import { gateInstanceProjection } from './projection.js';
import { SYSTEM_ACTORS, isSystemActor, readGateState, type GateState } from './state.js';

// GateInstance lifecycle (PLAN M3.1): open, supersede, withdraw and the TTL sweep. Every function
// is one transaction in which the ledger entry, if there is one, is the last write. Opening is a
// record event only; supersede, expire and withdraw are ledger decisions plus a marker event.

export interface OpenGateInput {
  readonly gate_id: GateId;
  readonly project_id: ProjectId;
  readonly subject_kind: SubjectKind;
  /** The item id, or the S0 record UUID (fix #32). */
  readonly subject_id: string;
  readonly subject_hash: string;
  readonly evidence_pack_hash?: string | null;
  /** Who asked for the work; they cannot decide it unless the single-holder waiver applies. */
  readonly requester?: PrincipalId | null;
  /** Conflict facts and project policy. `expires_at` is added (`gateTtlMs` after now) if missing. */
  readonly facts?: JsonObject;
  /** Require a step-up even where the gate policy does not (never the other way round). */
  readonly step_up?: boolean;
  /** What the step-up proof binds to; default the subject hash (D37 uses `text_sha256`). */
  readonly step_up_bound_hash?: string;
  /** The actor of a supersede entry. Default `system.gate`. */
  readonly opened_by?: string;
}

export interface OpenGateResult {
  readonly gate_instance_id: string;
  /** False when a pending instance with the same subject hash already existed: nothing was written. */
  readonly opened: boolean;
  /** Pending instances for the same gate and subject that the new subject hash superseded. */
  readonly superseded: readonly string[];
  readonly required_quorum: number;
}

/** Instances of one gate and subject, oldest first, from the open events (an index lookup). */
async function instancesOf(tx: Tx, gate: string, kind: string, subject: string): Promise<string[]> {
  const q = await tx.query<{ stream: string }>(
    `SELECT stream FROM record.record_event
      WHERE type = $1 AND seq = 1 AND body ->> 'subject_id' = $2
        AND body ->> 'gate_id' = $3 AND body ->> 'subject_kind' = $4
      ORDER BY global_seq`,
    [GATE_EVENT.opened, subject, gate, kind],
  );
  return q.rows.map((r) => r.stream.slice('gate:'.length));
}

/**
 * Opens a gate instance for a subject. If a pending instance of the same gate and subject has the
 * same `subject_hash` it is returned unchanged. If its hash differs, the new instance supersedes it
 * (the old one gets a `supersede` ledger decision and ends `superseded`). A gate that could never be
 * decided (nobody holds the slot; T2 two-person with fewer than two approvers) is refused.
 */
export async function openGate(
  deps: DecisionDeps,
  input: OpenGateInput,
): Promise<Result<Written<OpenGateResult>, DecisionError>> {
  const clock = clockOf(deps);
  return inDecisionTx<OpenGateResult>(deps, async (tx) => {
    // Gate keys first (subject, then each existing instance), the ledger lock after them.
    await lockKey(tx, `subject:${input.gate_id}:${input.subject_kind}:${input.subject_id}`);
    const ids = await instancesOf(tx, input.gate_id, input.subject_kind, input.subject_id);
    for (const id of [...ids].sort()) await lockKey(tx, `gate:${id}`);
    const entered = await enterLedger(tx, deps);
    if (!entered.ok) return entered;

    const pendingStates: GateState[] = [];
    for (const id of ids) {
      const s = await readGateState(tx, id);
      if (s?.status === 'pending') pendingStates.push(s);
    }
    const same = pendingStates.find((s) => s.open.payload.subject_hash === input.subject_hash);
    if (same) {
      return ok({
        value: {
          gate_instance_id: same.open.gate_instance_id,
          opened: false,
          superseded: [],
          required_quorum: same.open.payload.quorum.required,
        },
        pending: entered.value,
      });
    }

    const policy = gatePolicy(input.gate_id);
    const holders = await deps.eligibility.holders(input.project_id, policy.slot);
    const ctx = await deps.eligibility.policy(input.project_id);
    if (!holders.ok || !ctx.ok) {
      const why = !holders.ok ? holders.error.message : !ctx.ok ? ctx.error.message : '';
      return err(decisionError('eligibility_unavailable', why));
    }
    const requester = input.requester ?? null;
    const plan = planQuorum(input.gate_id, ctx.value, holders.value, requester);
    if (!plan.ok) return err(decisionError('quorum_infeasible', plan.error.message));

    const newIdStr = newId<'GateInstance'>(clock.nowMs());
    const expiresAt =
      typeof input.facts?.['expires_at'] === 'string'
        ? input.facts['expires_at']
        : new Date(clock.nowMs() + (deps.gateTtlMs ?? DEFAULT_GATE_TTL_MS)).toISOString();
    const payload = GateOpenedPayload.safeParse({
      gate_instance_id: newIdStr,
      gate_id: input.gate_id,
      project_id: input.project_id,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      subject_hash: input.subject_hash,
      evidence_pack_hash: input.evidence_pack_hash ?? null,
      requester,
      facts: { ...input.facts, expires_at: expiresAt },
      quorum: { required: plan.value.required, slot: plan.value.slot, basis: plan.value.basis },
      step_up: {
        required: policy.step_up || input.step_up === true,
        bound_hash: input.step_up_bound_hash ?? input.subject_hash,
      },
      supersedes: pendingStates[0]?.open.gate_instance_id ?? null,
      opened_by: input.opened_by ?? SYSTEM_ACTORS.gate,
    });
    if (!payload.success) return err(decisionError('invalid_input', payload.error.message));
    if (Date.parse(expiresAt) <= clock.nowMs()) {
      return err(decisionError('invalid_input', 'facts.expires_at is not in the future'));
    }

    // Record writes first: a marker on each old stream, then the new stream.
    const superseding = pendingStates.map((s) => ({ state: s, entry_id: newEntryId(deps) }));
    const actor = input.opened_by ?? SYSTEM_ACTORS.gate;
    for (const { state, entry_id } of superseding) {
      const m = await appendGateEvents(tx, deps, state.open.gate_instance_id, [
        {
          type: GATE_EVENT.superseded,
          actor,
          idempotency_key: `superseded:${entry_id}`,
          body: {
            ledger_entry_id: entry_id,
            superseded_by: newIdStr,
            new_subject_hash: input.subject_hash,
          },
        },
      ]);
      if (!m.ok) return m;
    }
    const opened = await appendGateEvents(tx, deps, newIdStr, [
      {
        type: GATE_EVENT.opened,
        actor,
        idempotency_key: `opened:${newIdStr}`,
        body: payload.data,
      },
    ]);
    if (!opened.ok) return opened;

    // Ledger entries last: one `supersede` decision per instance replaced (normally zero or one).
    const pending: PendingConfirm[] = [...entered.value];
    for (const { state, entry_id } of superseding) {
      const p = state.open.payload;
      const w = await writeDecision(
        tx,
        deps,
        decisionDraft(deps, {
          entry_id,
          gate_instance_id: state.open.gate_instance_id,
          gate_id: p.gate_id,
          subject_kind: p.subject_kind,
          subject_id: p.subject_id,
          subject_hash: p.subject_hash, // binds the OLD subject: that is what is being superseded
          decision: 'supersede',
          actor,
          sod_waiver: false,
          body: {
            kind: 'supersede',
            superseded_by: newIdStr,
            new_subject_hash: input.subject_hash,
          },
        }),
      );
      if (!w.ok) return w;
      pending.push(...w.value.pending);
    }
    return ok({
      value: {
        gate_instance_id: newIdStr,
        opened: true,
        superseded: superseding.map((s) => s.state.open.gate_instance_id),
        required_quorum: plan.value.required,
      },
      pending,
    });
  });
}

// ---------------------------------------------------------------- Withdraw

export interface WithdrawInput {
  readonly gate_instance_id: string;
  /** The requester, a holder of the project's `admin` slot, or a system actor (item ended). */
  readonly actor: string;
  readonly reason: string;
}

/** Closes a pending gate ("item ended or withdrawn", DM §6.2) with a `withdraw` ledger decision. */
export function withdrawGate(
  deps: DecisionDeps,
  input: WithdrawInput,
): Promise<Result<Written<{ gate_instance_id: string }>, DecisionError>> {
  return inDecisionTx(deps, async (tx) => {
    if (input.reason.trim() === '')
      return err(decisionError('invalid_input', 'a reason is needed'));
    await lockKey(tx, `gate:${input.gate_instance_id}`);
    const entered = await enterLedger(tx, deps);
    if (!entered.ok) return entered;
    const state = await readGateState(tx, input.gate_instance_id);
    if (!state) return err(decisionError('gate_not_found', `no gate ${input.gate_instance_id}`));
    if (state.status !== 'pending') {
      return err(decisionError('gate_not_pending', `gate is ${state.status}, not pending`));
    }
    const p = state.open.payload;
    if (!isSystemActor(input.actor) && input.actor !== p.requester) {
      const admins = await deps.eligibility.holders(p.project_id, 'admin');
      if (!admins.ok) return err(decisionError('eligibility_unavailable', admins.error.message));
      if (!admins.value.includes(input.actor as PrincipalId)) {
        return err(decisionError('not_allowed', `${input.actor} may not withdraw this gate`));
      }
    }
    const entryId = newEntryId(deps);
    const m = await appendGateEvents(tx, deps, input.gate_instance_id, [
      {
        type: GATE_EVENT.closed,
        actor: input.actor,
        idempotency_key: `closed:${entryId}`,
        body: { ledger_entry_id: entryId, reason: input.reason },
      },
    ]);
    if (!m.ok) return m;
    const w = await writeDecision(
      tx,
      deps,
      decisionDraft(deps, {
        entry_id: entryId,
        gate_instance_id: input.gate_instance_id,
        gate_id: p.gate_id,
        subject_kind: p.subject_kind,
        subject_id: p.subject_id,
        subject_hash: p.subject_hash,
        decision: 'withdraw',
        actor: input.actor,
        sod_waiver: false,
        body: { kind: 'withdraw', reason: input.reason },
      }),
    );
    if (!w.ok) return w;
    return ok({
      value: { gate_instance_id: input.gate_instance_id },
      pending: [...entered.value, ...w.value.pending],
    });
  });
}

// ---------------------------------------------------------------- TTL sweep

export interface SweepReport {
  /** Instances this sweep marked expired. */
  readonly expired: readonly string[];
  /** Candidates that were not expired, and why: the ledger already ended them, or they are not due. */
  readonly skipped: ReadonlyArray<{ gate_instance_id: string; reason: string }>;
  readonly failed: ReadonlyArray<{ gate_instance_id: string; error: DecisionError }>;
}

/**
 * Expires pending instances past `facts.expires_at`. The sweep NEVER decides: it only writes an
 * `expire` decision, which `foldDecisions` maps to `expired`, and it leaves a decided, superseded
 * or closed instance alone. It uses the read model only to find candidates; each candidate is
 * re-read from the record and the ledger under the gate lock, so a decision the projection has not
 * folded yet (for instance one stranded by a rolled-back transaction and just reconciled) wins.
 */
export async function sweepExpired(
  deps: DecisionDeps,
  opts: { limit?: number } = {},
): Promise<Result<SweepReport, DecisionError>> {
  const clock = clockOf(deps);
  // MM-2: timers are frozen. A gate that was pending stays pending; it expires after the maintenance.
  if (await inMaintenance(deps)) return ok({ expired: [], skipped: [], failed: [] });
  const caught = await runProjection(deps.pool, gateInstanceProjection);
  if (!caught.ok) return err(decisionError('database', JSON.stringify(caught.error)));
  const due = await deps.pool.query<{ gate_instance_id: string }>(
    `SELECT gate_instance_id FROM decisions.gate_instance
      WHERE status = 'pending' AND expires_at <= $1 ORDER BY expires_at LIMIT $2`,
    [clock.now(), opts.limit ?? 100],
  );
  const expired: string[] = [];
  const skipped: Array<{ gate_instance_id: string; reason: string }> = [];
  const failed: Array<{ gate_instance_id: string; error: DecisionError }> = [];
  for (const { gate_instance_id: id } of due.rows) {
    const r = await expireOne(deps, id);
    if (!r.ok) failed.push({ gate_instance_id: id, error: r.error });
    else if (r.value.expired) expired.push(id);
    else skipped.push({ gate_instance_id: id, reason: r.value.reason });
  }
  return ok({ expired, skipped, failed });
}

type ExpireOutcome = { expired: true } | { expired: false; reason: string };

async function expireOne(
  deps: DecisionDeps,
  id: string,
): Promise<Result<ExpireOutcome, DecisionError>> {
  const clock = clockOf(deps);
  const done = await inDecisionTx<ExpireOutcome>(deps, async (tx) => {
    await lockKey(tx, `gate:${id}`);
    const entered = await enterLedger(tx, deps);
    if (!entered.ok) return entered;
    const state = await readGateState(tx, id);
    if (!state) return err(decisionError('gate_not_found', `no gate ${id}`));
    if (state.status !== 'pending') {
      return ok({ value: { expired: false, reason: state.status }, pending: entered.value });
    }
    const p = state.open.payload;
    const expiresAt = String(p.facts['expires_at']);
    if (!(Date.parse(expiresAt) <= clock.nowMs())) {
      return ok({ value: { expired: false, reason: 'not_due' }, pending: entered.value });
    }
    const entryId = newEntryId(deps);
    const m = await appendGateEvents(tx, deps, id, [
      {
        type: GATE_EVENT.expired,
        actor: SYSTEM_ACTORS.sweep,
        idempotency_key: `expired:${entryId}`,
        body: { ledger_entry_id: entryId, expires_at: expiresAt },
      },
    ]);
    if (!m.ok) return m;
    const w = await writeDecision(
      tx,
      deps,
      decisionDraft(deps, {
        entry_id: entryId,
        gate_instance_id: id,
        gate_id: p.gate_id,
        subject_kind: p.subject_kind,
        subject_id: p.subject_id,
        subject_hash: p.subject_hash,
        decision: 'expire',
        actor: SYSTEM_ACTORS.sweep,
        sod_waiver: false,
        body: { kind: 'expire', expires_at: expiresAt },
      }),
    );
    if (!w.ok) return w;
    return ok({ value: { expired: true }, pending: [...entered.value, ...w.value.pending] });
  });
  return done.ok ? ok(done.value) : done;
}
