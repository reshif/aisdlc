import { canonicalJson, err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
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
}

const toRow = (r: OutboxDbRow): OutboxRow => ({ ...r, id: Number(r.id) });

/**
 * Locks up to `limit` undispatched rows for `destination` with FOR UPDATE SKIP LOCKED, oldest
 * first. The locks last until the transaction ends, so two claimers never hold the same row, and a
 * claimer that dies releases its rows for redelivery (at least once). Order across concurrent
 * claimers is not guaranteed.
 */
export async function claimOutbox(
  tx: Tx,
  destination: string,
  limit: number,
): Promise<OutboxRow[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('claimOutbox: limit must be >= 1');
  const r = await tx.query<OutboxDbRow>(
    `SELECT id::text AS id, destination, payload, idempotency_key, created_at, attempts, last_error
       FROM record.outbox
      WHERE destination = $1 AND dispatched_at IS NULL
      ORDER BY id
      LIMIT $2
        FOR UPDATE SKIP LOCKED`,
    [destination, limit],
  );
  return r.rows.map(toRow);
}

/** Marks claimed rows dispatched. Commit the transaction only after the delivery succeeded. */
export async function markDispatched(tx: Tx, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.query(
    `UPDATE record.outbox
        SET dispatched_at = now(), attempts = attempts + 1, last_error = NULL
      WHERE id = ANY($1::bigint[]) AND dispatched_at IS NULL`,
    [ids.map(String)],
  );
}

/** Records a failed delivery attempt; the row stays pending and is claimed again later. */
export async function markFailed(tx: Tx, id: number, error: string): Promise<void> {
  await tx.query(
    `UPDATE record.outbox SET attempts = attempts + 1, last_error = $2
      WHERE id = $1 AND dispatched_at IS NULL`,
    [String(id), error.slice(0, 2000)],
  );
}

export interface DispatchOutcome {
  dispatched: number;
  failed: number;
}

/**
 * Claim, deliver, mark, commit in one transaction. `handler` is called once per claimed row; a
 * throw marks that row failed and the others continue. If the process dies after a handler
 * succeeded but before COMMIT, the row is delivered again, so handlers must dedupe on
 * `idempotency_key`.
 */
export async function dispatchOutbox(
  pool: pg.Pool,
  destination: string,
  limit: number,
  handler: (row: OutboxRow) => Promise<void>,
): Promise<DispatchOutcome> {
  return withTransaction(pool, async (tx) => {
    const rows = await claimOutbox(tx, destination, limit);
    const done: number[] = [];
    let failed = 0;
    for (const row of rows) {
      try {
        await handler(row);
        done.push(row.id);
      } catch (e) {
        failed += 1;
        await markFailed(tx, row.id, e instanceof Error ? e.message : String(e));
      }
    }
    await markDispatched(tx, done);
    return { dispatched: done.length, failed };
  });
}

/** Number of rows still waiting for `destination`. */
export async function pendingOutboxCount(db: Executor, destination: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM record.outbox WHERE destination = $1 AND dispatched_at IS NULL',
    [destination],
  );
  return Number(r.rows[0]?.n ?? 0);
}
