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
export interface Projection<State = unknown, FeedItem = unknown> {
  /** Checkpoint key, unique across projections. */
  readonly name: string;
  /** Bump when the fold logic changes. A stored checkpoint with another version is refused until `rebuild`. */
  readonly version: number;
  /** Schema-qualified tables this projection owns and `reset` empties. */
  readonly tables: readonly string[];
  apply(tx: Tx, event: RecordEvent): Promise<void>;
  /**
   * Further append-only sources the projection folds besides the record, for example the ledger
   * (`ledgerFeed` in `@aisdlc/ledger`). Each feed has its own position, stored next to the main
   * checkpoint and advanced in the same transaction as the items it folded. Feeds and the record
   * are folded in no fixed relative order (live, a feed may be ahead of the record or behind it;
   * a rebuild folds the record first, then each feed), so with feeds `apply` and `applyFeed` MUST
   * be order-insensitive across sources: the state has to be a function of the SET of folded
   * events and items, not of how they interleaved. The rebuild harness checks exactly that.
   */
  readonly feeds?: readonly ProjectionFeed<FeedItem>[];
  applyFeed?(tx: Tx, feed: string, seq: number, item: FeedItem): Promise<void>;
  /** Empties every table in `tables` (not the checkpoint). */
  reset(tx: Tx): Promise<void>;
  /** The whole state in a deterministic order, for rebuild-equals-live comparisons. */
  snapshot(db: Executor): Promise<State>;
}

/**
 * An append-only source with a dense, ascending integer position (`seq` 1, 2, 3, ...), like the
 * ledger's `ledger_seq`. A hole after the checkpoint is a `ProjectionGapError` (fail closed).
 */
export interface ProjectionFeed<Item = unknown> {
  /** Unique within the projection; the position is stored under `<projection>#<feed>`. */
  readonly name: string;
  /** Items with `seq > after`, ascending, at most `limit`. */
  read(db: Executor, after: number, limit: number): Promise<Array<{ seq: number; item: Item }>>;
  /** The highest `seq` stored, 0 when empty. */
  head(db: Executor): Promise<number>;
}

/** Checkpoint row name of a feed's position. */
export const feedCheckpointName = (projection: string, feed: string): string =>
  `${projection}#${feed}`;

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
  /** Record events folded, plus feed items folded. */
  applied: number;
  last_global_seq: number;
  /** Position of each feed; present only for a projection that has feeds. */
  feeds?: Record<string, number>;
}

interface Checkpoint {
  version: number;
  last_global_seq: number;
}

const DEFAULT_BATCH = 500;

/** Creates the checkpoint row if missing, then locks it. Concurrent runners queue here. */
async function lockCheckpoint(tx: Tx, p: Projection, name = p.name): Promise<Checkpoint> {
  await tx.query(
    `INSERT INTO record.projection_checkpoint (name, version, last_global_seq)
     VALUES ($1, $2, 0) ON CONFLICT (name) DO NOTHING`,
    [name, p.version],
  );
  const r = await tx.query<{ version: number; last_global_seq: string }>(
    `SELECT version, last_global_seq::text AS last_global_seq
       FROM record.projection_checkpoint WHERE name = $1 FOR UPDATE`,
    [name],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`checkpoint row for ${name} vanished`);
  return { version: row.version, last_global_seq: Number(row.last_global_seq) };
}

async function setCheckpoint(tx: Tx, p: Projection, last: number, name = p.name): Promise<void> {
  await tx.query(
    `UPDATE record.projection_checkpoint
        SET version = $2, last_global_seq = $3::bigint, updated_at = now() WHERE name = $1`,
    [name, p.version, String(last)],
  );
}

/** How many positions in [from, to) a deletion purged (0 before migration 0005). */
async function purgedBetween(tx: Tx, from: number, to: number): Promise<number> {
  if (to <= from) return 0;
  const t = await tx.query<{ t: string | null }>(
    `SELECT to_regclass('record.purged_event')::text AS t`,
  );
  if (!t.rows[0]?.t) return 0;
  const q = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM record.purged_event WHERE global_seq >= $1 AND global_seq < $2`,
    [String(from), String(to)],
  );
  return Number(q.rows[0]?.n ?? 0);
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
    const g = Number(row.global_seq);
    // A deletion's purge (docs/specs/deletion.md §2) leaves positions that `record.purged_event` names: those are
    // not a hole. Anything else is.
    if (g !== expected && (await purgedBetween(tx, expected, g)) !== g - expected) {
      throw new ProjectionGapError(
        `${p.name}: expected global_seq ${expected}, found ${row.global_seq}`,
      );
    }
    expected = g;
    await p.apply(tx, toRecordEvent(row));
  }
  return { applied: r.rows.length, last_global_seq: expected };
}

/** Folds up to `batch` items of one feed after `from`. Returns how many and the new position. */
async function foldFeedBatch(
  tx: Tx,
  p: Projection,
  feed: ProjectionFeed,
  from: number,
  batch: number,
): Promise<{ applied: number; position: number }> {
  if (!p.applyFeed) throw new Error(`${p.name}: has feeds but no applyFeed`);
  const items = await feed.read(tx, from, batch);
  let expected = from;
  for (const { seq, item } of items) {
    expected += 1;
    if (seq !== expected) {
      throw new ProjectionGapError(
        `${p.name}#${feed.name}: expected seq ${expected}, found ${seq}`,
      );
    }
    await p.applyFeed(tx, feed.name, seq, item);
  }
  return { applied: items.length, position: expected };
}

const feedsOf = (p: Projection): readonly ProjectionFeed[] => p.feeds ?? [];

/** Locks each feed's checkpoint row (after the main one) and returns the positions. */
async function lockFeeds(tx: Tx, p: Projection): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const f of feedsOf(p)) {
    const cp = await lockCheckpoint(tx, p, feedCheckpointName(p.name, f.name));
    if (cp.version !== p.version) {
      throw new Error(`${p.name}#${f.name}: feed checkpoint version ${cp.version} != ${p.version}`);
    }
    out[f.name] = cp.last_global_seq;
  }
  return out;
}

/**
 * Folds every event after the projection's checkpoint, in global (commit) order, one transaction
 * per batch (and, for a projection with feeds, up to one batch of each feed in the same
 * transaction). A batch is applied and checkpointed atomically: if `apply` throws, the batch is
 * rolled back and the error propagates. Concurrent runners of one projection serialise on its
 * checkpoint row. Returns `ProjectionVersionMismatch` (fail closed) if the stored version is not
 * the code's.
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
      const positions = await lockFeeds(tx, projection);
      const stats = await foldBatch(tx, projection, cp.last_global_seq, batch);
      if (stats.applied > 0) await setCheckpoint(tx, projection, stats.last_global_seq);
      let total = stats.applied;
      for (const f of feedsOf(projection)) {
        const r = await foldFeedBatch(tx, projection, f, positions[f.name] ?? 0, batch);
        if (r.applied > 0) {
          await setCheckpoint(
            tx,
            projection,
            r.position,
            feedCheckpointName(projection.name, f.name),
          );
        }
        positions[f.name] = r.position;
        total += r.applied;
      }
      return ok({
        applied: total,
        last_global_seq: stats.last_global_seq,
        ...(feedsOf(projection).length > 0 ? { feeds: positions } : {}),
      } satisfies RunStats);
    });
    if (!step.ok) return step;
    applied += step.value.applied;
    if (step.value.applied === 0) {
      return ok({ ...step.value, applied });
    }
  }
}

/**
 * Drops the projection's state and refolds the whole record, then every feed, in ONE transaction:
 * `reset`, then every event in global order, then every feed item in order, then the checkpoints at
 * the new heads (and the code's version). Readers of the projection tables see the old state until
 * COMMIT, then the new one; a failure leaves the old state untouched. The checkpoint rows stay
 * locked throughout, so live runners wait.
 */
export async function rebuild(
  pool: pg.Pool,
  projection: Projection,
  opts: RunOptions = {},
): Promise<RunStats> {
  const batch = opts.batchSize ?? DEFAULT_BATCH;
  return withTransaction(pool, async (tx) => {
    await lockCheckpoint(tx, projection);
    for (const f of feedsOf(projection)) {
      await lockCheckpoint(tx, projection, feedCheckpointName(projection.name, f.name));
    }
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
    const positions: Record<string, number> = {};
    for (const f of feedsOf(projection)) {
      let pos = 0;
      for (;;) {
        const r = await foldFeedBatch(tx, projection, f, pos, batch);
        applied += r.applied;
        pos = r.position;
        if (r.applied === 0) break;
      }
      await setCheckpoint(tx, projection, pos, feedCheckpointName(projection.name, f.name));
      positions[f.name] = pos;
    }
    return {
      applied,
      last_global_seq: last,
      ...(feedsOf(projection).length > 0 ? { feeds: positions } : {}),
    };
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
