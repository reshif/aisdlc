import {
  Checkpoint,
  DELETION_ENTRY_TYPE,
  DeletionPerformedBody,
  LEDGER_SIGNATURE_ALG,
  checkCheckpointSignature,
  checkLedgerEntrySignature,
  type LedgerEntry,
} from '@aisdlc/contracts';
import { MerkleFrontier, err, ok, type Jwk, type Result } from '@aisdlc/kernel';
import { es256VerifyDigest, hexBytes } from '@aisdlc/ports';
import type { Executor } from '@aisdlc/record';
import {
  LEDGER_ENTRY_COLUMNS,
  toCheckpointInput,
  toLedgerEntry,
  type CheckpointRow,
  type LedgerEntryRow,
} from './rows.js';

export type VerifyFailureCode =
  | 'entry_invalid'
  | 'gap'
  | 'chain_break'
  | 'entry_hash'
  | 'notary_signature'
  | 'checkpoint_invalid'
  | 'checkpoint_seq'
  | 'checkpoint_range'
  | 'checkpoint_root'
  | 'checkpoint_head'
  | 'checkpoint_signers'
  | 'checkpoint_signature'
  | 'head_uncovered'
  /** A redacted entry, and the verification was not asked to accept redacted entries. */
  | 'redacted'
  /** A redacted entry that no later, verified `deletion.performed` entry names. */
  | 'redaction_unaccounted';

export interface VerifyFailure {
  code: VerifyFailureCode;
  message: string;
  ledger_seq?: number;
  cp_seq?: number;
}

export interface VerifyReport {
  entries: number;
  checkpoints: number;
  /** Highest ledger_seq, 0 for an empty ledger. */
  head_seq: number;
  /** `to_ledger_seq` of the latest checkpoint, 0 if none. */
  covered_to: number;
  /** Entries verified by their stored hash only (content erased by a deletion). */
  redacted: number;
}

export interface VerifyKeys {
  notary: Jwk;
  witness: Jwk;
}

export interface VerifyOptions {
  /** Accept entries after the latest checkpoint (a live ledger up to one interval behind). */
  allowUncoveredTail?: boolean;
  /**
   * Accept entries redacted by a deletion (docs/specs/deletion.md §2): such an entry is checked by its stored hash
   * (its link, its Notary signature over that hash, its place in every checkpoint's Merkle root), and must be named
   * by a later `deletion.performed` entry that verifies in full. Without it, any redacted entry fails.
   */
  allowRedacted?: boolean;
  batchSize?: number;
}

interface RedactableRow extends LedgerEntryRow {
  redacted_at: Date | null;
}

const fail = (f: VerifyFailure): Result<never, VerifyFailure> => err(f);

/**
 * Verifies the whole ledger offline, from a read-only connection and the two public keys, and
 * stops at the first failure:
 *   - entries 1..n have no gap, each `prev_hash` is the previous `entry_hash`;
 *   - each `entry_hash` is the hash of its fields, and each Notary signature verifies;
 *   - each checkpoint is well-formed, numbered 1.., covers 1..to, its Merkle root equals the root
 *     recomputed over entries 1..to, its head_hash is entry `to`, and it carries one valid
 *     Notary and one valid Witness signature;
 *   - the latest checkpoint covers the head (unless `allowUncoveredTail`).
 * It trusts nothing in the database and nothing but the two keys it is given.
 */
export async function verifyLedger(
  db: Executor,
  keys: VerifyKeys,
  opts: VerifyOptions = {},
): Promise<Result<VerifyReport, VerifyFailure>> {
  const batch = opts.batchSize ?? 500;

  // Checkpoints first (few), so each can be checked as the walk reaches its entry.
  const cpRows = await db.query<CheckpointRow>('SELECT * FROM ledger.checkpoint ORDER BY cp_seq');
  const cps: Checkpoint[] = [];
  for (const r of cpRows.rows) {
    const parsed = Checkpoint.safeParse(toCheckpointInput(r));
    if (!parsed.success) {
      return fail({
        code: 'checkpoint_invalid',
        cp_seq: Number(r.cp_seq),
        message: `checkpoint ${r.cp_seq} is not a valid checkpoint: ${parsed.error.message}`,
      });
    }
    const c = parsed.data;
    if (c.cp_seq !== cps.length + 1) {
      return fail({
        code: 'checkpoint_seq',
        cp_seq: c.cp_seq,
        message: `checkpoint numbers must run 1, 2, 3, ...; found ${c.cp_seq} after ${cps.length}`,
      });
    }
    const prev = cps[cps.length - 1];
    if (c.from_ledger_seq !== 1 || (prev && c.to_ledger_seq < prev.to_ledger_seq)) {
      return fail({
        code: 'checkpoint_range',
        cp_seq: c.cp_seq,
        message: `checkpoint ${c.cp_seq} must cover entries from 1 and never shrink`,
      });
    }
    cps.push(c);
  }

  const frontier = new MerkleFrontier();
  let prev: { ledger_seq: number; entry_hash: string } | null = null;
  /** Redacted seqs, and the seq of the deletion entry that names each. */
  const redactedSeqs: number[] = [];
  const accountedBy = new Map<number, number>();
  let nextCp = 0;
  let after = 0;
  for (;;) {
    const q = await db.query<RedactableRow>(
      `SELECT ${LEDGER_ENTRY_COLUMNS}, redacted_at FROM ledger.ledger_entry
        WHERE ledger_seq > $1 ORDER BY ledger_seq LIMIT $2`,
      [after, batch],
    );
    if (q.rows.length === 0) break;
    for (const row of q.rows) {
      const seq = Number(row.ledger_seq);
      const expected: number = (prev?.ledger_seq ?? 0) + 1;
      if (seq !== expected) {
        return fail({
          code: 'gap',
          ledger_seq: seq,
          message: `entry ${expected} is missing (next stored is ${seq})`,
        });
      }
      if (row.redacted_at !== null) {
        if (!opts.allowRedacted) {
          return fail({
            code: 'redacted',
            ledger_seq: seq,
            message: `entry ${seq} was redacted by a deletion (verify with --allow-redacted)`,
          });
        }
        const bad = checkRedacted(row, prev?.entry_hash ?? null, keys.notary);
        if (bad) return fail({ ...bad, ledger_seq: seq });
        redactedSeqs.push(seq);
        frontier.append(hexBytes(row.entry_hash));
        prev = { ledger_seq: seq, entry_hash: row.entry_hash };
        after = seq;
        while (cps[nextCp] && (cps[nextCp] as Checkpoint).to_ledger_seq === seq) {
          const c = cps[nextCp] as Checkpoint;
          const r = await checkCheckpoint(c, frontier.root(), row.entry_hash, keys);
          if (r) return fail(r);
          nextCp += 1;
        }
        continue;
      }
      let e: LedgerEntry;
      try {
        e = toLedgerEntry(row);
      } catch (cause) {
        return fail({
          code: 'entry_invalid',
          ledger_seq: seq,
          message: `entry ${seq} is not a valid ledger entry: ${String(cause).slice(0, 200)}`,
        });
      }
      if (e.prev_hash !== (prev?.entry_hash ?? null)) {
        return fail({
          code: 'chain_break',
          ledger_seq: seq,
          message: `entry ${seq} does not link to entry ${seq - 1}: its prev_hash is not that entry's hash`,
        });
      }
      const bad = await checkLedgerEntrySignature(e, keys.notary);
      if (bad === 'entry_hash_mismatch') {
        return fail({
          code: 'entry_hash',
          ledger_seq: seq,
          message: `entry ${seq}: entry_hash does not match its content (the row was altered)`,
        });
      }
      if (bad !== null) {
        return fail({
          code: 'notary_signature',
          ledger_seq: seq,
          message: `entry ${seq}: Notary signature rejected (${bad})`,
        });
      }
      frontier.append(hexBytes(e.entry_hash));
      prev = e;
      after = seq;
      if (e.entry_type === DELETION_ENTRY_TYPE) {
        const d = DeletionPerformedBody.safeParse(e.body);
        if (d.success) {
          for (const r of d.data.redacted_ledger_seqs) {
            if (r < seq && !accountedBy.has(r)) accountedBy.set(r, seq);
          }
        }
      }

      while (cps[nextCp] && (cps[nextCp] as Checkpoint).to_ledger_seq === seq) {
        const c = cps[nextCp] as Checkpoint;
        const r = await checkCheckpoint(c, frontier.root(), e.entry_hash, keys);
        if (r) return fail(r);
        nextCp += 1;
      }
    }
  }

  if (nextCp < cps.length) {
    const c = cps[nextCp] as Checkpoint;
    return fail({
      code: 'checkpoint_range',
      cp_seq: c.cp_seq,
      message: `checkpoint ${c.cp_seq} covers entry ${c.to_ledger_seq}, beyond the head (${prev?.ledger_seq ?? 0})`,
    });
  }
  for (const r of redactedSeqs) {
    if (!accountedBy.has(r)) {
      return fail({
        code: 'redaction_unaccounted',
        ledger_seq: r,
        message: `entry ${r} is redacted but no later deletion.performed entry names it`,
      });
    }
  }
  const head = prev?.ledger_seq ?? 0;
  const covered = cps[cps.length - 1]?.to_ledger_seq ?? 0;
  if (head > 0 && covered !== head && !opts.allowUncoveredTail) {
    return fail({
      code: 'head_uncovered',
      ledger_seq: head,
      message:
        covered === 0
          ? `no checkpoint covers the ledger head (entry ${head})`
          : `the latest checkpoint covers entry ${covered} but the head is entry ${head}`,
    });
  }
  return ok({
    entries: head,
    checkpoints: cps.length,
    head_seq: head,
    covered_to: covered,
    redacted: redactedSeqs.length,
  });
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A redacted entry, by its stored hash: it links to the entry before it, and the Notary's signature verifies over
 * its `entry_hash` (the digest the Notary signed). Its content cannot be checked: that is what was deleted.
 */
function checkRedacted(
  row: RedactableRow,
  prevHash: string | null,
  notary: Jwk,
): Omit<VerifyFailure, 'ledger_seq'> | null {
  const seq = Number(row.ledger_seq);
  if (!HEX64.test(row.entry_hash) || (row.prev_hash !== null && !HEX64.test(row.prev_hash))) {
    return { code: 'entry_invalid', message: `entry ${seq}: redacted entry with a malformed hash` };
  }
  if (row.prev_hash !== prevHash) {
    return {
      code: 'chain_break',
      message: `entry ${seq} does not link to entry ${seq - 1}: its prev_hash is not that entry's hash`,
    };
  }
  if (
    row.notary_alg !== LEDGER_SIGNATURE_ALG ||
    (notary.kid !== undefined && notary.kid !== row.notary_key_id) ||
    !es256VerifyDigest(notary, hexBytes(row.entry_hash), row.notary_sig)
  ) {
    return {
      code: 'notary_signature',
      message: `entry ${seq}: Notary signature over the stored hash of a redacted entry rejected`,
    };
  }
  return null;
}

async function checkCheckpoint(
  c: Checkpoint,
  root: string,
  headHash: string,
  keys: VerifyKeys,
): Promise<VerifyFailure | null> {
  if (c.root_hash !== root) {
    return {
      code: 'checkpoint_root',
      cp_seq: c.cp_seq,
      message: `checkpoint ${c.cp_seq}: Merkle root differs from the root over entries 1..${c.to_ledger_seq} (history differs from what was checkpointed)`,
    };
  }
  if (c.head_hash !== headHash) {
    return {
      code: 'checkpoint_head',
      cp_seq: c.cp_seq,
      message: `checkpoint ${c.cp_seq}: head_hash is not the hash of entry ${c.to_ledger_seq}`,
    };
  }
  for (const signer of ['notary', 'witness'] as const) {
    const sigs = c.signatures.filter((s) => s.signer === signer);
    if (sigs.length !== 1) {
      return {
        code: 'checkpoint_signers',
        cp_seq: c.cp_seq,
        message: `checkpoint ${c.cp_seq} needs exactly one ${signer} signature, has ${sigs.length}`,
      };
    }
    const bad = await checkCheckpointSignature(
      c,
      (sigs[0] as (typeof sigs)[number]).signature,
      keys[signer],
    );
    if (bad !== null) {
      return {
        code: 'checkpoint_signature',
        cp_seq: c.cp_seq,
        message: `checkpoint ${c.cp_seq}: ${signer} signature rejected (${bad})`,
      };
    }
  }
  return null;
}
