import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, withTransaction } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

// M19, the Postgres failover drill (ADR-0003 §9 "Main Postgres failover"): to a client, a failover is every
// connection dropped at once (the old primary goes away) and new connections succeeding against the new one. A
// service pool must survive that: an idle connection the server kills must not crash the process (an unhandled
// `error` on a pg Pool is an uncaught exception), the next query must get a fresh connection, and a transaction cut
// in the middle must be an error to its caller (rolled back by the server), never a silent half-write.

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query('CREATE TABLE drill (n integer PRIMARY KEY)');
});
afterAll(async () => {
  await db?.drop();
});

/** What a failover does to the clients: every backend of the database, but the caller's, is terminated. */
async function failover(): Promise<number> {
  const r = await db.pool.query<{ n: string }>(
    `SELECT count(pg_terminate_backend(pid))::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

const settle = () => new Promise((r) => setTimeout(r, 100));

describe('a service pool across a failover', () => {
  it('idle connections killed by the server do not crash the process; the next query reconnects', async () => {
    const errors: string[] = [];
    const pool = createPool(db.url, 3, { onError: (e) => errors.push(e.constructor.name) });
    try {
      // three idle connections in the pool
      await Promise.all([1, 2, 3].map(() => pool.query('SELECT pg_sleep(0.05)')));
      expect(pool.idleCount).toBeGreaterThan(0);
      expect(await failover()).toBeGreaterThan(0);
      await settle();
      // the pool saw the deaths (and said so), and nothing threw
      expect(errors.length).toBeGreaterThan(0);
      const r = await pool.query<{ one: number }>('SELECT 1 AS one');
      expect(r.rows[0]?.one).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('a transaction cut by the failover fails to its caller and leaves nothing behind', async () => {
    const pool = createPool(db.url, 2, { onError: () => undefined });
    try {
      const cut = withTransaction(pool, async (tx) => {
        await tx.query('INSERT INTO drill (n) VALUES (1)');
        await failover();
        await tx.query('INSERT INTO drill (n) VALUES (2)');
      });
      await expect(cut).rejects.toThrow();
      await settle();
      const left = await pool.query<{ n: number }>('SELECT n FROM drill ORDER BY n');
      expect(left.rows).toEqual([]);
      // and the work, retried after the failover, lands once
      await withTransaction(pool, async (tx) => {
        await tx.query('INSERT INTO drill (n) VALUES (1)');
        await tx.query('INSERT INTO drill (n) VALUES (2)');
      });
      expect((await pool.query('SELECT n FROM drill')).rowCount).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it('the default error sink logs the error class only (never a connection string)', async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (l: unknown) => {
      lines.push(String(l));
    };
    const pool = createPool(db.url, 1);
    try {
      await pool.query('SELECT 1');
      await failover();
      await settle();
      expect(lines.some((l) => l.startsWith('db pool: idle connection lost'))).toBe(true);
      expect(lines.join('\n')).not.toContain(new URL(db.url).password || '\u0000');
    } finally {
      console.error = orig;
      await pool.end();
    }
  });
});
