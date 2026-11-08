import { Checkpoint as CheckpointSchema, LedgerEntry } from '@aisdlc/contracts';
import type { Checkpoint } from '@aisdlc/contracts';
import { taggedError, type TaggedError } from '@aisdlc/kernel';
import type { Executor } from '@aisdlc/record';

export const LEDGER_ENTRY_COLUMNS = `ledger_seq, entry_id, entry_type, gate_instance_id, gate_id,
  subject_kind, subject_id, subject_hash, decision, actor, sod_waiver, policy_bundle_version, body,
  prev_hash, entry_hash, notary_key_id, notary_alg, notary_sig, created_at`;

export interface LedgerEntryRow {
  ledger_seq: string;
  entry_id: string;
  entry_type: string;
  gate_instance_id: string | null;
  gate_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  subject_hash: string | null;
  decision: string | null;
  actor: string | null;
  sod_waiver: boolean;
  policy_bundle_version: string;
  body: Record<string, unknown>;
  prev_hash: string | null;
  entry_hash: string;
  notary_key_id: string;
  notary_alg: string;
  notary_sig: string;
  created_at: Date;
}

/** The contract-checked entry for a row. Throws a ZodError if the row is not a valid entry. */
export function toLedgerEntry(r: LedgerEntryRow): LedgerEntry {
  return LedgerEntry.parse({
    entry_id: r.entry_id,
    ledger_seq: Number(r.ledger_seq),
    entry_type: r.entry_type,
    gate_instance_id: r.gate_instance_id,
    gate_id: r.gate_id,
    subject_kind: r.subject_kind,
    subject_id: r.subject_id,
    subject_hash: r.subject_hash,
    decision: r.decision,
    actor: r.actor,
    sod_waiver: r.sod_waiver,
    policy_bundle_version: r.policy_bundle_version,
    body: r.body,
    prev_hash: r.prev_hash,
    entry_hash: r.entry_hash,
    notary: { key_id: r.notary_key_id, alg: r.notary_alg, value: r.notary_sig },
    created_at: r.created_at.toISOString(),
  });
}

/** An entry for this seq is stored with a different hash: the Notary and the record disagree. */
export const LedgerConflict = taggedError('LedgerConflict');
export type LedgerConflict = TaggedError<
  'LedgerConflict',
  { ledger_seq: number; stored_hash: string; offered_hash: string }
>;

/**
 * Inserts an entry. Idempotent on `ledger_seq` + `entry_hash`: the same entry again is a no-op
 * ('exists'); a different entry for a stored seq throws `LedgerConflict` (fail closed). The chain
 * trigger refuses an entry that does not extend the head. Call it with a transaction client that
 * holds the ledger lock (see `lockLedger`).
 */
export async function insertLedgerEntry(
  tx: Executor,
  e: LedgerEntry,
): Promise<'inserted' | 'exists'> {
  const have = await tx.query<{ entry_hash: string }>(
    'SELECT entry_hash FROM ledger.ledger_entry WHERE ledger_seq = $1',
    [e.ledger_seq],
  );
  const stored = have.rows[0];
  if (stored) {
    if (stored.entry_hash === e.entry_hash) return 'exists';
    throw LedgerConflict({
      ledger_seq: e.ledger_seq,
      stored_hash: stored.entry_hash,
      offered_hash: e.entry_hash,
    });
  }
  await tx.query(
    `INSERT INTO ledger.ledger_entry (${LEDGER_ENTRY_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      e.ledger_seq,
      e.entry_id,
      e.entry_type,
      e.gate_instance_id,
      e.gate_id,
      e.subject_kind,
      e.subject_id,
      e.subject_hash,
      e.decision,
      e.actor,
      e.sod_waiver,
      e.policy_bundle_version,
      JSON.stringify(e.body),
      e.prev_hash,
      e.entry_hash,
      e.notary.key_id,
      e.notary.alg,
      e.notary.value,
      e.created_at,
    ],
  );
  return 'inserted';
}

/** The head: the last committed entry, or null for an empty ledger. */
export async function readLedgerHead(
  tx: Executor,
): Promise<{ ledger_seq: number; entry_hash: string } | null> {
  const q = await tx.query<{ ledger_seq: string; entry_hash: string }>(
    'SELECT ledger_seq, entry_hash FROM ledger.ledger_entry ORDER BY ledger_seq DESC LIMIT 1',
  );
  const r = q.rows[0];
  return r ? { ledger_seq: Number(r.ledger_seq), entry_hash: r.entry_hash } : null;
}

/** Entries `fromSeq`..`toSeq` inclusive, ascending. */
export async function readLedgerEntries(
  db: Executor,
  fromSeq: number,
  toSeq: number,
): Promise<LedgerEntry[]> {
  const q = await db.query<LedgerEntryRow>(
    `SELECT ${LEDGER_ENTRY_COLUMNS} FROM ledger.ledger_entry
      WHERE ledger_seq BETWEEN $1 AND $2 ORDER BY ledger_seq`,
    [fromSeq, toSeq],
  );
  return q.rows.map(toLedgerEntry);
}

interface CheckpointRow {
  cp_seq: string;
  from_ledger_seq: string;
  to_ledger_seq: string;
  root_hash: string;
  head_hash: string;
  signatures: Checkpoint['signatures'];
  created_at: Date;
}

export function toCheckpointInput(r: CheckpointRow): unknown {
  return {
    cp_seq: Number(r.cp_seq),
    from_ledger_seq: Number(r.from_ledger_seq),
    to_ledger_seq: Number(r.to_ledger_seq),
    root_hash: r.root_hash,
    head_hash: r.head_hash,
    signatures: r.signatures,
    created_at: r.created_at.toISOString(),
  };
}

export type { CheckpointRow };

/** Inserts a checkpoint; the chain trigger enforces cp_seq, growth and the head hash. */
export async function insertCheckpoint(tx: Executor, c: Checkpoint): Promise<void> {
  await tx.query(
    `INSERT INTO ledger.checkpoint
       (cp_seq, from_ledger_seq, to_ledger_seq, root_hash, head_hash, signatures, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      c.cp_seq,
      c.from_ledger_seq,
      c.to_ledger_seq,
      c.root_hash,
      c.head_hash,
      JSON.stringify(c.signatures),
      c.created_at,
    ],
  );
}

/** The last checkpoint, or null. */
export async function readLastCheckpoint(db: Executor): Promise<Checkpoint | null> {
  const q = await db.query<CheckpointRow>(
    'SELECT * FROM ledger.checkpoint ORDER BY cp_seq DESC LIMIT 1',
  );
  const r = q.rows[0];
  return r ? CheckpointSchema.parse(toCheckpointInput(r)) : null;
}

/** Serialises everything that appends to the ledger: held until the transaction ends. */
export async function lockLedger(tx: Executor): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('aisdlc.ledger.append'))");
}

export async function lockCheckpointing(tx: Executor): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('aisdlc.ledger.checkpoint'))");
}
