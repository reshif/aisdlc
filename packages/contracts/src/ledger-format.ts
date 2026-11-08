import { canonicalJson, hashCanonical, sha256Hex, verifyEs256, type Jwk } from '@aisdlc/kernel';
import type { Checkpoint, LedgerEntry, LedgerEntryDraft } from './entities/decisions.js';
import { LedgerEntryDraft as LedgerEntryDraftSchema } from './entities/decisions.js';

// What is hashed and what is signed for the ledger (PLAN M2.3, M2.4). One definition, used by the
// Notary, the Witness, the writer and the offline verifier.
//
// Signing scheme. The signer is asked to sign a 32-byte digest (`KeyCustodyPort.sign`), because
// that is what a KMS signs. The digest is always sha256 of a canonical JSON message, so a verifier
// that has only the public JWK and the message can check the signature with plain WebCrypto
// (`ECDSA` + `SHA-256` over the message). For an entry the digest IS its `entry_hash`.

export const LEDGER_SIGNATURE_ALG = 'ES256' as const;

/** The message an entry hash and Notary signature cover: every field except `entry_hash`, `notary`. */
export function ledgerEntryPreimage(
  draft: LedgerEntryDraft,
  ledger_seq: number,
  prev_hash: string | null,
): LedgerEntryDraft & { ledger_seq: number; prev_hash: string | null } {
  return { ...draft, ledger_seq, prev_hash };
}

export function ledgerEntryMessage(
  draft: LedgerEntryDraft,
  ledger_seq: number,
  prev_hash: string | null,
): Uint8Array {
  return new TextEncoder().encode(canonicalJson(ledgerEntryPreimage(draft, ledger_seq, prev_hash)));
}

/** `entry_hash`: sha256 (hex) of the canonical entry preimage. */
export function computeLedgerEntryHash(
  draft: LedgerEntryDraft,
  ledger_seq: number,
  prev_hash: string | null,
): string {
  return hashCanonical(ledgerEntryPreimage(draft, ledger_seq, prev_hash));
}

/** The hash the writer sends in the reserve step, before the entry has a position. */
export function ledgerDraftHash(draft: LedgerEntryDraft): string {
  return hashCanonical(draft);
}

/** The writer-chosen part of an entry. */
export function draftOfEntry(entry: LedgerEntry): LedgerEntryDraft {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(LedgerEntryDraftSchema.shape)) {
    out[k] = (entry as Record<string, unknown>)[k];
  }
  return out as LedgerEntryDraft;
}

export type CheckpointCore = Pick<
  Checkpoint,
  'cp_seq' | 'from_ledger_seq' | 'to_ledger_seq' | 'root_hash' | 'head_hash' | 'created_at'
>;

/** The message both checkpoint signatures cover: the checkpoint without its signatures. */
export function checkpointMessage(cp: CheckpointCore): Uint8Array {
  const { cp_seq, from_ledger_seq, to_ledger_seq, root_hash, head_hash, created_at } = cp;
  return new TextEncoder().encode(
    canonicalJson({ cp_seq, from_ledger_seq, to_ledger_seq, root_hash, head_hash, created_at }),
  );
}

/** sha256 (hex) of the checkpoint message: the digest the Notary and the Witness sign. */
export function checkpointDigestHex(cp: CheckpointCore): string {
  return sha256Hex(checkpointMessage(cp));
}

export type LedgerSignatureFailure =
  'entry_hash_mismatch' | 'wrong_alg' | 'wrong_key_id' | 'bad_signature';

/**
 * Checks an entry's `entry_hash` against its fields and its Notary signature against the JWK.
 * Returns null when valid, else why not. The JWK's `kid`, when present, must equal the
 * signature's `key_id`.
 */
export async function checkLedgerEntrySignature(
  entry: LedgerEntry,
  notaryKey: Jwk,
): Promise<LedgerSignatureFailure | null> {
  const draft = draftOfEntry(entry);
  if (computeLedgerEntryHash(draft, entry.ledger_seq, entry.prev_hash) !== entry.entry_hash) {
    return 'entry_hash_mismatch';
  }
  if (entry.notary.alg !== LEDGER_SIGNATURE_ALG) return 'wrong_alg';
  if (notaryKey.kid !== undefined && notaryKey.kid !== entry.notary.key_id) return 'wrong_key_id';
  const msg = ledgerEntryMessage(draft, entry.ledger_seq, entry.prev_hash);
  return (await verifyEs256(notaryKey, msg, entry.notary.value)) ? null : 'bad_signature';
}

/** Checks one signer's signature on a checkpoint. Returns null when valid, else why not. */
export async function checkCheckpointSignature(
  cp: CheckpointCore,
  signature: { key_id: string; alg: string; value: string },
  key: Jwk,
): Promise<Exclude<LedgerSignatureFailure, 'entry_hash_mismatch'> | null> {
  if (signature.alg !== LEDGER_SIGNATURE_ALG) return 'wrong_alg';
  if (key.kid !== undefined && key.kid !== signature.key_id) return 'wrong_key_id';
  return (await verifyEs256(key, checkpointMessage(cp), signature.value)) ? null : 'bad_signature';
}
