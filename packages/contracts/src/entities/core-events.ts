import { z } from 'zod';
import { LevelValues, Level, Tier } from '../values.js';
import { RepoFullName } from './codehost.js';
import { CatalogueRef } from './config.js';
import { Classification } from './identity.js';
import {
  CauseCode,
  CardId,
  IsoDateTime,
  LedgerEntryId,
  PrincipalId,
  ProjectId,
  RepoId,
  S0RecordId,
  Sha256Hex,
  TeamId,
  WorkItemId,
  WorkRequestId,
} from './ids.js';
import {
  CardKind,
  OnboardingStepId,
  OnboardingStepState,
  OnboardingStep,
  S0Record,
} from './onboarding.js';
import { OnboardingStatus } from '../states/onboarding.js';
import { ReadinessActor, ReadinessStatus } from '../states/readiness.js';
import { Lane } from '../values.js';
import { ControlsReport } from './onboarding-cards.js';
import {
  GatingProfile,
  Project,
  Repo,
  KillDelegation,
  ProjectSettings,
  RepoOwnerType,
  RepoVisibility,
  RoleMap,
  RoleSlotValues,
  TwoPerson,
  type RoleSlot,
} from './projects.js';
import { ProjectReadinessRecord, SignerMode } from './readiness.js';
import { VoteDecision } from './decisions.js';
import { EntryChannel } from '../values.js';
import { TaintedText } from './work-lifecycle.js';

// The Projects and Onboarding context of core (PLAN M7.1, M7.2): the record streams of the Project,
// Repo and S0 aggregates with their event payloads, the `project.onboard` request, the S0 step
// driver's configuration (OB §6.2 time boxes, DEC-9 failure model) and the shapes core serves to
// its callers. The record is the source of truth; the `core` read models fold these events.

// ---------------------------------------------------------------- Streams

export const projectStream = (project: string): string => `project:${project}`;
/** One stream per repo; repo names compare without case, like the code host's. */
export const repoStream = (repo: string): string => `repo:${repo.toLowerCase()}`;
export const s0Stream = (s0Id: string): string => `s0:${s0Id}`;
/** The versions of one Project Readiness Record (`prr:<project>:<repo_id>`, OB §2.4) are one stream. */
export const prrStream = (project: string, repoId: string): string => `prr:${project}:${repoId}`;
/** A work request (PLAN M7.6, the minimal intake; the full lifecycle is M9). */
export const workStream = (requestId: string): string => `work:${requestId}`;

/** The stream prefixes the `core` read model folds. */
export const CORE_STREAM_PREFIXES = ['project:', 'repo:', 's0:'] as const;

/** The key a repo is looked up by: owner/name without case. */
export const repoKeyOf = (repo: string): string => repo.toLowerCase();

/** `record:<intake event id>` (DEC-2, OB §6: `s0_ref`, never `g0_ref`). */
export const s0RefOf = (intakeEventId: string): string => `record:${intakeEventId}`;

// ---------------------------------------------------------------- Event types

export const PROJECT_EVENT = {
  registered: 'project.registered',
  attested: 'project.attested',
  /** M4 signed the onboarding: the project's tier and level (M7.5 writes it). */
  signed: 'project.signed',
  /** The PRR is active: the repo may take work in the lanes it lists (`project.ready`, OB §6.2 row 0.5). */
  ready: 'project.ready',
} as const;

export const REPO_EVENT = {
  registered: 'repo.registered',
  observed: 'repo.observed',
  level_set: 'repo.level_set',
} as const;

export const S0_EVENT = {
  /** The intake event: `s0_ref = record:<its event id>`. */
  requested: 's0.requested',
  status_changed: 's0.status_changed',
  step_changed: 's0.step_changed',
  /** A step needs a person: the hand-off to the card layer (M7.3). */
  card_required: 's0.card_required',
  job_started: 's0.job_started',
  census_ready: 's0.census_ready',
  machine_failed: 's0.machine_failed',
  send_back: 's0.send_back',
  waiting: 's0.waiting',
  reminder: 's0.reminder',
  timebox_exceeded: 's0.timebox_exceeded',
  signable_level_set: 's0.signable_level_set',
  /** A decided card was applied to the S0 record (M7.3). */
  card_applied: 's0.card_applied',
  /** Card 5 was approved: the 0.5 sign-off and M4 are on the ledger, and the PRR goes active (M7.5). */
  signoff_ready: 's0.signoff_ready',
  /** Card 4's re-check read the code host again. */
  controls_checked: 's0.controls_checked',
  /** The bootstrap decider (PLAN M7.4): the requester is the provisional admin of cards 1, 4 and 5. */
  bootstrap_granted: 's0.bootstrap_granted',
  /** The controls report card 4 was decided on, in full: the PRR's `controls` are read from it. */
  controls_recorded: 's0.controls_recorded',
  /** A PRR was built and proposed for the sign-off (PLAN M7.4, M7.5); its hash is the M4 subject. */
  prr_proposed: 's0.prr_proposed',
} as const;

/** The events of a PRR stream (`prr:<project>:<repo_id>`). */
export const PRR_EVENT = {
  /** A version, whole, in status `proposed`. */
  proposed: 'prr.proposed',
  /** Only an M4 decision does this (`proposed -> active`). */
  activated: 'prr.activated',
  /** A later status: stale, suspended, expired (mechanical, tighten-only) or superseded (a newer M4). */
  status_changed: 'prr.status_changed',
} as const;

/** The events of a work request (PLAN M7.6). */
export const WORK_EVENT = {
  requested: 'work.requested',
  /** N8: no active PRR, so the request waits. */
  held: 'work.held',
  /** The lane was eligible: the request goes on to the normal lifecycle (M9 owns it). */
  admitted: 'work.admitted',
  /** The 1.4 rule: a PRR that is too low, suspended, stale or expired sends the request to L8. */
  routed_l8: 'work.routed_l8',
  /** A held request was released into its lane by an M4 (the project-level fan-out). */
  released: 'work.released',
  /** An M4 made the PRR active but not for this request's lane: L8 human-led is offered. */
  l8_offered: 'work.l8_offered',
  /** M9.1: the item made from this request (the request's own marker, so it is made once). */
  item_created: 'work.item_created',
} as const;

// ---------------------------------------------------------------- The request

/**
 * Raise-only attestations that may come with a `project.onboard` request (OB §6.1): each can only
 * make the project's risk higher, never lower it. A claim that lowers anything (tier T0, an
 * "internal" classification, "does not deploy") is not expressible here: T0 needs the positive
 * owner attestation on card 1 (DEC-4).
 */
export const OnboardAttestations = z.strictObject({
  classification: Classification.extract(['confidential']).optional(),
  /** A tier floor; the detectors and the owner can only raise it further. */
  tier_floor: Tier.extract(['T1', 'T2']).optional(),
  /** The project deploys (turns the T2 `g5` floor on). */
  deploys: z.literal(true).optional(),
  /** Team mode raises RS-CC-1/2 to FLOOR. */
  mode: SignerMode.extract(['team']).optional(),
});
export type OnboardAttestations = z.infer<typeof OnboardAttestations>;

/** `POST /v1/onboard`: repo, requested level, project slug and optional raise-only attestations. */
export const OnboardRequest = z.strictObject({
  project_id: ProjectId,
  repo: RepoFullName,
  level: Level,
  /** Default: the slug. Only used when the request creates the project. */
  name: z.string().min(1).max(200).optional(),
  team_id: TeamId.nullable().optional(),
  attestations: OnboardAttestations.optional(),
  /**
   * A retry key (principle 3): the S0 record's UUID is derived from it, so the same request sent
   * twice is one record. Absent: every request is a new S0 record, which supersedes the old one.
   */
  request_id: z.uuid().optional(),
  /** The signed-in human the BFF acts for; the PDP decides about them. */
  on_behalf_of: PrincipalId,
});
export type OnboardRequest = z.infer<typeof OnboardRequest>;

// ---------------------------------------------------------------- Payloads: Project and Repo

export const ProjectRegisteredPayload = z.strictObject({
  project_id: ProjectId,
  name: z.string().min(1),
  team_id: TeamId.nullable(),
  classification: Classification,
  stack: z.string().min(1).nullable(),
  deploys: z.boolean().nullable(),
  owner: PrincipalId.nullable(),
  requested_by: PrincipalId,
});
export type ProjectRegisteredPayload = z.infer<typeof ProjectRegisteredPayload>;

export const ProjectAttestedPayload = z.strictObject({
  s0_id: S0RecordId,
  attestations: OnboardAttestations,
  by: PrincipalId,
});
export type ProjectAttestedPayload = z.infer<typeof ProjectAttestedPayload>;

export const ProjectSignedPayload = z.strictObject({
  s0_id: S0RecordId,
  tier: Tier,
  level: Level,
  by: z.string().min(1),
});
export type ProjectSignedPayload = z.infer<typeof ProjectSignedPayload>;

export const RepoRegisteredPayload = z.strictObject({
  repo_id: RepoId,
  repo_ref: RepoFullName,
  project_id: ProjectId,
  host: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
});
export type RepoRegisteredPayload = z.infer<typeof RepoRegisteredPayload>;

/** What the code host said about the repo (step 0.1); a field it did not say stays `null`. */
export const RepoObservedPayload = z.strictObject({
  visibility: RepoVisibility.nullable(),
  owner_type: RepoOwnerType.nullable(),
  default_branch: z.string().min(1).nullable(),
});
export type RepoObservedPayload = z.infer<typeof RepoObservedPayload>;

export const RepoLevelSetPayload = z.strictObject({
  level: Level,
  s0_id: S0RecordId,
});
export type RepoLevelSetPayload = z.infer<typeof RepoLevelSetPayload>;

// ---------------------------------------------------------------- Payloads: S0

export const S0RequestedPayload = z.strictObject({
  s0_id: S0RecordId,
  project_id: ProjectId,
  repo: RepoFullName,
  repo_id: RepoId,
  requested_level: Level,
  attestations: OnboardAttestations,
  requested_by: PrincipalId,
  /** The catalogue revision this onboarding starts with (M1.6). */
  catalogue_ref: CatalogueRef,
});
export type S0RequestedPayload = z.infer<typeof S0RequestedPayload>;

export const S0StatusChangedPayload = z.strictObject({
  from: OnboardingStatus,
  to: OnboardingStatus,
  /** `park.timeout`, `machine.retries_exhausted`, `superseded`, `withdrawn`... */
  cause: CauseCode.nullable(),
  reason: z.string().max(500).nullable(),
  /** Set when `to` is `superseded`: the newer record. */
  superseded_by: S0RecordId.nullable(),
  /** Set when `to` is `rejected`: the step that was sent back twice (`rejected_at:<step>`). */
  rejected_at: OnboardingStepId.nullable(),
});
export type S0StatusChangedPayload = z.infer<typeof S0StatusChangedPayload>;

export const S0StepChangedPayload = z.strictObject({
  step: OnboardingStepId,
  state: OnboardingStepState,
  blocked_cause: CauseCode.nullable(),
  reason: z.string().max(500).nullable(),
});
export type S0StepChangedPayload = z.infer<typeof S0StepChangedPayload>;

export const S0CardRequiredPayload = z.strictObject({
  step: OnboardingStepId,
  card: CardKind,
  /** 0.4 at Census is the reduced one (OB §6.2 notes). */
  reduced: z.boolean(),
  /** `first`: the step reached its card; `again`: after a send-back, a park or a restore. */
  occasion: z.enum(['first', 'again']),
});
export type S0CardRequiredPayload = z.infer<typeof S0CardRequiredPayload>;

export const S0JobStartedPayload = z.strictObject({
  step: OnboardingStepId.extract(['0.1']),
  job_id: z.string().min(1),
});
export type S0JobStartedPayload = z.infer<typeof S0JobStartedPayload>;

export const S0CensusReadyPayload = z.strictObject({
  job_id: z.string().min(1),
  census_id: z.string().min(1),
  census_hash: Sha256Hex,
  /** An open secret: Light and Full are blocked, Census may still sign. */
  b1_blocked: z.boolean(),
  /** B1 or B2 is not met (an open secret, or a scan that did not complete). */
  secrets_not_met: z.boolean(),
});
export type S0CensusReadyPayload = z.infer<typeof S0CensusReadyPayload>;

export const S0MachineFailedPayload = z.strictObject({
  step: OnboardingStepId,
  /** 1 for the first failure of the step. */
  attempt: z.number().int().min(1),
  cause: CauseCode,
  detail: z.string().max(500),
});
export type S0MachineFailedPayload = z.infer<typeof S0MachineFailedPayload>;

export const S0SendBackPayload = z.strictObject({
  step: OnboardingStepId,
  /** The step's send-back count after this one. */
  count: z.number().int().min(1),
  by: z.string().min(1),
  reason: z.string().max(500).nullable(),
});
export type S0SendBackPayload = z.infer<typeof S0SendBackPayload>;

/** `0.1 waiting: App not installed`; `waiting: null` clears it. */
export const S0WaitingPayload = z.strictObject({
  step: OnboardingStepId,
  waiting: z.string().min(1).max(200).nullable(),
  cause: CauseCode.nullable(),
});
export type S0WaitingPayload = z.infer<typeof S0WaitingPayload>;

export const S0ReminderPayload = z.strictObject({
  step: OnboardingStepId,
  due_at: IsoDateTime,
});
export type S0ReminderPayload = z.infer<typeof S0ReminderPayload>;

export const S0TimeboxExceededPayload = z.strictObject({
  step: OnboardingStepId,
  overall_business_days: z.number().int().min(1),
  due_at: IsoDateTime,
});
export type S0TimeboxExceededPayload = z.infer<typeof S0TimeboxExceededPayload>;

export const S0SignableLevelPayload = z.strictObject({
  requested_level: Level,
  signable_level: Level,
  /** A cause code (`security.open_secret`) or `human`. */
  reason: CauseCode,
  by: z.string().min(1),
});
export type S0SignableLevelPayload = z.infer<typeof S0SignableLevelPayload>;

/** What a decided card did to the record (M7.3). Written in the transaction that moves the step. */
export const S0CardAppliedPayload = z.strictObject({
  card_id: CardId,
  card: CardKind,
  step: OnboardingStepId,
  decision: VoteDecision,
  /** The hash of the list payload the ledger entries carry. */
  payload_hash: Sha256Hex,
  /**
   * `stale`: the person decided, but the record had moved on (parked, withdrawn): the decision is
   * on the ledger and nothing was applied; the step is raised again.
   */
  outcome: z.enum([
    'step_done',
    'sent_back',
    'rejected',
    'finding_resolved',
    'signoff_ready',
    /** Card 5, approved: the sign-off and M4 are on the ledger, the PRR is active, the record is done. */
    'm4_approved',
    'stale',
  ]),
  by: PrincipalId,
  /** Pointers to what the decision caused (a config revision hash, its M1 gate); never a value. */
  refs: z.record(z.string().min(1), z.string().min(1)),
});
export type S0CardAppliedPayload = z.infer<typeof S0CardAppliedPayload>;

/** What M4 signs over (OB §6.2 row 0.5): the three hashes, and the PRR they went into. */
export const M4Package = z.strictObject({
  census_hash: Sha256Hex,
  gap_ledger_hash: Sha256Hex,
  controls_report_hash: Sha256Hex,
  prr_record_hash: Sha256Hex,
});
export type M4Package = z.infer<typeof M4Package>;

/**
 * Card 5 was approved (PLAN M7.5): the sign-off of step 0.5 and the M4 gate are both on the ledger
 * (two entries, one card). Written in the transaction that makes the PRR active.
 */
export const S0SignoffReadyPayload = z.strictObject({
  card_id: CardId,
  signoff_entry_id: LedgerEntryId,
  package: M4Package,
  payload_hash: Sha256Hex,
  by: PrincipalId,
});
export type S0SignoffReadyPayload = z.infer<typeof S0SignoffReadyPayload>;

export const S0ControlsCheckedPayload = z.strictObject({
  step: OnboardingStepId.extract(['0.4']),
  report_hash: Sha256Hex,
  /** Ids of the blocking controls that are not met (empty: the card can be decided). */
  blocking_open: z.array(z.string().min(1)),
  by: PrincipalId,
});
export type S0ControlsCheckedPayload = z.infer<typeof S0ControlsCheckedPayload>;

// ---------------------------------------------------------------- Bootstrap, PRR and work events

/** The cards the bootstrap decider covers (PLAN M7.4). The security card, M4 and every other gate are not among them. */
export const BOOTSTRAP_CARDS = ['C1', 'C4', 'C5'] as const;
export const BootstrapCard = z.enum(BOOTSTRAP_CARDS);

/**
 * User decision 2026-11-08: on a project's first onboarding (no published role map, no other live
 * bootstrap) the requester, who passed `project.onboard`, is the provisional admin of this S0
 * record's cards 1, 4 and 5. It ends when card 4's revision is published, or when the record ends.
 * `ledger_entry_id` is the ledger entry that states the grant.
 */
export const S0BootstrapGrantedPayload = z.strictObject({
  s0_id: S0RecordId,
  project_id: ProjectId,
  grantee: PrincipalId,
  slot: z.literal('admin'),
  cards: z.array(BootstrapCard).min(1),
  basis: z.literal('first_onboarding_no_role_map'),
  ledger_entry_id: LedgerEntryId,
});
export type S0BootstrapGrantedPayload = z.infer<typeof S0BootstrapGrantedPayload>;

/** The `entry_type` of the ledger entry that states a bootstrap grant. */
export const BOOTSTRAP_ENTRY_TYPE = 's0.bootstrap_grant';

export const S0ControlsRecordedPayload = z.strictObject({
  report: ControlsReport,
  /** When the factory read the code host for this report (the card 4 decision). */
  read_at: IsoDateTime,
  /** What reading the collaborators gave when the role map was proposed. */
  collaborators_read: z.enum(['ok', 'unknown', 'unreadable']),
});
export type S0ControlsRecordedPayload = z.infer<typeof S0ControlsRecordedPayload>;

export const S0PrrProposedPayload = z.strictObject({
  /** Which raising of card 5 this PRR belongs to (the n-th `s0.card_required` for C5). */
  occurrence: z.number().int().min(1),
  record_id: z.string().min(1),
  version: z.number().int().min(1),
  record_hash: Sha256Hex,
  level_signed: Level,
  tier: Tier,
});
export type S0PrrProposedPayload = z.infer<typeof S0PrrProposedPayload>;

export const PrrProposedPayload = z.strictObject({
  s0_id: S0RecordId,
  prr: ProjectReadinessRecord,
});
export type PrrProposedPayload = z.infer<typeof PrrProposedPayload>;

export const PrrActivatedPayload = z.strictObject({
  s0_id: S0RecordId,
  version: z.number().int().min(1),
  record_hash: Sha256Hex,
  /** The M4 ledger entry and its `entry_hash`: the decision this version was made active by. */
  m4: z.strictObject({ ledger_entry_id: LedgerEntryId, decision_hash: Sha256Hex }),
});
export type PrrActivatedPayload = z.infer<typeof PrrActivatedPayload>;

export const PrrStatusChangedPayload = z.strictObject({
  version: z.number().int().min(1),
  record_hash: Sha256Hex,
  from: ReadinessStatus,
  to: ReadinessStatus,
  actor: ReadinessActor,
  cause: CauseCode,
});
export type PrrStatusChangedPayload = z.infer<typeof PrrStatusChangedPayload>;

export const ProjectReadyPayload = z.strictObject({
  project_id: ProjectId,
  repo: RepoFullName,
  s0_id: S0RecordId,
  prr_version: z.number().int().min(1),
  record_hash: Sha256Hex,
  level: Level,
  lanes_eligible: z.array(Lane),
});
export type ProjectReadyPayload = z.infer<typeof ProjectReadyPayload>;

/** Why a lane was or was not open to a repo (PLAN M7.6). */
export const EligibilityReason = z.enum([
  'eligible',
  /** N8: no PRR has ever been active for the repo. */
  'no_active_prr',
  'prr_stale',
  'prr_suspended',
  'prr_expired',
  'level_too_low',
  /** L0 and L7 are `unspecified` at every level (OB §2.1): not eligible. */
  'lane_unspecified',
  'tier_requires_full',
  'posture_red',
  'staging_separation_not_attested',
  /** R3: the circuit breaker (ET14) of the project and lane is tripped: new items go to L8. */
  'circuit_breaker',
  /** R4: a hotfix's L1 follow-up is overdue: no new agent items for the project. */
  'followup_overdue',
]);
export type EligibilityReason = z.infer<typeof EligibilityReason>;

export const EligibilityRoute = z.enum(['normal', 'n8_hold', 'l8']);
export type EligibilityRoute = z.infer<typeof EligibilityRoute>;

/** `eligibility(repo, lane)`: whether the lane runs, and where a request for it goes (DEC-8). */
export const LaneEligibility = z.strictObject({
  repo: RepoFullName,
  lane: Lane,
  eligible: z.boolean(),
  route: EligibilityRoute,
  reason: EligibilityReason,
  prr: z
    .strictObject({
      version: z.number().int().min(1),
      status: ReadinessStatus,
      level: Level,
      record_hash: Sha256Hex,
      fresh_until: IsoDateTime,
    })
    .nullable(),
});
export type LaneEligibility = z.infer<typeof LaneEligibility>;

export const WorkRequestedPayload = z.strictObject({
  request_id: WorkRequestId,
  project_id: ProjectId,
  repo: RepoFullName,
  lane: Lane,
  channel: EntryChannel,
  requester: PrincipalId,
  catalogue_ref: CatalogueRef,
  /**
   * M9.1: the request's text after S1 step 1.1 (normalised, taint-marked, with its provenance and
   * any injection flags). Absent on a request made by the M7.6 minimal intake.
   */
  request_text: TaintedText.nullable().optional(),
});
export type WorkRequestedPayload = z.infer<typeof WorkRequestedPayload>;

export const WorkItemCreatedPayload = z.strictObject({
  request_id: WorkRequestId,
  item_id: WorkItemId,
});
export type WorkItemCreatedPayload = z.infer<typeof WorkItemCreatedPayload>;

export const WorkHeldPayload = z.strictObject({
  request_id: WorkRequestId,
  channel: z.literal('N8'),
  reason: z.literal('no_active_prr'),
  /** The held card offers "Onboard" or "Continue as L8 human-led" (OB §N8). */
  offers: z.array(z.enum(['onboard', 'continue_as_l8'])),
});
export type WorkHeldPayload = z.infer<typeof WorkHeldPayload>;

export const WorkAdmittedPayload = z.strictObject({
  request_id: WorkRequestId,
  lane: Lane,
  prr_version: z.number().int().min(1),
  record_hash: Sha256Hex,
});
export type WorkAdmittedPayload = z.infer<typeof WorkAdmittedPayload>;

export const WorkRoutedL8Payload = z.strictObject({
  request_id: WorkRequestId,
  requested_lane: Lane,
  reason: EligibilityReason,
  prr_version: z.number().int().min(1).nullable(),
});
export type WorkRoutedL8Payload = z.infer<typeof WorkRoutedL8Payload>;

/** The fan-out of an M4: a held request released, or offered L8. */
export const WorkFanOutPayload = z.strictObject({
  request_id: WorkRequestId,
  requested_lane: Lane,
  /** The M4 behind it: the PRR version and its hash. */
  prr_version: z.number().int().min(1),
  record_hash: Sha256Hex,
  s0_id: S0RecordId,
  /** `released`: the lane is eligible now. `l8_offered`: it is not, and nothing else starts. */
  reason: EligibilityReason,
});
export type WorkFanOutPayload = z.infer<typeof WorkFanOutPayload>;

// ---------------------------------------------------------------- Config: S0 driver

/** DEC-9 and OB §6.2. `send_backs_per_step` is 1: a second reject is `rejected_at:<step>`. */
export const S0FailureModel = z.strictObject({
  send_backs_per_step: z.number().int().min(1),
  /** Business days of silence at a human step before the onboarding is parked. */
  park_business_days: z.number().int().min(1),
  /** Machine retries after the first failure; the next failure blocks the step with a cause code. */
  machine_retries: z.number().int().min(0),
  /** Wait between a failure and its retry. */
  machine_retry_delay_seconds: z.number().int().min(0),
});
export type S0FailureModel = z.infer<typeof S0FailureModel>;

/** One row of OB §6.2's "Time box" column; `null` is not given for that step. */
export const S0StepTimebox = z.strictObject({
  /** Machine part: a job running longer than this is a machine failure (`machine.timebox`). */
  machine_minutes: z.number().int().min(1).nullable(),
  /** The expected human effort; recorded for the card, never enforced. */
  human_minutes: z.number().int().min(1).nullable(),
  /** Business days from the step's start; past it, one `s0.timebox_exceeded` is recorded. */
  overall_business_days: z.number().int().min(1).nullable(),
  /** Business days of silence at the step's card before one reminder is recorded. */
  reminder_business_days: z.number().int().min(1).nullable(),
  /** Business days a card of this step may wait (B21, never auto). Information for the card layer. */
  sla_business_days: z.number().int().min(1).nullable(),
});
export type S0StepTimebox = z.infer<typeof S0StepTimebox>;

export const S0TimeBoxes = z.record(OnboardingStepId, S0StepTimebox);
export type S0TimeBoxes = z.infer<typeof S0TimeBoxes>;

/** Same fields as the decision kernel's calendar; contracts cannot import it. */
export const S0Calendar = z.strictObject({
  weekend: z.array(z.number().int().min(0).max(6)).max(6),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  utc_offset_minutes: z.number().int().min(-720).max(840),
});
export type S0Calendar = z.infer<typeof S0Calendar>;

export const S0_CONFIG_KEYS = {
  failure_model: 's0.failure_model',
  timeboxes: 's0.timeboxes',
  calendar: 's0.calendar',
  /** DEC-4: a T0 tier needs the owner's positive attestation on card 1. Default on. */
  t0_attestation: 's0.t0_attestation_required',
} as const;

export const S0_DEFAULT_FAILURE_MODEL: S0FailureModel = {
  send_backs_per_step: 1,
  park_business_days: 5,
  machine_retries: 3,
  machine_retry_delay_seconds: 60,
};

const tb = (o: Partial<S0StepTimebox>): S0StepTimebox => ({
  machine_minutes: null,
  human_minutes: null,
  overall_business_days: null,
  reminder_business_days: null,
  sla_business_days: null,
  ...o,
});

/** OB §6.2 "Time box" column. 0.5 + M4 is "~15 min; SLA 1 bd" (B21). */
export const S0_DEFAULT_TIMEBOXES: S0TimeBoxes = {
  '0.1': tb({ machine_minutes: 30, human_minutes: 15, reminder_business_days: 2 }),
  '0.2': tb({ human_minutes: 240, overall_business_days: 10 }),
  '0.3': tb({ human_minutes: 600, overall_business_days: 15 }),
  '0.4': tb({ machine_minutes: 5, human_minutes: 30 }),
  '0.5': tb({ human_minutes: 15, sla_business_days: 1 }),
};

export const S0_DEFAULT_CALENDAR: S0Calendar = {
  weekend: [0, 6],
  holidays: [],
  utc_offset_minutes: 0,
};

// ---------------------------------------------------------------- Config: project settings

/**
 * A project's settings are config revisions of its project layer, one key per part, so a change is
 * an M1-gated publish (PLAN M7.1). A project that has published none has no settings: the port
 * says `unknown_project` and identity binds nothing.
 */
export const PROJECT_CONFIG_KEYS = {
  role_map: 'project.role_map',
  two_person: 'project.two_person',
  gating_profile: 'project.gating_profile',
  kill_delegations: 'project.kill_delegations',
} as const;

/** A role map in which nobody holds any slot (g4 is the code owners on GitHub). */
export const EMPTY_ROLE_MAP: RoleMap = Object.fromEntries(
  RoleSlotValues.map((slot: RoleSlot) => [
    slot,
    slot === 'g4' ? { kind: 'codeowners' } : { kind: 'principals', principals: [] },
  ]),
) as RoleMap;

/** OB §1B/§1C defaults: two-person on when 2+ hold the role; every toggle group on, automatic scheduling. */
export const DEFAULT_TWO_PERSON: TwoPerson = {
  enabled: true,
  default: 'on_if_2plus',
  locked_on: false,
};
export const DEFAULT_GATING_PROFILE: GatingProfile = {
  gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
  schedule: 'auto',
  tier_floor_applied: true,
};

/** The parts of `ProjectSettings` that are config; the rest (id, version, time) come from the lineage. */
export const ProjectSettingsDoc = z.strictObject({
  [PROJECT_CONFIG_KEYS.role_map]: RoleMap,
  [PROJECT_CONFIG_KEYS.two_person]: TwoPerson,
  [PROJECT_CONFIG_KEYS.gating_profile]: GatingProfile,
  [PROJECT_CONFIG_KEYS.kill_delegations]: z.array(KillDelegation),
});
export type ProjectSettingsDoc = z.infer<typeof ProjectSettingsDoc>;

/** `GET /v1/projects/:id/settings`: the settings in force and the tier of the project. */
export const ProjectSettingsWire = z.strictObject({
  settings: ProjectSettings,
  tier: Tier.nullable(),
});
export type ProjectSettingsWire = z.infer<typeof ProjectSettingsWire>;

// ---------------------------------------------------------------- Served shapes

/** An S0 record with its steps and what the driver is waiting for (`GET /v1/s0/:id`). */
export const S0Overview = z.strictObject({
  record: S0Record,
  steps: z.array(OnboardingStep),
  /** `0.1 waiting: App not installed`, or `null`. */
  waiting: z.string().nullable(),
  /** Send-backs used per human step (DEC-9: one allowed). */
  send_backs: z.record(OnboardingStepId, z.number().int().min(0)),
  /** Machine failures since the step last changed state (BLOCKED after the retries are used). */
  failures: z.record(OnboardingStepId, z.number().int().min(0)),
});
export type S0Overview = z.infer<typeof S0Overview>;

/** The newest S0 record of a repo, as the portal's project list and detail show it. */
export const S0Brief = z.strictObject({
  s0_id: S0RecordId,
  repo: RepoFullName,
  status: OnboardingStatus,
  requested_level: Level,
  signable_level: Level,
  /** `0.1 waiting: App not installed`, or `null`. */
  waiting: z.string().nullable(),
  updated_at: IsoDateTime,
});
export type S0Brief = z.infer<typeof S0Brief>;

/** One row of the portal's project list (`GET /v1/projects`): the Project and its latest S0 record. */
export const ProjectSummary = z.strictObject({
  project: Project,
  repos: z.array(Repo),
  latest_s0: S0Brief.nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

/** The portal's project page (`GET /v1/projects/:id/overview`): the Project, its repos, every S0 record. */
export const ProjectDetail = z.strictObject({
  project: Project,
  repos: z.array(Repo),
  /** Newest first, with their steps. */
  s0: z.array(S0Overview),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

/** The levels in order, lowest first: `census < light < full`. */
export const levelRank = (l: Level): number => LevelValues.indexOf(l);
export const minLevel = (a: Level, b: Level): Level => (levelRank(a) <= levelRank(b) ? a : b);
