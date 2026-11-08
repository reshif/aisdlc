import { describe, expect, it } from 'vitest';
import { withTransaction } from '@aisdlc/db';
import { manualClock } from '@aisdlc/kernel';
import {
  PermanentDeliveryError,
  appendEvents,
  claimOutbox,
  deadOutboxCount,
  dispatchOutbox,
  enqueueOutbox,
  listDeadOutbox,
  markDispatched,
  pendingOutboxCount,
  requeueDeadOutbox,
} from '../src/index.js';
import { appendCommitted, bigPool, ev, withRecordDb } from './helpers.js';

const msg = (i: number, destination = 'dest') => ({
  destination,
  payload: { i },
  idempotency_key: `${destination}-${i}`,
});

describe('transactional outbox', () => {
  it('is written in the same transaction as the event', async () => {
    await withRecordDb(async (t) => {
      const r = await withTransaction(t.pool, (tx) =>
        appendEvents(tx, 's', 0, [ev('sig.in')], {
          outbox: (events) => [
            {
              destination: 'notify',
              payload: { event_id: events[0]!.event_id },
              idempotency_key: 'n1',
            },
          ],
        }),
      );
      expect(r.ok).toBe(true);
      const row = await t.pool.query('SELECT destination, payload, attempts FROM record.outbox');
      expect(row.rows).toEqual([
        {
          destination: 'notify',
          payload: { event_id: r.ok ? r.value.events[0]?.event_id : '' },
          attempts: 0,
        },
      ]);
    });
  });

  it('a rolled-back append leaves no outbox row (and no event)', async () => {
    await withRecordDb(async (t) => {
      await expect(
        withTransaction(t.pool, async (tx) => {
          await appendEvents(tx, 's', 0, [ev()], { outbox: [msg(1)] });
          throw new Error('crash before commit');
        }),
      ).rejects.toThrow();
      const n = await t.pool.query(
        'SELECT (SELECT count(*) FROM record.outbox)::int AS o, (SELECT count(*) FROM record.record_event)::int AS e',
      );
      expect(n.rows).toEqual([{ o: 0, e: 0 }]);
    });
  });

  it('a refused append (conflict or outbox key clash) writes neither event nor outbox row', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 's', 0, [ev()]);
      const conflict = await withTransaction(t.pool, (tx) =>
        appendEvents(tx, 's', 0, [ev()], { outbox: [msg(1)] }),
      );
      expect(!conflict.ok && conflict.error._tag).toBe('ConcurrencyConflict');

      await withTransaction(t.pool, (tx) => enqueueOutbox(tx, [msg(2)]));
      const clash = await withTransaction(t.pool, (tx) =>
        appendEvents(tx, 's', 1, [ev('x.y')], {
          outbox: [{ ...msg(2), payload: { i: 'different' } }],
        }),
      );
      expect(!clash.ok && clash.error._tag).toBe('OutboxKeyMismatch');
      const n = await t.pool.query(
        'SELECT (SELECT count(*) FROM record.outbox)::int AS o, (SELECT count(*) FROM record.record_event)::int AS e',
      );
      expect(n.rows).toEqual([{ o: 1, e: 1 }]);
    });
  });

  it('a duplicate signal does not enqueue a second message', async () => {
    await withRecordDb(async (t) => {
      const run = () =>
        withTransaction(t.pool, (tx) =>
          appendEvents(tx, 's', 0, [ev('sig.in', {}, 'sig-1')], { outbox: [msg(1)] }),
        );
      await run();
      const again = await run();
      expect(again.ok && again.value.duplicate).toBe(true);
      expect(await pendingOutboxCount(t.pool, 'dest')).toBe(1);
      // Re-enqueueing the identical message is a no-op too.
      const r = await withTransaction(t.pool, (tx) => enqueueOutbox(tx, [msg(1)]));
      expect(r.ok && r.value.inserted).toBe(0);
    });
  });

  it('concurrent claimers never get the same row (FOR UPDATE SKIP LOCKED)', async () => {
    await withRecordDb(async (t) => {
      await withTransaction(t.pool, (tx) =>
        enqueueOutbox(
          tx,
          Array.from({ length: 20 }, (_, i) => msg(i)),
        ),
      );
      const c1 = await t.pool.connect();
      const c2 = await t.pool.connect();
      try {
        await c1.query('BEGIN');
        await c2.query('BEGIN');
        const a = await claimOutbox(c1, 'dest', 12);
        const b = await claimOutbox(c2, 'dest', 12); // must not block, must skip a's rows
        const ids1 = new Set(a.map((r) => r.id));
        expect(a).toHaveLength(12);
        expect(b).toHaveLength(8);
        expect(b.some((r) => ids1.has(r.id))).toBe(false);
        // A third claimer finds nothing while both hold their locks.
        const c3 = await t.pool.connect();
        try {
          await c3.query('BEGIN');
          expect(await claimOutbox(c3, 'dest', 5)).toEqual([]);
          await c3.query('ROLLBACK');
        } finally {
          c3.release();
        }
        await c1.query('ROLLBACK'); // claimer 1 dies: its rows are claimable again
        const c4 = await t.pool.connect();
        try {
          await c4.query('BEGIN');
          expect(
            (await claimOutbox(c4, 'dest', 50)).map((r) => r.id).sort((x, y) => x - y),
          ).toEqual(a.map((r) => r.id).sort((x, y) => x - y));
          await c4.query('ROLLBACK');
        } finally {
          c4.release();
        }
        await c2.query('ROLLBACK');
      } finally {
        c1.release();
        c2.release();
      }
    });
  });

  it('many concurrent dispatchers deliver each message exactly once when nothing fails', async () => {
    await withRecordDb(async (t) => {
      const pool = bigPool(t, 10);
      try {
        await withTransaction(pool, (tx) =>
          enqueueOutbox(tx, [...Array.from({ length: 60 }, (_, i) => msg(i)), msg(0, 'other')]),
        );
        const delivered: string[] = [];
        const worker = async (): Promise<void> => {
          for (;;) {
            const out = await dispatchOutbox(pool, 'dest', 7, async (row) => {
              delivered.push(row.idempotency_key);
            });
            if (out.dispatched === 0) return;
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        expect(delivered).toHaveLength(60);
        expect(new Set(delivered).size).toBe(60);
        expect(await pendingOutboxCount(pool, 'dest')).toBe(0);
        expect(await pendingOutboxCount(pool, 'other')).toBe(1); // other destinations untouched
      } finally {
        await pool.end();
      }
    });
  });

  it('is at least once: failure and crash leave the row pending, success marks it', async () => {
    await withRecordDb(async (t) => {
      await withTransaction(t.pool, (tx) => enqueueOutbox(tx, [msg(1), msg(2)]));

      const clock = manualClock(Date.now());
      const first = await dispatchOutbox(
        t.pool,
        'dest',
        10,
        async (row) => {
          if (row.payload['i'] === 1) throw new Error('downstream 503');
        },
        { clock },
      );
      expect(first).toEqual({ dispatched: 1, failed: 1, dead: 0 });
      const state = await t.pool.query(
        'SELECT idempotency_key AS k, attempts, last_error, dispatched_at IS NOT NULL AS done FROM record.outbox ORDER BY id',
      );
      expect(state.rows).toEqual([
        { k: 'dest-1', attempts: 1, last_error: 'downstream 503', done: false },
        { k: 'dest-2', attempts: 1, last_error: null, done: true },
      ]);

      // Crash after the handler ran but before COMMIT: the row is delivered again, same key (once
      // its backoff, one second after the failure, has passed).
      clock.advance(1_000);
      const seen: string[] = [];
      await expect(
        withTransaction(t.pool, async (tx) => {
          const rows = await claimOutbox(tx, 'dest', 10, { now: clock.now() });
          seen.push(...rows.map((r) => r.idempotency_key));
          await markDispatched(
            tx,
            rows.map((r) => r.id),
          );
          throw new Error('process died');
        }),
      ).rejects.toThrow();
      const retry = await dispatchOutbox(
        t.pool,
        'dest',
        10,
        async (row) => {
          seen.push(row.idempotency_key);
        },
        { clock },
      );
      expect(retry.dispatched).toBe(1);
      expect(seen).toEqual(['dest-1', 'dest-1']);
      const done = await t.pool.query(
        'SELECT attempts, last_error FROM record.outbox WHERE idempotency_key = $1',
        ['dest-1'],
      );
      expect(done.rows).toEqual([{ attempts: 2, last_error: null }]);
    });
  });
});

describe('outbox delivery limits: backoff and dead letters (PLAN M5.4)', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 4_000 };

  it('a failing message backs off exponentially, is dead-lettered after maxAttempts and then never claimed', async () => {
    await withRecordDb(async (t) => {
      await withTransaction(t.pool, (tx) => enqueueOutbox(tx, [msg(1)]));
      const clock = manualClock('2026-11-08T10:00:00.000Z');
      let calls = 0;
      const fail = async () => {
        calls += 1;
        throw new Error('rejected by the destination');
      };
      const at = async () =>
        (await t.pool.query('SELECT attempts, next_attempt_at, dead_at FROM record.outbox'))
          .rows[0];

      expect(await dispatchOutbox(t.pool, 'dest', 5, fail, { clock, policy })).toEqual({
        dispatched: 0,
        failed: 1,
        dead: 0,
      });
      expect((await at()).next_attempt_at.toISOString()).toBe('2026-11-08T10:00:01.000Z');
      // Not due yet: the handler is not even called.
      clock.advance(999);
      expect(await dispatchOutbox(t.pool, 'dest', 5, fail, { clock, policy })).toEqual({
        dispatched: 0,
        failed: 0,
        dead: 0,
      });
      expect(calls).toBe(1);
      clock.advance(1);
      await dispatchOutbox(t.pool, 'dest', 5, fail, { clock, policy });
      expect((await at()).next_attempt_at.toISOString()).toBe('2026-11-08T10:00:03.000Z'); // +2 s
      clock.advance(2_000);
      expect(await dispatchOutbox(t.pool, 'dest', 5, fail, { clock, policy })).toEqual({
        dispatched: 0,
        failed: 0,
        dead: 1,
      });
      expect(calls).toBe(3);
      const row = await at();
      expect(row.attempts).toBe(3);
      expect(row.dead_at.toISOString()).toBe('2026-11-08T10:00:03.000Z');
      expect(await pendingOutboxCount(t.pool, 'dest')).toBe(0);
      expect(await deadOutboxCount(t.pool)).toEqual([
        { destination: 'dest', dead: 1, oldest_dead_at: row.dead_at },
      ]);

      // Dead is final: a year later nothing is claimed and the handler is not called.
      clock.advance(365 * 86_400_000);
      expect(await dispatchOutbox(t.pool, 'dest', 5, fail, { clock, policy })).toEqual({
        dispatched: 0,
        failed: 0,
        dead: 0,
      });
      expect(calls).toBe(3);
      const dead = await listDeadOutbox(t.pool);
      expect(dead.map((r) => [r.idempotency_key, r.last_error])).toEqual([
        ['dest-1', 'rejected by the destination'],
      ]);
    });
  });

  it('the delay is capped at maxDelayMs', async () => {
    await withRecordDb(async (t) => {
      await withTransaction(t.pool, (tx) => enqueueOutbox(tx, [msg(1)]));
      const clock = manualClock('2026-11-08T10:00:00.000Z');
      const p = { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 4_000 };
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        await dispatchOutbox(t.pool, 'dest', 1, () => Promise.reject(new Error('x')), {
          clock,
          policy: p,
        });
        const r = await t.pool.query('SELECT next_attempt_at FROM record.outbox');
        const due = (r.rows[0].next_attempt_at as Date).getTime();
        delays.push(due - clock.nowMs());
        clock.set(due);
      }
      expect(delays).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
    });
  });

  it('a permanently failing message is dead-lettered and does not delay the others', async () => {
    await withRecordDb(async (t) => {
      // The poison message is FIRST in line, ahead of ten good ones.
      await withTransaction(t.pool, (tx) =>
        enqueueOutbox(tx, [msg(0), ...Array.from({ length: 10 }, (_, i) => msg(i + 1))]),
      );
      const clock = manualClock('2026-11-08T10:00:00.000Z');
      const delivered: number[] = [];
      const handler = async (row: { payload: Record<string, unknown> }) => {
        if (row.payload['i'] === 0) throw new Error('poison');
        delivered.push(row.payload['i'] as number);
      };
      // Round 1: the good ones are delivered in the same call that fails the poison one.
      const r1 = await dispatchOutbox(t.pool, 'dest', 20, handler, { clock, policy });
      expect(r1).toEqual({ dispatched: 10, failed: 1, dead: 0 });
      // A limit of 1 would have been blocked by it forever without backoff; now it is skipped.
      await withTransaction(t.pool, (tx) => enqueueOutbox(tx, [msg(11)]));
      const r2 = await dispatchOutbox(t.pool, 'dest', 1, handler, { clock, policy });
      expect(r2.dispatched).toBe(1);
      expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      // The poison message runs out its attempts without ever touching the rest.
      for (const advance of [1_000, 2_000]) {
        clock.advance(advance);
        await dispatchOutbox(t.pool, 'dest', 20, handler, { clock, policy });
      }
      const dead = await listDeadOutbox(t.pool);
      expect(dead.map((r) => r.payload)).toEqual([{ i: 0 }]);
      expect(await pendingOutboxCount(t.pool, 'dest')).toBe(0);
    });
  });

  it('a PermanentDeliveryError dead-letters at the first failure; requeueing is an explicit act', async () => {
    await withRecordDb(async (t) => {
      await withTransaction(t.pool, (tx) => enqueueOutbox(tx, [msg(1), msg(2, 'other')]));
      const clock = manualClock('2026-11-08T10:00:00.000Z');
      const out = await dispatchOutbox(
        t.pool,
        'dest',
        5,
        () => Promise.reject(new PermanentDeliveryError('invalid payload')),
        { clock, policy },
      );
      expect(out).toEqual({ dispatched: 0, failed: 0, dead: 1 });
      expect(await deadOutboxCount(t.pool, 'other')).toEqual([]);
      const [row] = await listDeadOutbox(t.pool, { destination: 'dest' });
      expect(row?.attempts).toBe(1);
      expect(await withTransaction(t.pool, (tx) => requeueDeadOutbox(tx, [row?.id ?? 0]))).toBe(1);
      const ok = await dispatchOutbox(t.pool, 'dest', 5, async () => undefined, { clock, policy });
      expect(ok.dispatched).toBe(1);
      expect(await deadOutboxCount(t.pool)).toEqual([]);
    });
  });

  it('the record rules still hold: only delivery bookkeeping can change, dead rows cannot be dispatched', async () => {
    await withRecordDb(async (t) => {
      await withTransaction(t.pool, (tx) => enqueueOutbox(tx, [msg(1)]));
      await dispatchOutbox(t.pool, 'dest', 1, () =>
        Promise.reject(new PermanentDeliveryError('x')),
      );
      await expect(t.pool.query('UPDATE record.outbox SET dispatched_at = now()')).rejects.toThrow(
        /outbox_dead_is_not_dispatched/,
      );
      await expect(t.pool.query("UPDATE record.outbox SET payload = '{}'::jsonb")).rejects.toThrow(
        /immutable/,
      );
      await expect(t.pool.query('DELETE FROM record.outbox')).rejects.toThrow(/immutable/);
    });
  });
});
