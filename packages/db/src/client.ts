import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

export type { Pool, PoolClient } from 'pg';

/**
 * A pool for one service. M19 (the Postgres failover drill): a failover drops every connection at once, and pg emits
 * the death of an IDLE connection as an `error` on the pool, which without a listener is an uncaught exception that
 * kills the process. Every pool therefore has a listener: the dead connection is dropped from the pool, the error's
 * class is logged (never its text, which can name the server), and the next query opens a fresh connection. A query
 * or transaction in flight still fails to its own caller (the server rolled it back), which retries or refuses.
 */
export function createPool(
  connectionString: string,
  max = 10,
  opts: { onError?: (e: Error) => void } = {},
): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on(
    'error',
    opts.onError ??
      ((e: Error) => {
        const code = (e as { code?: unknown }).code;
        console.error(
          `db pool: idle connection lost (${e.constructor.name}${typeof code === 'string' ? ` ${code}` : ''}); the next query reconnects`,
        );
      }),
  );
  return pool;
}

/** Drizzle handle over an existing pool. The pool stays owned by the caller. */
export function createDb(pool: pg.Pool) {
  return drizzle(pool);
}

export type Db = ReturnType<typeof createDb>;

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Runs `fn` in one transaction on one pooled connection: COMMIT when it resolves, ROLLBACK when it
 * throws (the error is rethrown). The connection is always released. A connection the server drops while it is
 * checked out (a failover) is an error to `fn`'s next query, never an uncaught exception, and is destroyed on
 * release instead of going back to the pool.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<T>,
  opts: { isolation?: IsolationLevel } = {},
): Promise<T> {
  const client = await pool.connect();
  let lost: Error | undefined;
  const onLost = (e: Error): void => {
    lost = e;
  };
  client.on('error', onLost);
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
    client.off('error', onLost);
    client.release(lost);
  }
}
