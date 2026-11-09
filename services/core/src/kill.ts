import {
  ITEM_EVENT,
  KILL_EVENT,
  KILL_LEDGER_ENTRY_TYPE,
  KILL_SIGNATURE_PENDING,
  KILL_OBSERVED_EVENT,
  KILL_OBSERVED_STREAM,
  KillObservedPayload,
  type HoldReason,
  type KillEvent,
  type LedgerEntryDraft,
  type ProjectId,
} from '@aisdlc/contracts';
import { DEFAULT_POLICY_BUNDLE_VERSION, type EligibilityPort } from '@aisdlc/decisions';
import { deterministicId, err, ok, type Jwk, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type PendingConfirm,
} from '@aisdlc/ledger';
import type { LoopSpec } from '@aisdlc/loops';
import { admitAgentWork, type KillStatePort } from '@aisdlc/ports';
import { verifyKillJournal } from '@aisdlc/killswitch/client';
import type { ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { coreError, type CoreError } from './errors.js';
import { clockOf, inCoreLedgerTx, lockKeys, type CoreDeps } from './journal.js';
import { listProjects } from './queries.js';
import { WORK_ACTOR, ingestItem, readItem, readItemEvents } from './work-items.js';

// What core does with the kill switch (PLAN M9.6, AR9). The kill switch is its own service; core never
// writes to it on its own account and it never calls core. Three things only:
//
//   1. READ  `KillStatePort.status` before agent work is admitted (the work driver, `admitAgentWork`:
//      an unreachable kill switch is a kill) and mirror a kill as a `kill` HOLD on the items it covers.
//   2. PUSH  who holds the admin and kill slots of each project, and its tier and two-person setting
//      (`syncKillHolders`): the kill switch decides who may kill from its own copy, never by asking core.
//   3. OBSERVE the kill switch's own journal (`observeKillswitch`): each entry is verified against the
//      kill switch's pinned public key, then recorded as a `kill.observed` fact and written to the ledger
//      through the Notary (`kill.event`). That is how a kill reaches core's record without the kill
//      switch calling a core write API: core pulls, the kill switch has no route in.

export const KILL_HOLD_ID = 'kill';

// ---------------------------------------------------------------- 1. holds

/**
 * Puts a hold on an item, or takes it off, so that the item has it exactly when `want`. One signal per
 * placing and per release, keyed by how often this hold was placed before, so a repeat is a no-op.
 */
export async function setHold(
  d: CoreDeps,
  itemId: string,
  s: ItemState,
  h: { hold_id: string; reason: HoldReason; origin: string | null; want: boolean },
): Promise<'placed' | 'released' | 'none'> {
  const has = s.holds.some((x) => x.hold_id === h.hold_id);
  if (has === h.want) return 'none';
  const events = await readItemEvents(d.pool, itemId);
  const nth = events.filter(
    (e) =>
      e.type === ITEM_EVENT.hold_placed &&
      (e.payload as { hold_id?: string }).hold_id === h.hold_id,
  ).length;
  const w = await ingestItem(
    d,
    itemId,
    h.want
      ? {
          type: ITEM_EVENT.hold_placed,
          payload: { hold_id: h.hold_id, reason: h.reason, origin: h.origin },
          actor: WORK_ACTOR,
          idempotency_key: `${h.hold_id}:placed:${nth + 1}`,
        }
      : {
          type: ITEM_EVENT.hold_released,
          payload: { hold_id: h.hold_id },
          actor: WORK_ACTOR,
          idempotency_key: `${h.hold_id}:released:${nth}`,
        },
  );
  if (!w.ok) throw new Error(w.error.message);
  if (w.value.duplicate) return 'none';
  return h.want ? 'placed' : 'released';
}

export interface KillHoldDeps extends CoreDeps {
  readonly kill: KillStatePort;
}

/**
 * Puts the `kill` hold on every item a kill covers and takes it off those it no longer covers. A kill
 * switch that cannot be reached changes no hold (the dispatch side refuses agent work instead), so a
 * blip does not release anything and does not hold everything.
 */
export async function syncKillHolds(
  d: KillHoldDeps,
  itemIds: readonly string[],
): Promise<{ placed: number; released: number; unreachable: boolean }> {
  let placed = 0;
  let released = 0;
  let unreachable = false;
  const seen = new Map<string, Awaited<ReturnType<typeof admitAgentWork>>>();
  for (const id of itemIds) {
    const item = await readItem(d.pool, id);
    if (!item || item.state.terminal !== null) continue;
    const s = item.state;
    const q = { project_id: s.project_id, lane: s.lane ?? s.proposed_lane };
    const key = `${q.project_id}/${q.lane}`;
    let a = seen.get(key);
    if (a === undefined) {
      a = await admitAgentWork(d.kill, q);
      seen.set(key, a);
    }
    if (!a.admitted && a.why === 'unreachable') {
      unreachable = true;
      continue;
    }
    const r = await setHold(d, id, s, {
      hold_id: KILL_HOLD_ID,
      reason: 'kill',
      origin: a.admitted ? null : (a.kill_ids[0] ?? null),
      want: !a.admitted,
    });
    if (r === 'placed') placed += 1;
    if (r === 'released') released += 1;
  }
  return { placed, released, unreachable };
}

// ---------------------------------------------------------------- 2. push the holders

/** The part of the kill switch's API this module uses (the `KillswitchClient` satisfies it). */
export interface KillswitchLink {
  syncHolders(
    project_id: string,
    body: {
      admins: string[];
      kill_holders: string[];
      tier: 'T0' | 'T1' | 'T2' | null;
      two_person: boolean;
    },
  ): Promise<Result<unknown, { message: string }>>;
  events(
    after: number,
    limit?: number,
  ): Promise<Result<{ events: KillEvent[]; key: Jwk | null }, { message: string }>>;
}

/**
 * Pushes, for every project, who holds the admin and kill slots and its tier and two-person setting.
 * A project whose slots cannot be read is skipped and counted: the kill switch keeps what it had
 * (it never learns "nobody holds the slot" from an error).
 */
export async function syncKillHolders(d: {
  pool: pg.Pool;
  eligibility: EligibilityPort;
  link: KillswitchLink;
}): Promise<{ pushed: number; failed: number }> {
  let pushed = 0;
  let failed = 0;
  for (const p of await listProjects(d.pool)) {
    const id = p.project.project_id as ProjectId;
    const [admins, kill, policy] = await Promise.all([
      d.eligibility.holders(id, 'admin'),
      d.eligibility.holders(id, 'kill'),
      d.eligibility.policy(id),
    ]);
    if (!admins.ok || !kill.ok || !policy.ok) {
      failed += 1;
      continue;
    }
    const r = await d.link.syncHolders(id, {
      admins: [...admins.value],
      kill_holders: [...kill.value],
      tier: policy.value.tier,
      two_person: policy.value.two_person.enabled,
    });
    if (r.ok) pushed += 1;
    else failed += 1;
  }
  return { pushed, failed };
}

// ---------------------------------------------------------------- 3. observe the journal

/** Where the observation stopped: the last entry of the kill switch's journal core recorded. */
export async function killObservedCursor(
  db: pg.Pool | pg.PoolClient,
): Promise<{ seq: number; hash: string | null }> {
  const q = await db.query<{ body: Record<string, unknown> }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY record_event.seq DESC LIMIT 1`,
    [KILL_OBSERVED_STREAM, KILL_OBSERVED_EVENT],
  );
  const b = q.rows[0]?.body;
  return b ? { seq: Number(b['ks_seq']), hash: String(b['entry_hash']) } : { seq: 0, hash: null };
}

export interface ObserveDeps extends CoreDeps {
  readonly ledger: NonNullable<CoreDeps['ledger']>;
  readonly link: KillswitchLink;
  /** The kill switch's public key, pinned (looked up in key custody at start), never taken from its own answer. */
  readonly key: Jwk;
  readonly batch?: number;
}

/**
 * Reads the kill switch's journal after the last entry recorded, verifies the chain and every signature
 * against the pinned key, and for each entry writes one `kill.observed` record event and one `kill.event`
 * ledger entry (through the Notary), together. An entry that does not verify stops the run and nothing
 * after it is recorded: a journal that no longer verifies is not recorded as fact.
 */
export async function observeKillswitch(
  d: ObserveDeps,
): Promise<Result<{ observed: number; head_seq: number }, CoreError>> {
  const cursor = await killObservedCursor(d.pool);
  const got = await d.link.events(cursor.seq, d.batch ?? 200);
  if (!got.ok) return err(coreError('unavailable', `kill switch: ${got.error.message}`));
  if (got.value.events.length === 0) return ok({ observed: 0, head_seq: cursor.seq });
  const problems = await verifyKillJournal(got.value.events, d.key, cursor);
  if (problems.length > 0) {
    return err(
      coreError(
        'refused',
        `the kill switch journal does not verify: ${problems.map((p) => `#${p.seq} ${p.problem}`).join('; ')}`,
      ),
    );
  }
  let observed = 0;
  for (const e of got.value.events) {
    const payload = KillObservedPayload.parse({
      ks_seq: e.seq,
      kind: e.kind,
      subject: e.subject,
      actor: e.actor,
      entry_hash: e.entry_hash,
      signature: e.signature,
      key_id: e.key_id,
      at: e.at,
      body: e.body,
    });
    // A kill written while the KMS was away is enforced already and is recorded as a fact at once; its
    // ledger entry follows when the signed attestation of it is observed.
    const unsigned = e.signature === KILL_SIGNATURE_PENDING;
    const r = await ledgerObserved(d, payload, unsigned);
    if (!r.ok) return r;
    if (r.value) observed += 1;
    if (e.kind === KILL_EVENT.signature_attested) {
      const pending = (e.body as { pending_seq?: number }).pending_seq;
      if (typeof pending === 'number') {
        const l = await ledgerPendingKill(d, pending);
        if (!l.ok) return l;
      }
    }
  }
  const last = got.value.events[got.value.events.length - 1];
  return ok({ observed, head_seq: last?.seq ?? cursor.seq });
}

/** The ledger entry of an observed kill switch entry: bound to its signed hash, written last. */
function ledgerDraft(
  d: ObserveDeps,
  p: KillObservedPayload,
  extra: Record<string, unknown> = {},
): LedgerEntryDraft {
  return {
    entry_id: deterministicId<'LedgerEntry'>(`kill.observed:${p.ks_seq}`),
    entry_type: KILL_LEDGER_ENTRY_TYPE,
    gate_instance_id: null,
    gate_id: null,
    subject_kind: null,
    subject_id: null,
    subject_hash: p.entry_hash as never,
    decision: null,
    actor: p.actor,
    sod_waiver: false,
    policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
    body: {
      kind: 'kill_observed',
      ks_seq: p.ks_seq,
      event: p.kind,
      subject: p.subject,
      key_id: p.key_id,
      signature: p.signature,
      killswitch_entry_hash: p.entry_hash,
      detail: p.body,
      ...extra,
    } as never,
    created_at: clockOf(d).now().toISOString(),
  };
}

/** One entry: the fact, and (when signed) the ledger entry, in one transaction. `true`: it was new. */
async function ledgerObserved(
  d: ObserveDeps,
  payload: KillObservedPayload,
  unsigned: boolean,
): Promise<Result<boolean, CoreError>> {
  return inCoreLedgerTx({ ...d, ledger: d.ledger }, async (j, tx) => {
    await lockKeys(tx, [KILL_OBSERVED_STREAM]);
    // The ledger lock before the first record append, the entry last (AGENTS.md lock order).
    await lockLedger(tx);
    const pending: PendingConfirm[] = [];
    const caught = await importUnconfirmed(tx, d.ledger);
    if (!caught.ok) return err(coreError('unavailable', caught.error.message));
    pending.push(...caught.value.pending);
    const w = await j.emitAll(KILL_OBSERVED_STREAM, [
      {
        type: KILL_OBSERVED_EVENT,
        body: payload,
        actor: 'system.kill_observer',
        idempotency_key: `ks:${payload.ks_seq}`,
      },
    ]);
    if (!w.ok) return w;
    if (w.value.duplicate) return ok({ value: false, pending });
    if (unsigned) return ok({ value: true, pending });
    const l = await appendLedgerEntryTx(tx, d.ledger, ledgerDraft(d, payload));
    if (!l.ok) return err(coreError('unavailable', l.error.message));
    pending.push(...l.value.pending);
    return ok({ value: true, pending });
  });
}

/** The ledger entry of a kill that was observed unsigned, once its attestation has been observed. Once. */
async function ledgerPendingKill(
  d: ObserveDeps,
  ks_seq: number,
): Promise<Result<boolean, CoreError>> {
  const id = deterministicId<'LedgerEntry'>(`kill.observed:${ks_seq}`);
  const f = await d.pool.query<{ body: unknown }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 AND (body ->> 'ks_seq')::int = $3`,
    [KILL_OBSERVED_STREAM, KILL_OBSERVED_EVENT, ks_seq],
  );
  if (!f.rows[0]) return ok(false);
  const payload = KillObservedPayload.parse(f.rows[0].body);
  return inCoreLedgerTx({ ...d, ledger: d.ledger }, async (_j, tx) => {
    await lockLedger(tx);
    const pending: PendingConfirm[] = [];
    const caught = await importUnconfirmed(tx, d.ledger);
    if (!caught.ok) return err(coreError('unavailable', caught.error.message));
    pending.push(...caught.value.pending);
    const have = await tx.query('SELECT 1 FROM ledger.ledger_entry WHERE entry_id = $1', [id]);
    if (have.rowCount) return ok({ value: false, pending });
    const l = await appendLedgerEntryTx(
      tx,
      d.ledger,
      ledgerDraft(d, payload, { signed_later: true }),
    );
    if (!l.ok) return err(coreError('unavailable', l.error.message));
    pending.push(...l.value.pending);
    return ok({ value: true, pending });
  });
}

// ---------------------------------------------------------------- loops

export interface KillLoopOptions {
  readonly intervalMs?: number;
  readonly startDelayMs?: number;
}

/** `kill_holders`: pushes the holders of every project to the kill switch. */
export function killHoldersLoop(
  d: { pool: pg.Pool; eligibility: EligibilityPort; link: KillswitchLink },
  o: KillLoopOptions = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 10_000;
  return {
    name: 'kill_holders',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick() {
      const r = await syncKillHolders(d);
      return { ok: r.pushed, failed: r.failed };
    },
  };
}

/** `kill_observer`: records the kill switch's journal as facts and ledger entries. */
export function killObserverLoop(d: ObserveDeps, o: KillLoopOptions = {}): LoopSpec {
  const intervalMs = o.intervalMs ?? 5_000;
  return {
    name: 'kill_observer',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick() {
      // a long journal is read in batches until it is caught up
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const r = await observeKillswitch(d);
        if (!r.ok) throw new Error(r.error.message);
        total += r.value.observed;
        if (r.value.observed < (d.batch ?? 200)) break;
      }
      return { ok: total, failed: 0 };
    },
  };
}
