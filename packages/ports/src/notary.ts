import {
  LedgerEntry,
  LedgerEntryDraft,
  LEDGER_SIGNATURE_ALG,
  checkLedgerEntrySignature,
  checkpointDigestHex,
  computeLedgerEntryHash,
  ledgerDraftHash,
  type CheckpointCore,
  type Signature,
} from '@aisdlc/contracts';
import {
  b64urlEncode,
  err,
  merkleRoot,
  ok,
  taggedError,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';
import type { KeyCustodyPort } from './key-custody.js';

export type NotaryErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_request'
  /** The draft fails the `LedgerEntryDraft` contract. */
  | 'invalid_entry'
  /** `prev_hash` is not the `entry_hash` of the last entry the Notary signed. */
  | 'prev_hash_mismatch'
  /** No open reservation for this seq. */
  | 'not_reserved'
  /** An entry for this seq is already signed. */
  | 'seq_already_signed'
  /** The draft is not the one that was reserved. */
  | 'body_mismatch'
  | 'unknown_seq'
  /** `confirm` named an entry hash that is not the one signed for that seq. */
  | 'entry_mismatch'
  /** A checkpoint asks for entries the Notary has not signed, or from other than seq 1. */
  | 'checkpoint_range'
  | 'invalid_signature'
  | 'signer_unavailable'
  | 'unavailable'
  | 'internal';

export const NotaryError = taggedError('NotaryError');
export type NotaryError = TaggedError<'NotaryError', { code: NotaryErrorCode; message: string }>;
export const notaryError = (code: NotaryErrorCode, message: string): NotaryError =>
  NotaryError({ code, message });

export interface ReserveRequest {
  /** `entry_hash` of the writer's current head, `null` for the first entry. */
  prev_hash: string | null;
  /** `ledgerDraftHash(draft)` of the entry about to be signed. */
  body_hash: string;
}

export interface SignRequest {
  ledger_seq: number;
  draft: LedgerEntryDraft;
}

export interface SignedLedgerEntry {
  ledger_seq: number;
  prev_hash: string | null;
  entry_hash: string;
  /** Raw ES256 signature, base64url. */
  signature: string;
  key_id: string;
}

export interface CheckpointSignRequest {
  cp_seq: number;
  from_ledger_seq: number;
  to_ledger_seq: number;
  created_at: string;
}

export interface SignedCheckpoint {
  root_hash: string;
  head_hash: string;
  signature: Signature;
}

/**
 * The Notary: the only signer of ledger entries (PLAN M2.3). Signing is in two phases, then the
 * writer commits and confirms:
 *   1. `reserve`  the Notary assigns the next `ledger_seq` and journals `reserved`;
 *   2. `sign`     it computes the entry hash, signs it, journals `signed`, returns the signature;
 *   3. the writer inserts the `ledger_entry` row in the record database, then `confirm`
 *      journals `committed`.
 * A `signed` entry that is never `committed` is returned by `unconfirmed` so a reconciler can
 * insert it. The Notary never signs two entries for one seq and never signs on a `prev_hash` that
 * is not its own last entry hash.
 */
export interface NotaryPort {
  reserve(req: ReserveRequest): Promise<Result<{ ledger_seq: number }, NotaryError>>;
  sign(req: SignRequest): Promise<Result<SignedLedgerEntry, NotaryError>>;
  /** Idempotent. */
  confirm(req: { ledger_seq: number; entry_hash: string }): Promise<Result<true, NotaryError>>;
  /** Entries signed but not committed, ascending by seq, ready to insert. */
  unconfirmed(): Promise<Result<LedgerEntry[], NotaryError>>;
  /** Signs a tree head over entries 1..to, after recomputing the root from its own journal. */
  signCheckpoint(req: CheckpointSignRequest): Promise<Result<SignedCheckpoint, NotaryError>>;
  /** Checks an entry's hash and Notary signature. */
  verify(entry: LedgerEntry): Promise<Result<true, NotaryError>>;
}

/** The ledger row for a draft and the Notary's answer. */
export function assembleLedgerEntry(
  draft: LedgerEntryDraft,
  signed: SignedLedgerEntry,
): LedgerEntry {
  return {
    ...draft,
    ledger_seq: signed.ledger_seq,
    prev_hash: signed.prev_hash,
    entry_hash: signed.entry_hash,
    notary: { key_id: signed.key_id, alg: LEDGER_SIGNATURE_ALG, value: signed.signature },
  };
}

export const hexBytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));

type Status = 'reserved' | 'signed' | 'committed';
interface Row {
  status: Status;
  prev_hash: string | null;
  body_hash: string;
  entry?: LedgerEntry;
}

/**
 * In-process Notary for tests of other packages. Same rules as `services/notary`, in memory, with
 * a `KeyCustodyPort` for the signatures (use `fakeKeyCustody()` for a deterministic one). The
 * shared conformance suite in `@aisdlc/ports/testing` runs against it and the real service.
 */
export class FakeNotary implements NotaryPort {
  private readonly rows = new Map<number, Row>();
  private lastSeq = 0;
  private lastHash: string | null = null;

  constructor(
    private readonly custody: KeyCustodyPort,
    private readonly keyId = 'dev:notary',
  ) {}

  async reserve(req: ReserveRequest) {
    if (req.prev_hash !== this.lastHash) {
      return err(notaryError('prev_hash_mismatch', 'prev_hash is not the last signed entry hash'));
    }
    const seq = this.lastSeq + 1;
    this.rows.set(seq, { status: 'reserved', prev_hash: req.prev_hash, body_hash: req.body_hash });
    return ok({ ledger_seq: seq });
  }

  async sign(req: SignRequest) {
    const parsed = LedgerEntryDraft.safeParse(req.draft);
    if (!parsed.success) return err(notaryError('invalid_entry', parsed.error.message));
    const row = this.rows.get(req.ledger_seq);
    if (!row) return err(notaryError('not_reserved', `seq ${req.ledger_seq} is not reserved`));
    if (row.status !== 'reserved') {
      return err(notaryError('seq_already_signed', `seq ${req.ledger_seq} is already signed`));
    }
    if (ledgerDraftHash(parsed.data) !== row.body_hash) {
      return err(notaryError('body_mismatch', 'draft is not the reserved body'));
    }
    const entry_hash = computeLedgerEntryHash(parsed.data, req.ledger_seq, row.prev_hash);
    const sig = await this.custody.sign(this.keyId, hexBytes(entry_hash));
    if (!sig.ok) return err(notaryError('signer_unavailable', sig.error.message));
    const signed: SignedLedgerEntry = {
      ledger_seq: req.ledger_seq,
      prev_hash: row.prev_hash,
      entry_hash,
      signature: b64urlEncode(sig.value),
      key_id: this.keyId,
    };
    row.status = 'signed';
    row.entry = assembleLedgerEntry(parsed.data, signed);
    this.lastSeq = req.ledger_seq;
    this.lastHash = entry_hash;
    return ok(signed);
  }

  async confirm(req: { ledger_seq: number; entry_hash: string }) {
    const row = this.rows.get(req.ledger_seq);
    if (!row || row.status === 'reserved') {
      return err(notaryError('unknown_seq', `seq ${req.ledger_seq} is not signed`));
    }
    if (row.entry?.entry_hash !== req.entry_hash) {
      return err(notaryError('entry_mismatch', 'entry_hash is not the one signed for this seq'));
    }
    row.status = 'committed';
    return ok(true as const);
  }

  async unconfirmed() {
    const out: LedgerEntry[] = [];
    for (let s = 1; s <= this.lastSeq; s++) {
      const r = this.rows.get(s);
      if (r?.status === 'signed' && r.entry) out.push(r.entry);
    }
    return ok(out);
  }

  async signCheckpoint(req: CheckpointSignRequest) {
    if (req.from_ledger_seq !== 1 || req.to_ledger_seq < 1 || req.to_ledger_seq > this.lastSeq) {
      return err(notaryError('checkpoint_range', 'checkpoint must cover 1..n of signed entries'));
    }
    const hashes: Uint8Array[] = [];
    for (let s = 1; s <= req.to_ledger_seq; s++) {
      hashes.push(hexBytes((this.rows.get(s)?.entry as LedgerEntry).entry_hash));
    }
    const core: CheckpointCore = {
      cp_seq: req.cp_seq,
      from_ledger_seq: 1,
      to_ledger_seq: req.to_ledger_seq,
      root_hash: merkleRoot(hashes),
      head_hash: (this.rows.get(req.to_ledger_seq)?.entry as LedgerEntry).entry_hash,
      created_at: req.created_at,
    };
    const sig = await this.custody.sign(this.keyId, hexBytes(checkpointDigestHex(core)));
    if (!sig.ok) return err(notaryError('signer_unavailable', sig.error.message));
    return ok({
      root_hash: core.root_hash,
      head_hash: core.head_hash,
      signature: { key_id: this.keyId, alg: LEDGER_SIGNATURE_ALG, value: b64urlEncode(sig.value) },
    });
  }

  async verify(entry: LedgerEntry) {
    const parsed = LedgerEntry.safeParse(entry);
    if (!parsed.success) return err(notaryError('invalid_entry', parsed.error.message));
    if (parsed.data.notary.key_id !== this.keyId) {
      return err(notaryError('invalid_signature', 'signed by another key'));
    }
    const key = await this.custody.publicKey(this.keyId);
    if (!key.ok) return err(notaryError('signer_unavailable', key.error.message));
    const bad = await checkLedgerEntrySignature(parsed.data, key.value);
    return bad === null ? ok(true as const) : err(notaryError('invalid_signature', bad));
  }
}
