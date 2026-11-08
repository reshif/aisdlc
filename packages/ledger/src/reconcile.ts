import { ok, type Result } from '@aisdlc/kernel';
import type pg from 'pg';
import {
  confirmAll,
  importUnconfirmed,
  inLedgerTransaction,
  type LedgerClientDeps,
  type LedgerWriteError,
} from './writer.js';
import { lockLedger } from './rows.js';

export interface ReconcileReport {
  /** Rows that were missing and have been inserted (signed, never committed). */
  inserted: number;
  /** Notary journal entries moved to `committed`. */
  confirmed: number;
}

/**
 * The reconciler (PLAN M2.3), a function for a core-worker loop to call. It asks the Notary for
 * entries it signed but never saw committed, inserts the missing ledger rows (idempotent on
 * `ledger_seq` + `entry_hash`), then confirms them. It covers both crash points:
 *   - crash after `sign`, before the insert: the row is missing and is inserted here;
 *   - crash after the insert, before `confirm`: the row exists, the insert is a no-op, and the
 *     confirm completes.
 * It takes the same ledger lock as writers, so it never races one. A failure to confirm after the
 * rows are committed is returned as an error; running it again finishes the job.
 */
export async function reconcileLedger(
  pool: pg.Pool,
  deps: LedgerClientDeps,
): Promise<Result<ReconcileReport, LedgerWriteError>> {
  const imported = await inLedgerTransaction(pool, async (tx) => {
    await lockLedger(tx);
    return importUnconfirmed(tx, deps);
  });
  if (!imported.ok) return imported;
  const confirmed = await confirmAll(deps.notary, imported.value.pending);
  if (!confirmed.ok) return confirmed;
  return ok({ inserted: imported.value.inserted, confirmed: confirmed.value });
}
