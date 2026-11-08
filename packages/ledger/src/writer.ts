import {
  LedgerEntry,
  LedgerEntryDraft,
  checkLedgerEntrySignature,
  computeLedgerEntryHash,
  draftOfEntry,
  ledgerDraftHash,
} from '@aisdlc/contracts';
import { err, ok, taggedError, type Jwk, type Result, type TaggedError } from '@aisdlc/kernel';
import { assembleLedgerEntry, type NotaryError, type NotaryPort } from '@aisdlc/ports';
import type { Executor } from '@aisdlc/record';
import type pg from 'pg';
import { inTransaction } from './tx.js';
import { LedgerConflict, insertLedgerEntry, lockLedger, readLedgerHead } from './rows.js';

export type LedgerWriteErrorCode =
  /** The draft fails the contract; nothing was sent. */
  | 'invalid_draft'
  /** The Notary refused or could not be reached. */
  | 'notary'
  /** The Notary answered with something that does not check out (wrong seq, hash or signature). */
  | 'notary_misbehaved'
  /** The record database and the Notary disagree about a stored entry. */
  | 'conflict'
  | 'database';

export const LedgerWriteError = taggedError('LedgerWriteError');
export type LedgerWriteError = TaggedError<
  'LedgerWriteError',
  { code: LedgerWriteErrorCode; message: string; notary?: NotaryError }
>;

const writeError = (
  code: LedgerWriteErrorCode,
  message: string,
  notary?: NotaryError,
): LedgerWriteError => LedgerWriteError({ code, message, ...(notary ? { notary } : {}) });

export interface LedgerClientDeps {
  notary: NotaryPort;
  /** The Notary's public key. When given, every signature is verified before a row is inserted. */
  notaryKey?: Jwk;
}

/** An entry the Notary has signed that must be confirmed after the surrounding transaction commits. */
export interface PendingConfirm {
  ledger_seq: number;
  entry_hash: string;
}

/** Checks what the Notary returned before it goes into the record: hash always, signature if keyed. */
async function checkSigned(e: LedgerEntry, deps: LedgerClientDeps): Promise<string | null> {
  if (deps.notaryKey) return checkLedgerEntrySignature(e, deps.notaryKey);
  const h = computeLedgerEntryHash(draftOfEntry(e), e.ledger_seq, e.prev_hash);
  return h === e.entry_hash ? null : 'entry_hash_mismatch';
}

/**
 * Inserts every entry the Notary has signed but not seen committed (a crash happened between its
 * `sign` and our `insert`, or between `insert` and `confirm`). Must run on a transaction that
 * holds the ledger lock. Returns what to confirm after COMMIT.
 */
export async function importUnconfirmed(
  tx: Executor,
  deps: LedgerClientDeps,
): Promise<Result<{ pending: PendingConfirm[]; inserted: number }, LedgerWriteError>> {
  const list = await deps.notary.unconfirmed();
  if (!list.ok) return err(writeError('notary', list.error.message, list.error));
  const pending: PendingConfirm[] = [];
  let inserted = 0;
  for (const e of list.value) {
    const parsed = LedgerEntry.safeParse(e);
    const bad = parsed.success ? await checkSigned(parsed.data, deps) : 'invalid_entry';
    if (!parsed.success || bad !== null) {
      return err(writeError('notary_misbehaved', `unconfirmed entry ${e.ledger_seq}: ${bad}`));
    }
    try {
      if ((await insertLedgerEntry(tx, parsed.data)) === 'inserted') inserted += 1;
    } catch (cause) {
      if (LedgerConflict.is(cause)) {
        return err(writeError('conflict', `entry ${e.ledger_seq} differs from the Notary's`));
      }
      throw cause;
    }
    pending.push({ ledger_seq: e.ledger_seq, entry_hash: e.entry_hash });
  }
  return ok({ pending, inserted });
}

/** Tells the Notary these entries are committed. Idempotent; stops at the first failure. */
export async function confirmAll(
  notary: NotaryPort,
  pending: readonly PendingConfirm[],
): Promise<Result<number, LedgerWriteError>> {
  let n = 0;
  for (const p of pending) {
    const r = await notary.confirm(p);
    if (!r.ok) return err(writeError('notary', r.error.message, r.error));
    n += 1;
  }
  return ok(n);
}

/**
 * Appends one entry to the ledger inside the caller's transaction:
 *   lock the ledger, import anything the Notary signed that we do not have, read the head,
 *   `reserve` with the head hash, `sign`, check the answer, insert the row.
 * The ledger lock is an advisory transaction lock, so concurrent writers queue behind it and each
 * sees the previous writer's committed head; entries are chained in lock order. It is held until
 * the caller commits or rolls back, so keep the transaction short.
 *
 * The caller must COMMIT and only then call `confirmAll(notary, pending)`. If the process dies
 * after the Notary signed and before COMMIT, the signed entry is found by the next writer or by
 * the reconciler, never lost and never signed twice. On an error return roll the transaction back.
 */
export async function appendLedgerEntryTx(
  tx: Executor,
  deps: LedgerClientDeps,
  draftInput: LedgerEntryDraft,
): Promise<Result<{ entry: LedgerEntry; pending: PendingConfirm[] }, LedgerWriteError>> {
  const draft = LedgerEntryDraft.safeParse(draftInput);
  if (!draft.success) return err(writeError('invalid_draft', draft.error.message));

  await lockLedger(tx);
  const caught = await importUnconfirmed(tx, deps);
  if (!caught.ok) return caught;

  const head = await readLedgerHead(tx);
  const reserved = await deps.notary.reserve({
    prev_hash: head?.entry_hash ?? null,
    body_hash: ledgerDraftHash(draft.data),
  });
  if (!reserved.ok) return err(writeError('notary', reserved.error.message, reserved.error));
  const seq = reserved.value.ledger_seq;
  if (seq !== (head?.ledger_seq ?? 0) + 1) {
    return err(writeError('notary_misbehaved', `reserved seq ${seq} does not follow the head`));
  }

  const signed = await deps.notary.sign({ ledger_seq: seq, draft: draft.data });
  if (!signed.ok) return err(writeError('notary', signed.error.message, signed.error));
  const entry = assembleLedgerEntry(draft.data, signed.value);
  const parsed = LedgerEntry.safeParse(entry);
  const bad = parsed.success ? await checkSigned(parsed.data, deps) : 'invalid_entry';
  if (
    !parsed.success ||
    bad !== null ||
    entry.ledger_seq !== seq ||
    entry.prev_hash !== (head?.entry_hash ?? null)
  ) {
    return err(writeError('notary_misbehaved', `signed entry ${seq} does not check out: ${bad}`));
  }

  await insertLedgerEntry(tx, entry);
  return ok({
    entry,
    pending: [...caught.value.pending, { ledger_seq: seq, entry_hash: entry.entry_hash }],
  });
}

/** `inTransaction` on the record database; a thrown database error is code `database`. */
export function inLedgerTransaction<T>(
  pool: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<Result<T, LedgerWriteError>>,
): Promise<Result<T, LedgerWriteError>> {
  return inTransaction(pool, fn, (e) =>
    writeError('database', e instanceof Error ? e.message : String(e)),
  );
}

/**
 * `appendLedgerEntryTx` in its own transaction, then COMMIT, then confirm. Returns the committed
 * entry. If only the final confirm fails the entry is still committed; the error says so and the
 * reconciler will confirm it later.
 */
export async function appendLedgerEntry(
  pool: pg.Pool,
  deps: LedgerClientDeps,
  draft: LedgerEntryDraft,
): Promise<Result<LedgerEntry, LedgerWriteError>> {
  const done = await inLedgerTransaction(pool, (tx) => appendLedgerEntryTx(tx, deps, draft));
  if (!done.ok) return done;
  const confirmed = await confirmAll(deps.notary, done.value.pending);
  return confirmed.ok ? ok(done.value.entry) : confirmed;
}
