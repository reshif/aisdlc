import type { Executor } from './types.js';

// The record's purge path (owner decision 2026-11-13, "delete means delete"; docs/specs/deletion.md §2, §4). Only a
// transaction that ran `SET LOCAL ROLE aisdlc_purge` may call these: migration 0005's trigger refuses everyone else.
//   - removeEvents: a stream that is all the deleted object's goes, row by row, each position first written to
//     `record.purged_event` (the trigger refuses a delete that is not accounted for), so `verifyAll` can tell a
//     purge from a deleted row;
//   - redactEvents: an event of the object in someone else's stream is erased in place, its link and hash kept.

/** The role a purge transaction takes. */
export const PURGE_ROLE = 'aisdlc_purge';

/** Takes the purge role for the rest of the transaction. Throws when the login is not a member (fail closed). */
export async function enterPurgeRole(tx: Executor): Promise<void> {
  await tx.query(`SET LOCAL ROLE ${PURGE_ROLE}`);
}

/** Removes the events at these global positions. Returns how many were removed. */
export async function removeEvents(
  tx: Executor,
  deletionId: string,
  globalSeqs: readonly number[],
  at: Date,
): Promise<number> {
  if (globalSeqs.length === 0) return 0;
  const seqs = globalSeqs.map(String);
  await tx.query(
    `INSERT INTO record.purged_event (global_seq, deletion_id, purged_at)
     SELECT g, $2, $3 FROM unnest($1::bigint[]) AS g ON CONFLICT DO NOTHING`,
    [seqs, deletionId, at],
  );
  const r = await tx.query('DELETE FROM record.record_event WHERE global_seq = ANY($1::bigint[])', [
    seqs,
  ]);
  return r.rowCount ?? 0;
}

/** Erases the events at these global positions in place. Returns how many were redacted. */
export async function redactEvents(
  tx: Executor,
  globalSeqs: readonly number[],
  at: Date,
): Promise<number> {
  if (globalSeqs.length === 0) return 0;
  const r = await tx.query(
    `UPDATE record.record_event
        SET type = 'redacted', body = '{}'::jsonb, actor = 'redacted', idempotency_key = NULL,
            redacted_at = $2
      WHERE global_seq = ANY($1::bigint[]) AND redacted_at IS NULL`,
    [globalSeqs.map(String), at],
  );
  return r.rowCount ?? 0;
}
