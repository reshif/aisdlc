import { describe, expect, it } from 'vitest';
import { withTransaction } from '@aisdlc/db';
import {
  appendEvents,
  claimOutbox,
  dispatchOutbox,
  enqueueOutbox,
  markDispatched,
  pendingOutboxCount,
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

      const first = await dispatchOutbox(t.pool, 'dest', 10, async (row) => {
        if (row.payload['i'] === 1) throw new Error('downstream 503');
      });
      expect(first).toEqual({ dispatched: 1, failed: 1 });
      const state = await t.pool.query(
        'SELECT idempotency_key AS k, attempts, last_error, dispatched_at IS NOT NULL AS done FROM record.outbox ORDER BY id',
      );
      expect(state.rows).toEqual([
        { k: 'dest-1', attempts: 1, last_error: 'downstream 503', done: false },
        { k: 'dest-2', attempts: 1, last_error: null, done: true },
      ]);

      // Crash after the handler ran but before COMMIT: the row is delivered again, same key.
      const seen: string[] = [];
      await expect(
        withTransaction(t.pool, async (tx) => {
          const rows = await claimOutbox(tx, 'dest', 10);
          seen.push(...rows.map((r) => r.idempotency_key));
          await markDispatched(
            tx,
            rows.map((r) => r.id),
          );
          throw new Error('process died');
        }),
      ).rejects.toThrow();
      const retry = await dispatchOutbox(t.pool, 'dest', 10, async (row) => {
        seen.push(row.idempotency_key);
      });
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
