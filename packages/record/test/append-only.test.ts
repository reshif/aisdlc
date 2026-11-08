import { describe, expect, it } from 'vitest';
import { withTransaction } from '@aisdlc/db';
import type pg from 'pg';
import { appendEvents, enqueueOutbox } from '../src/index.js';
import { appendCommitted, ev, withRecordDb } from './helpers.js';

const code = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code,
  );

describe('append-only enforcement', () => {
  it('refuses UPDATE, DELETE and TRUNCATE even for the table owner (trigger)', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 's', 0, [ev()]);
      // The test connection is a superuser: only the trigger stands in the way.
      expect(await code(t.pool.query("UPDATE record.record_event SET actor = 'evil'"))).toBe(
        '23001',
      );
      expect(await code(t.pool.query('DELETE FROM record.record_event'))).toBe('23001');
      expect(await code(t.pool.query('TRUNCATE record.record_event'))).toBe('23001');
      const r = await t.pool.query('SELECT actor FROM record.record_event');
      expect(r.rows).toEqual([{ actor: 'system:test' }]);
    });
  });

  it('refuses UPDATE, DELETE and TRUNCATE for aisdlc_app (grants) but lets it append and read', async () => {
    await withRecordDb(async (t) => {
      const asApp = async <T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> =>
        withTransaction(t.pool, async (tx) => {
          await tx.query('SET LOCAL ROLE aisdlc_app');
          return fn(tx);
        });

      const appended = await asApp(async (tx) => {
        const r = await appendEvents(tx, 's', 0, [ev()], {
          outbox: [{ destination: 'd', payload: { a: 1 }, idempotency_key: 'o1' }],
        });
        expect(r.ok).toBe(true);
        const n = await tx.query('SELECT count(*)::int AS n FROM record.record_event');
        return (n.rows[0] as { n: number }).n;
      });
      expect(appended).toBe(1);

      for (const sql of [
        "UPDATE record.record_event SET actor = 'evil'",
        'DELETE FROM record.record_event',
        'TRUNCATE record.record_event',
        'DELETE FROM record.outbox',
      ]) {
        expect(await code(asApp((tx) => tx.query(sql))), sql).toBe('42501');
      }
      // Grants layer only: the role cannot even create objects in the schema.
      expect(await code(asApp((tx) => tx.query('CREATE TABLE record.x (a int)')))).toBe('42501');

      const privs = await t.pool.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'aisdlc_app' AND table_schema = 'record' AND table_name = 'record_event'
          ORDER BY privilege_type`,
      );
      expect(privs.rows).toEqual([{ privilege_type: 'INSERT' }, { privilege_type: 'SELECT' }]);
    });
  });

  it('keeps the global counter moving forward only and outbox payloads immutable', async () => {
    await withRecordDb(async (t) => {
      await appendCommitted(t.pool, 's', 0, [ev(), ev()]);
      expect(await code(t.pool.query('UPDATE record.global_counter SET last_seq = 1'))).toBe(
        '23001',
      );
      expect(await code(t.pool.query('DELETE FROM record.global_counter'))).toBe('23001');
      await withTransaction(t.pool, (tx) =>
        enqueueOutbox(tx, [{ destination: 'd', payload: { a: 1 }, idempotency_key: 'o1' }]),
      );
      expect(await code(t.pool.query(`UPDATE record.outbox SET payload = '{"a":2}'`))).toBe(
        '23001',
      );
      expect(await code(t.pool.query('DELETE FROM record.outbox'))).toBe('23001');
      expect(
        await code(t.pool.query('UPDATE record.outbox SET attempts = attempts + 1')),
      ).toBeUndefined();
    });
  });

  it('migrations are idempotent and the role survives a second database', async () => {
    await withRecordDb(async () => {
      await withRecordDb(async (t2) => {
        const r = await t2.pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'aisdlc_app'");
        expect(r.rowCount).toBe(1);
      });
    });
  });
});
