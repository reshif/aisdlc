import { sha256Hex } from '@aisdlc/kernel';
import type { Executor } from '@aisdlc/record';

// Redaction of ledger entries for a deletion (owner decision 2026-11-13; docs/specs/deletion.md §2, §3). Only a
// member of `aisdlc_purge` may run these (the trigger of migration 0002 refuses everyone else and every other shape).
// The entry keeps its seq, id, prev_hash, entry_hash, Notary signature and created_at; `verifyLedger` with
// `allowRedacted` checks it by its stored hash, and the deletion's own `deletion.performed` entry names its seq.

/** The keys a person-redacted decision keeps: exactly what `foldDecisions` reads. */
export const ACTOR_REDACTION_KEPT_KEYS = [
  'kind',
  'superseded_by',
  'quorum_required',
  'approvals_after',
  'override',
] as const;

/** The stand-in actor of a deleted person: unlinkable to the person, stable within one deletion. */
export const deletedActorId = (deletionId: string, principal: string): string =>
  `deleted.${sha256Hex(`${deletionId}|${principal}`).slice(0, 16)}`;

/** Erases everything of the entries but their place in the chain. Returns how many were redacted. */
export async function redactEntriesFully(
  tx: Executor,
  deletionId: string,
  seqs: readonly number[],
  at: Date,
): Promise<number> {
  if (seqs.length === 0) return 0;
  const r = await tx.query(
    `UPDATE ledger.ledger_entry SET
       entry_type = 'redacted', gate_instance_id = NULL, gate_id = NULL, subject_kind = NULL,
       subject_id = NULL, subject_hash = NULL, decision = NULL, actor = NULL, sod_waiver = false,
       policy_bundle_version = 'redacted', body = '{}'::jsonb, redacted_at = $2, redaction_id = $3
     WHERE ledger_seq = ANY($1::bigint[]) AND entry_type <> 'redacted'`,
    [seqs.map(String), at, deletionId],
  );
  return r.rowCount ?? 0;
}

/**
 * A deleted person's decisions on something that stays: the actor becomes `deleted.<hash>` and the body keeps only
 * what the gate's fold reads (the override's reason erased), so a decided gate stays decided.
 */
export async function redactEntriesActor(
  tx: Executor,
  deletionId: string,
  principal: string,
  seqs: readonly number[],
  at: Date,
): Promise<number> {
  if (seqs.length === 0) return 0;
  const r = await tx.query(
    `UPDATE ledger.ledger_entry SET
       actor = $3,
       body = (SELECT coalesce(jsonb_object_agg(k, CASE WHEN k = 'override'
                       THEN jsonb_set(v, '{reason}', '"redacted"') ELSE v END), '{}'::jsonb)
                 FROM jsonb_each(body) AS e(k, v) WHERE k = ANY($4::text[])),
       redacted_at = $2, redaction_id = $5
     WHERE ledger_seq = ANY($1::bigint[]) AND redacted_at IS NULL`,
    [
      seqs.map(String),
      at,
      deletedActorId(deletionId, principal),
      [...ACTOR_REDACTION_KEPT_KEYS],
      deletionId,
    ],
  );
  return r.rowCount ?? 0;
}
