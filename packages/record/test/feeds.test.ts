import { describe, expect, it } from 'vitest';
import {
  ProjectionGapError,
  feedCheckpointName,
  readCheckpoint,
  rebuild,
  runProjection,
  type Executor,
  type Projection,
  type ProjectionFeed,
} from '../src/index.js';
import { expectRebuildEqualsLive } from '../src/testing.js';
import { appendCommitted, ev, withRecordDb } from './helpers.js';

// A projection with a second source: an append-only table `feed_src(seq, v)` next to the record.
const feed: ProjectionFeed<string> = {
  name: 'src',
  async read(db: Executor, after: number, limit: number) {
    const r = await db.query<{ seq: string; v: string }>(
      'SELECT seq::text, v FROM public.feed_src WHERE seq > $1 ORDER BY seq LIMIT $2',
      [after, limit],
    );
    return r.rows.map((x) => ({ seq: Number(x.seq), item: x.v }));
  },
  async head(db: Executor) {
    const r = await db.query<{ n: string }>(
      'SELECT coalesce(max(seq), 0)::text AS n FROM public.feed_src',
    );
    return Number(r.rows[0]?.n);
  },
};

// State: the set of tokens seen from either source (order-insensitive, as feeds require).
const tokens: Projection<string[], string> = {
  name: 'tokens',
  version: 1,
  tables: ['public.feed_tokens'],
  feeds: [feed],
  async apply(tx, e) {
    await tx.query('INSERT INTO public.feed_tokens VALUES ($1) ON CONFLICT DO NOTHING', [
      `ev:${e.type}`,
    ]);
  },
  async applyFeed(tx, _f, _seq, item) {
    await tx.query('INSERT INTO public.feed_tokens VALUES ($1) ON CONFLICT DO NOTHING', [
      `feed:${item}`,
    ]);
  },
  async reset(tx) {
    await tx.query('DELETE FROM public.feed_tokens');
  },
  async snapshot(db) {
    const r = await db.query<{ t: string }>('SELECT t FROM public.feed_tokens ORDER BY t');
    return r.rows.map((x) => x.t);
  },
};

const setup = (pool: { query: (q: string) => Promise<unknown> }) =>
  pool.query(`CREATE TABLE public.feed_src (seq bigint PRIMARY KEY, v text NOT NULL);
              CREATE TABLE public.feed_tokens (t text PRIMARY KEY)`);
const addSrc = (pool: { query: (q: string, v: unknown[]) => Promise<unknown> }, seq: number) =>
  pool.query('INSERT INTO public.feed_src VALUES ($1, $2)', [seq, `v${seq}`]);

describe('projection feeds', () => {
  it('folds the record and every feed, each with its own checkpoint', async () => {
    await withRecordDb(async (t) => {
      await setup(t.pool);
      await appendCommitted(t.pool, 'a:1', 0, [ev('x.one'), ev('x.two')]);
      await addSrc(t.pool, 1);
      await addSrc(t.pool, 2);
      await addSrc(t.pool, 3);
      const r = await runProjection(t.pool, tokens, { batchSize: 2 });
      expect(r).toEqual({ ok: true, value: { applied: 5, last_global_seq: 2, feeds: { src: 3 } } });
      expect(await tokens.snapshot(t.pool)).toEqual([
        'ev:x.one',
        'ev:x.two',
        'feed:v1',
        'feed:v2',
        'feed:v3',
      ]);
      expect(await readCheckpoint(t.pool, feedCheckpointName('tokens', 'src'))).toEqual({
        version: 1,
        last_global_seq: 3,
      });
      expect(await readCheckpoint(t.pool, 'tokens')).toEqual({ version: 1, last_global_seq: 2 });

      await addSrc(t.pool, 4);
      const again = await runProjection(t.pool, tokens);
      expect(again.ok && again.value.applied).toBe(1);
    });
  });

  it('rebuild equals live, with the sources advancing in separate steps', async () => {
    await withRecordDb(async (t) => {
      await setup(t.pool);
      await addSrc(t.pool, 1);
      await runProjection(t.pool, tokens, { batchSize: 1 });
      await appendCommitted(t.pool, 'a:1', 0, [ev('x.one')]);
      await addSrc(t.pool, 2);
      await runProjection(t.pool, tokens, { batchSize: 1 });
      await appendCommitted(t.pool, 'a:1', 1, [ev('x.two')]);
      await addSrc(t.pool, 3);
      const state = await expectRebuildEqualsLive(t.pool, tokens);
      expect(state).toHaveLength(5);
    });
  });

  it('rebuild discards drifted state and refolds both sources', async () => {
    await withRecordDb(async (t) => {
      await setup(t.pool);
      await appendCommitted(t.pool, 'a:1', 0, [ev('x.one')]);
      await addSrc(t.pool, 1);
      await runProjection(t.pool, tokens);
      await t.pool.query("INSERT INTO public.feed_tokens VALUES ('ghost')");
      const stats = await rebuild(t.pool, tokens);
      expect(stats).toEqual({ applied: 2, last_global_seq: 1, feeds: { src: 1 } });
      expect(await tokens.snapshot(t.pool)).toEqual(['ev:x.one', 'feed:v1']);
    });
  });

  it('fails closed on a hole in a feed instead of folding past it', async () => {
    await withRecordDb(async (t) => {
      await setup(t.pool);
      await addSrc(t.pool, 1);
      await addSrc(t.pool, 3);
      await expect(runProjection(t.pool, tokens)).rejects.toThrow(ProjectionGapError);
      expect(await tokens.snapshot(t.pool)).toEqual([]);
    });
  });

  it('a projection without feeds reports no feed positions (unchanged behaviour)', async () => {
    await withRecordDb(async (t) => {
      await setup(t.pool);
      const plain: Projection<string[]> = { ...tokens, feeds: [] };
      await appendCommitted(t.pool, 'a:1', 0, [ev('x.one')]);
      const r = await runProjection(t.pool, plain);
      expect(r).toEqual({ ok: true, value: { applied: 1, last_global_seq: 1 } });
    });
  });
});
