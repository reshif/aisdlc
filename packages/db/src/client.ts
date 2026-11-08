import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

export type { Pool, PoolClient } from 'pg';

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

/** Drizzle handle over an existing pool. The pool stays owned by the caller. */
export function createDb(pool: pg.Pool) {
  return drizzle(pool);
}

export type Db = ReturnType<typeof createDb>;

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Runs `fn` in one transaction on one pooled connection: COMMIT when it resolves, ROLLBACK when it
 * throws (the error is rethrown). The connection is always released.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<T>,
  opts: { isolation?: IsolationLevel } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
    let value: T;
    try {
      value = await fn(client);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
    await client.query('COMMIT');
    return value;
  } finally {
    client.release();
  }
}
