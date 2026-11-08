import { systemClock, type Clock, type Result } from '@aisdlc/kernel';
import { inTransaction } from '@aisdlc/ledger';
import type pg from 'pg';
import { identityError, type IdentityError } from './errors.js';
import { Journal } from './journal.js';

/** What the writer needs: the record database and a clock. The ledger is the access-sync loop's. */
export interface IdentityDeps {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
}

/** The key every identity writer takes first. */
export const WRITERS_KEY = 'aisdlc.identity:writers';

export const clockOf = (d: { readonly clock?: Clock }): Clock => d.clock ?? systemClock;

/**
 * Runs `fn` in one transaction on the record database with a `Journal`. An `Err` or a throw rolls
 * everything back. Identity writes never touch the ledger (the access-sync loop does, later).
 *
 * LOCK ORDER: the writers lock first (shared for a command on one aggregate, exclusive for an
 * operation that reaches many: the role map reconcile and the IdP sync), then the aggregate keys
 * (`lockKeys`, sorted), then the record's global counter, which the first append takes and holds
 * to COMMIT. Because a many-aggregate operation excludes every other writer up front, it can take
 * the keys it finds it needs as it goes without risk of a deadlock against the counter.
 */
export function inIdentityTx<T>(
  deps: IdentityDeps,
  fn: (j: Journal, tx: pg.PoolClient) => Promise<Result<T, IdentityError>>,
  opts: { exclusive?: boolean } = {},
): Promise<Result<T, IdentityError>> {
  return inTransaction(
    deps.pool,
    async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock${opts.exclusive ? '' : '_shared'}(hashtext($1))`,
        [WRITERS_KEY],
      );
      return fn(new Journal(tx, clockOf(deps)), tx);
    },
    (e) => identityError('database', e instanceof Error ? e.message : String(e)),
  );
}
