import { newId } from '@aisdlc/kernel';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  enterPurgeRole,
  redactEvents,
  removeEvents,
  verifyAll,
  verifyChain,
} from '../src/index.js';
import { appendCommitted, ev, withRecordDb } from './helpers.js';

// Delete means delete (docs/specs/deletion.md §2, §4): a deleted object's own streams go, its events in other
// streams are redacted in place, and the record still verifies.

async function asPurger<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await enterPurgeRole(c);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const globals = async (pool: pg.Pool, stream: string, seqs?: number[]) =>
  (
    await pool.query<{ g: string }>(
      `SELECT global_seq::text AS g FROM record.record_event WHERE stream = $1
         AND ($2::bigint[] IS NULL OR seq = ANY($2::bigint[])) ORDER BY seq`,
      [stream, seqs ? seqs.map(String) : null],
    )
  ).rows.map((r) => Number(r.g));

describe('the purge path', () => {
  it('removes a whole stream and redacts an event of a shared stream; the record verifies', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 'item:gone', 0, [ev('x.one', { secret: 'acme' }), ev('x.two')]);
      await appendCommitted(t.pool, 'shared', 0, [
        ev('y.one'),
        ev('y.mentions', { secret: 'acme' }),
        ev('y.three'),
      ]);
      await appendCommitted(t.pool, 'item:gone', 2, [ev('x.three')]);
      const deletion = newId<'Deletion'>();
      const at = new Date('2026-11-13T00:00:00.000Z');
      const removed = await asPurger(t.pool, async (c) =>
        removeEvents(c, deletion, await globals(t.pool, 'item:gone'), at),
      );
      expect(removed).toBe(3);
      const redacted = await asPurger(t.pool, async (c) =>
        redactEvents(c, await globals(t.pool, 'shared', [2]), at),
      );
      expect(redacted).toBe(1);
      const left = await t.pool.query(
        `SELECT 1 FROM record.record_event WHERE body::text LIKE '%acme%'`,
      );
      expect(left.rowCount).toBe(0);
      expect(await verifyChain(t.pool, 'shared')).toEqual({ valid: true, events: 3 });
      expect(await verifyAll(t.pool)).toEqual({ valid: true, events: 3, redacted: 1, purged: 3 });
      // The purged log holds positions only.
      const log = await t.pool.query('SELECT * FROM record.purged_event');
      expect(Object.keys(log.rows[0] as object).sort()).toEqual([
        'deletion_id',
        'global_seq',
        'purged_at',
      ]);
    });
  });

  it('refuses everyone but the purge role, an unaccounted delete, and a redaction that moves the hash', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 's', 0, [ev('a.one'), ev('a.two')]);
      await expect(
        t.pool.query(`DELETE FROM record.record_event WHERE stream = 's'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        t.pool.query(
          `UPDATE record.record_event SET type = 'redacted', body = '{}', actor = 'redacted', redacted_at = now() WHERE seq = 1`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        asPurger(t.pool, (c) => c.query(`DELETE FROM record.record_event WHERE stream = 's'`)),
      ).rejects.toThrow(/append-only/);
      await expect(
        asPurger(t.pool, (c) =>
          c.query(
            `UPDATE record.record_event SET type = 'redacted', body = '{}', actor = 'redacted',
               idempotency_key = NULL, redacted_at = now(), hash = repeat('0', 64) WHERE seq = 1`,
          ),
        ),
      ).rejects.toThrow(/append-only/);
      expect(await verifyAll(t.pool)).toEqual({ valid: true, events: 2 });
    });
  });

  it('a gap that the purge log does not account for is still a gap', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 's', 0, [ev('a.one')]);
      await appendCommitted(t.pool, 'u', 0, [ev('b.one')]);
      await appendCommitted(t.pool, 's', 1, [ev('a.two')]);
      const c = await t.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`DELETE FROM record.record_event WHERE stream = 'u'`);
        const v = await verifyAll(c);
        expect(v.valid).toBe(false);
        if (!v.valid) expect(v.break.kind).toBe('global_seq_gap');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });
});
