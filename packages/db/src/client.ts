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
