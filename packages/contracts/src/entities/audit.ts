import {
  canonicalJson,
  hashCanonical,
  merkleRoot,
  sha256Hex,
  verifyEs256,
  type Jwk,
} from '@aisdlc/kernel';
import { z } from 'zod';
import {
  LEDGER_SIGNATURE_ALG,
  checkCheckpointSignature,
  checkLedgerEntrySignature,
} from '../ledger-format.js';
import type { RecordEvent } from './decisions.js';
import { Checkpoint, LedgerEntry, RECORD_GENESIS_HASH } from './decisions.js';
import { IsoDateTime, PrincipalId, ProjectId, Sha256Hex, Signature } from './ids.js';

// Audit (PLAN M19; ADR-0003 §1 Trust plane "audit": signed exports to write-once storage, erasure, retention, legal
// hold; DM §3.12 AuditExport, ErasureRequest, LegalHold, RetentionClass; docs/specs/audit-api.md). ONE vocabulary for
// the audit service (which builds, signs, stores and records exports and executes erasures), the Notary (which signs an
// export id under its own purpose), the offline checker (`aisdlc verify-export`), the bff and the portal.
//
// ADR-0003 names ONE service (`audit`, "audit (one service)" in its milestone table); PLAN M19's two names
// (audit-exporter, audit-backend, after RV §1.3) are the two halves of it: `services/audit` builds both.
//
// An export is a signed, self-contained package: the ledger entries of a scope and time range IN FULL (each with its
// Notary signature), the hash of every ledger entry from 1 to the newest checkpoint (so the checkpoint's Merkle root,
// co-signed by the Notary and the Witness, can be recomputed offline and every exported entry is placed in the chain),
// and the record events of the scope and range with their per-stream hash links. The export id is the sha256 of the
// package's canonical JSON; the Notary signs a domain-separated message over it (never the bare id, so an export
// signature can never be taken for a ledger entry, a checkpoint or an Evidence Pack signature). The signed bytes live in
// the write-once bucket `audit-exports` under their sha256; the `audit.export` ledger entry names them.
//
// Erasure removes ONLY payloads kept OFF the hash chain (today: the conversation payloads, `core.conversation_payload`):
// their text goes, their sha256 stays, so the record and the ledger still verify. A record event or a ledger entry is
// never erased, by anyone. An erasure is requested by one factory admin and approved (the legal approval) by ANOTHER;
// the approval is the `erasure.execute` ledger entry, written before anything is erased (record first). A legal hold
// over the subject, its project or the fleet blocks the approval and stops an approved erasure before each payload.

const Text = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------- vocabulary

export const AUDIT_EXPORT_FORMAT = 'aisdlc-audit-export/1';
export const SIGNED_AUDIT_EXPORT_FORMAT = 'aisdlc-signed-audit-export/1';
/** The domain of the message the Notary signs for an export. */
export const AUDIT_EXPORT_SIGNING_PURPOSE = 'aisdlc.audit-export.sign/1';
/** The write-once bucket of signed exports (S3 Object Lock in a real store). */
export const AUDIT_BUCKET = 'audit-exports';
export const SIGNED_AUDIT_EXPORT_CONTENT_TYPE = 'application/vnd.aisdlc.signed-audit-export+json';

/** The ledger entry types the audit service writes (and only these: its database role may insert no other). */
export const AUDIT_LEDGER_ENTRY_TYPE = {
  export: 'audit.export',
  erasure: 'erasure.execute',
  hold_placed: 'legal_hold.place',
  hold_released: 'legal_hold.release',
} as const;
export type AuditLedgerEntryType =
  (typeof AUDIT_LEDGER_ENTRY_TYPE)[keyof typeof AUDIT_LEDGER_ENTRY_TYPE];
export const AUDIT_LEDGER_ENTRY_TYPES: readonly AuditLedgerEntryType[] =
  Object.values(AUDIT_LEDGER_ENTRY_TYPE);

/**
 * The PDP actions the audit service asks (PLAN M19). `audit.read` is the catalogue's. Erasure and legal hold need the
 * proposed `identity.admin` (portal-coverage §5 item 6), which is NOT in `ACTION_CATALOGUE`: adding it is an M3
 * catalogue change for the user to decide. Until then they are decided under `config.decide` on the fleet, the nearest
 * existing action (factory admins only, a `decide` action whose allows are logged); the two-person rule is the audit
 * service's own (the approver is never the requester, the releaser never the placer).
 */
export const AUDIT_ACTION = {
  read: 'audit.read',
  export: 'audit.read',
  govern: 'config.decide',
} as const;

/** What an export covers: one project, or the whole factory. */
export const AuditScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fleet') }),
  z.strictObject({ kind: z.literal('project'), project_id: ProjectId }),
]);
export type AuditScope = z.infer<typeof AuditScope>;
export const auditScopeText = (s: AuditScope): string =>
  s.kind === 'fleet' ? 'fleet' : `project ${s.project_id}`;

/** The longest range one export may cover (a bigger audit is several exports). */
export const AUDIT_EXPORT_MAX_DAYS = 366;
/** The most record events and ledger entries one export carries (the object store's limit is 64 MiB). */
export const AUDIT_EXPORT_MAX_EVENTS = 20_000;
export const AUDIT_EXPORT_MAX_ENTRIES = 20_000;

const rangeOk = (r: { from: string; to: string }) => {
  const a = Date.parse(r.from);
  const b = Date.parse(r.to);
  return a < b && b - a <= AUDIT_EXPORT_MAX_DAYS * 86_400_000;
};

export const AuditExportRequest = z
  .strictObject({
    scope: AuditScope,
    /** Half-open: `from <= created_at/occurred_at < to`. */
    from: IsoDateTime,
    to: IsoDateTime,
    /** Why (an auditor's reference: SOC 2 sample, access review); kept in the package. */
    reason: Text(500),
  })
  .refine(rangeOk, {
    message: `from is before to and the range is at most ${AUDIT_EXPORT_MAX_DAYS} days`,
    path: ['to'],
  });
export type AuditExportRequest = z.infer<typeof AuditExportRequest>;

// ---------------------------------------------------------------- the package

/** A record event as exported: the hashed fields, its global position and its hash. */
export const ExportedRecordEvent = z.strictObject({
  stream: z.string().min(1),
  seq: z.number().int().min(1),
  global_seq: z.number().int().min(1),
  event_id: z.string().min(1),
  type: z.string().min(1),
  body: z.record(z.string(), z.unknown()),
  actor: z.string().min(1),
  occurred_at: IsoDateTime,
  prev_hash: Sha256Hex,
  hash: Sha256Hex,
});
export type ExportedRecordEvent = z.infer<typeof ExportedRecordEvent>;

export const AuditExportPackage = z.strictObject({
  format: z.literal(AUDIT_EXPORT_FORMAT),
  export_id: z.uuid(),
  scope: AuditScope,
  from: IsoDateTime,
  to: IsoDateTime,
  reason: Text(500),
  requested_by: PrincipalId,
  produced_at: IsoDateTime,
  ledger: z.strictObject({
    /** The newest checkpoint when the export was made, co-signed by the Notary and the Witness. */
    checkpoint: Checkpoint,
    /** `entry_hash` of every entry 1..checkpoint.to_ledger_seq, in order: the leaves of the checkpoint's root. */
    entry_hashes: z.array(Sha256Hex).min(1),
    /** The scope's entries in the range, up to the checkpoint, in full and in ledger order. */
    entries: z.array(LedgerEntry).max(AUDIT_EXPORT_MAX_ENTRIES),
    /** The scope's entries in the range AFTER the checkpoint: not exported (not yet anchored), only counted. */
    uncovered: z.number().int().min(0),
  }),
  record: z.strictObject({
    /** The scope's record events in the range, in global order. */
    events: z.array(ExportedRecordEvent).max(AUDIT_EXPORT_MAX_EVENTS),
    /** How many streams they come from. */
    streams: z.number().int().min(0),
  }),
});
export type AuditExportPackage = z.infer<typeof AuditExportPackage>;

/** The export id: the sha256 of the package's canonical JSON. */
export const auditExportId = (p: AuditExportPackage): string =>
  sha256Hex(canonicalJson(p as never));

/** The message the Notary signs for an export (its digest is what key custody signs). */
export const auditExportSigningMessage = (exportSha256: string): Uint8Array =>
  new TextEncoder().encode(
    canonicalJson({ purpose: AUDIT_EXPORT_SIGNING_PURPOSE, export_sha256: exportSha256 }),
  );
export const auditExportSigningDigest = (exportSha256: string): string =>
  sha256Hex(auditExportSigningMessage(exportSha256));

export const SignedAuditExport = z.strictObject({
  format: z.literal(SIGNED_AUDIT_EXPORT_FORMAT),
  export_sha256: Sha256Hex,
  package: AuditExportPackage,
  signature: Signature,
});
export type SignedAuditExport = z.infer<typeof SignedAuditExport>;

/** The stored bytes: the canonical JSON of the signed export (its sha256 is the object key). */
export const signedAuditExportBytes = (s: SignedAuditExport): Uint8Array =>
  new TextEncoder().encode(canonicalJson(s as never));

/** The hash of a record event, exactly as `@aisdlc/record` computes it (a test pins the two together). */
export const exportedEventHash = (e: ExportedRecordEvent): string =>
  hashCanonical({
    stream: e.stream,
    seq: e.seq,
    event_id: e.event_id,
    type: e.type,
    body: e.body,
    actor: e.actor,
    occurred_at: e.occurred_at,
    prev_hash: e.prev_hash,
  } as never);

/** A record row as the export carries it (from the contract's `RecordEvent`). */
export const exportedEventOf = (e: RecordEvent): ExportedRecordEvent => ({
  stream: e.stream_id,
  seq: e.stream_seq,
  global_seq: e.global_seq,
  event_id: e.event_id,
  type: e.type,
  body: e.payload,
  actor: e.actor,
  occurred_at: e.occurred_at,
  prev_hash: e.prev_hash,
  hash: e.hash,
});

// ---------------------------------------------------------------- offline verification

export type AuditExportCheckFailure =
  | 'not_json'
  | 'not_canonical'
  | 'bad_format'
  | 'object_key_mismatch'
  | 'export_hash_mismatch'
  | 'wrong_alg'
  | 'wrong_key_id'
  | 'bad_signature'
  | 'checkpoint_signature'
  | 'checkpoint_root'
  | 'checkpoint_head'
  | 'entry_outside_checkpoint'
  | 'entry_not_in_chain'
  | 'entry_chain_break'
  | 'entry_signature'
  | 'entry_order'
  | 'entry_out_of_range'
  | 'event_hash'
  | 'event_chain_break'
  | 'event_order'
  | 'event_out_of_range';

export interface AuditExportKeys {
  readonly notary: Jwk;
  readonly witness: Jwk;
}

export type AuditExportCheck =
  | {
      readonly ok: true;
      readonly signed: SignedAuditExport;
      readonly entries: number;
      readonly events: number;
      readonly covered_to: number;
    }
  | { readonly ok: false; readonly code: AuditExportCheckFailure; readonly message: string };

const failed = (code: AuditExportCheckFailure, message: string): AuditExportCheck => ({
  ok: false,
  code,
  message,
});

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};

const inRange = (at: string, from: string, to: string): boolean => {
  const t = Date.parse(at);
  return t >= Date.parse(from) && t < Date.parse(to);
};

/**
 * Checks a signed export from its bytes alone, with the Notary's and the Witness's PUBLIC keys and nothing else (no
 * network, no database), the same way `aisdlc verify-ledger` checks the live ledger:
 *   - the bytes are canonical JSON and hash to the object key (when given); the package has the contract's shape and
 *     hashes to `export_sha256`; the Notary signed that id under the export purpose;
 *   - the checkpoint carries one valid Notary and one valid Witness signature, its Merkle root is the root over
 *     `entry_hashes` and its head hash is the last of them;
 *   - every exported entry hashes to its content, its Notary signature verifies, it is the entry at its position in
 *     `entry_hashes` and links to the one before it; entries are in ledger order and inside the range;
 *   - every exported record event hashes to its content, links to the event before it when that one is exported too
 *     (the first of a stream links to the genesis hash), and is in global order inside the range.
 * Fail closed: the first failure is the answer.
 */
export async function checkSignedAuditExport(
  bytes: Uint8Array,
  keys: AuditExportKeys,
  expect: { readonly object_key?: string } = {},
): Promise<AuditExportCheck> {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return failed('not_json', e instanceof Error ? e.message : 'not JSON');
  }
  let canonical: string;
  try {
    canonical = canonicalJson(raw as never);
  } catch (e) {
    return failed('not_canonical', e instanceof Error ? e.message : 'not canonical JSON');
  }
  if (canonical !== text)
    return failed('not_canonical', 'the bytes are not the canonical JSON form');
  if (expect.object_key !== undefined && sha256Hex(bytes) !== expect.object_key) {
    return failed('object_key_mismatch', 'the bytes do not hash to the object key');
  }
  const parsed = SignedAuditExport.safeParse(raw);
  if (!parsed.success) return failed('bad_format', parsed.error.message.slice(0, 500));
  const s = parsed.data;
  const p = s.package;
  if (auditExportId(p) !== s.export_sha256) {
    return failed('export_hash_mismatch', 'the package does not hash to export_sha256');
  }
  if (s.signature.alg !== LEDGER_SIGNATURE_ALG) return failed('wrong_alg', s.signature.alg);
  if (keys.notary.kid !== undefined && keys.notary.kid !== s.signature.key_id) {
    return failed(
      'wrong_key_id',
      `signed by ${s.signature.key_id}, the key given is ${keys.notary.kid}`,
    );
  }
  if (
    !(await verifyEs256(keys.notary, auditExportSigningMessage(s.export_sha256), s.signature.value))
  ) {
    return failed('bad_signature', 'the Notary signature does not verify under the key given');
  }

  // the checkpoint, and the chain of entry hashes it covers
  const cp = p.ledger.checkpoint;
  for (const signer of ['notary', 'witness'] as const) {
    const sigs = cp.signatures.filter((x) => x.signer === signer);
    const one = sigs[0];
    if (sigs.length !== 1 || !one) {
      return failed('checkpoint_signature', `the checkpoint needs exactly one ${signer} signature`);
    }
    const bad = await checkCheckpointSignature(cp, one.signature, keys[signer]);
    if (bad !== null) return failed('checkpoint_signature', `${signer}: ${bad}`);
  }
  const hashes = p.ledger.entry_hashes;
  if (cp.from_ledger_seq !== 1 || hashes.length !== cp.to_ledger_seq) {
    return failed('checkpoint_root', 'entry_hashes is not exactly entries 1..to of the checkpoint');
  }
  if (merkleRoot(hashes.map(hexToBytes)) !== cp.root_hash) {
    return failed(
      'checkpoint_root',
      'the Merkle root over entry_hashes is not the checkpoint root',
    );
  }
  if (hashes[hashes.length - 1] !== cp.head_hash) {
    return failed('checkpoint_head', 'the checkpoint head is not the last entry hash');
  }

  let prevSeq = 0;
  for (const e of p.ledger.entries) {
    if (e.ledger_seq <= prevSeq)
      return failed('entry_order', `entry ${e.ledger_seq} is out of order`);
    prevSeq = e.ledger_seq;
    if (e.ledger_seq > cp.to_ledger_seq) {
      return failed('entry_outside_checkpoint', `entry ${e.ledger_seq} is after the checkpoint`);
    }
    if (hashes[e.ledger_seq - 1] !== e.entry_hash) {
      return failed('entry_not_in_chain', `entry ${e.ledger_seq} is not the entry at its position`);
    }
    const before = e.ledger_seq === 1 ? null : (hashes[e.ledger_seq - 2] ?? null);
    if (e.prev_hash !== before) {
      return failed(
        'entry_chain_break',
        `entry ${e.ledger_seq} does not link to the entry before it`,
      );
    }
    const bad = await checkLedgerEntrySignature(e, keys.notary);
    if (bad !== null) return failed('entry_signature', `entry ${e.ledger_seq}: ${bad}`);
    if (!inRange(e.created_at, p.from, p.to)) {
      return failed('entry_out_of_range', `entry ${e.ledger_seq} is outside the range`);
    }
  }

  const last = new Map<string, ExportedRecordEvent>();
  let prevGlobal = 0;
  for (const e of p.record.events) {
    if (e.global_seq <= prevGlobal) {
      return failed('event_order', `event ${e.global_seq} is out of global order`);
    }
    prevGlobal = e.global_seq;
    if (exportedEventHash(e) !== e.hash) {
      return failed('event_hash', `event ${e.stream}#${e.seq} does not hash to its content`);
    }
    const before = last.get(e.stream);
    if (e.seq === 1 && e.prev_hash !== RECORD_GENESIS_HASH) {
      return failed('event_chain_break', `event ${e.stream}#1 does not link to the genesis hash`);
    }
    if (before && before.seq === e.seq - 1 && before.hash !== e.prev_hash) {
      return failed(
        'event_chain_break',
        `event ${e.stream}#${e.seq} does not link to #${before.seq}`,
      );
    }
    if (before && before.seq >= e.seq) {
      return failed('event_order', `event ${e.stream}#${e.seq} is out of stream order`);
    }
    last.set(e.stream, e);
    if (!inRange(e.occurred_at, p.from, p.to)) {
      return failed('event_out_of_range', `event ${e.stream}#${e.seq} is outside the range`);
    }
  }
  return {
    ok: true,
    signed: s,
    entries: p.ledger.entries.length,
    events: p.record.events.length,
    covered_to: cp.to_ledger_seq,
  };
}

// ---------------------------------------------------------------- legal hold

/** What a legal hold freezes: a person's payloads, a project's, or every payload in the factory. */
export const LegalHoldScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fleet') }),
  z.strictObject({ kind: z.literal('project'), project_id: ProjectId }),
  z.strictObject({ kind: z.literal('principal'), principal_id: PrincipalId }),
]);
export type LegalHoldScope = z.infer<typeof LegalHoldScope>;
export const legalHoldScopeText = (s: LegalHoldScope): string =>
  s.kind === 'fleet'
    ? 'fleet'
    : s.kind === 'project'
      ? `project ${s.project_id}`
      : `principal ${s.principal_id}`;

/** An erasable payload the hold is asked about: whose it is and the project it belongs to. */
export interface HeldSubject {
  readonly owner: string;
  readonly project_id: string | null;
}

export const holdCovers = (s: LegalHoldScope, p: HeldSubject): boolean =>
  s.kind === 'fleet' ||
  (s.kind === 'project' && p.project_id === s.project_id) ||
  (s.kind === 'principal' && p.owner === s.principal_id);

/** A matter reference: the legal matter a hold or an erasure's approval is under (LA-112). */
export const MatterRef = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'a matter reference: letters, digits, . _ / -');

export const PlaceHoldRequest = z.strictObject({
  scope: LegalHoldScope,
  matter_ref: MatterRef,
  reason: Text(500),
});
export type PlaceHoldRequest = z.infer<typeof PlaceHoldRequest>;

export const ReleaseHoldRequest = z.strictObject({ reason: Text(500) });

export const LegalHoldState = z.enum(['active', 'released']);
export type LegalHoldState = z.infer<typeof LegalHoldState>;

export const LegalHoldView = z.strictObject({
  hold_id: z.uuid(),
  scope: LegalHoldScope,
  matter_ref: MatterRef,
  reason: Text(500),
  state: LegalHoldState,
  placed_by: PrincipalId,
  placed_at: IsoDateTime,
  place_entry_seq: z.number().int().min(1),
  released_by: PrincipalId.nullable(),
  released_at: IsoDateTime.nullable(),
  release_reason: Text(500).nullable(),
  release_entry_seq: z.number().int().min(1).nullable(),
});
export type LegalHoldView = z.infer<typeof LegalHoldView>;

// ---------------------------------------------------------------- erasable payloads and erasure

/** The kinds of payload kept off the hash chain that erasure may remove (today one: conversation text). */
export const ErasablePayloadKind = z.enum(['conversation_payload']);
export type ErasablePayloadKind = z.infer<typeof ErasablePayloadKind>;

/** One erasable payload as its owner (core) lists it: never its text. */
export const ErasablePayload = z.strictObject({
  kind: ErasablePayloadKind,
  payload_id: z.uuid(),
  /** The record stream that names it (`thread:<id>`), where its erasure is recorded too. */
  thread_id: z.uuid(),
  owner: PrincipalId,
  project_id: ProjectId.nullable(),
  sha256: Sha256Hex,
  created_at: IsoDateTime,
  erased_at: IsoDateTime.nullable(),
});
export type ErasablePayload = z.infer<typeof ErasablePayload>;

export const ErasablePayloadList = z.strictObject({ payloads: z.array(ErasablePayload).max(1000) });

/** Whose payloads: one person's, optionally narrowed to one project. */
export const ErasureSubject = z.strictObject({
  principal_id: PrincipalId,
  project_id: ProjectId.nullable(),
});
export type ErasureSubject = z.infer<typeof ErasureSubject>;

export const ErasureRequestInput = z.strictObject({
  subject: ErasureSubject,
  reason: Text(500),
});
export type ErasureRequestInput = z.infer<typeof ErasureRequestInput>;

export const ErasureApproveInput = z.strictObject({ matter_ref: MatterRef, reason: Text(500) });
export const ErasureRejectInput = z.strictObject({ reason: Text(500) });

/** `request`: a person asked and another approved; `retention`: the published retention class said so. */
export const ErasureBasis = z.enum(['request', 'retention']);
export type ErasureBasis = z.infer<typeof ErasureBasis>;

export const ErasureState = z.enum([
  /** waiting for a second factory admin's legal approval */
  'requested',
  /** a legal hold covered it at approval or before a payload: nothing (more) was erased */
  'blocked',
  /** approved (`erasure.execute` is on the ledger): erasing */
  'approved',
  'executed',
  'rejected',
]);
export type ErasureState = z.infer<typeof ErasureState>;

/** A payload of an erasure, by id and hash (what the request found and the approval binds). */
export const ErasureTarget = ErasablePayload.pick({
  kind: true,
  payload_id: true,
  thread_id: true,
  owner: true,
  project_id: true,
  sha256: true,
});
export type ErasureTarget = z.infer<typeof ErasureTarget>;

export const ErasureView = z.strictObject({
  erasure_id: z.uuid(),
  basis: ErasureBasis,
  subject: ErasureSubject.nullable(),
  state: ErasureState,
  reason: Text(500),
  requested_by: z.string().min(1),
  requested_at: IsoDateTime,
  approved_by: z.string().min(1).nullable(),
  approved_at: IsoDateTime.nullable(),
  matter_ref: z.string().nullable(),
  /** The `erasure.execute` entry. */
  entry_seq: z.number().int().min(1).nullable(),
  targets: z.array(
    ErasureTarget.extend({
      erased: z.boolean(),
    }),
  ),
  blocked_by: z.array(z.uuid()),
  rejected_by: PrincipalId.nullable(),
  executed_at: IsoDateTime.nullable(),
});
export type ErasureView = z.infer<typeof ErasureView>;

/** The most payloads one erasure covers (a bigger subject is several requests). */
export const ERASURE_MAX_TARGETS = 500;

// ---------------------------------------------------------------- retention (config, M1-gated)

export const AUDIT_RETENTION_CONFIG_KEY = 'audit.retention';

/**
 * Retention classes (DM RetentionClass {retention, days}): how long each kind of erasable payload is kept before the
 * retention sweep erases it (`days: null`: kept until an erasure request). Only payloads OFF the hash chain have a
 * class: the record, the ledger and the signed exports are kept for ever (exports are under Object Lock). The default
 * keeps everything: retention erases nothing until a factory revision (an M1 gate) sets a class.
 */
export const AuditRetentionConfig = z.strictObject({
  classes: z.strictObject({
    conversation_payload: z.strictObject({
      days: z.number().int().min(1).max(36_500).nullable(),
    }),
  }),
});
export type AuditRetentionConfig = z.infer<typeof AuditRetentionConfig>;
export const DEFAULT_AUDIT_RETENTION: AuditRetentionConfig = {
  classes: { conversation_payload: { days: null } },
};

// ---------------------------------------------------------------- record events

export const AUDIT_SERVICE_EVENT = {
  export_written: 'audit.export_written',
  erasure_requested: 'audit.erasure_requested',
  erasure_rejected: 'audit.erasure_rejected',
  erasure_blocked: 'audit.erasure_blocked',
  erasure_approved: 'audit.erasure_approved',
  payload_erased: 'audit.payload_erased',
  erasure_executed: 'audit.erasure_executed',
  hold_placed: 'audit.legal_hold_placed',
  hold_released: 'audit.legal_hold_released',
  retention_swept: 'audit.retention_swept',
} as const;
export type AuditServiceEventType = (typeof AUDIT_SERVICE_EVENT)[keyof typeof AUDIT_SERVICE_EVENT];
/**
 * The audit service's streams. Not `audit:` (9.5's mode-E sample streams are `audit:<project>`, core's): every stream
 * here starts with `audit-`, which no project stream can (a project slug never follows `audit:` with a dash first).
 */
export const AUDIT_SERVICE_STREAM_PREFIX = 'audit-';
export const auditExportStream = (id: string): string => `audit-export:${id}`;
export const auditErasureStream = (id: string): string => `audit-erasure:${id}`;
export const auditHoldStream = (id: string): string => `audit-hold:${id}`;
export const AUDIT_RETENTION_STREAM = 'audit-retention';
export const AUDIT_ACTOR = 'system.audit';

export const ExportWrittenPayload = z.strictObject({
  export_id: z.uuid(),
  scope: AuditScope,
  from: IsoDateTime,
  to: IsoDateTime,
  reason: Text(500),
  requested_by: PrincipalId,
  export_sha256: Sha256Hex,
  bucket: z.string().min(3).max(63),
  object_key: Sha256Hex,
  size: z.number().int().min(0),
  key_id: z.string().min(1).max(128),
  checkpoint_seq: z.number().int().min(1),
  covered_to: z.number().int().min(1),
  entries: z.number().int().min(0),
  events: z.number().int().min(0),
  uncovered: z.number().int().min(0),
  produced_at: IsoDateTime,
});
export type ExportWrittenPayload = z.infer<typeof ExportWrittenPayload>;

export const ErasureRequestedPayload = z.strictObject({
  erasure_id: z.uuid(),
  basis: ErasureBasis,
  subject: ErasureSubject.nullable(),
  reason: Text(500),
  requested_by: z.string().min(1),
  /** For a retention erasure: the class and the config revision that said so. */
  retention: z
    .strictObject({
      class: ErasablePayloadKind,
      days: z.number().int().min(1),
      rev_hash: z.string().nullable(),
    })
    .nullable(),
  targets: z.array(ErasureTarget).min(1).max(ERASURE_MAX_TARGETS),
  requested_at: IsoDateTime,
});
export type ErasureRequestedPayload = z.infer<typeof ErasureRequestedPayload>;

export const ErasureDecidedPayload = z.strictObject({
  erasure_id: z.uuid(),
  by: z.string().min(1),
  reason: Text(500),
  matter_ref: MatterRef.nullable(),
  /** The `erasure.execute` entry (approved only). */
  entry_seq: z.number().int().min(1).nullable(),
  entry_hash: Sha256Hex.nullable(),
  at: IsoDateTime,
});
export type ErasureDecidedPayload = z.infer<typeof ErasureDecidedPayload>;

export const ErasureBlockedPayload = z.strictObject({
  erasure_id: z.uuid(),
  hold_ids: z.array(z.uuid()).min(1),
  /** Where it was stopped: at the approval, or while erasing (after the entry). */
  at_stage: z.enum(['approval', 'execution']),
  at: IsoDateTime,
});
export type ErasureBlockedPayload = z.infer<typeof ErasureBlockedPayload>;

export const AuditPayloadErasedPayload = z.strictObject({
  erasure_id: z.uuid(),
  payload_id: z.uuid(),
  sha256: Sha256Hex,
  /** `true` when the owner said it was already erased (nothing changed). */
  already: z.boolean(),
  at: IsoDateTime,
});
export type AuditPayloadErasedPayload = z.infer<typeof AuditPayloadErasedPayload>;

export const ErasureExecutedPayload = z.strictObject({
  erasure_id: z.uuid(),
  erased: z.number().int().min(0),
  at: IsoDateTime,
});

export const HoldPlacedPayload = z.strictObject({
  hold_id: z.uuid(),
  scope: LegalHoldScope,
  matter_ref: MatterRef,
  reason: Text(500),
  placed_by: PrincipalId,
  entry_seq: z.number().int().min(1),
  entry_hash: Sha256Hex,
  at: IsoDateTime,
});
export type HoldPlacedPayload = z.infer<typeof HoldPlacedPayload>;

export const HoldReleasedPayload = z.strictObject({
  hold_id: z.uuid(),
  released_by: PrincipalId,
  reason: Text(500),
  entry_seq: z.number().int().min(1),
  entry_hash: Sha256Hex,
  at: IsoDateTime,
});
export type HoldReleasedPayload = z.infer<typeof HoldReleasedPayload>;

export const RetentionSweptPayload = z.strictObject({
  class: ErasablePayloadKind,
  days: z.number().int().min(1),
  rev_hash: z.string().nullable(),
  due: z.number().int().min(0),
  held: z.number().int().min(0),
  erasure_id: z.uuid().nullable(),
  at: IsoDateTime,
});
export type RetentionSweptPayload = z.infer<typeof RetentionSweptPayload>;

// ---------------------------------------------------------------- views (the API and the portal)

export const AuditExportView = ExportWrittenPayload.extend({
  entry_seq: z.number().int().min(1),
});
export type AuditExportView = z.infer<typeof AuditExportView>;

export const AuditExportList = z.strictObject({ exports: z.array(AuditExportView) });
export const ErasureList = z.strictObject({ erasures: z.array(ErasureView) });
export const LegalHoldList = z.strictObject({ holds: z.array(LegalHoldView) });

export const RetentionView = z.strictObject({
  config: AuditRetentionConfig,
  /** The published revision the classes come from (`null`: the default, nothing published). */
  rev_hash: z.string().nullable(),
  last_sweeps: z.array(RetentionSweptPayload),
});
export type RetentionView = z.infer<typeof RetentionView>;

/** The signed bytes as the API carries them (base64 of the exact stored bytes) beside their object key. */
export const SignedExportBytes = z.strictObject({
  object_key: Sha256Hex,
  bytes_b64: z.string().min(1),
});
