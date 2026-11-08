import pg from 'pg';
import { computeEventHash, GENESIS_HASH } from './hash.js';
import { EVENT_COLUMNS, type EventRow } from './rows.js';
import type { Executor } from './types.js';

export type ChainBreakKind =
  /** A stream's seq skips or does not start at 1 (row deleted or inserted out of band). */
  | 'seq_gap'
  /** A row's prev_hash is not the hash of its predecessor (genesis for seq 1). */
  | 'prev_hash_mismatch'
  /** A row's stored hash is not the hash of its contents (row edited). */
  | 'hash_mismatch'
  /** global_seq skips or repeats (verifyAll). */
  | 'global_seq_gap'
  /** The global counter is not the highest global_seq: rows missing at the tail (verifyAll). */
  | 'global_counter_mismatch';

export interface ChainBreak {
  kind: ChainBreakKind;
  /** Null for global breaks that name no stream. */
  stream: string | null;
  seq: number | null;
  global_seq: number | null;
  expected: string | number;
  actual: string | number | null;
}

export type Verification = { valid: true; events: number } | { valid: false; break: ChainBreak };

const BATCH = 1000;

interface Link {
  seq: number;
  hash: string;
}

/** Checks one row against its predecessor in the stream. Returns the first fault, if any. */
function checkRow(row: EventRow, last: Link): ChainBreak | null {
  const seq = Number(row.seq);
  const global_seq = Number(row.global_seq);
  const at = { stream: row.stream, seq, global_seq };
  if (seq !== last.seq + 1) {
    return { kind: 'seq_gap', ...at, expected: last.seq + 1, actual: seq };
  }
  if (row.prev_hash !== last.hash) {
    return { kind: 'prev_hash_mismatch', ...at, expected: last.hash, actual: row.prev_hash };
  }
  const recomputed = computeEventHash({
    stream: row.stream,
    seq,
    event_id: row.event_id,
    type: row.type,
    body: row.body,
    actor: row.actor,
    occurred_at: row.occurred_at.toISOString(),
    prev_hash: row.prev_hash,
  });
  if (recomputed !== row.hash) {
    return { kind: 'hash_mismatch', ...at, expected: recomputed, actual: row.hash };
  }
  return null;
}

/** On a pool, runs `fn` in one REPEATABLE READ read-only transaction so it sees one snapshot. */
async function inSnapshot<T>(db: Executor, fn: (ex: Executor) => Promise<T>): Promise<T> {
  if (!(db instanceof pg.Pool)) return fn(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** Recomputes every hash and link of one stream and returns the first break, by seq. */
export async function verifyChain(db: Executor, stream: string): Promise<Verification> {
  return inSnapshot(db, async (ex) => {
    let last: Link = { seq: 0, hash: GENESIS_HASH };
    let count = 0;
    for (;;) {
      const r = await ex.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM record.record_event
          WHERE stream = $1 AND seq > $2::bigint ORDER BY record_event.seq LIMIT ${BATCH}`,
        [stream, String(last.seq)],
      );
      for (const row of r.rows) {
        const broken = checkRow(row, last);
        if (broken) return { valid: false, break: broken } as const;
        last = { seq: Number(row.seq), hash: row.hash };
        count += 1;
      }
      if (r.rows.length < BATCH) return { valid: true, events: count } as const;
    }
  });
}

/**
 * Verifies every stream and the global order in one pass over `global_seq`: each stream's chain,
 * global_seq contiguous from 1, and `global_counter` equal to the highest global_seq (which catches
 * deleted tail events that no per-stream chain can see). Returns the first break in global order.
 */
export async function verifyAll(db: Executor): Promise<Verification> {
  return inSnapshot(db, async (ex) => {
    const heads = new Map<string, Link>();
    let lastGlobal = 0;
    for (;;) {
      const r = await ex.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM record.record_event
          WHERE global_seq > $1::bigint ORDER BY record_event.global_seq LIMIT ${BATCH}`,
        [String(lastGlobal)],
      );
      for (const row of r.rows) {
        const g = Number(row.global_seq);
        if (g !== lastGlobal + 1) {
          return {
            valid: false,
            break: {
              kind: 'global_seq_gap',
              stream: row.stream,
              seq: Number(row.seq),
              global_seq: g,
              expected: lastGlobal + 1,
              actual: g,
            },
          } as const;
        }
        const broken = checkRow(row, heads.get(row.stream) ?? { seq: 0, hash: GENESIS_HASH });
        if (broken) return { valid: false, break: broken } as const;
        heads.set(row.stream, { seq: Number(row.seq), hash: row.hash });
        lastGlobal = g;
      }
      if (r.rows.length < BATCH) break;
    }
    const c = await ex.query<{ last_seq: string }>(
      'SELECT last_seq::text AS last_seq FROM record.global_counter WHERE id',
    );
    const counter = Number(c.rows[0]?.last_seq);
    if (counter !== lastGlobal) {
      return {
        valid: false,
        break: {
          kind: 'global_counter_mismatch',
          stream: null,
          seq: null,
          global_seq: lastGlobal,
          expected: lastGlobal,
          actual: Number.isNaN(counter) ? null : counter,
        },
      } as const;
    }
    return { valid: true, events: lastGlobal } as const;
  });
}
