import { Checkpoint, LedgerEntry, LedgerTimestamp, Sha256Hex, Signature } from '@aisdlc/contracts';
import { z } from 'zod';
import type { KeyCustodyErrorKind } from './key-custody.js';
import type { NotaryErrorCode } from './notary.js';
import type { WitnessErrorCode } from './witness.js';

// HTTP bodies between the services and their clients. Entities come from `@aisdlc/contracts`;
// only the request and response envelopes live here, once, for both ends.

const Seq = z.number().int().min(1);
const B64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'base64url');

export const ErrorEnvelope = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

// ------------------------------------------------------------------ kms-local

export const KmsSignRequest = z.strictObject({
  /** The 32-byte digest, base64url. */
  digest: B64Url.length(43),
});
export const KmsSignResponse = z.strictObject({
  /** Raw ES256 r||s, base64url. */
  signature: B64Url.length(86),
});
export const KmsHmacRequest = z.strictObject({ data: z.string().regex(/^[A-Za-z0-9_-]*$/) });
export const KmsHmacResponse = z.strictObject({ mac: Sha256Hex });

export const KMS_STATUS: Record<KeyCustodyErrorKind, number> = {
  unauthenticated: 401,
  forbidden: 403,
  dev_key_refused: 403,
  unknown_key: 404,
  wrong_key_type: 400,
  invalid_request: 400,
  unavailable: 503,
};

// --------------------------------------------------------------------- notary

export const NotaryReserveRequest = z.strictObject({
  prev_hash: Sha256Hex.nullable(),
  body_hash: Sha256Hex,
});
export const NotaryReserveResponse = z.strictObject({ ledger_seq: Seq });

/** `draft` is validated by the Notary itself so that a bad body is `invalid_entry`, not a 400. */
export const NotarySignRequest = z.strictObject({ ledger_seq: Seq, draft: z.unknown() });
export const NotarySignResponse = z.strictObject({
  ledger_seq: Seq,
  prev_hash: Sha256Hex.nullable(),
  entry_hash: Sha256Hex,
  signature: B64Url,
  key_id: z.string().min(1),
});

export const NotaryConfirmRequest = z.strictObject({ ledger_seq: Seq, entry_hash: Sha256Hex });
export const NotaryConfirmResponse = z.strictObject({ ok: z.literal(true) });

export const NotaryUnconfirmedResponse = z.strictObject({ entries: z.array(LedgerEntry) });

export const NotaryCheckpointRequest = z.strictObject({
  cp_seq: Seq,
  from_ledger_seq: Seq,
  to_ledger_seq: Seq,
  created_at: LedgerTimestamp,
});
export const NotaryCheckpointResponse = z.strictObject({
  root_hash: Sha256Hex,
  head_hash: Sha256Hex,
  signature: Signature,
});

export const NotaryVerifyRequest = z.strictObject({ entry: z.unknown() });
/** `POST /v1/journal/redact` (scope `ledger`, docs/specs/deletion.md §1): the deletion.performed entry it obeys. */
export const NotaryRedactRequest = z.strictObject({ entry: z.unknown() });
export const NotaryRedactResponse = z.strictObject({ redacted: z.number().int().min(0) });
export const NotaryVerifyResponse = z.strictObject({ valid: z.literal(true) });

/** `POST /v1/evidence/sign` (scope `evidence`, PLAN M14.4): the Notary signs an Evidence Pack id. */
export const NotaryEvidenceSignRequest = z.strictObject({
  pack_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  item_id: z.string().min(1).max(64),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
});
export const NotaryEvidenceSignResponse = z.strictObject({ signature: Signature });
export const NotaryAuditExportSignRequest = z.strictObject({
  export_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  scope_ref: z.string().min(1).max(160),
});
export const NotaryAuditExportSignResponse = NotaryEvidenceSignResponse;

export const NOTARY_STATUS: Record<NotaryErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  invalid_entry: 400,
  prev_hash_mismatch: 409,
  not_reserved: 409,
  seq_already_signed: 409,
  body_mismatch: 409,
  unknown_seq: 404,
  entry_mismatch: 409,
  checkpoint_range: 409,
  invalid_signature: 422,
  signer_unavailable: 503,
  unavailable: 503,
  internal: 500,
};

// -------------------------------------------------------------------- witness

export const WitnessCosignRequest = z.strictObject({
  core: z.strictObject({
    cp_seq: Seq,
    from_ledger_seq: Seq,
    to_ledger_seq: Seq,
    root_hash: Sha256Hex,
    head_hash: Sha256Hex,
    created_at: LedgerTimestamp,
  }),
  notary: Signature,
  entries: z.array(
    z.strictObject({ ledger_seq: Seq, prev_hash: Sha256Hex.nullable(), entry_hash: Sha256Hex }),
  ),
});
export const WitnessCosignResponse = z.strictObject({ checkpoint: Checkpoint });
export const WitnessLastResponse = z.strictObject({ checkpoint: Checkpoint.nullable() });

export const WITNESS_STATUS: Record<WitnessErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  invalid_notary_signature: 422,
  cp_seq_mismatch: 409,
  size_regressed: 409,
  entries_invalid: 409,
  head_mismatch: 409,
  not_append_only: 409,
  signer_unavailable: 503,
  unavailable: 503,
  internal: 500,
};
