import { z } from 'zod';
import { GateId } from '../flow.js';
import { VoteDecision } from './decisions.js';
import { CardStatus } from './onboarding.js';
import { Lane } from '../values.js';
import { PrincipalId } from './ids.js';
import { UnitState } from '../states/unit.js';
import { StepId, type StepId as StepIdT } from '../values.js';
import { ArtefactType, AgentId } from './agent-definitions.js';
import { AgentRunId } from './agent-runs.js';
import { GitSha, IsoDateTime, ProjectId, Sha256Hex, WorkItemId } from './ids.js';

// Planning, S2 and S3 (PLAN M12.1, M12.2; DM §3.5 Proposal and Artefact, §8 gap 6): what a planning step
// stores and how a gate binds it. An Artefact is content-addressed (sha256 of the canonical JSON of what
// the step produced); a Proposal is one agent's answer to one run, accepted (it became an Artefact) or
// rejected (it did not validate, or it held a secret: only a hash and the reasons are kept, never the
// text). Both are record events on `planning:<item>` (authoritative for existence and hash); the bodies
// are in core's `artefact` table, which every read checks against the event's hash.

export const planningStream = (itemId: string): string => `planning:${itemId}`;
export const PLANNING_STREAM_PREFIX = 'planning:';

export const PLANNING_EVENT = {
  artefact_stored: 'artefact.stored',
  proposal_recorded: 'proposal.recorded',
  /** M12.4: the Units a plan lists, in DAG order, as they enter the `core.unit` read model (state Planned). */
  units_planned: 'units.planned',
} as const;
export type PlanningEventType = (typeof PLANNING_EVENT)[keyof typeof PLANNING_EVENT];

/**
 * The artefact each S2 and S3 step produces (a step stores exactly one primary artefact; its hash is
 * the step's `output_hash`). 3.3 is deterministic and stores its report; the rest are agent proposals.
 */
export const STEP_ARTEFACT: Readonly<Partial<Record<StepIdT, ArtefactType>>> = {
  // S1 (Gap A): 1.3 stores what the classifier said (the factory derives the lane from it), 1.5 the intent block
  '1.3': 'classification',
  '1.5': 'intent_block',
  '2.1': 'context_brief',
  '2.1b': 'reverse_engineering',
  '2.2': 'impact',
  '2.3': 'decision_brief',
  '2.4': 'initiative',
  '3.1': 'affected_requirements',
  '3.2': 'spec_delta',
  '3.3': 'validation_report',
  '3.4': 'oracle_specs',
  '3.5': 'spec_review',
  // S4 (M12.3)
  '4.1': 'adr',
  '4.2': 'contracts',
  '4.3': 'data_migration',
  '4.4': 'nfr_threat_ops',
  '4.5': 'constitution_report',
  // S5 (M12.4): 5.3 is the task plan (`plan.md`), the rest as named
  '5.1': 'unit_split',
  '5.2': 'unit_sequence',
  '5.3': 'plan',
  '5.4': 'verification_binding',
  '5.5': 'budget_envelope',
  '5.6': 'capacity_input',
  // S6 (M13.6): 6.6's artefact is the patch an X2 decision is bound to (its sha256 IS the patch hash)
  '6.6': 'patch',
};

/**
 * The steps whose artefacts a gate decides, in the order the card shows them. G2 approves the spec AND
 * the oracle specs together (FL FIX 9), with the clean-context review as the evidence beside them; G1f
 * is the final acceptance of the intent against everything S2 produced. The engine binds the latest
 * output hash of each step into the gate's subject hash, so changing any one changes what is decided.
 */
export const GATE_ARTEFACT_STEPS: Readonly<Partial<Record<string, readonly StepIdT[]>>> = {
  // S1: G0 binds the lane profile AND what the classifier said and the intent block; G1 the intent block
  G0: ['1.3', '1.5'],
  G1: ['1.5'],
  G1f: ['2.1', '2.1b', '2.2', '2.3', '2.4'],
  // R2 (E1): the decision brief that said the work is smaller than its lane
  E1: ['2.3'],
  G2: ['3.2', '3.4', '3.5'],
  // S4: the design review decides all five design artefacts; E2 decides the constitution report
  G3d: ['4.1', '4.2', '4.3', '4.4', '4.5'],
  E2: ['4.5'],
  // M13.6: X2 at 6.6 decides exactly one patch: the artefact's hash is the patch hash the Push Broker checks
  X2: ['6.6'],
  // S5: G3 decides the whole plan (and, in the subject hash, the base commit); G3s is the skeleton of it:
  // the Units, their paths and their order, without the task detail
  G3: ['5.1', '5.2', '5.3', '5.4', '5.5', '5.6'],
  G3s: ['5.1', '5.2'],
};

/** An artefact as a gate binds it: which step produced it, its type, and its content hash. */
export const GateArtefactRef = z.strictObject({
  step: StepId,
  type: ArtefactType,
  sha256: Sha256Hex,
});
export type GateArtefactRef = z.infer<typeof GateArtefactRef>;

export const ARTEFACT_SCHEMA_ID = 'artefact/1';

/** A stored artefact: the event on the item's planning stream. The body is in core's table under `sha256`. */
export const ArtefactStoredPayload = z.strictObject({
  schema: z.literal(ARTEFACT_SCHEMA_ID),
  item_id: WorkItemId,
  project_id: ProjectId,
  type: ArtefactType,
  /** 1, 2, ... per item and type: a redraft (B3, B10, B23) is the next version. */
  version: z.number().int().min(1),
  sha256: Sha256Hex,
  bytes: z.number().int().min(1),
  step: StepId,
  command_key: z.string().min(1),
  /** The agent run that proposed it; `null` for a deterministic step (3.3). */
  run_id: AgentRunId.nullable(),
});
export type ArtefactStoredPayload = z.infer<typeof ArtefactStoredPayload>;

/** DM Proposal.kind (`plan spec design triage intent learn`), with the kinds S2 and S3 add. */
export const ProposalKind = z.enum([
  'triage',
  'intent',
  'shape',
  'reverse_engineering',
  'spec',
  'oracle',
  'review',
  'design',
  'plan',
  'learn',
]);
export type ProposalKind = z.infer<typeof ProposalKind>;

/** Why a proposal was refused: field-level codes and paths, never the text of the output. */
export const ProposalReason = z.strictObject({
  path: z.string().max(200),
  code: z.string().min(1).max(64),
});
export type ProposalReason = z.infer<typeof ProposalReason>;

export const ProposalRecordedPayload = z.strictObject({
  proposal_id: z.string().min(1),
  item_id: WorkItemId,
  project_id: ProjectId,
  step: StepId,
  run_id: AgentRunId,
  command_key: z.string().min(1),
  agent_id: AgentId,
  /** Which model call of the command this answers (B3: three automatic attempts). */
  attempt: z.number().int().min(1),
  kind: ProposalKind,
  status: z.enum(['accepted', 'rejected']),
  /** `accepted`: the artefact it became. */
  artefact_sha256: Sha256Hex.nullable(),
  /** The hash of what the model said (its text, before parsing): all that is kept of a refused output. */
  output_sha256: Sha256Hex,
  reasons: z.array(ProposalReason).max(50),
});
export type ProposalRecordedPayload = z.infer<typeof ProposalRecordedPayload>;

// ---------------------------------------------------------------- Units (M12.4, DM §3.5 Unit, §6.4)

export const UnitSize = z.enum(['small', 'medium', 'large']);
export type UnitSize = z.infer<typeof UnitSize>;

/** A Unit's key inside one plan: a slug (it becomes part of a branch name in M13). */
export const UnitKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/);

/** What a Unit may spend (5.5; the gateway's per-Unit virtual key is minted from it in M13). */
export const UnitEnvelope = z.strictObject({
  max_tokens: z.number().int().min(1),
  max_cost_micro_usd: z.number().int().min(1),
});
export type UnitEnvelope = z.infer<typeof UnitEnvelope>;

export const PlannedUnit = z.strictObject({
  unit_key: UnitKey,
  title: z.string().min(1).max(200),
  /** The scope: the paths the Unit may touch (a prefix ending in `/`, or a file). */
  paths: z.array(z.string().min(1).max(512)).min(1).max(50),
  size: UnitSize,
  depends_on: z.array(UnitKey).max(20),
  /** The Unit's place in DAG (topological) order, from 0. */
  position: z.number().int().min(0),
  envelope: UnitEnvelope,
});
export type PlannedUnit = z.infer<typeof PlannedUnit>;

export const UNITS_SCHEMA_ID = 'units/1';

/** The plan's Units entering the read model: the record is the authority, `core.unit` is rebuilt from these. */
export const UnitsPlannedPayload = z.strictObject({
  schema: z.literal(UNITS_SCHEMA_ID),
  item_id: WorkItemId,
  project_id: ProjectId,
  repo: z.string().min(1),
  /** Hash of the plan artefacts the Units came from (5.1 to 5.4): a re-plan is a different hash. */
  plan_sha256: Sha256Hex,
  /** The merged commit the plan was made against (G3 binds it); `null` for a Unit no plan made (M13.1: L0's implicit one). */
  base_sha: GitSha.nullable(),
  units: z.array(PlannedUnit).min(1).max(30),
});
export type UnitsPlannedPayload = z.infer<typeof UnitsPlannedPayload>;

/** The `unit` read model's row (DM §3.5 Unit; fields M13 fills are `null` until it does). */
export const Unit = z.strictObject({
  unit_id: z.string().min(1),
  item_id: WorkItemId,
  project_id: ProjectId,
  repo: z.string().min(1),
  unit_key: UnitKey,
  title: z.string(),
  paths: z.array(z.string()),
  size: UnitSize,
  depends_on: z.array(UnitKey),
  position: z.number().int().min(0),
  envelope: UnitEnvelope,
  state: UnitState,
  plan_sha256: Sha256Hex,
  base_sha: GitSha.nullable(),
  branch: z.string().nullable(),
  lease_epoch: z.number().int().nullable(),
  head_sha: z.string().nullable(),
  pr_ref: z.string().nullable(),
});
export type Unit = z.infer<typeof Unit>;

export const PlanningEventPayloads = {
  [PLANNING_EVENT.artefact_stored]: ArtefactStoredPayload,
  [PLANNING_EVENT.proposal_recorded]: ProposalRecordedPayload,
  [PLANNING_EVENT.units_planned]: UnitsPlannedPayload,
} as const satisfies Record<PlanningEventType, z.ZodType>;

// ---------------------------------------------------------------- The constitution (M12.3, 4.5)

/** The config key (factory layer, M1-gated like every config change): the rules 4.5 checks a design against. */
export const CONSTITUTION_CONFIG_KEY = 'factory.constitution';

const RuleId = z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/);
const Hostname = z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/);

/**
 * One deterministic rule of the factory constitution. The format is small on purpose: each `kind` is a
 * check the factory implements in code over the design's structured facts, and a rule only names the kind
 * and its parameters. A new kind is a code change and a contract change, never a free-text rule an agent
 * could read as an instruction.
 */
export const ConstitutionRule = z.discriminatedUnion('kind', [
  /** No network call to a host outside `allow_hosts` without an approval reference naming who approved it. */
  z.strictObject({
    rule_id: RuleId,
    kind: z.literal('no_unapproved_egress'),
    title: z.string().min(1).max(200),
    allow_hosts: z.array(Hostname).max(100),
  }),
  /** A migration is reversible, or says so loudly: it is flagged irreversible (a person reads that at G3d). */
  z.strictObject({
    rule_id: RuleId,
    kind: z.literal('migrations_reversible_or_flagged'),
    title: z.string().min(1).max(200),
  }),
]);
export type ConstitutionRule = z.infer<typeof ConstitutionRule>;

export const Constitution = z
  .strictObject({
    version: z.number().int().min(1),
    rules: z.array(ConstitutionRule).min(1).max(50),
  })
  .refine((c) => new Set(c.rules.map((r) => r.rule_id)).size === c.rules.length, {
    message: 'rule ids must be unique',
    path: ['rules'],
  });
export type Constitution = z.infer<typeof Constitution>;

export const DEFAULT_CONSTITUTION: Constitution = {
  version: 1,
  rules: [
    {
      rule_id: 'C-EGRESS',
      kind: 'no_unapproved_egress',
      title: 'No new external network egress without an approval reference',
      allow_hosts: [],
    },
    {
      rule_id: 'C-MIGRATION',
      kind: 'migrations_reversible_or_flagged',
      title: 'Migrations must be reversible or flagged irreversible',
    },
  ],
};

/** One artefact as the portal and an agent's input read it: its identity, the content and the rendered markdown. */
export const ArtefactView = z.strictObject({
  item_id: WorkItemId,
  step: StepId,
  type: ArtefactType,
  version: z.number().int().min(1),
  sha256: Sha256Hex,
  stored_at: IsoDateTime,
  /** Rendered for people from the content by one pure function (never stored, always reproducible). */
  markdown: z.string(),
});
export type ArtefactView = z.infer<typeof ArtefactView>;

/** What a gate card shows: the artefacts its subject hash binds, rendered, each with its hash. */
export const GateArtefactsView = z.strictObject({
  card_id: z.string().min(1),
  project_id: ProjectId,
  item_id: WorkItemId,
  gates: z.array(z.string()),
  subject_hash: Sha256Hex,
  /** `false`: an artefact the card names is missing or its stored bytes do not hash to the bound hash. */
  intact: z.boolean(),
  artefacts: z.array(
    z.strictObject({
      step: StepId,
      type: ArtefactType,
      sha256: Sha256Hex,
      version: z.number().int().min(1).nullable(),
      markdown: z.string().nullable(),
      intact: z.boolean(),
    }),
  ),
});
export type GateArtefactsView = z.infer<typeof GateArtefactsView>;

// ---------------------------------------------------------------- Deciding a work-item gate card (Gap B)

/** One gate of a work-item card, with where it stands. */
export const GateCardGate = z.strictObject({
  gate_instance_id: z.string().min(1),
  gate: GateId,
  /** The role slot that decides it (`intent`, `design`, `x`...): who holds it is `deciders`. */
  slot: z.string().min(1),
  status: z.string().min(1),
  outcome: z.string().nullable(),
  /** The gate wants a step-up proof (G5, M4): the portal does not decide those here. */
  step_up_required: z.boolean(),
});
export type GateCardGate = z.infer<typeof GateCardGate>;

/**
 * `GET /v1/cards/:id/gate`: a work-item card as something to DECIDE (the artefacts it binds are
 * `GateArtefactsView`). Every field is the factory's own: nothing here is text an agent wrote.
 */
export const GateCardView = z.strictObject({
  card_id: z.string().min(1),
  project_id: ProjectId,
  item_id: WorkItemId,
  status: CardStatus,
  gates: z.array(GateCardGate).min(1),
  subject_hash: Sha256Hex,
  /** The lane the factory proposes (G0 binds it), the commit a plan is made against (G3), what the card says it is for. */
  proposed_lane: Lane.nullable(),
  base_sha: GitSha.nullable(),
  injection_suspected: z.boolean(),
  /** Who may decide it, by role (the portal adds the PDP's yes). */
  deciders: z.strictObject({ slots: z.array(z.string()), holders: z.array(PrincipalId) }),
  /** What a decision may be: reject and request_changes need a reason. */
  decisions_allowed: z.array(VoteDecision),
  /** The decision's reason, once decided (the card payload's `decision_reason`). */
  decision_reason: z.string().nullable(),
});
export type GateCardView = z.infer<typeof GateCardView>;

/** One nonce per pending gate of the card, each bound to the evidence its gate decides. */
export const GateCardPrepared = z.strictObject({
  card_id: z.string().min(1),
  gates: z.array(
    z.strictObject({
      gate_instance_id: z.string().min(1),
      gate: GateId,
      nonce: z.string().min(1),
      expires_at: IsoDateTime,
      subject_hash: Sha256Hex,
      evidence_hash: Sha256Hex,
      step_up: z.strictObject({ required: z.boolean(), bound_hash: z.string() }),
    }),
  ),
});
export type GateCardPrepared = z.infer<typeof GateCardPrepared>;

export const GateCardPrepareRequest = z.strictObject({ on_behalf_of: PrincipalId });
export const GateCardEvidenceRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  views: z
    .array(z.strictObject({ nonce: z.string().min(1), evidence_hash: Sha256Hex }))
    .min(1)
    .max(10),
});
export const GateCardDecideRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  decision: VoteDecision,
  /** Required for a rejection and for a request for changes. */
  reason: z.string().min(1).max(1000).optional(),
  /** A gate that needs a step-up (G5, M4, one opened with it) carries the proof bound to its `step_up.bound_hash`. */
  votes: z
    .array(
      z.strictObject({
        nonce: z.string().min(1),
        step_up: z.strictObject({ proof: z.string().min(1).max(8192) }).optional(),
      }),
    )
    .min(1)
    .max(10),
});
export type GateCardPrepareRequest = z.infer<typeof GateCardPrepareRequest>;
export type GateCardEvidenceRequest = z.infer<typeof GateCardEvidenceRequest>;
export type GateCardDecideRequest = z.infer<typeof GateCardDecideRequest>;
