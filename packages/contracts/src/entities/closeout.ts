import { hashCanonical } from '@aisdlc/kernel';
import { z } from 'zod';
import { GateId } from '../flow.js';
import { Lane } from '../values.js';
import { RepoFullName } from './codehost.js';
import { CatalogueRef } from './config.js';
import { MergeClass } from './gate-check.js';
import {
  GateInstanceId,
  GitSha,
  IsoDateTime,
  PrincipalId,
  ProjectId,
  Sha256Hex,
  WorkItemId,
} from './ids.js';
import { UnitKey } from './planning.js';
import { ReviewMode } from './review.js';
import { GateOutcome } from './work-lifecycle.js';

// S9 close-out (PLAN M15.4; FL S9 9.2 to 9.5, G6, X4, B17, B18, B19; FIX 4 "audit sample and break-glass review hang off
// 9.3 asynchronously", FIX 12 "mode-E suspension needs min sample"):
//
//   9.2 / G6   the requester accepts: G6 is opened with exactly the requester as its decider (the one gate the
//              requester decides; `own_request: allowed`), its facts and subject hash binding what is accepted
//              (`G6_ACCEPTANCE_FACT`). A rejection is B18 (the engine: Done, and a NEW linked item).
//   9.3        the close-out record: deterministic, built from the record and the ledger only, its id the sha256 of
//              its canonical JSON, recorded as `closeout.recorded` on `closeout:<item>` AND a ledger entry, folded
//              into `core.closeout` (rebuildable). Break-glass merges of the item's PRs get their X4 (opened if
//              gate-check or 8.2 had not), listed in the record; X4 never blocks the closing chain.
//   9.5        the mode-E audit sample: drawn asynchronously from close-out records whose G4 was mode E, outside the
//              closing chain; a person records `ok` or `gate_miss`; a miss is B19 (a NEW item); over the pinned
//              catalogue's B19 limits (miss rate over a minimum sample) mode E is suspended for the project and G4
//              opens in mode C with `mode_e_suspended`.
//   B17        an escape found post-merge: a NEW L0/L1 item, ET13, recorded on the close-out stream.

// ---------------------------------------------------------------- 9.2 / G6

/** The G6 card's fact: what the requester accepts. */
export const G6_ACCEPTANCE_FACT = 'g6_acceptance';
export const G6Acceptance = z.strictObject({
  requester: PrincipalId,
  /** The merge commit 8.2 observed (`item.merge_observed`), `null` when none is in the record. */
  merged_sha: GitSha.nullable(),
  /** The DeployMarker of S8b's release (its hash), `null` when the project releases nothing. */
  release_output: Sha256Hex.nullable(),
});
export type G6Acceptance = z.infer<typeof G6Acceptance>;

/** G6's subject hash: the engine's subject and the acceptance, bound together. */
export const g6SubjectHash = (engineSubjectHash: string, a: G6Acceptance): string =>
  hashCanonical({ engine: engineSubjectHash, [G6_ACCEPTANCE_FACT]: a } as never);

// ---------------------------------------------------------------- 9.3 close-out record

export const CLOSEOUT_SCHEMA = 'aisdlc-closeout/1';
export const CLOSEOUT_STREAM_PREFIX = 'closeout:';
export const closeoutStream = (itemId: string): string => `${CLOSEOUT_STREAM_PREFIX}${itemId}`;
export const CLOSEOUT_EVENT = {
  recorded: 'closeout.recorded',
  /** B17: an escape found after the merge; ET13 and the NEW item's spawn key. */
  escape_reported: 'closeout.escape_reported',
} as const;
export const CLOSEOUT_LEDGER_ENTRY_TYPE = 'closeout.recorded';

export const CloseOutGate = z.strictObject({
  gate: GateId,
  gate_instance_id: GateInstanceId,
  /** `null` while pending. */
  outcome: GateOutcome.nullable(),
  ledger_entry_id: z.string().min(1).nullable(),
});
export type CloseOutGate = z.infer<typeof CloseOutGate>;

export const CloseOutUnit = z.strictObject({
  unit_key: UnitKey,
  pr_number: z.number().int().min(1),
  head_sha: GitSha,
  merge_commit_sha: GitSha.nullable(),
  /** The passing Evidence Pack of exactly the head, `null` when there is none. */
  pack_sha256: Sha256Hex.nullable(),
});
export type CloseOutUnit = z.infer<typeof CloseOutUnit>;

/** A merge of one of the item's PRs that did not go through the gate: its X4 post-hoc review. */
export const CloseOutBreakGlass = z.strictObject({
  repo: RepoFullName,
  pr_number: z.number().int().min(1),
  head_sha: GitSha,
  /** gate-check's class, or `post_hoc_review` for one 8.2's reconcile found. */
  class: z.union([MergeClass.extract(['bypass', 'unauthorised']), z.literal('post_hoc_review')]),
  x4_gate_instance_id: GateInstanceId.nullable(),
});
export type CloseOutBreakGlass = z.infer<typeof CloseOutBreakGlass>;

export const CloseOutRecord = z.strictObject({
  schema: z.literal(CLOSEOUT_SCHEMA),
  item_id: WorkItemId,
  project_id: ProjectId,
  repo: RepoFullName,
  lane: Lane,
  requester: PrincipalId,
  catalogue: CatalogueRef,
  /** Every gate instance the item opened, in the order opened, with its ledger decision. */
  gates: z.array(CloseOutGate).max(500),
  merged_sha: GitSha.nullable(),
  units: z.array(CloseOutUnit).max(50),
  /** G4's review as it was decided: mode, the gate and who decided it (the audit sample's subject). */
  g4: z
    .strictObject({
      gate_instance_id: GateInstanceId,
      mode: ReviewMode.nullable(),
      deciders: z.array(PrincipalId).max(16),
    })
    .nullable(),
  release_output: Sha256Hex.nullable(),
  acceptance: z.strictObject({
    outcome: GateOutcome.nullable(),
    by: PrincipalId.nullable(),
  }),
  break_glass: z.array(CloseOutBreakGlass).max(50),
  rework: z.strictObject({
    total: z.number().int().min(0),
    by_edge: z.record(z.string(), z.number().int().min(0)),
  }),
});
export type CloseOutRecord = z.infer<typeof CloseOutRecord>;

/** The close-out record's id: the sha256 of its canonical JSON. */
export const closeOutId = (r: CloseOutRecord): string => hashCanonical(r as never);

export const CloseOutRecordedPayload = z.strictObject({
  command_key: z.string().min(1),
  closeout_sha256: Sha256Hex,
  record: CloseOutRecord,
  recorded_at: IsoDateTime,
});
export type CloseOutRecordedPayload = z.infer<typeof CloseOutRecordedPayload>;

export const EscapeReportedPayload = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  trigger: z.literal('ET13'),
  lane: Lane.extract(['L0', 'L1']),
  by: PrincipalId,
  reason_code: z.string().min(1).max(64),
  key: z.string().min(1).max(200),
  closeout_sha256: Sha256Hex,
  reported_at: IsoDateTime,
});
export type EscapeReportedPayload = z.infer<typeof EscapeReportedPayload>;

// ---------------------------------------------------------------- 9.5 mode-E audit sample, B19

export const AUDIT_STREAM_PREFIX = 'audit:';
/** One stream per project: `audit:<project>`. */
export const auditStream = (projectId: string): string => `${AUDIT_STREAM_PREFIX}${projectId}`;
export const AUDIT_EVENT = {
  /** A mode-E merge was considered for the sample (drawn or not: each close-out record once). */
  considered: 'audit.considered',
  result_recorded: 'audit.result_recorded',
  mode_e_suspended: 'audit.mode_e_suspended',
} as const;
export const MODE_E_SUSPENDED_LEDGER_ENTRY_TYPE = 'audit.mode_e_suspended';

export const AuditConsideredPayload = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  closeout_sha256: Sha256Hex,
  g4_gate_instance_id: GateInstanceId,
  /** Who decided the mode-E G4 and who requested the item: neither audits it. */
  g4_deciders: z.array(PrincipalId).max(16),
  requester: PrincipalId,
  catalogue: CatalogueRef,
  /** One in how many mode-E merges is drawn, and whether this one was. */
  sample_one_in: z.number().int().min(1),
  sampled: z.boolean(),
  at: IsoDateTime,
});
export type AuditConsideredPayload = z.infer<typeof AuditConsideredPayload>;

export const AuditOutcome = z.enum(['ok', 'gate_miss']);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

export const AuditResultRecordedPayload = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  outcome: AuditOutcome,
  by: PrincipalId,
  reason_code: z.string().min(1).max(64),
  /** The project's recorded audits after this one: how many, and how many were misses. */
  sampled: z.number().int().min(1),
  missed: z.number().int().min(0),
  at: IsoDateTime,
});
export type AuditResultRecordedPayload = z.infer<typeof AuditResultRecordedPayload>;

export const ModeESuspendedPayload = z.strictObject({
  project_id: ProjectId,
  sampled: z.number().int().min(1),
  missed: z.number().int().min(1),
  /** The pinned catalogue's B19 limits that tripped (the catalogue of the audited item). */
  limits: z.strictObject({ miss_rate: z.number(), min_sample: z.number().int() }),
  catalogue: CatalogueRef,
  /** The audit that tripped it. */
  item_id: WorkItemId,
  at: IsoDateTime,
});
export type ModeESuspendedPayload = z.infer<typeof ModeESuspendedPayload>;
