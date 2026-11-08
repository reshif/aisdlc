import {
  ACCESS_EVENT_TYPES,
  ACCESS_LEDGERED,
  ACCESS_POLICY_BUNDLE_VERSION,
  ACCESS_SYNC_SLO_SECONDS,
  AccessLedgerBody,
  PrincipalId,
  type LedgerEntryDraft,
  type RecordEvent,
} from '@aisdlc/contracts';
import { err, newId, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  confirmAll,
  importUnconfirmed,
  inTransaction,
  lockLedger,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import { EVENT_COLUMNS, toRecordEvent, type EventRow, type Executor } from '@aisdlc/record';
import type pg from 'pg';
import { identityError, type IdentityError } from './errors.js';

// The access-sync loop (PLAN M4.1, RV §3.1). Identity writers append journal events and never
// touch the ledger; this loop makes the permanent record: every access event (a membership or
// binding change, a status or qualification change) gets exactly one `access.*` ledger entry,
// within `ACCESS_SYNC_SLO_SECONDS`.
//
// Lock order: this transaction writes the ledger and no record events, so the loop's own key comes
// first, then the ledger lock, then the entries (ledger last, after the import of anything the
// Notary signed that the record lacks). It is idempotent three ways: it checks the ledger before
// signing, it skips events it already ledgered, and a unique index on `body.access_event_id`
// makes a second entry for one event impossible. A crash after the Notary signed is repaired by
// the import that precedes every check.

export interface AccessSyncDeps {
  readonly pool: pg.Pool;
  readonly ledger: LedgerClientDeps;
  readonly clock?: Clock;
}

export interface AccessSyncOptions {
  /** Entries per transaction. Default 25. */
  readonly batch?: number;
  /** Stop after this many entries (default: until caught up). */
  readonly max?: number;
}

export interface AccessSyncReport {
  /** Ledger entries written by this call. */
  readonly written: number;
  /** Events found already on the ledger (a retry, or an entry a crashed run had signed). */
  readonly already: number;
  /** Seconds the oldest unledgered access event is behind, after the run. */
  readonly lag_seconds: number;
  /** False when `max` stopped the run before it caught up. */
  readonly caught_up: boolean;
}

const clockOf = (d: AccessSyncDeps): Clock => d.clock ?? systemClock;
const KEY = 'aisdlc.identity:access-sync';
const ACCESS_ENTRY = "entry_type LIKE 'access.%'";

/** The ledger entry an access event gets (a draft: the Notary adds position, hashes and signature). */
export function accessDraft(e: RecordEvent, clock: Clock): LedgerEntryDraft {
  const actor = PrincipalId.safeParse(e.actor);
  return {
    entry_id: newId<'LedgerEntry'>(clock.nowMs()),
    entry_type: ACCESS_LEDGERED[e.type] as string,
    gate_instance_id: null,
    gate_id: null,
    subject_kind: null,
    subject_id: null,
    subject_hash: null,
    decision: null,
    actor: actor.success ? actor.data : null,
    sod_waiver: false,
    policy_bundle_version: ACCESS_POLICY_BUNDLE_VERSION,
    body: AccessLedgerBody.parse({
      access_event_id: e.event_id,
      stream: e.stream_id,
      stream_seq: e.stream_seq,
      global_seq: e.global_seq,
      event_type: e.type,
      occurred_at: e.occurred_at,
      change: e.payload,
    }),
    created_at: clock.now().toISOString(),
  };
}

interface BatchOutcome {
  written: number;
  already: number;
  processed: number;
  pending: PendingConfirm[];
  more: boolean;
}

async function oneBatch(
  deps: AccessSyncDeps,
  batch: number,
): Promise<Result<BatchOutcome, IdentityError>> {
  const done = await inTransaction(
    deps.pool,
    async (tx): Promise<Result<BatchOutcome, IdentityError>> => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [KEY]);
      const cp = await tx.query<{ ledgered_through: string }>(
        'SELECT ledgered_through::text AS ledgered_through FROM identity.access_sync WHERE id FOR UPDATE',
      );
      const through = Number(cp.rows[0]?.ledgered_through ?? 0);
      // The head first: events up to it are all visible (commit order is sequence order).
      const head = Number(
        (
          await tx.query<{ n: string }>(
            'SELECT coalesce(max(global_seq), 0)::text AS n FROM record.record_event',
          )
        ).rows[0]?.n ?? 0,
      );

      await lockLedger(tx);
      const caught = await importUnconfirmed(tx, deps.ledger);
      if (!caught.ok) return err(identityError('ledger', caught.error.message, caught.error));
      const pending: PendingConfirm[] = [...caught.value.pending];

      const rows = await tx.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM record.record_event
          WHERE global_seq > $1::bigint AND global_seq <= $2::bigint AND type = ANY($3::text[])
          ORDER BY record_event.global_seq LIMIT $4`,
        [String(through), String(head), [...ACCESS_EVENT_TYPES], batch],
      );
      let written = 0;
      let already = 0;
      let last = through;
      for (const row of rows.rows) {
        const e = toRecordEvent(row);
        const have = await tx.query(
          `SELECT 1 FROM ledger.ledger_entry WHERE ${ACCESS_ENTRY} AND body ->> 'access_event_id' = $1`,
          [e.event_id],
        );
        if (have.rows.length > 0) already += 1;
        else {
          const draft = accessDraft(e, clockOf(deps));
          const w = await appendLedgerEntryTx(tx, deps.ledger, draft);
          if (!w.ok) return err(identityError('ledger', w.error.message, w.error));
          pending.push(...w.value.pending);
          written += 1;
        }
        last = e.global_seq;
      }
      // Fewer rows than asked for: everything up to the head is ledgered.
      const more = rows.rows.length === batch;
      const newThrough = more ? last : head;
      if (newThrough > through) {
        await tx.query('UPDATE identity.access_sync SET ledgered_through = $1::bigint WHERE id', [
          String(newThrough),
        ]);
      }
      return ok({ written, already, processed: rows.rows.length, pending, more });
    },
    (e) => identityError('database', e instanceof Error ? e.message : String(e)),
  );
  if (!done.ok) return done;
  // After COMMIT: tell the Notary these entries are committed (idempotent; the reconciler finishes
  // the job if this fails).
  const confirmed = await confirmAll(deps.ledger.notary, dedupe(done.value.pending));
  if (!confirmed.ok) return err(identityError('ledger', confirmed.error.message, confirmed.error));
  return done;
}

const dedupe = (p: readonly PendingConfirm[]): PendingConfirm[] => [
  ...new Map(p.map((x) => [x.ledger_seq, x])).values(),
];

/**
 * One pass of the loop: ledgers every access event that has no entry yet, oldest first, and returns
 * what it did. Safe to call concurrently and repeatedly (a second call finds nothing to do). An
 * error leaves the position where it was; the next call picks up from there.
 */
export async function syncAccessLedger(
  deps: AccessSyncDeps,
  opts: AccessSyncOptions = {},
): Promise<Result<AccessSyncReport, IdentityError>> {
  const batch = opts.batch ?? 25;
  let written = 0;
  let already = 0;
  let caughtUp = true;
  for (;;) {
    const room = opts.max === undefined ? batch : Math.min(batch, opts.max - written);
    if (room <= 0) {
      caughtUp = false;
      break;
    }
    const r = await oneBatch(deps, room);
    if (!r.ok) return r;
    written += r.value.written;
    already += r.value.already;
    if (!r.value.more) break;
  }
  const lag = await accessSyncLagSeconds(deps.pool, clockOf(deps));
  return ok({ written, already, lag_seconds: lag, caught_up: caughtUp });
}

/**
 * The metric: how many seconds the oldest access event without a ledger entry is behind (0 when
 * every one has an entry). It reads the record and the ledger, not the loop's position, so a stuck
 * or dead loop shows as a growing number.
 */
export async function accessSyncLagSeconds(
  db: Executor,
  clock: Clock = systemClock,
): Promise<number> {
  const q = await db.query<{ occurred_at: Date }>(
    `SELECT e.occurred_at
       FROM record.record_event e
      WHERE e.global_seq > (SELECT ledgered_through FROM identity.access_sync WHERE id)
        AND e.type = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM ledger.ledger_entry l
                         WHERE ${ACCESS_ENTRY.replace('entry_type', 'l.entry_type')}
                           AND l.body ->> 'access_event_id' = e.event_id::text)
      ORDER BY e.global_seq LIMIT 1`,
    [[...ACCESS_EVENT_TYPES]],
  );
  const oldest = q.rows[0]?.occurred_at;
  return oldest === undefined ? 0 : Math.max(0, (clock.nowMs() - oldest.getTime()) / 1000);
}

export interface AccessSyncStatus {
  readonly lag_seconds: number;
  readonly slo_seconds: number;
  /** True when an access change has waited longer than the SLO: an alert condition. */
  readonly breached: boolean;
}

export async function accessSyncStatus(
  db: Executor,
  clock: Clock = systemClock,
): Promise<AccessSyncStatus> {
  const lag = await accessSyncLagSeconds(db, clock);
  return {
    lag_seconds: lag,
    slo_seconds: ACCESS_SYNC_SLO_SECONDS,
    breached: lag > ACCESS_SYNC_SLO_SECONDS,
  };
}

export interface AccessSyncLoop {
  /** Runs one pass now (also what the interval does); coalesces with a pass already running. */
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Runs `syncAccessLedger` every `intervalMs` (default 5 s, far inside the 60 s SLO). A failed pass
 * is reported through `onError` and retried at the next tick; one pass at a time.
 */
export function startAccessSyncLoop(
  deps: AccessSyncDeps,
  opts: { intervalMs?: number; onError?: (e: IdentityError) => void } = {},
): AccessSyncLoop {
  let running: Promise<void> | null = null;
  let stopped = false;
  const pass = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      try {
        const r = await syncAccessLedger(deps);
        if (!r.ok) opts.onError?.(r.error);
      } catch (e) {
        opts.onError?.(identityError('database', e instanceof Error ? e.message : String(e)));
      } finally {
        running = null;
      }
    })();
    return running;
  };
  const timer = setInterval(() => {
    if (!stopped) void pass();
  }, opts.intervalMs ?? 5_000);
  timer.unref();
  return {
    runOnce: pass,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
