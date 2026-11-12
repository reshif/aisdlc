import { z } from 'zod';
import { GateId } from '../flow.js';
import { GateStatus, LedgerDecision } from '../states/gate-instance.js';
import {
  GateInstanceId,
  IsoDateTime,
  JsonObject,
  LedgerEntryId,
  PrincipalId,
  RecordEventId,
  Sha256Hex,
  Signature,
} from './ids.js';

// The record, the ledger and the decision kernel (DM §3.4).

// ---------------------------------------------------------------- RecordEvent

/** `prev_hash` of the first event of every stream: 64 zeros (PLAN M2.1). */
export const RECORD_GENESIS_HASH = '0'.repeat(64);

/**
 * An append-only fact in a stream (PLAN M2.1): per-stream `seq`, `prev_hash` and `hash`, plus a
 * `global_seq` that is the commit order across all streams. The stream is an item, an S0 record or
 * another subject, so `stream_id` is a string. The hash is sha256 of the canonical JSON of
 * `{stream: stream_id, seq: stream_seq, event_id, type, body: payload, actor, occurred_at,
 * prev_hash}` (`global_seq` and `idempotency_key` are not hashed). `occurred_at` has millisecond
 * precision.
 */
export const RecordEvent = z
  .strictObject({
    event_id: RecordEventId,
    stream_id: z.string().min(1),
    stream_seq: z.number().int().min(1),
    global_seq: z.number().int().min(1),
    /** Event kind, dotted lowercase, for example `item.question_asked`. */
    type: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/, 'dotted lowercase'),
    payload: JsonObject,
    /** Who caused the fact: a principal id, or a system actor such as `system:notary`. */
    actor: z.string().min(1),
    occurred_at: IsoDateTime,
    /** Every inbound signal carries one (PLAN principle 3). */
    idempotency_key: z.string().min(1).nullable(),
    prev_hash: Sha256Hex,
    hash: Sha256Hex,
  })
  .refine((e) => (e.stream_seq === 1) === (e.prev_hash === RECORD_GENESIS_HASH), {
    message: 'only the first event of a stream links to the genesis hash',
    path: ['prev_hash'],
  });
export type RecordEvent = z.infer<typeof RecordEvent>;

// ---------------------------------------------------------------- Gate subject

/**
 * What a gate decides on: a work item, an S0 record (fix #32), or a config lineage (an M1 gate
 * decides a proposed `rev_hash` of one layer and scope; PLAN M3.5), an R3 breaker (its M5 reset), or a merge that
 * gate-check observed without its check passing (M14.5: the X4 post-hoc review of a bypass merge; the subject id is
 * the merge's id, `mergeSubjectId`).
 */
export const SubjectKind = z.enum(['item', 's0_record', 'config', 'breaker', 'merge', 'learn']);
export type SubjectKind = z.infer<typeof SubjectKind>;
export const SubjectKindValues: readonly SubjectKind[] = SubjectKind.options;

const SubjectId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

// ---------------------------------------------------------------- GateInstance and votes

export const GateInstance = z
  .strictObject({
    gate_instance_id: GateInstanceId,
    gate_id: GateId,
    subject_kind: SubjectKind,
    subject_id: SubjectId,
    subject_hash: Sha256Hex,
    evidence_pack_hash: Sha256Hex.nullable(),
    status: GateStatus,
    /** Conflict facts, G4 facts, project policy; `facts.expires_at` drives the TTL sweep. */
    facts: JsonObject,
    opened_at: IsoDateTime,
    decided_at: IsoDateTime.nullable(),
  })
  .superRefine((g, ctx) => {
    if (g.status === 'decided' && g.decided_at === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['decided_at'],
        message: 'a decided instance has decided_at',
      });
    }
    if (g.status === 'pending' && g.decided_at !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['decided_at'],
        message: 'a pending instance has no decided_at',
      });
    }
  });
export type GateInstance = z.infer<typeof GateInstance>;

/** A vote is one of the three quorum decisions; supersede, expire and withdraw are not votes. */
export const VoteDecision = LedgerDecision.extract(['approve', 'reject', 'request_changes']);
export type VoteDecision = z.infer<typeof VoteDecision>;

export const GateVote = z.strictObject({
  gate_instance_id: GateInstanceId,
  approver: PrincipalId,
  decision: VoteDecision,
  ledger_entry_id: LedgerEntryId,
});
export type GateVote = z.infer<typeof GateVote>;

// ---------------------------------------------------------------- LedgerEntry

/**
 * An ISO 8601 UTC instant in the exact form `Date.prototype.toISOString` writes (milliseconds,
 * `Z`). The ledger hashes this string and stores it as `timestamptz`, so only the form that
 * round-trips is accepted.
 */
export const LedgerTimestamp = IsoDateTime.refine(
  (s) => {
    const d = new Date(s);
    return !Number.isNaN(d.getTime()) && d.toISOString() === s;
  },
  { message: 'ISO 8601 UTC with milliseconds, as toISOString writes it' },
);
export type LedgerTimestamp = z.infer<typeof LedgerTimestamp>;

/** The fields the writer chooses. The Notary adds `ledger_seq`, `prev_hash`, `entry_hash`, `notary`. */
const ledgerDraftShape = {
  entry_id: LedgerEntryId,
  /** Dotted token. A `decision` entry carries every gate field; other types leave them `null`. */
  entry_type: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/, 'dotted lowercase'),
  gate_instance_id: GateInstanceId.nullable(),
  gate_id: GateId.nullable(),
  subject_kind: SubjectKind.nullable(),
  subject_id: SubjectId.nullable(),
  subject_hash: Sha256Hex.nullable(),
  decision: LedgerDecision.nullable(),
  actor: PrincipalId.nullable(),
  /** Stamped when a single person holds the role or two-person is off; never for T2. */
  sod_waiver: z.boolean(),
  /** The policy bundle version the PDP decided under. */
  policy_bundle_version: z.string().min(1),
  body: JsonObject,
  created_at: LedgerTimestamp,
};

const DECISION_FIELDS = [
  'gate_instance_id',
  'gate_id',
  'subject_kind',
  'subject_id',
  'subject_hash',
  'decision',
  'actor',
] as const;

function requireDecisionFields(
  e: { entry_type: string } & Record<(typeof DECISION_FIELDS)[number], unknown>,
  ctx: z.RefinementCtx,
): void {
  if (e.entry_type !== 'decision') return;
  for (const k of DECISION_FIELDS) {
    if (e[k] === null) {
      ctx.addIssue({ code: 'custom', path: [k], message: `a decision entry carries ${k}` });
    }
  }
}

/**
 * What a writer hands the Notary to sign (PLAN M2.3): a ledger entry before it has a position.
 * `body_hash` in the reserve step is the hash of this object.
 */
export const LedgerEntryDraft = z.strictObject(ledgerDraftShape).superRefine(requireDecisionFields);
export type LedgerEntryDraft = z.infer<typeof LedgerEntryDraft>;

/**
 * A hash-chained, Notary-signed ledger entry. `entry_type` is `decision` for a gate decision; DM
 * says the ledger has 17 types (`gate.bind`, `access`, `kill.event`, `config_publish`, ...) and names
 * only some, so the type is a dotted token. `entry_hash` is sha256 of the canonical JSON of every
 * other field except `notary` (see `ledger-format.ts`); `notary` signs that hash.
 */
export const LedgerEntry = z
  .strictObject({
    ...ledgerDraftShape,
    ledger_seq: z.number().int().min(1),
    prev_hash: Sha256Hex.nullable(),
    entry_hash: Sha256Hex,
    notary: Signature,
  })
  .superRefine((e, ctx) => {
    requireDecisionFields(e, ctx);
    if ((e.ledger_seq === 1) !== (e.prev_hash === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['prev_hash'],
        message: 'only the first entry has no prev_hash',
      });
    }
  });
export type LedgerEntry = z.infer<typeof LedgerEntry>;

// ---------------------------------------------------------------- Checkpoint

export const Cosigner = z.enum(['notary', 'witness']);
export type Cosigner = z.infer<typeof Cosigner>;

/**
 * A signed tree head over ledger entries 1..`to_ledger_seq` (DM `LedgerCheckpoint`, PLAN M2.4):
 * every 5 min, signed by the Notary and co-signed with the Witness's own key. `root_hash` is the
 * RFC 6962 Merkle root over the entry hashes of those entries, `head_hash` the last one. A
 * checkpoint without a witness signature is not valid. Both signatures cover the same digest, see
 * `ledger-format.ts`.
 */
export const Checkpoint = z
  .strictObject({
    cp_seq: z.number().int().min(1),
    from_ledger_seq: z.number().int().min(1),
    to_ledger_seq: z.number().int().min(1),
    /** Merkle tree head over the `entry_hash` of entries `from_ledger_seq`..`to_ledger_seq`. */
    root_hash: Sha256Hex,
    /** The `entry_hash` of the last covered entry, the head the signatures cover. */
    head_hash: Sha256Hex,
    signatures: z.array(z.strictObject({ signer: Cosigner, signature: Signature })).min(1),
    created_at: LedgerTimestamp,
  })
  .refine((c) => c.to_ledger_seq >= c.from_ledger_seq, {
    message: 'to_ledger_seq before from_ledger_seq',
    path: ['to_ledger_seq'],
  })
  .refine((c) => c.signatures.some((s) => s.signer === 'witness'), {
    message: 'a checkpoint is co-signed by the Witness',
    path: ['signatures'],
  });
export type Checkpoint = z.infer<typeof Checkpoint>;
