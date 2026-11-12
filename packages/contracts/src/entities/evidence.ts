import { canonicalJson, sha256Hex, verifyEs256, type Jwk } from '@aisdlc/kernel';
import { z } from 'zod';
import { BackEdgeId, GateId, TriggerId } from '../flow.js';
import { LEDGER_SIGNATURE_ALG } from '../ledger-format.js';
import { Lane, Tier } from '../values.js';
import { RepoFullName } from './codehost.js';
import { CatalogueRef } from './config.js';
import { GitSha, IsoDateTime, ProjectId, Sha256Hex, Signature, WorkItemId } from './ids.js';
import {
  CheckVerdict,
  FindingKind,
  FindingSeverity,
  MutationScore,
  RepairClass,
  VerifyCheckId,
  VerifyRaise,
  VerifyStep,
} from './verify.js';

// The Evidence Pack (PLAN M14.4; FL S7 "signed Evidence Pack bound to head SHA", 7.6 "Pack assembly + sign"; DM §3.4
// EvidencePack; ADR-0003 §2 "Evidence Packs live in the object store"). One definition for core's 7.6 (which builds,
// signs, stores and records it), the Notary (which signs its id), the offline verifier (`aisdlc-verify-pack`) and,
// later, gate-check (M14.5: PR head SHA = the pack's head SHA).
//
// A pack is ids, hashes, verdicts and counts: each step's result is bound by its hash (`verifyResultHash`) with its
// verdict and a findings summary (kind, severity, class, rule, path, line, fingerprint: what the result already carries,
// never a message, a secret's value or repo text). The pack id is the sha256 of its canonical JSON (RFC 8785). The
// Notary signs a domain-separated message over that id (`evidencePackSigningMessage`), never the bare id, so no pack
// signature can be mistaken for a ledger entry or checkpoint signature by the same key.
//
// A pack is made for EVERY 7.6 outcome (and for a D2 raised at 7.2 or 7.3): `passed` is the only one gate-check may
// accept; a pack that asks for rework or a handoff is signed too, marked not passing, so the person at E4 sees the
// evidence the factory had.

export const EVIDENCE_PACK_FORMAT = 'aisdlc-evidence-pack/1';
export const SIGNED_EVIDENCE_PACK_FORMAT = 'aisdlc-signed-evidence-pack/1';
/** The domain of the message the Notary signs for a pack. */
export const EVIDENCE_PACK_SIGNING_PURPOSE = 'aisdlc.evidence-pack.sign/1';
/** The write-once bucket that holds signed packs (and the Handoff Pack a D2 carries). */
export const EVIDENCE_BUCKET = 'evidence-packs';
export const SIGNED_EVIDENCE_PACK_CONTENT_TYPE = 'application/vnd.aisdlc.signed-evidence-pack+json';
export const HANDOFF_PACK_CONTENT_TYPE = 'application/vnd.aisdlc.handoff-pack+json';

const Text = (max: number) => z.string().min(1).max(max);
const RepoPath = z.string().min(1).max(1024);

// ---------------------------------------------------------------- what 7.6 decided

/** The ET triggers S7 hands off with (the catalogue's ET table gives each the D2 effect; their numbers stay its own). */
export const S7HandoffTrigger = TriggerId.extract(['ET3', 'ET4', 'ET5', 'ET6']);
export type S7HandoffTrigger = z.infer<typeof S7HandoffTrigger>;

/**
 * The factory's reading of the four S7 triggers (the flow names "ET3-ET6 limits" and defines only ET3, "repeat fail"):
 *   ET3  a back-edge of S7 (B9 to B12) has no round left under the pinned catalogue's limit
 *   ET4  a check gave no verdict (`unknown`): nothing can be repaired that was not seen
 *   ET5  a hard-fail finding (`hard_fail`, or misbehaviour that reached 7.6)
 *   ET6  a gate a check raised is not approved at 7.6
 */
export const S7_HANDOFF_TRIGGER = {
  limit: 'ET3',
  unknown: 'ET4',
  hard_fail: 'ET5',
  gate: 'ET6',
} as const satisfies Record<string, S7HandoffTrigger>;

/** What S7 decided for the head, which the pack records: the only passing one is `passed`. */
export const S7Disposition = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('passed') }),
  z.strictObject({
    kind: z.literal('rework'),
    edge: BackEdgeId.extract(['B9', 'B11']),
    /** The catalogue limit this round counts against (`et3_rounds` for B9). */
    loop: z.string().min(1).max(64).nullable(),
    reason_code: Text(64),
  }),
  z.strictObject({
    kind: z.literal('handoff'),
    trigger: S7HandoffTrigger,
    /** Where it was raised: 7.6, or 7.2 (B12 out of rounds) and 7.3 (B10 out of rounds). */
    step: z.enum(['7.2', '7.3', '7.6']),
    reason_code: Text(64),
  }),
]);
export type S7Disposition = z.infer<typeof S7Disposition>;

// ---------------------------------------------------------------- the pack

export const EvidenceFinding = z.strictObject({
  kind: FindingKind,
  severity: FindingSeverity,
  repair_class: RepairClass.nullable(),
  rule_id: z.string().min(1).max(64).nullable(),
  path: RepoPath.nullable(),
  line: z.number().int().min(1).nullable(),
  fingerprint: Sha256Hex,
});
export type EvidenceFinding = z.infer<typeof EvidenceFinding>;

/** One step of S7 for the head: its result by hash, or `null` fields when it has none (not run: unmet). */
export const EvidenceStep = z.strictObject({
  step: VerifyStep,
  check: VerifyCheckId,
  result_sha256: Sha256Hex.nullable(),
  verdict: CheckVerdict.nullable(),
  inputs_sha256: Sha256Hex.nullable(),
  raised: VerifyRaise.nullable(),
  /** The raised gate was approved (decided `approve` in the ledger); `null` when nothing was raised. */
  gate_approved: z.boolean().nullable(),
  /** The step is met: passed, and its raised gate (if any) approved. */
  met: z.boolean(),
  mutation: MutationScore.nullable(),
  rules_version: z.string().max(64).nullable(),
  findings: z.strictObject({
    total: z.number().int().min(0),
    failing: z.number().int().min(0),
    /** The failing ones (other findings are counted, not listed), at most 100. */
    items: z.array(EvidenceFinding).max(100),
  }),
});
export type EvidenceStep = z.infer<typeof EvidenceStep>;

/** A ledger decision on a gate the item raised, by its entry. */
export const EvidenceDecision = z.strictObject({
  entry_id: z.string().min(1).max(64),
  ledger_seq: z.number().int().min(1),
  entry_hash: Sha256Hex,
  decision: z.string().min(1).max(32),
});

export const EvidenceGate = z.strictObject({
  gate: GateId,
  gate_instance_id: z.string().min(1).max(64),
  station: z.string().min(1).max(64),
  status: z.enum(['pending', 'decided']),
  outcome: z.string().min(1).max(32).nullable(),
  decisions: z.array(EvidenceDecision).max(20),
});
export type EvidenceGate = z.infer<typeof EvidenceGate>;

export const EvidencePushReceipt = z.strictObject({
  receipt_id: z.string().min(1).max(64),
  patch_hash: Sha256Hex,
  head_sha: GitSha,
  pr_number: z.number().int().min(1),
});

export const EvidencePack = z
  .strictObject({
    format: z.literal(EVIDENCE_PACK_FORMAT),
    item_id: WorkItemId,
    project_id: ProjectId,
    repo: RepoFullName,
    /** The lane profile the item runs: its lane, tier and the sha256 of the gating profile it pinned at intake. */
    lane: Lane,
    tier: Tier,
    profile_sha256: Sha256Hex,
    catalogue_ref: CatalogueRef,
    units: z
      .array(z.strictObject({ unit_key: Text(128) }))
      .min(1)
      .max(30),
    /** The merged commit the plan was made against. */
    base_sha: GitSha,
    /** The Unit head verified: the pack is bound to exactly this commit. */
    head_sha: GitSha,
    disposition: S7Disposition,
    /** `true` only for `passed`: every step 7.1 to 7.5 met for this head. */
    passing: z.boolean(),
    steps: z.array(EvidenceStep).length(5),
    gates: z.array(EvidenceGate).max(100),
    push_receipt: EvidencePushReceipt.nullable(),
    /** The locked oracle tests: path -> the sha256 they were locked with. */
    oracle_locks: z.record(RepoPath, Sha256Hex),
    produced_at: IsoDateTime,
  })
  .refine((p) => p.passing === (p.disposition.kind === 'passed'), {
    message: 'a pack passes exactly when its disposition is `passed`',
    path: ['passing'],
  })
  .refine((p) => !p.passing || p.steps.every((s) => s.met), {
    message: 'a passing pack has every step met',
    path: ['passing'],
  });
export type EvidencePack = z.infer<typeof EvidencePack>;

/** The pack id: the sha256 of its canonical JSON. */
export const evidencePackId = (p: EvidencePack): string => sha256Hex(canonicalJson(p as never));

/** The message the Notary signs for a pack (its digest is what key custody signs). */
export const evidencePackSigningMessage = (packSha256: string): Uint8Array =>
  new TextEncoder().encode(
    canonicalJson({ purpose: EVIDENCE_PACK_SIGNING_PURPOSE, pack_sha256: packSha256 }),
  );
export const evidencePackSigningDigest = (packSha256: string): string =>
  sha256Hex(evidencePackSigningMessage(packSha256));

/** What the object store holds: the pack, its id and the Notary's signature over it. */
export const SignedEvidencePack = z.strictObject({
  format: z.literal(SIGNED_EVIDENCE_PACK_FORMAT),
  pack_sha256: Sha256Hex,
  pack: EvidencePack,
  signature: Signature,
});
export type SignedEvidencePack = z.infer<typeof SignedEvidencePack>;

/** The stored bytes: the canonical JSON of the signed pack (its sha256 is the object key). */
export const signedEvidencePackBytes = (s: SignedEvidencePack): Uint8Array =>
  new TextEncoder().encode(canonicalJson(s as never));

// ---------------------------------------------------------------- offline verification

export type EvidencePackCheckFailure =
  | 'not_json'
  | 'not_canonical'
  | 'bad_format'
  | 'object_key_mismatch'
  | 'pack_hash_mismatch'
  | 'wrong_alg'
  | 'wrong_key_id'
  | 'bad_signature'
  | 'head_mismatch'
  | 'item_mismatch'
  | 'not_passing';

export interface EvidencePackExpectations {
  /** The head SHA the caller says the pack is for (gate-check: the PR head). Required. */
  readonly head_sha: string;
  readonly item_id?: string;
  /** The object key the bytes were stored under (sha256 of the bytes). */
  readonly object_key?: string;
  /** Refuse a pack that is not passing (default true). */
  readonly require_passing?: boolean;
}

export type EvidencePackCheck =
  | { readonly ok: true; readonly signed: SignedEvidencePack }
  | { readonly ok: false; readonly code: EvidencePackCheckFailure; readonly message: string };

const fail = (code: EvidencePackCheckFailure, message: string): EvidencePackCheck => ({
  ok: false,
  code,
  message,
});

/**
 * Checks a signed pack from its bytes alone, with the Notary's public key and nothing else (no network, no database):
 * the bytes are canonical JSON, they hash to the object key (when given), the pack has the contract's shape and hashes
 * to `pack_sha256`, the Notary signed that id under this key, and the pack is for the head (and item) the caller says.
 * Fail closed: the first failure is the answer.
 */
export async function checkSignedEvidencePack(
  bytes: Uint8Array,
  notaryKey: Jwk,
  expect: EvidencePackExpectations,
): Promise<EvidencePackCheck> {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail('not_json', e instanceof Error ? e.message : 'not JSON');
  }
  let canonical: string;
  try {
    canonical = canonicalJson(raw as never);
  } catch (e) {
    return fail('not_canonical', e instanceof Error ? e.message : 'not canonical JSON');
  }
  if (canonical !== text) return fail('not_canonical', 'the bytes are not the canonical JSON form');
  if (expect.object_key !== undefined && sha256Hex(bytes) !== expect.object_key) {
    return fail('object_key_mismatch', 'the bytes do not hash to the object key');
  }
  const parsed = SignedEvidencePack.safeParse(raw);
  if (!parsed.success) return fail('bad_format', parsed.error.message.slice(0, 500));
  const s = parsed.data;
  if (evidencePackId(s.pack) !== s.pack_sha256) {
    return fail('pack_hash_mismatch', 'the pack does not hash to pack_sha256');
  }
  if (s.signature.alg !== LEDGER_SIGNATURE_ALG) return fail('wrong_alg', s.signature.alg);
  if (notaryKey.kid !== undefined && notaryKey.kid !== s.signature.key_id) {
    return fail(
      'wrong_key_id',
      `signed by ${s.signature.key_id}, the key given is ${notaryKey.kid}`,
    );
  }
  if (
    !(await verifyEs256(notaryKey, evidencePackSigningMessage(s.pack_sha256), s.signature.value))
  ) {
    return fail('bad_signature', 'the Notary signature does not verify under the key given');
  }
  if (s.pack.head_sha !== expect.head_sha) {
    return fail('head_mismatch', `the pack is for head ${s.pack.head_sha}, not ${expect.head_sha}`);
  }
  if (expect.item_id !== undefined && s.pack.item_id !== expect.item_id) {
    return fail('item_mismatch', `the pack is for item ${s.pack.item_id}`);
  }
  if ((expect.require_passing ?? true) && !s.pack.passing) {
    return fail('not_passing', `the pack records ${s.pack.disposition.kind}, not a pass`);
  }
  return { ok: true, signed: s };
}

// ---------------------------------------------------------------- what core records

export const EVIDENCE_EVENT = { pack_signed: 'evidence.pack_signed' } as const;
export type EvidenceEventType = (typeof EVIDENCE_EVENT)[keyof typeof EVIDENCE_EVENT];
export const EVIDENCE_STREAM_PREFIXES = ['evidence:'] as const;
export const evidenceStream = (itemId: string): string => `evidence:${itemId}`;
export const EVIDENCE_LEDGER_ENTRY_TYPE = 'evidence.pack_signed';

/**
 * `evidence.pack_signed` on `evidence:<item>` (and the same facts in the `evidence.pack_signed` ledger entry): the pack
 * id, the head it is bound to, where the signed bytes are (bucket, object key = their sha256), what it decided, and for a
 * D2 the Handoff Pack beside it (its sha256 and object key). The `core.evidence_pack` read model is a fold of these.
 */
export const EvidencePackSignedPayload = z.strictObject({
  command_key: z.string().min(1).max(512),
  item_id: WorkItemId,
  unit_key: Text(128),
  base_sha: GitSha,
  head_sha: GitSha,
  pack_sha256: Sha256Hex,
  bucket: z.string().min(3).max(63),
  object_key: Sha256Hex,
  disposition: S7Disposition,
  passing: z.boolean(),
  key_id: z.string().min(1).max(128),
  /** D2: the Handoff Pack (A11) carried beside the Evidence Pack; `null` otherwise or when no S6 session was found. */
  handoff_pack_sha256: Sha256Hex.nullable(),
  handoff_object_key: Sha256Hex.nullable(),
  produced_at: IsoDateTime,
});
export type EvidencePackSignedPayload = z.infer<typeof EvidencePackSignedPayload>;

/** What a D2 from S7 binds into the item's Handoff (the trigger's output hash): both packs, by hash. */
export const D2HandoffRecord = z.strictObject({
  schema: z.literal('d2-handoff/1'),
  item_id: WorkItemId,
  trigger: S7HandoffTrigger,
  reason_code: Text(64),
  evidence_pack_sha256: Sha256Hex,
  handoff_pack_sha256: Sha256Hex.nullable(),
});
export type D2HandoffRecord = z.infer<typeof D2HandoffRecord>;
export const d2HandoffHash = (r: D2HandoffRecord): string => sha256Hex(canonicalJson(r as never));
