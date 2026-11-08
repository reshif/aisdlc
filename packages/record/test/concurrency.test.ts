import { describe, expect, it } from 'vitest';
import { appendEvents, verifyAll, verifyChain } from '../src/index.js';
import { bigPool, ev, settledWithin, waitUntilBlocked, withRecordDb } from './helpers.js';

describe('concurrent appends (two or more real connections)', () => {
  it('serialises two appenders: global_seq follows commit order, not call order', async () => {
    await withRecordDb(async (t) => {
      const c1 = await t.pool.connect();
      const c2 = await t.pool.connect();
      try {
        const pid2 = Number(
          ((await c2.query('SELECT pg_backend_pid() AS p')).rows[0] as { p: number }).p,
        );
        await c1.query('BEGIN');
        await c2.query('BEGIN');
        const a = await appendEvents(c1, 'a', 0, [ev()]);
        // c2 starts second but cannot assign a number until c1 ends its transaction.
        const pendingB = appendEvents(c2, 'b', 0, [ev()]);
        await waitUntilBlocked(t.pool, pid2);
        expect(await settledWithin(pendingB, 100)).toBe('pending');

        await c1.query('COMMIT');
        const b = await pendingB;
        await c2.query('COMMIT');
        expect(a.ok && a.value.events[0]?.global_seq).toBe(1);
        expect(b.ok && b.value.events[0]?.global_seq).toBe(2);
      } finally {
        c1.release();
        c2.release();
      }
    });
  });

  it('a rolled-back appender leaves no gap for the one waiting behind it', async () => {
    await withRecordDb(async (t) => {
      const c1 = await t.pool.connect();
      const c2 = await t.pool.connect();
      try {
        const pid2 = Number(
          ((await c2.query('SELECT pg_backend_pid() AS p')).rows[0] as { p: number }).p,
        );
        await c1.query('BEGIN');
        await c2.query('BEGIN');
        await appendEvents(c1, 'a', 0, [ev(), ev()]);
        const pendingB = appendEvents(c2, 'b', 0, [ev()]);
        await waitUntilBlocked(t.pool, pid2);
        await c1.query('ROLLBACK');
        const b = await pendingB;
        await c2.query('COMMIT');
        expect(b.ok && b.value.events[0]?.global_seq).toBe(1);
        expect(await verifyAll(t.pool)).toEqual({ valid: true, events: 1 });
      } finally {
        c1.release();
        c2.release();
      }
    });
  });

  it('two writers with the same expectedSeq: one wins, the other gets ConcurrencyConflict', async () => {
    await withRecordDb(async (t) => {
      const c1 = await t.pool.connect();
      const c2 = await t.pool.connect();
      try {
        const pid2 = Number(
          ((await c2.query('SELECT pg_backend_pid() AS p')).rows[0] as { p: number }).p,
        );
        await c1.query('BEGIN');
        await c2.query('BEGIN');
        const first = await appendEvents(c1, 's', 0, [ev('x.one')]);
        const second = appendEvents(c2, 's', 0, [ev('x.two')]);
        await waitUntilBlocked(t.pool, pid2);
        await c1.query('COMMIT');
        const lost = await second;
        await c2.query('ROLLBACK');
        expect(first.ok).toBe(true);
        expect(!lost.ok && lost.error).toEqual({
          _tag: 'ConcurrencyConflict',
          stream: 's',
          expected_seq: 0,
          actual_seq: 1,
        });
        expect(await verifyChain(t.pool, 's')).toEqual({ valid: true, events: 1 });
      } finally {
        c1.release();
        c2.release();
      }
    });
  });

  it('two concurrent duplicates of one signal store it once', async () => {
    await withRecordDb(async (t) => {
      const c1 = await t.pool.connect();
      const c2 = await t.pool.connect();
      try {
        const pid2 = Number(
          ((await c2.query('SELECT pg_backend_pid() AS p')).rows[0] as { p: number }).p,
        );
        await c1.query('BEGIN');
        await c2.query('BEGIN');
        const a = await appendEvents(c1, 's', 0, [ev('sig.in', { v: 1 }, 'same')]);
        const pendingB = appendEvents(c2, 's', 0, [ev('sig.in', { v: 1 }, 'same')]);
        await waitUntilBlocked(t.pool, pid2);
        await c1.query('COMMIT');
        const b = await pendingB;
        await c2.query('COMMIT');
        expect(a.ok && a.value.duplicate).toBe(false);
        expect(b.ok && b.value.duplicate).toBe(true);
        expect(b.ok && b.value.events[0]?.event_id).toBe(a.ok && a.value.events[0]?.event_id);
      } finally {
        c1.release();
        c2.release();
      }
    });
  });

  it('stress: readers never see a hole in global order while many writers commit', async () => {
    await withRecordDb(async (t) => {
      const pool = bigPool(t, 14);
      const WORKERS = 8;
      const PER_WORKER = 25;
      const STREAMS = ['s0', 's1', 's2'];
      let writing = true;
      let observations = 0;
      let reader: Promise<void> | undefined;
      const violations: string[] = [];

      try {
        // One statement is one snapshot: count and max must agree, or a reader saw N+1 without N.
        reader = (async () => {
          while (writing) {
            const r = await pool.query<{ n: string; mx: string | null }>(
              'SELECT count(*)::text AS n, max(global_seq)::text AS mx FROM record.record_event',
            );
            const row = r.rows[0]!;
            observations += 1;
            if (Number(row.n) !== Number(row.mx ?? 0))
              violations.push(`${row.n} rows, max ${row.mx}`);
          }
        })();

        const writer = async (w: number): Promise<void> => {
          for (let i = 0; i < PER_WORKER; i++) {
            const stream = STREAMS[(w + i) % STREAMS.length]!;
            for (;;) {
              const client = await pool.connect();
              try {
                await client.query('BEGIN');
                const head = await client.query<{ s: string }>(
                  'SELECT coalesce(max(seq), 0)::text AS s FROM record.record_event WHERE stream = $1',
                  [stream],
                );
                const r = await appendEvents(client, stream, Number(head.rows[0]?.s), [
                  ev('w.tick', { w, i }, `w${w}-${i}`),
                ]);
                if (r.ok) {
                  await client.query('COMMIT');
                  break;
                }
                await client.query('ROLLBACK'); // lost the race: re-read the head and retry
              } finally {
                client.release();
              }
            }
          }
        };
        await Promise.all(Array.from({ length: WORKERS }, (_, w) => writer(w)));
        writing = false;
        await reader;

        expect(violations).toEqual([]);
        expect(observations).toBeGreaterThan(0);
        const total = WORKERS * PER_WORKER;
        expect(await verifyAll(pool)).toEqual({ valid: true, events: total });
        const counts = await pool.query<{ stream: string; n: string; mx: string }>(
          'SELECT stream, count(*)::text AS n, max(seq)::text AS mx FROM record.record_event GROUP BY stream',
        );
        expect(counts.rows.reduce((a, r) => a + Number(r.n), 0)).toBe(total);
        for (const r of counts.rows) expect(r.n).toBe(r.mx);
      } finally {
        writing = false;
        await reader?.catch(() => undefined);
        await pool.end();
      }
    });
  });
});
