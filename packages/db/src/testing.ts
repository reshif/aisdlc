import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createDb, createPool, type Db } from './client.js';

/** Set by the Vitest globalSetup when it started a throwaway cluster. */
export const CLUSTER_URL_ENV = 'AISDLC_TEST_PG_URL';

export interface TestDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
  db: Db;
  /** Closes the pool and drops the database. Safe to call more than once. */
  drop(): Promise<void>;
}

function adminUrl(): string {
  const url = process.env['DATABASE_URL'] ?? process.env[CLUSTER_URL_ENV];
  if (!url) {
    throw new Error(
      `no Postgres available: set DATABASE_URL, or run under Vitest with the @aisdlc/db globalSetup (${CLUSTER_URL_ENV})`,
    );
  }
  return url;
}

function withDatabase(url: string, name: string): string {
  // Replace only the database name; WHATWG URL cannot hold a socket path host reliably, so edit text.
  const u = url.indexOf('?');
  const base = u === -1 ? url : url.slice(0, u);
  const query = u === -1 ? '' : url.slice(u);
  const slash = base.lastIndexOf('/');
  return `${base.slice(0, slash + 1)}${encodeURIComponent(name)}${query}`;
}

/** Creates a uniquely named empty database on the available server. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = adminUrl();
  const name = `aisdlc_t_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const adminPool = createPool(admin, 1);
  try {
    await adminPool.query(`CREATE DATABASE "${name}"`);
  } finally {
    await adminPool.end();
  }
  const url = withDatabase(admin, name);
  const pool = createPool(url, 5);
  let dropped = false;
  return {
    name,
    url,
    pool,
    db: createDb(pool),
    async drop() {
      if (dropped) return;
      dropped = true;
      await pool.end();
      const p = createPool(admin, 1);
      try {
        // pool.end() returns before the server has seen every Terminate message. Dropping with
        // FORCE in that window kills a half-closed connection, and node-pg then raises an
        // unhandled 'error' on it. Wait for the backends to leave first.
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const left = await p.query(
            'SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
            [name],
          );
          if (left.rowCount === 0) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        await p.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await p.end();
      }
    },
  };
}

/** Runs `fn` against a fresh database and always drops it afterwards. */
export async function withTestDatabase<T>(fn: (t: TestDatabase) => Promise<T>): Promise<T> {
  const t = await createTestDatabase();
  try {
    return await fn(t);
  } finally {
    await t.drop();
  }
}
