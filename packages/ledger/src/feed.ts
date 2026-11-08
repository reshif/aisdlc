import type { LedgerEntry } from '@aisdlc/contracts';
import type { Executor, ProjectionFeed } from '@aisdlc/record';
import {
  LEDGER_ENTRY_COLUMNS,
  readLedgerHead,
  toLedgerEntry,
  type LedgerEntryRow,
} from './rows.js';

/**
 * The ledger as a projection feed (PLAN M2.5, M3.1): a read model that folds ledger entries as well
 * as record events lists this in `Projection.feeds`, so the rebuild harness drops and refolds it
 * from both authoritative sources. Positions are `ledger_seq`, which the chain trigger keeps dense.
 *
 * Only committed rows are visible. An entry the Notary signed whose caller transaction rolled back
 * appears here once the reconciler (or the next writer) inserts it, and the projection then catches
 * up on its next run.
 */
export const ledgerFeed: ProjectionFeed<LedgerEntry> = {
  name: 'ledger',
  async read(db: Executor, after: number, limit: number) {
    const q = await db.query<LedgerEntryRow>(
      `SELECT ${LEDGER_ENTRY_COLUMNS} FROM ledger.ledger_entry
        WHERE ledger_seq > $1 ORDER BY ledger_seq LIMIT $2`,
      [after, limit],
    );
    return q.rows.map((r) => ({ seq: Number(r.ledger_seq), item: toLedgerEntry(r) }));
  },
  async head(db: Executor) {
    return (await readLedgerHead(db))?.ledger_seq ?? 0;
  },
};
