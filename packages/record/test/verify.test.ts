import { describe, expect, it } from 'vitest';
import { computeEventHash, verifyAll, verifyChain } from '../src/index.js';
import { appendCommitted, disableTriggers, ev, withRecordDb } from './helpers.js';

async function seed(pool: Parameters<typeof appendCommitted>[0]) {
  await appendCommitted(pool, 'a', 0, [
    ev('x.one', { n: 1 }),
    ev('x.two', { n: 2 }),
    ev('x.three', { n: 3 }),
  ]);
  await appendCommitted(pool, 'b', 0, [ev('y.one'), ev('y.two')]);
  await appendCommitted(pool, 'a', 3, [ev('x.four')]);
}

describe('verifyChain / verifyAll', () => {
  it('accepts an intact record, including an empty one and an unknown stream', async () => {
    await withRecordDb(async (t) => {
      expect(await verifyAll(t.pool)).toEqual({ valid: true, events: 0 });
      expect(await verifyChain(t.pool, 'nope')).toEqual({ valid: true, events: 0 });
      await seed(t.pool);
      expect(await verifyChain(t.pool, 'a')).toEqual({ valid: true, events: 4 });
      expect(await verifyChain(t.pool, 'b')).toEqual({ valid: true, events: 2 });
      expect(await verifyAll(t.pool)).toEqual({ valid: true, events: 6 });
    });
  });

  it('crosses the internal batch boundary', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(
        t.pool,
        'big',
        0,
        Array.from({ length: 1005 }, (_, i) => ev('big.tick', { i })),
      );
      expect(await verifyChain(t.pool, 'big')).toEqual({ valid: true, events: 1005 });
      expect(await verifyAll(t.pool)).toEqual({ valid: true, events: 1005 });
    });
  });

  it('detects an edited row and reports its position', async () => {
    await withRecordDb(async (t) => {
      await seed(t.pool);
      await disableTriggers(t.pool); // superuser tampering, as an attacker with DB access would
      await t.pool.query(
        `UPDATE record.record_event SET body = '{"n": 999}' WHERE stream = 'a' AND seq = 2`,
      );
      const v = await verifyChain(t.pool, 'a');
      expect(v.valid).toBe(false);
      if (!v.valid) {
        expect(v.break).toMatchObject({
          kind: 'hash_mismatch',
          stream: 'a',
          seq: 2,
          global_seq: 2,
        });
      }
      expect(await verifyChain(t.pool, 'b')).toEqual({ valid: true, events: 2 });
      const all = await verifyAll(t.pool);
      expect(!all.valid && all.break).toMatchObject({ kind: 'hash_mismatch', stream: 'a', seq: 2 });
    });
  });

  it('detects an edited row whose hash was recomputed: the next link breaks', async () => {
    await withRecordDb(async (t) => {
      await seed(t.pool);
      await disableTriggers(t.pool);
      const r = await t.pool.query<{ event_id: string; occurred_at: Date; prev_hash: string }>(
        `SELECT event_id, occurred_at, prev_hash FROM record.record_event WHERE stream = 'a' AND seq = 2`,
      );
      const row = r.rows[0]!;
      const body = { n: 999 };
      const hash = computeEventHash({
        stream: 'a',
        seq: 2,
        event_id: row.event_id,
        type: 'x.two',
        body,
        actor: 'system:test',
        occurred_at: row.occurred_at.toISOString(),
        prev_hash: row.prev_hash,
      });
      await t.pool.query(
        `UPDATE record.record_event SET body = $1::jsonb, hash = $2 WHERE stream = 'a' AND seq = 2`,
        [JSON.stringify(body), hash],
      );
      const v = await verifyChain(t.pool, 'a');
      expect(!v.valid && v.break).toMatchObject({ kind: 'prev_hash_mismatch', seq: 3 });
    });
  });

  it('detects a deleted middle row (seq gap) and a deleted tail (global counter)', async () => {
    await withRecordDb(async (t) => {
      await seed(t.pool);
      await disableTriggers(t.pool);
      await t.pool.query(`DELETE FROM record.record_event WHERE stream = 'a' AND seq = 2`);
      const v = await verifyChain(t.pool, 'a');
      expect(!v.valid && v.break).toMatchObject({
        kind: 'seq_gap',
        stream: 'a',
        seq: 3,
        expected: 2,
      });
      const all = await verifyAll(t.pool);
      expect(!all.valid && all.break).toMatchObject({
        kind: 'global_seq_gap',
        expected: 2,
        actual: 3,
      });
    });
    await withRecordDb(async (t) => {
      await seed(t.pool);
      await disableTriggers(t.pool);
      await t.pool.query(`DELETE FROM record.record_event WHERE stream = 'a' AND seq = 4`);
      // The stream chain alone cannot see a missing tail; the global counter can.
      expect(await verifyChain(t.pool, 'a')).toEqual({ valid: true, events: 3 });
      const all = await verifyAll(t.pool);
      expect(!all.valid && all.break).toMatchObject({
        kind: 'global_counter_mismatch',
        expected: 5,
        actual: 6,
      });
    });
  });

  it('detects a swapped link and a forged genesis', async () => {
    await withRecordDb(async (t) => {
      await seed(t.pool);
      await disableTriggers(t.pool);
      await t.pool.query(
        `UPDATE record.record_event SET prev_hash = $1 WHERE stream = 'b' AND seq = 1`,
        ['f'.repeat(64)],
      );
      const v = await verifyChain(t.pool, 'b');
      expect(!v.valid && v.break).toMatchObject({
        kind: 'prev_hash_mismatch',
        stream: 'b',
        seq: 1,
      });
    });
  });
});
