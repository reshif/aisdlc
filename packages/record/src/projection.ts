import type { RecordEvent } from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import type pg from 'pg';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from './rows.js';
import type { Executor, Tx } from './types.js';

/**
 * A read model folded from the record (PLAN principle 2): everything it holds must be derivable
 * from `record.record_event` alone, so dropping it and refolding gives the same state.
 *
 * `apply` and `reset` run inside the runner's transaction, together with the checkpoint update,
 * so an event is applied exactly once. They must be deterministic functions of the event: no
 * clock, randomness or network.
 */
export interface Projection<State = unknown> {
  /** Checkpoint key, unique across projections. */
  readonly name: string;
  /** Bump when the fold logic changes. A stored checkpoint with another version is refused until `rebuild`. */
  readonly version: number;
  /** Schema-qualified tables this projection owns and `reset` empties. */
  readonly tables: readonly string[];
  apply(tx: Tx, event: RecordEvent): Promise<void>;
  /** Empties every table in `tables` (not the checkpoint). */
  reset(tx: Tx): Promise<void>;
  /** The whole state in a deterministic order, for rebuild-equals-live comparisons. */
  snapshot(db: Executor): Promise<State>;
}

export const ProjectionVersionMismatch = taggedError('ProjectionVersionMismatch');
export type ProjectionVersionMismatch = TaggedError<
  'ProjectionVersionMismatch',
  { projection: string; stored_version: number; code_version: number }
>;

/** The record has a hole in global_seq right after the checkpoint: refuse to fold past it. */
export class ProjectionGapError extends Error {
  override readonly name = 'ProjectionGapError';
}

export interface RunOptions {
  /** Events folded per transaction (default 500). */
  batchSize?: number;
}

export interface RunStats {
  applied: number;
  last_global_seq: number;
}

interface Checkpoint {
  version: number;
  last_global_seq: number;
}

const DEFAULT_BATCH = 500;

/** Creates the checkpoint row if missing, then locks it. Concurrent runners queue here. */
async function lockCheckpoint(tx: Tx, p: Projection): Promise<Checkpoint> {
  await tx.query(
    `INSERT INTO record.projection_checkpoint (name, version, last_global_seq)
     VALUES ($1, $2, 0) ON CONFLICT (name) DO NOTHING`,
    [p.name, p.version],
  );
  const r = await tx.query<{ version: number; last_global_seq: string }>(
    `SELECT version, last_global_seq::text AS last_global_seq
       FROM record.projection_checkpoint WHERE name = $1 FOR UPDATE`,
    [p.name],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`checkpoint row for ${p.name} vanished`);
  return { version: row.version, last_global_seq: Number(row.last_global_seq) };
}

async function setCheckpoint(tx: Tx, p: Projection, last: number): Promise<void> {
  await tx.query(
    `UPDATE record.projection_checkpoint
        SET version = $2, last_global_seq = $3::bigint, updated_at = now() WHERE name = $1`,
    [p.name, p.version, String(last)],
  );
}

/** Folds up to `batch` events after `from`, in global order. Returns how many and the new position. */
async function foldBatch(tx: Tx, p: Projection, from: number, batch: number): Promise<RunStats> {
  const r = await tx.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event
      WHERE global_seq > $1::bigint ORDER BY record_event.global_seq LIMIT $2`,
    [String(from), batch],
  );
  let expected = from;
  for (const row of r.rows) {
    expected += 1;
    if (Number(row.global_seq) !== expected) {
      throw new ProjectionGapError(
        `${p.name}: expected global_seq ${expected}, found ${row.global_seq}`,
      );
    }
    await p.apply(tx, toRecordEvent(row));
  }
  return { applied: r.rows.length, last_global_seq: expected };
}

/**
 * Folds every event after the projection's checkpoint, in global (commit) order, one transaction
 * per batch. A batch is applied and checkpointed atomically: if `apply` throws, the batch is rolled
 * back and the error propagates. Concurrent runners of one projection serialise on its checkpoint
 * row. Returns `ProjectionVersionMismatch` (fail closed) if the stored version is not the code's.
 */
export async function runProjection(
  pool: pg.Pool,
  projection: Projection,
  opts: RunOptions = {},
): Promise<Result<RunStats, ProjectionVersionMismatch>> {
  const batch = opts.batchSize ?? DEFAULT_BATCH;
  let applied = 0;
  for (;;) {
    const step = await withTransaction(pool, async (tx) => {
      const cp = await lockCheckpoint(tx, projection);
      if (cp.version !== projection.version) {
        return err(
          ProjectionVersionMismatch({
            projection: projection.name,
            stored_version: cp.version,
            code_version: projection.version,
          }),
        );
      }
      const stats = await foldBatch(tx, projection, cp.last_global_seq, batch);
      if (stats.applied > 0) await setCheckpoint(tx, projection, stats.last_global_seq);
      return ok(stats);
    });
    if (!step.ok) return step;
    applied += step.value.applied;
    if (step.value.applied === 0) {
      return ok({ applied, last_global_seq: step.value.last_global_seq });
    }
  }
}

/**
 * Drops the projection's state and refolds the whole record in ONE transaction: `reset`, then every
 * event in global order, then the checkpoint at the new head (and the code's version). Readers of
 * the projection tables see the old state until COMMIT, then the new one; a failure leaves the old
 * state untouched. The checkpoint row stays locked throughout, so live runners wait.
 */
export async function rebuild(
  pool: pg.Pool,
  projection: Projection,
  opts: RunOptions = {},
): Promise<RunStats> {
  const batch = opts.batchSize ?? DEFAULT_BATCH;
  return withTransaction(pool, async (tx) => {
    await lockCheckpoint(tx, projection);
    await projection.reset(tx);
    let applied = 0;
    let last = 0;
    for (;;) {
      const stats = await foldBatch(tx, projection, last, batch);
      applied += stats.applied;
      last = stats.last_global_seq;
      if (stats.applied === 0) break;
    }
    await setCheckpoint(tx, projection, last);
    return { applied, last_global_seq: last };
  });
}

/** The stored checkpoint, or null if the projection has never run. */
export async function readCheckpoint(db: Executor, name: string): Promise<Checkpoint | null> {
  const r = await db.query<{ version: number; last_global_seq: string }>(
    'SELECT version, last_global_seq::text AS last_global_seq FROM record.projection_checkpoint WHERE name = $1',
    [name],
  );
  const row = r.rows[0];
  return row ? { version: row.version, last_global_seq: Number(row.last_global_seq) } : null;
}
