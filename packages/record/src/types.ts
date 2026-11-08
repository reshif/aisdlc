import type pg from 'pg';

/**
 * Anything that runs SQL: a pooled client inside a transaction (what the write paths want) or a
 * pool (fine for read-only helpers). `appendEvents` and the outbox writers must be given a
 * transaction client, never a pool, or their statements would not be atomic.
 */
export interface Executor {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/** A transaction client (`withTransaction` from `@aisdlc/db` hands one out). */
export type Tx = Executor;

export type JsonObject = Record<string, unknown>;
