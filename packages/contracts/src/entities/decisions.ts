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

/**
 * An append-only fact in a stream (PLAN M2.1): per-stream `seq`, `prev_hash` and `hash`. The stream
 * is an item, an S0 record or another subject, so `stream_id` is a string. The hash recipe is M2.1's.
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
    occurred_at: IsoDateTime,
    /** Every inbound signal carries one (PLAN principle 3). */
    idempotency_key: z.string().min(1).nullable(),
    prev_hash: Sha256Hex.nullable(),
    hash: Sha256Hex,
  })
  .refine((e) => (e.stream_seq === 1) === (e.prev_hash === null), {
    message: 'only the first event of a stream has no prev_hash',
    path: ['prev_hash'],
  });
export type RecordEvent = z.infer<typeof RecordEvent>;

// ---------------------------------------------------------------- Gate subject

/** What a gate decides on: a work item, or an S0 record (fix #32). */
export const SubjectKind = z.enum(['item', 's0_record']);
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
 * A hash-chained, Notary-signed ledger entry. `entry_type` is `decision` for a gate decision; DM
 * says the ledger has 17 types (`gate.bind`, `access`, `kill.event`, `config_publish`, ...) and names
 * only some, so the type is a dotted token. A `decision` entry carries every gate field; other types
 * leave them `null`.
 */
export const LedgerEntry = z
  .strictObject({
    entry_id: LedgerEntryId,
    ledger_seq: z.number().int().min(1),
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
    prev_hash: Sha256Hex.nullable(),
    entry_hash: Sha256Hex,
    notary: Signature,
    created_at: IsoDateTime,
  })
  .superRefine((e, ctx) => {
    if (e.entry_type === 'decision') {
      for (const k of [
        'gate_instance_id',
        'gate_id',
        'subject_kind',
        'subject_id',
        'subject_hash',
        'decision',
        'actor',
      ] as const) {
        if (e[k] === null) {
          ctx.addIssue({ code: 'custom', path: [k], message: `a decision entry carries ${k}` });
        }
      }
    }
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
 * A signed tree head over a range of ledger entries (DM `LedgerCheckpoint`, PLAN M2.4): every 5 min,
 * co-signed with the Witness's own key. A checkpoint without a witness signature is not valid.
 */
export const Checkpoint = z
  .strictObject({
    cp_seq: z.number().int().min(1),
    from_ledger_seq: z.number().int().min(1),
    to_ledger_seq: z.number().int().min(1),
    /** The `entry_hash` of the last covered entry, the head the signatures cover. */
    head_hash: Sha256Hex,
    signatures: z.array(z.strictObject({ signer: Cosigner, signature: Signature })).min(1),
    created_at: IsoDateTime,
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
