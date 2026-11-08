import { describe, expect, it } from 'vitest';
import {
  ProjectionGapError,
  ProjectionVersionMismatch,
  readCheckpoint,
  rebuild,
  runProjection,
  streamType,
  streamTypeCounts,
  type Projection,
} from '../src/index.js';
import { expectRebuildEqualsLive } from '../src/testing.js';
import { appendCommitted, bigPool, disableTriggers, ev, withRecordDb } from './helpers.js';

describe('projection runner', () => {
  it('folds new events in global order and tracks the checkpoint', async () => {
    await withRecordDb(async (t) => {
      const first = await runProjection(t.pool, streamTypeCounts);
      expect(first).toEqual({ ok: true, value: { applied: 0, last_global_seq: 0 } });

      await appendCommitted(t.pool, 'item:1', 0, [ev(), ev()]);
      await appendCommitted(t.pool, 'record:x', 0, [ev()]);
      const second = await runProjection(t.pool, streamTypeCounts, { batchSize: 2 });
      expect(second).toEqual({ ok: true, value: { applied: 3, last_global_seq: 3 } });
      expect(await streamTypeCounts.snapshot(t.pool)).toEqual({ item: 2, record: 1 });

      await appendCommitted(t.pool, 'item:2', 0, [ev()]);
      const third = await runProjection(t.pool, streamTypeCounts);
      expect(third).toEqual({ ok: true, value: { applied: 1, last_global_seq: 4 } });
      expect(await streamTypeCounts.snapshot(t.pool)).toEqual({ item: 3, record: 1 });
      expect(await readCheckpoint(t.pool, 'stream_type_counts')).toEqual({
        version: 1,
        last_global_seq: 4,
      });
    });
  });

  it('derives the stream type from the stream name', () => {
    expect(streamType('item:0190-abc')).toBe('item');
    expect(streamType('s0_record:1:2')).toBe('s0_record');
    expect(streamType('plain')).toBe('plain');
  });

  it('rebuild equals live (sample projection, incremental live folding, several streams)', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 'item:1', 0, [ev(), ev(), ev()]);
      await runProjection(t.pool, streamTypeCounts, { batchSize: 2 });
      await appendCommitted(t.pool, 'item:2', 0, [ev()]);
      await appendCommitted(t.pool, 's0_record:1', 0, [ev(), ev()]);
      await runProjection(t.pool, streamTypeCounts, { batchSize: 1 });
      await appendCommitted(t.pool, 'item:1', 3, [ev()]);
      await appendCommitted(t.pool, 'plain', 0, [ev()]);

      const state = await expectRebuildEqualsLive(t.pool, streamTypeCounts);
      expect(state).toEqual({ item: 5, plain: 1, s0_record: 2 });
    });
  });

  it('rebuild equals live on an empty record', async () => {
    await withRecordDb(async (t) => {
      expect(await expectRebuildEqualsLive(t.pool, streamTypeCounts)).toEqual({});
    });
  });

  it('rebuild discards drifted state: reset runs before the refold', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 'item:1', 0, [ev(), ev()]);
      await runProjection(t.pool, streamTypeCounts);
      await t.pool.query('UPDATE record.stream_type_counts SET event_count = 99');
      await t.pool.query("INSERT INTO record.stream_type_counts VALUES ('ghost', 7)");
      const stats = await rebuild(t.pool, streamTypeCounts);
      expect(stats).toEqual({ applied: 2, last_global_seq: 2 });
      expect(await streamTypeCounts.snapshot(t.pool)).toEqual({ item: 2 });
    });
  });

  it('a failing apply rolls the batch back and leaves the checkpoint where it was', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 'item:1', 0, [
        ev('a.ok'),
        ev('a.ok'),
        ev('a.poison'),
        ev('a.ok'),
      ]);
      const flaky: Projection<Record<string, number>> = {
        ...streamTypeCounts,
        async apply(tx, event) {
          if (event.type === 'a.poison') throw new Error('cannot fold');
          await streamTypeCounts.apply(tx, event);
        },
      };
      await expect(runProjection(t.pool, flaky, { batchSize: 2 })).rejects.toThrow('cannot fold');
      // First batch (events 1-2) committed; the batch with the poison event rolled back whole.
      expect(await readCheckpoint(t.pool, flaky.name)).toMatchObject({ last_global_seq: 2 });
      expect(await flaky.snapshot(t.pool)).toEqual({ item: 2 });
      // A failing rebuild changes nothing at all.
      await expect(rebuild(t.pool, flaky)).rejects.toThrow('cannot fold');
      expect(await flaky.snapshot(t.pool)).toEqual({ item: 2 });
      expect(await readCheckpoint(t.pool, flaky.name)).toMatchObject({ last_global_seq: 2 });
    });
  });

  it('refuses to run on a stale checkpoint version until rebuilt', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 'item:1', 0, [ev(), ev()]);
      await runProjection(t.pool, streamTypeCounts);
      const v2: Projection<Record<string, number>> = { ...streamTypeCounts, version: 2 };
      const r = await runProjection(t.pool, v2);
      expect(!r.ok && ProjectionVersionMismatch.is(r.error)).toBe(true);
      expect(!r.ok && r.error).toMatchObject({ stored_version: 1, code_version: 2 });
      await rebuild(t.pool, v2); // an explicit rebuild adopts the new version
      expect((await runProjection(t.pool, v2)).ok).toBe(true);
      await expectRebuildEqualsLive(t.pool, v2);
      expect(await readCheckpoint(t.pool, v2.name)).toEqual({ version: 2, last_global_seq: 2 });
    });
  });

  it('fails closed on a hole in global_seq instead of folding past it', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 'item:1', 0, [ev(), ev(), ev()]);
      await disableTriggers(t.pool);
      await t.pool.query('DELETE FROM record.record_event WHERE global_seq = 2');
      await expect(runProjection(t.pool, streamTypeCounts)).rejects.toThrow(ProjectionGapError);
      await expect(rebuild(t.pool, streamTypeCounts)).rejects.toThrow(ProjectionGapError);
    });
  });

  it('concurrent runners fold each event exactly once', async () => {
    await withRecordDb(async (t) => {
      const pool = bigPool(t, 8);
      try {
        for (let i = 0; i < 10; i++)
          await appendCommitted(pool, `item:${i}`, 0, [ev(), ev(), ev()]);
        const results = await Promise.all(
          [1, 2, 3, 4].map(() => runProjection(pool, streamTypeCounts, { batchSize: 4 })),
        );
        expect(results.every((r) => r.ok)).toBe(true);
        expect(results.reduce((a, r) => a + (r.ok ? r.value.applied : 0), 0)).toBe(30);
        expect(await streamTypeCounts.snapshot(pool)).toEqual({ item: 30 });
      } finally {
        await pool.end();
      }
    });
  });

  it('keeps folding while appends land during a rebuild', async () => {
    await withRecordDb(async (t) => {
      const pool = bigPool(t, 8);
      try {
        await appendCommitted(
          pool,
          'item:1',
          0,
          Array.from({ length: 200 }, () => ev()),
        );
        const rebuilding = rebuild(pool, streamTypeCounts, { batchSize: 10 });
        await appendCommitted(pool, 'item:2', 0, [ev(), ev()]);
        await rebuilding;
        await expectRebuildEqualsLive(pool, streamTypeCounts, undefined, { batchSize: 10 });
        expect(await streamTypeCounts.snapshot(pool)).toEqual({ item: 202 });
      } finally {
        await pool.end();
      }
    });
  });
});
