import { createPool } from '@aisdlc/db';
import { withTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import type pg from 'pg';
import { appendEvents, migrateRecord, type NewEvent } from '../src/index.js';

/** A fresh database with the record migrations applied. */
export async function withRecordDb<T>(fn: (t: TestDatabase) => Promise<T>): Promise<T> {
  return withTestDatabase(async (t) => {
    await migrateRecord(t.pool);
    return fn(t);
  });
}

export const ev = (
  type = 'item.created',
  body: Record<string, unknown> = {},
  key?: string,
): NewEvent => ({
  type,
  body,
  actor: 'system:test',
  ...(key === undefined ? {} : { idempotency_key: key }),
});

/** Append in its own committed transaction; throws on Err. */
export async function appendCommitted(
  pool: pg.Pool,
  stream: string,
  expectedSeq: number,
  events: NewEvent[],
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await appendEvents(client, stream, expectedSeq, events);
    if (!r.ok) {
      await client.query('ROLLBACK');
      throw new Error(`append refused: ${JSON.stringify(r.error)}`);
    }
    await client.query('COMMIT');
    return r.value.events;
  } finally {
    client.release();
  }
}

/** A pool with room for the concurrent connections a test wants. */
export function bigPool(t: TestDatabase, max = 12): pg.Pool {
  return createPool(t.url, max);
}

export async function waitUntilBlocked(
  pool: pg.Pool,
  pid: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
      [pid],
    );
    if (r.rowCount === 1) return;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked on a lock`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Resolves to 'pending' if `p` has not settled within `ms`. */
export async function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}

export const disableTriggers = (pool: pg.Pool, table = 'record.record_event') =>
  pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
