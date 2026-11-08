import { z } from 'zod';
import {
  Autonomy,
  BackEdgeId,
  CatalogueVersion,
  Criterion,
  FloorDef,
  FloorId,
  GateId,
  GateSwitch,
  HandoffId,
  Lane,
  Level,
  ProjectToggleGroup,
  RelaneId,
  ScheduleMode,
  StageId,
  StepId,
  TerminalState,
  Tier,
  TriggerId,
  WaitState,
} from '@aisdlc/contracts';

// The shape of the catalogue data. Every id is imported from @aisdlc/contracts, never re-listed.
// A value the specs do not give is `null` (or an `unspecified` member) and is listed in the lane
// notes or in the data's `unspecified` index, never filled in with a guess.

// ---------------------------------------------------------------- Numbers

export const LimitUnit = z.enum([
  'rounds',
  'times',
  'business_days',
  'weeks',
  'percent',
  'sample_size',
  'multiple',
  'count',
]);
export type LimitUnit = z.infer<typeof LimitUnit>;

/**
 * One number of the flow. `tune` is true only where the flow marks it `(tune)`: "Numbers marked
 * (tune) are placeholders to confirm in internal testing". `value: null` means the flow names the
 * limit but gives no number.
 */
export const Limit = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  value: z.number().min(0).nullable(),
  unit: LimitUnit,
  tune: z.boolean(),
});
export type Limit = z.infer<typeof Limit>;

/** What happens when a limit is used up (the flow's "then ..."). */
export const ThenTarget = z.union([
  GateId,
  TriggerId,
  HandoffId,
  TerminalState,
  WaitState,
  z.enum(['human_writes_plan', 'suspend_mode_e', 'block_new_agent_items', 'backup_approver']),
]);
export type ThenTarget = z.infer<typeof ThenTarget>;

// ---------------------------------------------------------------- Back-edge limits

/**
 * Every back-edge has one entry. `unlimited` and `not_applicable` carry the reason, so "no limit" is
 * a recorded choice, never a missing row.
 */
export const BackEdgeLimit = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('limited'),
    limits: z.array(Limit).min(1),
    then: ThenTarget.nullable(),
    note: z.string().min(1).nullable(),
  }),
  z.strictObject({ kind: z.literal('unlimited'), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal('not_applicable'), reason: z.string().min(1) }),
]);
export type BackEdgeLimit = z.infer<typeof BackEdgeLimit>;

/** FIX 14: every back-edge B2-B26 adds 1; total or age over the limit goes to B28 -> E4. */
export const ReworkBudget = z.strictObject({
  counted_edges: z.array(BackEdgeId).min(1),
  total: Limit,
  item_age: Limit,
  then: ThenTarget,
  counts_toward: TriggerId,
  survives: z.array(z.enum(['relane', 'handoff'])),
});
export type ReworkBudget = z.infer<typeof ReworkBudget>;

export const EnvelopeExtension = z.strictObject({
  max_extensions: Limit,
  max_percent: Limit,
  via: GateId,
});

// ---------------------------------------------------------------- ET triggers

export const TriggerEffect = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('handoff'), handoff: HandoffId }),
  z.strictObject({ kind: z.literal('quarantine'), gate: GateId.extract(['Q1']) }),
  z.strictObject({ kind: z.literal('circuit_breaker'), relane: RelaneId.extract(['R3']) }),
  z.strictObject({ kind: z.literal('new_item'), lanes: z.array(Lane).min(1) }),
]);
export type TriggerEffect = z.infer<typeof TriggerEffect>;

export const TriggerDef = z.strictObject({
  effects: z.array(TriggerEffect).min(1),
  thresholds: z.array(Limit),
  /** Where the flow says other events count toward this trigger (ET14 only). */
  counts_from: z.array(z.string().min(1)),
});
export type TriggerDef = z.infer<typeof TriggerDef>;

// ---------------------------------------------------------------- Lanes

export const StageMode = z.enum(['full', 'partial', 'skipped', 'unspecified']);
export type StageMode = z.infer<typeof StageMode>;

/** `steps`: all steps of the stage for `full`, `[]` for `skipped`, a subset or `null` (not stated) otherwise. */
export const LaneStage = z.strictObject({
  stage: StageId,
  mode: StageMode,
  steps: z.array(StepId).nullable(),
});
export type LaneStage = z.infer<typeof LaneStage>;

export const GatePresence = z.enum(['required', 'by_profile', 'conditional']);
export type GatePresence = z.infer<typeof GatePresence>;

export const GatePosition = z.strictObject({
  gate: GateId,
  step: StepId,
  rel: z.enum(['at', 'after']),
  /** `by_profile`: present when the project's gating profile has it on. `conditional`: only when its trigger fires. */
  presence: GatePresence,
  condition: z.string().min(1).nullable(),
});
export type GatePosition = z.infer<typeof GatePosition>;

export const OracleSource = z.enum([
  'repro_test',
  'g2_oracle_specs',
  'not_applicable',
  'unspecified',
]);
export type OracleSource = z.infer<typeof OracleSource>;

export const LaneProfile = z.strictObject({
  /** Per-Unit default envelope when 5.5 gives none. The flow names it and gives no value. */
  default_envelope: z.strictObject({ budget_cents: z.number().int().min(0).nullable() }),
  oracle_source: OracleSource,
  /** 7.1-7.6 and G4 (FL PROFILES). */
  mandatory_steps: z.array(StepId),
  mandatory_gates: z.array(GateId),
  /** Why a lane does not carry the mandatory set (L7 never reaches 7.x or G4). */
  mandatory_exemption: z.string().min(1).nullable(),
});
export type LaneProfile = z.infer<typeof LaneProfile>;

export const LaneDef = z.strictObject({
  id: Lane,
  label: z.string().min(1).nullable(),
  /** The first step after G0 ("enter at 3.1"); `SCHED` for the hotfix; `null` for human-led. */
  enter_at: z.union([StepId, z.literal('SCHED')]).nullable(),
  stages: z.array(LaneStage),
  gates: z.array(GatePosition),
  profile: LaneProfile,
  exit: z.enum(['standard', 'spike_report']),
  /** R4: a hotfix auto-creates a follow-up. */
  follow_up: z.strictObject({ lane: Lane, overdue: Limit, effect: ThenTarget }).nullable(),
  /** Human-led re-entry points (D4 hand back, D5 dev completes). */
  reentry: z.partialRecord(HandoffId, StepId).nullable(),
  /** What the specs leave open for this lane. */
  unspecified: z.array(z.string().min(1)),
});
export type LaneDef = z.infer<typeof LaneDef>;

// ---------------------------------------------------------------- Gating profile

export const GatingDefault = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('fixed'),
    value: GateSwitch,
    /** "G6 [on; off when requester = operator]". */
    exceptions: z.array(z.strictObject({ when: z.string().min(1), value: GateSwitch })),
  }),
  z.strictObject({
    kind: z.literal('by_lane'),
    lanes: z.partialRecord(Lane, GateSwitch),
  }),
  z.strictObject({
    kind: z.literal('by_deploys'),
    deploys: GateSwitch,
    otherwise: GateSwitch,
  }),
]);
export type GatingDefault = z.infer<typeof GatingDefault>;

export const GatingCatalogue = z.strictObject({
  /** Gates no project can turn off: taken from contracts' `GATES`. */
  always_required: z.array(GateId),
  defaults: z.record(ProjectToggleGroup, GatingDefault),
  schedule_default: ScheduleMode,
  /** Human 5.7 scheduling is an opt-in profile flag. */
  human_schedule: z.literal('opt_in'),
  /** The T2 floor, from contracts' `T2_GATING_FLOOR`. */
  t2_floor: z.strictObject({
    lanes: z.array(Lane),
    groups: z.array(ProjectToggleGroup),
    deploy_group: ProjectToggleGroup,
  }),
});
export type GatingCatalogue = z.infer<typeof GatingCatalogue>;

// ---------------------------------------------------------------- Eligibility

/** `unspecified` is a row the specs leave open. Callers treat it as not eligible. */
export const Eligibility = z.enum(['eligible', 'not_eligible', 'unspecified']);
export type Eligibility = z.infer<typeof Eligibility>;

export const EligibilityCatalogue = z.strictObject({
  by_level: z.record(Level, z.record(Lane, Eligibility)),
  /** L5 also needs a floor (FF2, staging separation attested). */
  lane_requires_floor: z.partialRecord(Lane, FloorId),
  /** R-OPK-3: every T2 repo needs Full for any agent-led lane. */
  tier_min_level: z.partialRecord(Tier, z.strictObject({ level: Level, lanes: z.array(Lane) })),
});
export type EligibilityCatalogue = z.infer<typeof EligibilityCatalogue>;

// ---------------------------------------------------------------- Autonomy caps

export const Posture = z.enum(['red', 'amber', 'green']);
export type Posture = z.infer<typeof Posture>;

/** Readiness level of the composite (the min of the pillar levels). */
export const ReadinessLevel = z.enum(['RL0', 'RL1', 'RL2', 'RL3', 'RL4']);
export type ReadinessLevel = z.infer<typeof ReadinessLevel>;

export const AutonomyCatalogue = z.strictObject({
  tier: z.record(Tier, Autonomy),
  /** Census caps at A0. Light and Full: "Capped (§2.3)" and no further level cap stated, so `null`. */
  level: z.record(Level, Autonomy.nullable()),
  /** RL1 A0, RL2 A1, RL3 A2, RL4+ A3. RL0 is not stated: `null`. */
  readiness: z.record(ReadinessLevel, Autonomy.nullable()),
  posture: z.record(
    Posture,
    z.strictObject({
      cap: Autonomy.nullable(),
      /** Red also confines the project to Census lanes. */
      census_lanes_only: z.boolean(),
      /** Amber puts G4 in mode C on every PR. */
      g4_mode_c: z.boolean(),
    }),
  ),
  probation: z.strictObject({
    cap: Autonomy,
    min_weeks: Limit,
    ends_by: z.literal('governance_earn_rule'),
  }),
  /** Automatic changes only tighten; loosening always needs a human (OB §2.3). */
  automatic_changes: z.literal('tighten_only'),
  loosening: z.literal('human_only'),
});
export type AutonomyCatalogue = z.infer<typeof AutonomyCatalogue>;

// ---------------------------------------------------------------- Criteria

export const CriteriaCatalogue = z.strictObject({
  set: z.literal('CRITERIA_V2'),
  criteria: z.array(Criterion),
  floors: z.array(FloorDef),
});
export type CriteriaCatalogue = z.infer<typeof CriteriaCatalogue>;

// ---------------------------------------------------------------- The catalogue

export const CatalogueData = z.strictObject({
  version: CatalogueVersion,
  lanes: z.record(Lane, LaneDef),
  back_edge_limits: z.record(BackEdgeId, BackEdgeLimit),
  rework_budget: ReworkBudget,
  envelope_extension: EnvelopeExtension,
  triggers: z.record(TriggerId, TriggerDef),
  gating: GatingCatalogue,
  eligibility: EligibilityCatalogue,
  autonomy: AutonomyCatalogue,
  criteria: CriteriaCatalogue,
});
export type CatalogueData = z.infer<typeof CatalogueData>;
