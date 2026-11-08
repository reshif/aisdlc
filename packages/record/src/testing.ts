import { expect } from 'vitest';
import type pg from 'pg';
import {
  feedCheckpointName,
  readCheckpoint,
  rebuild,
  runProjection,
  type Projection,
  type RunOptions,
} from './projection.js';
import type { Executor } from './types.js';

/**
 * Shared assertion for every projection (PLAN M2.5): the state built incrementally ("live") equals
 * the state rebuilt from scratch, and the rebuild is repeatable.
 *
 * Call it after the test has appended events, ideally interleaved with `runProjection` calls so
 * the live state really was folded in several steps. It catches up the live projection, takes
 * `snapshotFn`, rebuilds, takes it again and compares; then it rebuilds once more to prove the fold
 * is deterministic, and checks the checkpoint sits at the record's head.
 *
 * `snapshotFn` defaults to `projection.snapshot`. Returns the rebuilt snapshot.
 */
export async function expectRebuildEqualsLive<State, FeedItem = unknown>(
  pool: pg.Pool,
  projection: Projection<State, FeedItem>,
  snapshotFn: (db: Executor) => Promise<State> = (db) => projection.snapshot(db),
  opts: RunOptions = {},
): Promise<State> {
  const caught = await runProjection(pool, projection, opts);
  expect(caught.ok, 'live projection catches up').toBe(true);
  const live = await snapshotFn(pool);

  const first = await rebuild(pool, projection, opts);
  const rebuilt = await snapshotFn(pool);
  expect(rebuilt, `${projection.name}: rebuilt state equals live state`).toEqual(live);

  const head = await pool.query<{ n: string }>(
    'SELECT coalesce(max(global_seq), 0)::text AS n FROM record.record_event',
  );
  expect(first.last_global_seq, 'rebuild reaches the head of the record').toBe(
    Number(head.rows[0]?.n),
  );
  const cp = await readCheckpoint(pool, projection.name);
  expect(cp).toEqual({ version: projection.version, last_global_seq: first.last_global_seq });

  for (const f of projection.feeds ?? []) {
    const fcp = await readCheckpoint(pool, feedCheckpointName(projection.name, f.name));
    expect(fcp, `${projection.name}#${f.name}: feed checkpoint sits at the feed head`).toEqual({
      version: projection.version,
      last_global_seq: await f.head(pool),
    });
    expect(first.feeds?.[f.name]).toBe(await f.head(pool));
  }

  await rebuild(pool, projection, opts);
  expect(await snapshotFn(pool), `${projection.name}: rebuild is repeatable`).toEqual(rebuilt);
  return rebuilt;
}
