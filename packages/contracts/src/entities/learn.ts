import { hashCanonical } from '@aisdlc/kernel';
import { z } from 'zod';
import { GateId } from '../flow.js';
import { Autonomy, Lane } from '../values.js';
import { ROLE_CATALOGUE } from './access.js';
import { RepoFullName } from './codehost.js';
import {
  GateInstanceId,
  IsoDateTime,
  LedgerEntryId,
  PrincipalId,
  ProjectId,
  RoleId,
  Sha256Hex,
  WorkItemId,
} from './ids.js';
import { UnitEnvelope } from './planning.js';
import { RoleSlot } from './projects.js';
import { AuditOutcome } from './closeout.js';
import { VoteDecision } from './decisions.js';
import { GateStatus } from '../states/gate-instance.js';

// 9.4 Learn and the META gates (PLAN M15.5; FL S9 "9.4 Learn, A", FIX 12 "learning feeds governance": 9.4 proposes
// config and catalogue changes into META = M1 config, M2 variance, M3 catalogue/permission, M5 autonomy promotion,
// M6 approver grant). The factory turns close-out evidence (9.3 records, 9.5 audits, B17 escapes, X4 break-glass
// merges) into PROPOSALS, each a META gate a person decides. A proposal never changes anything by itself:
//
//   M1, M3, M6   an approval records that the change is accepted; the change itself still goes through its own path
//                (a config revision and ITS M1, a catalogue release with a new CATALOGUE_VERSION, a role map revision).
//   M2           an approval records the variance as accepted (explained); a rejection keeps it open for review.
//   M5           the one META gate with an effect: an approval of an `autonomy_promotion` records the earned autonomy,
//                an approval of a `mode_e_lift` lifts B19's mode-E suspension. A promotion or a lift happens ONLY
//                through a decided M5 read from the ledger (`learn.settled` names the decision's ledger entry).
//
// Plus the factory-wide M1 decider (PLAN §7a "Factory-wide M1"): `factory.m1_policy`.

// ---------------------------------------------------------------- factory M1 policy (PLAN §7a)

/** The config key (factory layer, M1-gated like every key) that says who decides a factory-layer M1. */
export const FACTORY_M1_POLICY_KEY = 'factory.m1_policy';

/** The roles that may decide a factory M1: fleet-scoped and approval-capable (derived from the role catalogue). */
export const FACTORY_M1_ROLES: readonly string[] = ROLE_CATALOGUE.filter(
  (r) => r.scope_kinds.includes('fleet') && r.approval_capable,
).map((r) => r.role_id);

/**
 * Who decides a factory-layer revision: the holders of `role` at the fleet scope, never the proposer (no waiver of any
 * kind), `approvers` distinct approvals. Default (the user's decision, 2026-11-11): one factory admin other than the
 * proposer. Changing it is itself a factory revision decided under the rule in force when it was proposed.
 */
export const FactoryM1Policy = z.strictObject({
  role: RoleId.refine((r) => FACTORY_M1_ROLES.includes(r), {
    message: 'a fleet-scoped, approval-capable role of the role catalogue',
  }),
  approvers: z.number().int().min(1).max(2),
});
export type FactoryM1Policy = z.infer<typeof FactoryM1Policy>;
export const DEFAULT_FACTORY_M1_POLICY: FactoryM1Policy = {
  role: 'factory.admin' as RoleId,
  approvers: 1,
};

// ---------------------------------------------------------------- project admission limits (ADR-0003 §6)

/**
 * A project's WIP limit (ADR-0003 §6 "People set the limits": project admin, M1 on the project): at most this many of
 * the project's Units hold an admission grant at once. `null`: no project limit (the sandbox caps still apply).
 */
export const PROJECT_WIP_LIMIT_KEY = 'project.wip_limit';
export const ProjectWipLimit = z.number().int().min(1).max(64).nullable();
export type ProjectWipLimit = z.infer<typeof ProjectWipLimit>;

/**
 * A project's default envelope: the envelope of an item that has no plan (one implicit Unit), and the most any one
 * Unit of the project reserves (a planned Unit's envelope above it is reserved at this). `null`: the lane profile and
 * the coder contract alone (5.5).
 */
export const PROJECT_DEFAULT_ENVELOPE_KEY = 'project.default_envelope';
export const ProjectDefaultEnvelope = UnitEnvelope.nullable();
export type ProjectDefaultEnvelope = z.infer<typeof ProjectDefaultEnvelope>;

// ---------------------------------------------------------------- the Learn thresholds

/**
 * When 9.4 proposes (factory layer, M1-gated; never catalogue data: these say when to ASK a person, they decide
 * nothing). `window`: the newest close-outs of a project 9.4 looks at.
 */
export const LEARN_CONFIG_KEY = 'factory.learn';
export const LearnConfig = z.strictObject({
  window: z.number().int().min(1).max(500),
  /** M5 promotion / lift: this many clean close-outs in a row (no escape, no break-glass, no rework, no miss). */
  clean_streak: z.number().int().min(1).max(500),
  /** M2: a close-out whose rework total is at least this is a variance. */
  variance_rework: z.number().int().min(1).max(100),
  /** M3: a back-edge taken in at least this many close-outs of the window is a catalogue question. */
  edge_hotspot: z.number().int().min(2).max(500),
  /** M1: at least this many break-glass merges in the window asks to review the bypass list. */
  break_glass: z.number().int().min(1).max(500),
  /** M6: this many mode-E close-outs in a row decided by the same one approver asks for another approver. */
  single_approver: z.number().int().min(2).max(500),
});
export type LearnConfig = z.infer<typeof LearnConfig>;
export const DEFAULT_LEARN_CONFIG: LearnConfig = {
  window: 50,
  clean_streak: 20,
  variance_rework: 3,
  edge_hotspot: 5,
  break_glass: 3,
  single_approver: 10,
};

// ---------------------------------------------------------------- proposals

/** The META gates 9.4 proposes into. */
export const MetaGate = GateId.extract(['M1', 'M2', 'M3', 'M5', 'M6']);
export type MetaGate = z.infer<typeof MetaGate>;

export const LearnProposalKind = z.enum([
  'config_review',
  'variance',
  'catalogue_review',
  'autonomy_promotion',
  'mode_e_lift',
  'approver_grant',
]);
export type LearnProposalKind = z.infer<typeof LearnProposalKind>;

/** The one META gate each kind is decided by. */
export const META_GATE_OF_KIND: Readonly<Record<LearnProposalKind, MetaGate>> = {
  config_review: 'M1',
  variance: 'M2',
  catalogue_review: 'M3',
  autonomy_promotion: 'M5',
  mode_e_lift: 'M5',
  approver_grant: 'M6',
};

/** What a proposal asks for, by kind. */
export const LearnChange = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('config_review'),
    /** The config key to review (a person then proposes the revision, which has its own M1). */
    key: z.string().min(1).max(128),
    repos: z.array(RepoFullName).max(50),
    break_glass: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal('variance'),
    item_id: WorkItemId,
    lane: Lane,
    rework_total: z.number().int().min(0),
    by_edge: z.record(z.string(), z.number().int().min(0)),
  }),
  z.strictObject({
    kind: z.literal('catalogue_review'),
    /** The back-edge whose limit to review in the next catalogue release (never edited in place). */
    edge: z.string().min(1).max(16),
    items: z.number().int().min(1),
    catalogue_version: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('autonomy_promotion'),
    from: Autonomy,
    to: Autonomy,
    clean_streak: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal('mode_e_lift'),
    /** The suspension's record event (its global seq): the lift binds exactly this suspension. */
    suspension_gseq: z.number().int().min(1),
    sampled: z.number().int().min(0),
    missed: z.number().int().min(0),
    /** Clean close-outs since the suspension (0 for a person's own request). */
    clean_since: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal('approver_grant'),
    slot: RoleSlot,
    /** The one principal who decided every one of the streak. */
    sole_approver: PrincipalId,
    streak: z.number().int().min(1),
  }),
]);
export type LearnChange = z.infer<typeof LearnChange>;

/** Where a proposal came from: the evidence rule and the close-out records it read. */
export const LearnSignal = z.enum([
  'break_glass_repeat',
  'rework_variance',
  'edge_hotspot',
  'clean_streak',
  'clean_since_suspension',
  'requested',
  'single_approver',
]);
export type LearnSignal = z.infer<typeof LearnSignal>;

export const LearnProposalBody = z.strictObject({
  project_id: ProjectId,
  kind: LearnProposalKind,
  meta_gate: MetaGate,
  signal: LearnSignal,
  /** The close-out ids (sha256) the proposal rests on, oldest first. */
  evidence: z.array(Sha256Hex).max(500),
  change: LearnChange,
});
export type LearnProposalBody = z.infer<typeof LearnProposalBody>;

/** A proposal's id: the sha256 of its canonical body. The META gate's subject hash is this id. */
export const learnProposalId = (b: LearnProposalBody): string => hashCanonical(b as never);

export const LEARN_STREAM_PREFIX = 'learn:';
/** One stream per project: `learn:<project>`. */
export const learnStream = (projectId: string): string => `${LEARN_STREAM_PREFIX}${projectId}`;

export const LEARN_EVENT = {
  /** A proposal and the META gate opened for it. */
  proposed: 'learn.proposed',
  /** Its META gate ended (from the ledger): the outcome and, for an approved M5, the effect. */
  settled: 'learn.settled',
} as const;

export const LearnProposedPayload = z.strictObject({
  proposal_id: Sha256Hex,
  proposal: LearnProposalBody,
  gate_instance_id: GateInstanceId,
  proposed_by: z.string().min(1),
  at: IsoDateTime,
});
export type LearnProposedPayload = z.infer<typeof LearnProposedPayload>;

/** What an approved proposal did. Only M5 changes something; the others record acceptance. */
export const LearnEffect = z.enum(['autonomy_earned', 'mode_e_lifted', 'accepted', 'none']);
export type LearnEffect = z.infer<typeof LearnEffect>;

export const LearnSettledPayload = z.strictObject({
  proposal_id: Sha256Hex,
  project_id: ProjectId,
  gate_instance_id: GateInstanceId,
  meta_gate: MetaGate,
  /** The gate's end from the ledger: a vote's decision, or `expired`, `withdrawn`, `superseded`. */
  outcome: z.union([VoteDecision, z.enum(['expired', 'withdrawn', 'superseded'])]),
  /** The decision entry that ended it. */
  ledger_entry_id: LedgerEntryId.nullable(),
  effect: LearnEffect,
  at: IsoDateTime,
});
export type LearnSettledPayload = z.infer<typeof LearnSettledPayload>;

/** A proposal as the portal lists it. */
export const LearnProposalView = z.strictObject({
  proposal_id: Sha256Hex,
  proposal: LearnProposalBody,
  gate_instance_id: GateInstanceId,
  /** The card a person decides it on (`/v1/cards/:id/gate`), when one was opened. */
  card_id: z.string().min(1).nullable(),
  status: z.enum(['pending', 'settled']),
  outcome: LearnSettledPayload.shape.outcome.nullable(),
  effect: LearnEffect.nullable(),
  proposed_at: IsoDateTime,
});
export type LearnProposalView = z.infer<typeof LearnProposalView>;

/** What 9.4 knows of a project: its proposals, the earned autonomy and whether mode E is suspended. */
export const ProjectLearnView = z.strictObject({
  project_id: ProjectId,
  proposals: z.array(LearnProposalView),
  /** The autonomy an approved M5 earned (replaces the probation cap), `null`: none earned. */
  earned_autonomy: z
    .strictObject({
      level: Autonomy,
      gate_instance_id: GateInstanceId,
      ledger_entry_id: LedgerEntryId,
    })
    .nullable(),
  mode_e_suspended: z.boolean(),
});
export type ProjectLearnView = z.infer<typeof ProjectLearnView>;

// ---------------------------------------------------------------- the mode-E lift (B19, through M5)

/** The record event of a lift on `audit:<project>`: a new audit window starts after it. */
export const MODE_E_LIFTED_EVENT = 'audit.mode_e_lifted';
export const ModeELiftedPayload = z.strictObject({
  project_id: ProjectId,
  /** The suspension lifted (its record event). */
  suspension_gseq: z.number().int().min(1),
  proposal_id: Sha256Hex,
  gate_instance_id: GateInstanceId,
  ledger_entry_id: LedgerEntryId,
  at: IsoDateTime,
});
export type ModeELiftedPayload = z.infer<typeof ModeELiftedPayload>;

// ---------------------------------------------------------------- HTTP bodies (M15.5 routes)

const Key = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

/** 9.5: a person's audit of one drawn mode-E merge. */
export const AuditResultRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  outcome: AuditOutcome,
  reason_code: z.string().min(1).max(64),
});
export type AuditResultRequest = z.infer<typeof AuditResultRequest>;

export const AuditResultResult = z.strictObject({
  sampled: z.number().int().min(0),
  missed: z.number().int().min(0),
  suspended: z.boolean(),
});
export type AuditResultResult = z.infer<typeof AuditResultResult>;

/** B17: an escape found after the merge of a closed-out item. */
export const EscapeReportRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  lane: Lane.extract(['L0', 'L1']),
  reason_code: z.string().min(1).max(64),
  key: Key,
});
export type EscapeReportRequest = z.infer<typeof EscapeReportRequest>;

/** B14: the mode-E G4 approver is unsure; the review goes to a codeowner (mode C). */
export const ReviewerUnsureRequest = z.strictObject({ on_behalf_of: PrincipalId, key: Key });
export type ReviewerUnsureRequest = z.infer<typeof ReviewerUnsureRequest>;

export const DuplicateResult = z.strictObject({ duplicate: z.boolean() });
export type DuplicateResult = z.infer<typeof DuplicateResult>;

/** Run 9.4 for a project now (the loop does it too). */
export const LearnRunRequest = z.strictObject({ on_behalf_of: PrincipalId });
export type LearnRunRequest = z.infer<typeof LearnRunRequest>;
export const LearnRunResult = z.strictObject({
  proposed: z.array(Sha256Hex),
  settled: z.array(Sha256Hex),
});
export type LearnRunResult = z.infer<typeof LearnRunResult>;

/** A person asks to lift B19's mode-E suspension: an M5 the project admins decide. */
export const ModeELiftRequest = z.strictObject({ on_behalf_of: PrincipalId });
export type ModeELiftRequest = z.infer<typeof ModeELiftRequest>;
export const LearnProposeResult = z.strictObject({
  proposal_id: Sha256Hex,
  gate_instance_id: GateInstanceId,
  duplicate: z.boolean(),
});
export type LearnProposeResult = z.infer<typeof LearnProposeResult>;

/** A factory-layer revision as something to decide (the configuration console's decide path). */
export const FactoryRevisionView = z.strictObject({
  gate_instance_id: GateInstanceId,
  rev_hash: Sha256Hex,
  parent_rev_hash: Sha256Hex.nullable(),
  proposed_by: PrincipalId,
  status: GateStatus,
  outcome: VoteDecision.nullable(),
  published: z.boolean(),
  /** Every key the revision changes against its parent: before and after. */
  changes: z.array(z.strictObject({ key: z.string(), before: z.unknown(), after: z.unknown() })),
  evidence_hash: Sha256Hex,
  /** Who may decide it now: the policy's role holders without the proposer, and how many approvals it needs. */
  policy: FactoryM1Policy,
  deciders: z.array(PrincipalId),
  quorum: z.number().int().min(1),
});
export type FactoryRevisionView = z.infer<typeof FactoryRevisionView>;
