import { err, ok, type Result } from '@aisdlc/kernel';
import { confirmAll, inTransaction, type PendingConfirm } from '@aisdlc/ledger';
import { enterLedger, type DecisionDeps, type Written } from '@aisdlc/decisions';
import type pg from 'pg';
import { configError, type ConfigError } from './errors.js';

export interface TxOutcome<T> {
  readonly value: T;
  readonly pending: readonly PendingConfirm[];
}

/**
 * `inDecisionTx` for config: one transaction on the record database; then, after COMMIT, confirm the
 * entries the Notary signed during it (the ones `enter` imported). An `Err` or a throw rolls back.
 */
export async function inConfigTx<T>(
  deps: DecisionDeps,
  fn: (tx: pg.PoolClient) => Promise<Result<TxOutcome<T>, ConfigError>>,
): Promise<Result<Written<T>, ConfigError>> {
  const done = await inTransaction(deps.pool, fn, (e) =>
    configError('database', e instanceof Error ? e.message : String(e)),
  );
  if (!done.ok) return done;
  const confirmed = await confirmAll(deps.ledger.notary, done.value.pending);
  return ok({ ...(done.value.value as object), confirmed: confirmed.ok } as Written<T>);
}

/** The ledger lock and an import of anything the Notary signed that the record lacks (lock order). */
export async function enter(
  tx: pg.PoolClient,
  deps: DecisionDeps,
): Promise<Result<readonly PendingConfirm[], ConfigError>> {
  const r = await enterLedger(tx, deps);
  return r.ok ? ok(r.value) : err(configError('decision', r.error.message, r.error));
}
