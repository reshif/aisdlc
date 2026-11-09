import {
  canonicalJson,
  err,
  ok,
  systemClock,
  taggedError,
  type Clock,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';
import { withTransaction } from '@aisdlc/db';
import type pg from 'pg';
import type { Executor, JsonObject, Tx } from './types.js';

export interface OutboxMessage {
  destination: string;
  payload: JsonObject;
  /** Unique across the whole outbox. Consumers dedupe on it: delivery is at least once. */
  idempotency_key: string;
}

export interface OutboxRow {
  id: number;
  destination: string;
  payload: JsonObject;
  idempotency_key: string;
  created_at: Date;
  attempts: number;
  last_error: string | null;
  /** Not claimed before this instant (backoff after a failure); `null`: due now. */
  next_attempt_at: Date | null;
  /** Set when the row is dead-lettered: it is never claimed again. */
  dead_at: Date | null;
}

/**
 * How a failing message is retried (PLAN M5.4): the n-th failure schedules the next attempt
 * `min(maxDelayMs, baseDelayMs * 2^(n-1))` later, and the `maxAttempts`-th failure dead-letters it.
 */
export interface OutboxRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}
export const DEFAULT_OUTBOX_RETRY: OutboxRetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
};

/**
 * A handler throws this when retrying cannot help (the destination rejected the message as
 * invalid): the row is dead-lettered at once instead of after `maxAttempts`.
 */
export class PermanentDeliveryError extends Error {
  override readonly name = 'PermanentDeliveryError';
}

/**
 * Thrown by a handler that must not carry the message out NOW and has done nothing (a kill switch
 * says no, a control holds the scope): the row is claimed again after `delayMs` and neither counts an
 * attempt nor can it be dead-lettered by waiting. A failure is not the same thing: it counts, and ends
 * in the dead letter queue.
 */
export class DeferDelivery extends Error {
  override readonly name = 'DeferDelivery';
  constructor(
    message: string,
    readonly delayMs: number = 30_000,
  ) {
    super(message);
  }
}

export const OutboxKeyMismatch = taggedError('OutboxKeyMismatch');
export type OutboxKeyMismatch = TaggedError<'OutboxKeyMismatch', { idempotency_key: string }>;

/**
 * Writes outbox rows in the caller's transaction (the one that appends the event). A key that is
 * already present with the same destination and payload is a no-op; the same key with something
 * different is an `OutboxKeyMismatch` and nothing is changed by that message.
 */
export async function enqueueOutbox(
  tx: Tx,
  messages: readonly OutboxMessage[],
): Promise<Result<{ inserted: number }, OutboxKeyMismatch>> {
  let inserted = 0;
  for (const m of messages) {
    const r = await tx.query(
      `INSERT INTO record.outbox (destination, payload, idempotency_key)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [m.destination, JSON.stringify(m.payload), m.idempotency_key],
    );
    if (r.rowCount === 1) {
      inserted += 1;
      continue;
    }
    const prior = await tx.query<{ destination: string; payload: JsonObject }>(
      'SELECT destination, payload FROM record.outbox WHERE idempotency_key = $1',
      [m.idempotency_key],
    );
    const row = prior.rows[0];
    if (
      !row ||
      row.destination !== m.destination ||
      canonicalJson(row.payload) !== canonicalJson(m.payload)
    ) {
      return err(OutboxKeyMismatch({ idempotency_key: m.idempotency_key }));
    }
  }
  return ok({ inserted });
}

interface OutboxDbRow {
  id: string;
  destination: string;
  payload: JsonObject;
  idempotency_key: string;
  created_at: Date;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | null;
  dead_at: Date | null;
}

const OUTBOX_COLUMNS = `id::text AS id, destination, payload, idempotency_key, created_at, attempts,
       last_error, next_attempt_at, dead_at`;

const toRow = (r: OutboxDbRow): OutboxRow => ({ ...r, id: Number(r.id) });

/**
 * Locks up to `limit` rows for `destination` that are undispatched, not dead and due (their
 * `next_attempt_at` has passed) with FOR UPDATE SKIP LOCKED, oldest first (by the table's numeric
 * `id`: the select list aliases `id` as text, so `ORDER BY id` alone would sort as text). A row waiting out its
 * backoff, or dead, is not returned, so one failing message never holds up the ones behind it. The
 * locks last until the transaction ends, so two claimers never hold the same row, and a claimer
 * that dies releases its rows for redelivery (at least once). Order across concurrent claimers is
 * not guaranteed.
 */
export async function claimOutbox(
  tx: Tx,
  destination: string,
  limit: number,
  opts: { now?: Date } = {},
): Promise<OutboxRow[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('claimOutbox: limit must be >= 1');
  const r = await tx.query<OutboxDbRow>(
    `SELECT ${OUTBOX_COLUMNS}
       FROM record.outbox
      WHERE destination = $1 AND dispatched_at IS NULL AND dead_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= $3::timestamptz)
      ORDER BY outbox.id
      LIMIT $2
        FOR UPDATE SKIP LOCKED`,
    [destination, limit, (opts.now ?? new Date()).toISOString()],
  );
  return r.rows.map(toRow);
}

/** Marks claimed rows dispatched. Commit the transaction only after the delivery succeeded. */
export async function markDispatched(tx: Tx, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.query(
    `UPDATE record.outbox
        SET dispatched_at = now(), attempts = attempts + 1, last_error = NULL
      WHERE id = ANY($1::bigint[]) AND dispatched_at IS NULL AND dead_at IS NULL`,
    [ids.map(String)],
  );
}

export interface FailureOutcome {
  attempts: number;
  /** The row is now dead-lettered. */
  dead: boolean;
  /** When it will be claimed again; the failure time if it is dead. */
  next_attempt_at: Date;
}

/**
 * Records a failed delivery attempt. The row is claimed again after an exponential backoff, or, on
 * the `policy.maxAttempts`-th failure (or when `permanent`), dead-lettered. `null`: the row is not
 * pending any more (already dispatched or dead).
 */
export async function markFailed(
  tx: Tx,
  id: number,
  error: string,
  opts: { policy?: OutboxRetryPolicy; now?: Date; permanent?: boolean } = {},
): Promise<FailureOutcome | null> {
  const p = opts.policy ?? DEFAULT_OUTBOX_RETRY;
  const now = (opts.now ?? new Date()).toISOString();
  const r = await tx.query<{ attempts: number; dead: boolean; next_attempt_at: Date }>(
    `UPDATE record.outbox
        SET attempts = attempts + 1,
            last_error = $2,
            dead_at = CASE WHEN $3::boolean OR attempts + 1 >= $4::int THEN $5::timestamptz END,
            next_attempt_at = CASE
              WHEN $3::boolean OR attempts + 1 >= $4::int THEN $5::timestamptz
              ELSE $5::timestamptz
                   + LEAST($7::double precision, $6::double precision * power(2, attempts))
                     * interval '1 millisecond'
            END
      WHERE id = $1 AND dispatched_at IS NULL AND dead_at IS NULL
      RETURNING attempts, dead_at IS NOT NULL AS dead, next_attempt_at`,
    [
      String(id),
      error.slice(0, 2000),
      opts.permanent === true,
      p.maxAttempts,
      now,
      p.baseDelayMs,
      p.maxDelayMs,
    ],
  );
  return r.rows[0] ?? null;
}

export interface DispatchOutcome {
  dispatched: number;
  /** Attempts that failed and will be retried later. */
  failed: number;
  /** Messages dead-lettered by this call. */
  dead: number;
  /** Messages the handler deferred (`DeferDelivery`): untouched, claimed again later. */
  deferred?: number;
}

export interface DispatchOptions {
  readonly policy?: OutboxRetryPolicy;
  readonly clock?: Clock;
}

/**
 * Claim, deliver, mark, commit in one transaction. `handler` is called once per claimed row; a
 * throw schedules a retry with backoff for that row (or dead-letters it: after `maxAttempts`
 * failures, or at once for a `PermanentDeliveryError`) and the others continue. If the process dies
 * after a handler succeeded but before COMMIT, the row is delivered again, so handlers must dedupe
 * on `idempotency_key`.
 */
export async function dispatchOutbox(
  pool: pg.Pool,
  destination: string,
  limit: number,
  handler: (row: OutboxRow) => Promise<void>,
  opts: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const clock = opts.clock ?? systemClock;
  return withTransaction(pool, async (tx) => {
    const rows = await claimOutbox(tx, destination, limit, { now: clock.now() });
    const done: number[] = [];
    let failed = 0;
    let dead = 0;
    let deferred = 0;
    for (const row of rows) {
      try {
        await handler(row);
        done.push(row.id);
      } catch (e) {
        if (e instanceof DeferDelivery) {
          await tx.query(
            `UPDATE record.outbox
                SET next_attempt_at = $2::timestamptz + $3::double precision * interval '1 millisecond',
                    last_error = $4
              WHERE id = $1 AND dispatched_at IS NULL AND dead_at IS NULL`,
            [
              String(row.id),
              clock.now().toISOString(),
              e.delayMs,
              `deferred: ${e.message}`.slice(0, 2000),
            ],
          );
          deferred += 1;
          continue;
        }
        const out = await markFailed(tx, row.id, e instanceof Error ? e.message : String(e), {
          ...(opts.policy ? { policy: opts.policy } : {}),
          now: clock.now(),
          permanent: e instanceof PermanentDeliveryError,
        });
        if (out?.dead) dead += 1;
        else failed += 1;
      }
    }
    await markDispatched(tx, done);
    return { dispatched: done.length, failed, dead, ...(deferred > 0 ? { deferred } : {}) };
  });
}

/** Number of rows still waiting for `destination` (not dispatched, not dead). */
export async function pendingOutboxCount(db: Executor, destination: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM record.outbox
      WHERE destination = $1 AND dispatched_at IS NULL AND dead_at IS NULL`,
    [destination],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Dead-lettered rows, per destination (all destinations when `destination` is absent). */
export async function deadOutboxCount(
  db: Executor,
  destination?: string,
): Promise<Array<{ destination: string; dead: number; oldest_dead_at: Date }>> {
  const r = await db.query<{ destination: string; dead: string; oldest_dead_at: Date }>(
    `SELECT destination, count(*)::text AS dead, min(dead_at) AS oldest_dead_at
       FROM record.outbox
      WHERE dead_at IS NOT NULL AND ($1::text IS NULL OR destination = $1)
      GROUP BY destination ORDER BY destination`,
    [destination ?? null],
  );
  return r.rows.map((x) => ({ ...x, dead: Number(x.dead) }));
}

/** The dead-lettered rows themselves, oldest first, for an operator to read. */
export async function listDeadOutbox(
  db: Executor,
  opts: { destination?: string; limit?: number } = {},
): Promise<OutboxRow[]> {
  const r = await db.query<OutboxDbRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM record.outbox
      WHERE dead_at IS NOT NULL AND ($1::text IS NULL OR destination = $1)
      ORDER BY outbox.id LIMIT $2`,
    [opts.destination ?? null, opts.limit ?? 100],
  );
  return r.rows.map(toRow);
}

/**
 * An operator's decision to try dead rows again: they become pending with a fresh attempt count.
 * Nothing requeues a row by itself.
 */
export async function requeueDeadOutbox(tx: Tx, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await tx.query(
    `UPDATE record.outbox
        SET dead_at = NULL, attempts = 0, next_attempt_at = NULL
      WHERE id = ANY($1::bigint[]) AND dead_at IS NOT NULL AND dispatched_at IS NULL`,
    [ids.map(String)],
  );
  return r.rowCount ?? 0;
}
