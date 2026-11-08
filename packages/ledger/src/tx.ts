import { withTransaction } from '@aisdlc/db';
import { err, ok, type Result } from '@aisdlc/kernel';
import type pg from 'pg';

/**
 * Runs `fn` in a transaction. An `err` result rolls the transaction back, as does a thrown error,
 * which `onThrow` turns into the caller's error type.
 */
export async function inTransaction<T, E>(
  pool: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<Result<T, E>>,
  onThrow: (e: unknown) => E,
): Promise<Result<T, E>> {
  class Refused extends Error {
    constructor(readonly error: E) {
      super('refused');
    }
  }
  try {
    return ok(
      await withTransaction(pool, async (tx) => {
        const r = await fn(tx);
        if (!r.ok) throw new Refused(r.error); // roll back
        return r.value;
      }),
    );
  } catch (e) {
    return err(e instanceof Refused ? e.error : onThrow(e));
  }
}
