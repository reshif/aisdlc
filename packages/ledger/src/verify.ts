import {
  Checkpoint,
  checkCheckpointSignature,
  checkLedgerEntrySignature,
  type LedgerEntry,
} from '@aisdlc/contracts';
import { MerkleFrontier, err, ok, type Jwk, type Result } from '@aisdlc/kernel';
import { hexBytes } from '@aisdlc/ports';
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
  | 'head_uncovered';

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
}

export interface VerifyKeys {
  notary: Jwk;
  witness: Jwk;
}

export interface VerifyOptions {
  /** Accept entries after the latest checkpoint (a live ledger up to one interval behind). */
  allowUncoveredTail?: boolean;
  batchSize?: number;
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
  let prev: LedgerEntry | null = null;
  let nextCp = 0;
  let after = 0;
  for (;;) {
    const q = await db.query<LedgerEntryRow>(
      `SELECT ${LEDGER_ENTRY_COLUMNS} FROM ledger.ledger_entry
        WHERE ledger_seq > $1 ORDER BY ledger_seq LIMIT $2`,
      [after, batch],
    );
    if (q.rows.length === 0) break;
    for (const row of q.rows) {
      const seq = Number(row.ledger_seq);
      const expected = (prev?.ledger_seq ?? 0) + 1;
      if (seq !== expected) {
        return fail({
          code: 'gap',
          ledger_seq: seq,
          message: `entry ${expected} is missing (next stored is ${seq})`,
        });
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
  return ok({ entries: head, checkpoints: cps.length, head_seq: head, covered_to: covered });
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
