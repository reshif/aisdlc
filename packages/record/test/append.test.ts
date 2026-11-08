import { hashCanonical } from '@aisdlc/kernel';
import { RecordEvent } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@aisdlc/kernel';
import { withTransaction } from '@aisdlc/db';
import {
  appendEvents,
  ConcurrencyConflict,
  GENESIS_HASH,
  IdempotencyMismatch,
  verifyAll,
  verifyChain,
} from '../src/index.js';
import { appendCommitted, ev, withRecordDb } from './helpers.js';

describe('appendEvents', () => {
  it('chains events per stream from the genesis hash and numbers them globally', async () => {
    await withRecordDb(async (t) => {
      const a = await appendCommitted(t.pool, 'item:1', 0, [ev('item.created'), ev('item.moved')]);
      const b = await appendCommitted(t.pool, 'item:2', 0, [ev('item.created')]);
      const a3 = await appendCommitted(t.pool, 'item:1', 2, [ev('item.closed')]);

      expect(GENESIS_HASH).toBe('0'.repeat(64));
      expect(a.map((e) => e.stream_seq)).toEqual([1, 2]);
      expect(a[0]?.prev_hash).toBe(GENESIS_HASH);
      expect(a[1]?.prev_hash).toBe(a[0]?.hash);
      expect(b[0]?.prev_hash).toBe(GENESIS_HASH);
      expect(a3[0]?.prev_hash).toBe(a[1]?.hash);
      expect([a[0], a[1], b[0], a3[0]].map((e) => e?.global_seq)).toEqual([1, 2, 3, 4]);
      for (const e of [...a, ...b, ...a3]) expect(RecordEvent.safeParse(e).success).toBe(true);
    });
  });

  it('hashes the documented recipe, recomputable outside the package', async () => {
    await withRecordDb(async (t) => {
      const at = new Date('2026-11-08T10:11:12.345Z');
      const [e] = await appendCommitted(t.pool, 's', 0, [
        { type: 'a.b', body: { z: 1, a: [true, null, 'é'] }, actor: 'p1', occurred_at: at },
      ]);
      expect(e?.hash).toBe(
        hashCanonical({
          stream: 's',
          seq: 1,
          event_id: e?.event_id,
          type: 'a.b',
          body: { a: [true, null, 'é'], z: 1 },
          actor: 'p1',
          occurred_at: '2026-11-08T10:11:12.345Z',
          prev_hash: '0'.repeat(64),
        }),
      );
      expect(e?.occurred_at).toBe('2026-11-08T10:11:12.345Z');
    });
  });

  it('uses the injected clock and survives awkward JSON numbers and strings', async () => {
    await withRecordDb(async (t) => {
      const body = { big: 1e21, tiny: 5e-324, neg0: -0, frac: 0.1, s: 'a b😀', n: [1.5e300] };
      const client = await t.pool.connect();
      try {
        await client.query('BEGIN');
        const r = await appendEvents(client, 's', 0, [{ ...ev('x.y'), body }], {
          clock: fixedClock('2026-01-01T00:00:00.000Z'),
        });
        expect(r.ok && r.value.events[0]?.occurred_at).toBe('2026-01-01T00:00:00.000Z');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await verifyChain(t.pool, 's')).toEqual({ valid: true, events: 1 });
      expect(await verifyAll(t.pool)).toEqual({ valid: true, events: 1 });
    });
  });

  it('refuses a stale expectedSeq with a tagged ConcurrencyConflict and writes nothing', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 's', 0, [ev(), ev()]);
      const r = await withTransaction(t.pool, (tx) => appendEvents(tx, 's', 1, [ev('x.y')]));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(ConcurrencyConflict.is(r.error)).toBe(true);
        expect(r.error).toEqual({
          _tag: 'ConcurrencyConflict',
          stream: 's',
          expected_seq: 1,
          actual_seq: 2,
        });
      }
      const ahead = await withTransaction(t.pool, (tx) => appendEvents(tx, 's', 5, [ev()]));
      expect(!ahead.ok && ahead.error._tag).toBe('ConcurrencyConflict');
      const n = await t.pool.query('SELECT count(*)::int AS n FROM record.record_event');
      expect(n.rows).toEqual([{ n: 2 }]);
    });
  });

  it('treats a re-append with the same idempotency key as a no-op returning the original', async () => {
    await withRecordDb(async (t) => {
      const [orig] = await appendCommitted(t.pool, 's', 0, [ev('sig.received', { n: 1 }, 'k1')]);
      await appendCommitted(t.pool, 's', 1, [ev('other.thing')]);

      // Stale expectedSeq (0) is fine for a duplicate: the stream has moved on since.
      const again = await withTransaction(t.pool, (tx) =>
        appendEvents(tx, 's', 0, [ev('sig.received', { n: 1 }, 'k1')]),
      );
      expect(again.ok && again.value).toEqual({ events: [orig], duplicate: true });
      const n = await t.pool.query('SELECT count(*)::int AS n FROM record.record_event');
      expect(n.rows).toEqual([{ n: 2 }]);

      // The same key in another stream is a different signal.
      const other = await appendCommitted(t.pool, 's2', 0, [ev('sig.received', { n: 1 }, 'k1')]);
      expect(other).toHaveLength(1);
    });
  });

  it('refuses the same key with a different body or type, and partial or repeated keys', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 's', 0, [ev('sig.received', { n: 1 }, 'k1')]);
      const run = (events: ReturnType<typeof ev>[], expected = 1) =>
        withTransaction(t.pool, (tx) => appendEvents(tx, 's', expected, events));

      const diffBody = await run([ev('sig.received', { n: 2 }, 'k1')]);
      const diffType = await run([ev('sig.other', { n: 1 }, 'k1')]);
      const partial = await run([ev('sig.received', { n: 1 }, 'k1'), ev('new.one', {}, 'k2')]);
      const repeated = await run([ev('a.b', {}, 'k3'), ev('a.c', {}, 'k3')]);
      for (const [r, reason] of [
        [diffBody, 'different_body'],
        [diffType, 'different_body'],
        [partial, 'partial_batch'],
        [repeated, 'duplicate_in_batch'],
      ] as const) {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(IdempotencyMismatch.is(r.error)).toBe(true);
          expect(r.error).toMatchObject({ _tag: 'IdempotencyMismatch', stream: 's', reason });
        }
      }
      const n = await t.pool.query('SELECT count(*)::int AS n FROM record.record_event');
      expect(n.rows).toEqual([{ n: 1 }]);
    });
  });

  it('rolls everything back with the caller transaction', async () => {
    await withRecordDb(async (t) => {
      await expect(
        withTransaction(t.pool, async (tx) => {
          await appendEvents(tx, 's', 0, [ev(), ev()]);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const n = await t.pool.query(
        'SELECT (SELECT count(*) FROM record.record_event)::int AS e, (SELECT last_seq FROM record.global_counter)::int AS c',
      );
      expect(n.rows).toEqual([{ e: 0, c: 0 }]);
      // The numbers were returned: the next append is global_seq 1 again.
      const [e] = await appendCommitted(t.pool, 's', 0, [ev()]);
      expect(e?.global_seq).toBe(1);
    });
  });

  it('rejects malformed input at the database (type, body shape)', async () => {
    await withRecordDb(async (t) => {
      await expect(appendCommitted(t.pool, 's', 0, [ev('Not Valid')])).rejects.toThrow();
      await expect(
        appendCommitted(t.pool, 's', 0, [{ type: 'a.b', body: [] as never, actor: 'x' }]),
      ).rejects.toThrow();
      await expect(appendCommitted(t.pool, 's', 0, [{ ...ev(), actor: '' }])).rejects.toThrow();
    });
  });
});
