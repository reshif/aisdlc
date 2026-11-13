import {
  LedgerEntry,
  LedgerEntryDraft,
  LEDGER_SIGNATURE_ALG,
  checkLedgerEntrySignature,
  checkpointDigestHex,
  computeLedgerEntryHash,
  auditExportSigningDigest,
  evidencePackSigningDigest,
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

/**
 * Delete means delete (docs/specs/deletion.md §1): the Notary's journal keeps a copy of every entry it signed, so a
 * deletion asks it to erase the copies of the entries it redacted. The request carries the `deletion.performed` entry
 * itself; the Notary checks that it signed exactly that entry (its journal, its key) and erases only the entries the
 * entry's body names, keeping each one's seq, hashes and status. Nothing else can make it erase anything.
 */
export interface JournalRedactorPort {
  redactJournal(deletion: LedgerEntry): Promise<Result<{ redacted: number }, NotaryError>>;
}

/** What 7.6 asks the Notary to sign (PLAN M14.4): a pack id, with the item and head it says it is about (journalled). */
export interface EvidenceSignRequest {
  pack_sha256: string;
  item_id: string;
  head_sha: string;
}

/**
 * The Notary's second signing purpose (PLAN M14.4): an Evidence Pack. The Notary signs the domain-separated message of
 * `evidencePackSigningMessage(pack_sha256)` (never a bare digest the caller chose, so no request can obtain a
 * signature that verifies as a ledger entry or a checkpoint), journals what it signed, and answers the same signature
 * for the same pack again (idempotent). The same pack id named with another item or head is refused.
 */
export interface EvidenceSignerPort {
  signEvidencePack(req: EvidenceSignRequest): Promise<Result<Signature, NotaryError>>;
}

/** What the audit service asks the Notary to sign (PLAN M19): an export id, with the scope it says it covers. */
export interface AuditExportSignRequest {
  export_sha256: string;
  /** `fleet` or `project:<id>`: journalled with the signature. */
  scope_ref: string;
}

/**
 * The Notary's third signing purpose (PLAN M19): a signed audit export. The same rules as an Evidence Pack: the message
 * is domain-separated (`auditExportSigningMessage`), the signature is journalled once per export id and answered again
 * for the same id; the same id named with another scope is refused.
 */
export interface AuditExportSignerPort {
  signAuditExport(req: AuditExportSignRequest): Promise<Result<Signature, NotaryError>>;
}

/** Why an audit export signing request is malformed, or `null` (one check for the fake and the service). */
export function badAuditExportSignRequest(req: AuditExportSignRequest): string | null {
  if (!/^[0-9a-f]{64}$/.test(req.export_sha256)) return 'export_sha256 is not a sha256';
  if (!/^(fleet|project:[a-z0-9][a-z0-9_-]{0,127})$/.test(req.scope_ref)) {
    return 'scope_ref is fleet or project:<id>';
  }
  return null;
}

const PACK_REQ = {
  sha: /^[0-9a-f]{64}$/,
  item: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  head: /^[0-9a-f]{40}$/,
};

/** Why an evidence signing request is malformed, or `null` (one check for the fake and the service). */
export function badEvidenceSignRequest(req: EvidenceSignRequest): string | null {
  if (!PACK_REQ.sha.test(req.pack_sha256)) return 'pack_sha256 is not a sha256';
  if (!PACK_REQ.item.test(req.item_id)) return 'item_id is not an item id';
  if (!PACK_REQ.head.test(req.head_sha)) return 'head_sha is not a commit sha';
  return null;
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
export class FakeNotary
  implements NotaryPort, EvidenceSignerPort, AuditExportSignerPort, JournalRedactorPort
{
  private readonly rows = new Map<number, Row>();
  private readonly packs = new Map<string, { req: EvidenceSignRequest; signature: Signature }>();
  private readonly exports = new Map<string, { scope_ref: string; signature: Signature }>();
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

  /** Every pack this Notary signed (a test reads it). */
  get signedPacks(): number {
    return this.packs.size;
  }

  async signEvidencePack(req: EvidenceSignRequest): Promise<Result<Signature, NotaryError>> {
    const bad = badEvidenceSignRequest(req);
    if (bad) return err(notaryError('invalid_request', bad));
    const have = this.packs.get(req.pack_sha256);
    if (have) {
      return have.req.item_id === req.item_id && have.req.head_sha === req.head_sha
        ? ok(have.signature)
        : err(notaryError('invalid_request', 'this pack was signed for another item or head'));
    }
    const sig = await this.custody.sign(
      this.keyId,
      hexBytes(evidencePackSigningDigest(req.pack_sha256)),
    );
    if (!sig.ok) return err(notaryError('signer_unavailable', sig.error.message));
    const signature: Signature = {
      key_id: this.keyId,
      alg: LEDGER_SIGNATURE_ALG,
      value: b64urlEncode(sig.value),
    };
    this.packs.set(req.pack_sha256, { req: { ...req }, signature });
    return ok(signature);
  }

  async signAuditExport(req: AuditExportSignRequest): Promise<Result<Signature, NotaryError>> {
    const bad = badAuditExportSignRequest(req);
    if (bad) return err(notaryError('invalid_request', bad));
    const have = this.exports.get(req.export_sha256);
    if (have) {
      return have.scope_ref === req.scope_ref
        ? ok(have.signature)
        : err(notaryError('invalid_request', 'this export was signed for another scope'));
    }
    const sig = await this.custody.sign(
      this.keyId,
      hexBytes(auditExportSigningDigest(req.export_sha256)),
    );
    if (!sig.ok) return err(notaryError('signer_unavailable', sig.error.message));
    const signature: Signature = {
      key_id: this.keyId,
      alg: LEDGER_SIGNATURE_ALG,
      value: b64urlEncode(sig.value),
    };
    this.exports.set(req.export_sha256, { scope_ref: req.scope_ref, signature });
    return ok(signature);
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

  /** `JournalRedactorPort`, the same rules as `services/notary`: only for a deletion entry this Notary committed. */
  async redactJournal(entry: LedgerEntry) {
    const v = await this.verify(entry);
    if (!v.ok) return v;
    const seqs = (entry.body as { redacted_ledger_seqs?: unknown }).redacted_ledger_seqs;
    if (entry.entry_type !== 'deletion.performed' || !Array.isArray(seqs)) {
      return err(notaryError('invalid_entry', 'only a deletion.performed entry erases'));
    }
    const own = this.rows.get(entry.ledger_seq);
    if (!own || own.status !== 'committed' || own.entry?.entry_hash !== entry.entry_hash) {
      return err(notaryError('entry_mismatch', 'this Notary did not commit that deletion entry'));
    }
    let redacted = 0;
    for (const n of seqs) {
      const r = typeof n === 'number' && n < entry.ledger_seq ? this.rows.get(n) : undefined;
      if (r && r.status === 'committed' && r.entry) {
        delete r.entry;
        redacted += 1;
      }
    }
    return ok({ redacted });
  }
}
