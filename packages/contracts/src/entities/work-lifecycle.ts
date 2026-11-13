import { hashCanonical } from '@aisdlc/kernel';
import { z } from 'zod';
import { BackEdgeId, GateId, HoldReason, AbandonCause, RelaneId, TriggerId } from '../flow.js';
import { EntryChannel, Lane, StageId, StepId, Tier } from '../values.js';
import { AgentBinding } from './agent-definitions.js';
import { CatalogueRef } from './config.js';
import { LintRuleId } from './detectors.js';
import { PrrGatingProfile } from './readiness.js';
import {
  AreaId,
  CardId,
  IsoDateTime,
  PrincipalId,
  ProjectId,
  Sha256Hex,
  GitSha,
  WorkItemId,
  WorkRequestId,
  uuidId,
} from './ids.js';
import { PullRequestState, RepoFullName } from './codehost.js';

// The work lifecycle's vocabulary (PLAN M9.1, M9.2; DM §3.3, §6.1; FL S1, FIX 7, FIX 15). The Request
// and its text (data, never instructions), the Question and SpawnLink entities (one shape each, DM
// §8 gaps 4 and 6), the events of the item stream `item:<id>`, the commands the interpreter emits
// and the outcomes a stage port reports. `packages/work` folds and interprets them; core stores and
// executes them; the stage-port fakes answer them. Nothing here is re-listed elsewhere.

// ---------------------------------------------------------------- Streams

/** The event stream of one work item (DM §3 "Work owns the item event stream `item:<id>`"). */
export const itemStream = (itemId: string): string => `item:${itemId}`;
export const ITEM_STREAM_PREFIX = 'item:';

// ---------------------------------------------------------------- Entry channels

/**
 * What an entry channel is. The flow lists "portal Ask, Teams, API, code-host issue" under N1-N8
 * without a mapping, so this one follows the flow's order (an assumption, written here once):
 * N1 portal Ask, N2 Teams, N3 API, N4 code-host issue. N6 and N8 are named by OB (§8: a gap becomes
 * an N6 item; N8 is the "no active PRR" hold). N5 and N7 stay unassigned.
 */
export const IntakeSource = z.enum([
  'portal_ask',
  'teams',
  'api',
  'code_host_issue',
  'factory_proposed',
  'onboarding_hold',
]);
export type IntakeSource = z.infer<typeof IntakeSource>;

export const ENTRY_CHANNEL_SOURCES: Readonly<Record<EntryChannel, IntakeSource | null>> = {
  N1: 'portal_ask',
  N2: 'teams',
  N3: 'api',
  N4: 'code_host_issue',
  N5: null,
  N6: 'factory_proposed',
  N7: null,
  N8: 'onboarding_hold',
};

/** The channels a person or a system can submit a request on today (PLAN M9.1: portal Ask and API). */
export const OPEN_INTAKE_CHANNELS: readonly EntryChannel[] = ['N1', 'N3'];

// ---------------------------------------------------------------- Taint (FIX 15)

export const TaintOrigin = z.enum(['request', 'answer', 'issue', 'repo', 'dependency']);
export type TaintOrigin = z.infer<typeof TaintOrigin>;

/** A finding of the shared lint over text: which rule, where. Never the text itself. */
export const InjectionFlag = z.strictObject({
  rule: LintRuleId,
  line: z.number().int().min(1),
});
export type InjectionFlag = z.infer<typeof InjectionFlag>;

/**
 * A piece of text from outside the factory (a request, an answer, an issue, a repo file): DATA. It
 * carries its taint and its provenance wherever it goes, and the interpreter never reads it: it can
 * change no lane, gate, tool, egress or budget (FL FIX 15, B27).
 */
export const TaintedText = z.strictObject({
  text: z.string(),
  taint: z.literal('untrusted'),
  origin: TaintOrigin,
  provenance: z.strictObject({
    channel: EntryChannel,
    source: IntakeSource.nullable(),
    received_at: IsoDateTime,
    submitted_by: PrincipalId,
    /** sha256 of the bytes as received. */
    raw_sha256: Sha256Hex,
    /** sha256 of the comparison form of `text` (lower-cased, white space squeezed): what de-dupe compares. */
    normalised_sha256: Sha256Hex,
  }),
  /** Injection-like findings: the text is fenced as data and the G0 card carries these (B27). */
  flags: z.array(InjectionFlag),
});
export type TaintedText = z.infer<typeof TaintedText>;

/** What the G0 card shows of a request's text (the text itself is fenced data, never a field of the facts). */
export const InjectionReport = z.strictObject({
  suspected: z.boolean(),
  rules: z.array(LintRuleId),
  lines: z.array(z.number().int().min(1)),
  /** Hash of the fenced block the card renders, so the card shows exactly what was scanned. */
  text_sha256: Sha256Hex,
});
export type InjectionReport = z.infer<typeof InjectionReport>;

// ---------------------------------------------------------------- Question (one shape)

export const QuestionState = z.enum(['open', 'answered', 'defaulted']);
export type QuestionState = z.infer<typeof QuestionState>;

export const QuestionMateriality = z.enum(['blocking', 'non_blocking']);
export type QuestionMateriality = z.infer<typeof QuestionMateriality>;

/**
 * DM `Question`: one shape for the event, the thread turn, the agent output and the engine (DM §8
 * gap 4). `text` is what the planner asked; `answer` is the requester's reply, tainted like any
 * other outside text.
 */
export const Question = z.strictObject({
  question_id: z.string().min(1),
  item_id: WorkItemId,
  stage: StageId,
  step: StepId,
  round: z.number().int().min(1),
  material: QuestionMateriality,
  text: z.string().min(1),
  state: QuestionState,
  asked_at: IsoDateTime,
  answer: TaintedText.nullable(),
  answered_at: IsoDateTime.nullable(),
});
export type Question = z.infer<typeof Question>;

/** What a planner proposes; the engine stamps the id, round and time. */
export const QuestionDraft = z.strictObject({
  text: z.string().min(1).max(2000),
  material: QuestionMateriality,
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

// ---------------------------------------------------------------- SpawnLink

/**
 * The edges that start a NEW linked item (FL `REQ` targets): B16 B17 B18 B19, RELHOLD (B26), R4, and
 * B6 (BLOCKED spawns an L2 remediation item, OB §7 "Remediation path").
 */
export const SpawnEdge = z.union([
  BackEdgeId.extract(['B6', 'B16', 'B17', 'B18', 'B19', 'B26']),
  RelaneId.extract(['R4']),
]);
export type SpawnEdge = z.infer<typeof SpawnEdge>;

export const SpawnKind = z.enum([
  'rejected_rework',
  'rollback',
  'escape',
  'audit_miss',
  'release_change',
  'hotfix_follow_up',
  'remediation',
]);
export type SpawnKind = z.infer<typeof SpawnKind>;

/**
 * What each new-item edge may create: its kind and the lanes the flow names (B16 and B17 say "NEW
 * L0/L1"; B6 says L2 remediation, OB §7). `null` lanes: the flow names none, any lane may be asked
 * for. One table, so the interpreter, the stage ports and the tests cannot drift.
 */
export const SPAWN_RULES: Readonly<
  Record<SpawnEdge, { readonly kind: SpawnKind; readonly lanes: readonly Lane[] | null }>
> = {
  B6: { kind: 'remediation', lanes: ['L2'] },
  B16: { kind: 'rollback', lanes: ['L0', 'L1'] },
  B17: { kind: 'escape', lanes: ['L0', 'L1'] },
  B18: { kind: 'rejected_rework', lanes: null },
  B19: { kind: 'audit_miss', lanes: null },
  B26: { kind: 'release_change', lanes: null },
  R4: { kind: 'hotfix_follow_up', lanes: ['L1'] },
};

/** DM `SpawnLink`: the new item, where it came from (origin item and event) and which edge made it. */
export const SpawnLink = z.strictObject({
  item_id: WorkItemId,
  origin_item_id: WorkItemId,
  /** The origin stream's seq of the event that asked for it. */
  origin_seq: z.number().int().min(1),
  index: z.number().int().min(0),
  edge: SpawnEdge,
  kind: SpawnKind,
  lane: Lane,
  status: z.enum(['open', 'done']),
});
export type SpawnLink = z.infer<typeof SpawnLink>;

// ---------------------------------------------------------------- Holds (overlay)

export const ItemHold = z.strictObject({
  hold_id: z.string().min(1),
  reason: HoldReason,
  /** The control, kill or maintenance id that placed it; `null` for a hold the engine placed. */
  origin: z.string().min(1).nullable(),
  placed_at: IsoDateTime,
});
export type ItemHold = z.infer<typeof ItemHold>;

// ---------------------------------------------------------------- Holds placed by admission

/** The holds 6.0 admission can place (FL `HELD`: H1 approver pool, H2 capacity, H3 env, and WIP). */
export const AdmissionHold = HoldReason.extract(['H1', 'H2', 'H3', 'WIP']);
export type AdmissionHold = z.infer<typeof AdmissionHold>;

/** The id prefix of a hold the engine placed at admission: the release loop frees only these, never a kill or MM-2 hold. */
export const ADMISSION_HOLD_PREFIX = 'adm:';

// ---------------------------------------------------------------- Handoff (one id)

/** DM `Handoff.code`: D1 (from S6), D2 (from S7), D3 (from G4), or E4 reached directly (B2, B23-B25, B28). */
export const HandoffCode = z.enum(['D1', 'D2', 'D3', 'E4']);
export type HandoffCode = z.infer<typeof HandoffCode>;

/**
 * E4's choices (FL): answer and resume in the same envelope; one extension (E3/E5); re-plan -> 5.1;
 * re-spec -> 3.2; developer takes over (lane L8, lease epoch +1); abandon. `hand_over_close` is DM's
 * `Handoff -> HandedOverClosed` (the developer takes the work outside the factory and the item closes).
 */
export const HandoffChoice = z.enum([
  'resume',
  'extend',
  'replan',
  'respec',
  'takeover',
  'hand_over_close',
  'abandon',
]);
export type HandoffChoice = z.infer<typeof HandoffChoice>;

export const HandoffUuid = uuidId<'Handoff'>();
export type HandoffUuid = z.infer<typeof HandoffUuid>;

/** The Handoff Pack (A11): a reference, not the pack. The pack's content is the agent runtime's (M11+). */
export const HandoffPackRef = z.strictObject({
  pack_id: z.string().min(1),
  /** sha256 of the facts the engine held when it handed off (trigger, counters, the last stage outputs). */
  content_sha256: Sha256Hex,
});
export type HandoffPackRef = z.infer<typeof HandoffPackRef>;

/**
 * DM `Handoff` with ONE id (DM §8 gap 5): `handoff_id` is derived from the item and the handoff's
 * ordinal; the E4 gate instance and the pack are attributes, not other ids.
 */
export const Handoff = z.strictObject({
  handoff_id: HandoffUuid,
  item_id: WorkItemId,
  /** 1 for the item's first handoff. */
  n: z.number().int().min(1),
  code: HandoffCode,
  /** What caused it: an ET trigger id, a back-edge id, `X1`, `X2`, `E6`... */
  trigger: z.string().min(1),
  origin_phase: z.string().min(1),
  origin_step: StepId.nullable(),
  pack: HandoffPackRef,
  e4_gate_instance_id: z.string().min(1).nullable(),
  /** E4 was decided in the ledger: the owner may now record the choice. */
  e4_decided: z.boolean(),
  status: z.enum(['open', 'chosen']),
  choice: HandoffChoice.nullable(),
  chosen_by: PrincipalId.nullable(),
  /** The envelope extension asked for (E3 or E5), and whether the gate approved it. */
  extension: z
    .strictObject({
      percent: z.number().positive(),
      via: z.enum(['E3', 'E5']),
      approved: z.boolean().nullable(),
    })
    .nullable(),
  opened_at: IsoDateTime,
  chosen_at: IsoDateTime.nullable(),
});
export type Handoff = z.infer<typeof Handoff>;

/**
 * D5 (L8): where the developer's work is, as a reference the factory can check against the code host: a pull
 * request by number, or a commit by its full SHA. Data, never instructions; never free text.
 */
export const HumanWorkReference = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pr'), number: z.number().int().min(1).max(1_000_000_000) }),
  z.strictObject({ kind: z.literal('commit'), sha: GitSha }),
]);
export type HumanWorkReference = z.infer<typeof HumanWorkReference>;

// ---------------------------------------------------------------- Assumption (one shape)

/** The four places an assumption comes from today (DM §8 gap 4): thread, event, agent output, intent open questions. */
export const AssumptionOrigin = z.enum(['thread', 'event', 'agent_output', 'open_question']);
export type AssumptionOrigin = z.infer<typeof AssumptionOrigin>;

/** What the assumption is about: the engine's own, the intent block's, or a planner's output (spec, design, plan). */
export const AssumptionKind = z.enum(['engine', 'intent', 'plan', 'spec', 'design']);
export type AssumptionKind = z.infer<typeof AssumptionKind>;

export const AssumptionState = z.enum(['open', 'accepted', 'overridden']);
export type AssumptionState = z.infer<typeof AssumptionState>;

/** DM `Assumption`: one entity (id, item, origin run, text hash, state, overridden_by), fed by all four sources. */
export const Assumption = z.strictObject({
  assumption_id: z.string().min(1),
  item_id: WorkItemId,
  origin: AssumptionOrigin,
  kind: AssumptionKind,
  /** The agent run or command that produced it; `null` for a person's or the thread's. */
  origin_run: z.string().min(1).nullable(),
  text_hash: Sha256Hex,
  state: AssumptionState,
  overridden_by: PrincipalId.nullable(),
  raised_at: IsoDateTime,
});
export type Assumption = z.infer<typeof Assumption>;

/** What a planner reports of an assumption in its output (`spec`, `design`, `plan`); the engine stamps the rest. */
export const AssumptionReport = z.strictObject({
  kind: AssumptionKind,
  text_hash: Sha256Hex,
});
export type AssumptionReport = z.infer<typeof AssumptionReport>;

// ---------------------------------------------------------------- Config (MM-2)

/** The ops flag of maintenance mode MM-2: timers frozen, decisions disabled, drafts kept (FL `MM`). */
export const MAINTENANCE_FLAG_KEY = 'ops.maintenance.mm2';
/** The id of the hold MM-2 puts on every active item; its `origin` says which flag put it there. */
export const MAINTENANCE_HOLD_ID = 'mm2';
export const MAINTENANCE_HOLD_ORIGIN = 'mm-2';

// ---------------------------------------------------------------- Causes

/** Cause codes (lowercase dotted tokens, `AbandonCause`) the engine itself ends or declines an item with. */
export const CAUSE_PARK_TIMEOUT = 'park.timeout';
export const CAUSE_E4_ABANDON = 'e4.abandon';
export const CAUSE_E4_HANDED_OVER = 'e4.handed_over';
export const CAUSE_B18_REJECTED = 'b18.requester_rejected';
/** SECT confirmed a quarantine of an item that never reached S6: there is no branch to take over, the item ends. */
export const CAUSE_SECT_CONFIRMED = 'sect.confirmed';

// ---------------------------------------------------------------- Re-laning (R1-R4)

/**
 * What makes an item need more than its lane gives (R1, "free and logged"): the diff is over the
 * lane's budget, a sensitive path, a contract change found at 7.3, a new dependency, a second
 * repository, an irreversible migration, and the sensitive path X2 reports at 7.4.
 */
export const R1Trigger = z.enum([
  'diff_over_lane_budget',
  'sensitive_path',
  'contract_change',
  'new_dependency',
  'cross_repo',
  'irreversible_migration',
  'x2_sensitive_path',
]);
export type R1Trigger = z.infer<typeof R1Trigger>;
export const R1TriggerValues: readonly R1Trigger[] = R1Trigger.options;

/** R2's one trigger: the work is smaller than the lane ("smaller than lane", 2.3 and 4.6). */
export const R2_TRIGGER = 'smaller_than_lane';
export const RelaneTrigger = z.union([R1Trigger, z.literal(R2_TRIGGER)]);
export type RelaneTrigger = z.infer<typeof RelaneTrigger>;

/**
 * Where each re-lane edge may be raised, and for R1 what may be said there. R1 is drawn from 6.5, from
 * 7.3 (a contract change is found there) and from X2 (a sensitive path, at 7.4 where X2 is raised);
 * R2 from 2.3 and 4.6. One table, so the interpreter, the ports and the tests cannot drift.
 */
export const RELANE_SOURCES = {
  R1: {
    '6.5': [
      'diff_over_lane_budget',
      'sensitive_path',
      'new_dependency',
      'cross_repo',
      'irreversible_migration',
    ],
    '7.3': [
      'contract_change',
      'diff_over_lane_budget',
      'sensitive_path',
      'new_dependency',
      'cross_repo',
      'irreversible_migration',
    ],
    '7.4': ['x2_sensitive_path'],
  },
  R2: {
    '2.3': [R2_TRIGGER],
    '4.6': [R2_TRIGGER],
  },
} as const satisfies Record<string, Partial<Record<StepId, readonly RelaneTrigger[]>>>;

/** The flow endpoint an R1 raised at `step` is drawn from (`7.4` is where X2 is raised). */
export const R1_ENDPOINT: Readonly<Record<'6.5' | '7.3' | '7.4', '6.5' | '7.3' | 'X2'>> = {
  '6.5': '6.5',
  '7.3': '7.3',
  '7.4': 'X2',
};

/** One re-lane the item went through (the log R1 promises: free, but never silent). */
export const ItemRelane = z.strictObject({
  edge: z.enum(['R1', 'R2']),
  trigger: RelaneTrigger,
  from_lane: Lane,
  to_lane: Lane,
  /** The step it was raised at. */
  step: StepId,
  /** R1: the first missing stage's first step the item was sent to; R2: `1.3`. */
  target: StepId,
  /** The item stream's seq of the event that asked, and of the one that took effect. */
  asked_seq: z.number().int().min(1),
  applied_seq: z.number().int().min(1),
});
export type ItemRelane = z.infer<typeof ItemRelane>;

/** What counts toward the R3 circuit breaker ET14 (the catalogue's `counts_from`). */
export const BreakerSource = z.enum(['Q1', 'E4_abandon', 'E4_takeover', 'rework_budget']);
export type BreakerSource = z.infer<typeof BreakerSource>;
export const BreakerSourceValues: readonly BreakerSource[] = BreakerSource.options;

// ---------------------------------------------------------------- Stage ports

/** The four stage ports (PLAN M9.2). The step decides which one runs it (`portOfStep` in `@aisdlc/work`). */
export const StagePortName = z.enum(['planning', 'coding', 'verify', 'release']);
export type StagePortName = z.infer<typeof StagePortName>;

/** The conditional gates a stage can raise mid-step (FL: G3o, X1, X2, X3, E1 for R2, E2, E6). */
export const RaisableGate = GateId.extract(['G3o', 'X1', 'X2', 'X3', 'E1', 'E2', 'E6']);
export type RaisableGate = z.infer<typeof RaisableGate>;

/**
 * 6.3's oracle binding check (`checkOracleBinding` in `@aisdlc/build`): how an oracle test deviates from the oracle
 * specs G2 approved. `oracle_not_red` is an oracle that passes before the change (6.3 runs each one, red).
 */
export const OracleDeviationKind = z.enum([
  'oracle_missing',
  'oracle_unbound',
  'spec_mismatch',
  'no_marker',
  'duplicate_oracle',
  'oracle_not_red',
  'repro_missing',
]);
export type OracleDeviationKind = z.infer<typeof OracleDeviationKind>;

export const OracleDeviation = z.strictObject({
  kind: OracleDeviationKind,
  oracle_id: z.string().min(1).max(64).nullable(),
  path: z.string().min(1).max(1024).nullable(),
});
export type OracleDeviation = z.infer<typeof OracleDeviation>;

/**
 * P1-8: what a stage tells the person deciding the gate it raised, beside its reason code. Recorded on the item's
 * `stage_gate_needed` event and bound by core into the gate's facts (`GATE_NEEDED_FACT`) and subject hash, so an
 * approval is of exactly this operation or these deviations.
 *
 *   irreversible_operation  X1: what the operation is (the factory's own words), the command line the agent was about
 *                           to run (secrets masked; the agent's text, data, shown only at D2) and its target path
 *   oracle_deviation        G3o at 6.3: every way the oracle code deviates from the specs G2 approved
 */
export const IrreversibleOperationDetail = z.strictObject({
  kind: z.literal('irreversible_operation'),
  /** `tripwire`: the factory stopped the command before it ran; `agent_blocker`: the agent said it needs one. */
  source: z.enum(['tripwire', 'agent_blocker']),
  /** The factory's classification (`classifyCommand`), never repo or agent text. */
  what: z.string().min(1).max(300),
  command: z.string().min(1).max(500).nullable(),
  target: z.string().min(1).max(1024).nullable(),
  /** `agent_blocker`: what the agent said about it (masked, at most 500 characters; data, D2). */
  agent_note: z.string().min(1).max(500).nullable(),
});
export type IrreversibleOperationDetail = z.infer<typeof IrreversibleOperationDetail>;

export const OracleDeviationDetail = z.strictObject({
  kind: z.literal('oracle_deviation'),
  deviations: z.array(OracleDeviation).min(1).max(100),
});
export type OracleDeviationDetail = z.infer<typeof OracleDeviationDetail>;

export const GateNeededDetail = z.discriminatedUnion('kind', [
  IrreversibleOperationDetail,
  OracleDeviationDetail,
]);
export type GateNeededDetail = z.infer<typeof GateNeededDetail>;

/** The key a gate's facts carry its stage's `GateNeededDetail` under (X1, G3o at 6.3). */
export const GATE_NEEDED_FACT = 'gate_needed';

/** The subject hash of a gate that binds a `GateNeededDetail`: the engine's subject and the detail, together. */
export const gateNeededSubjectHash = (engineSubjectHash: string, d: GateNeededDetail): string =>
  hashCanonical({ engine: engineSubjectHash, [GATE_NEEDED_FACT]: d } as never);

/** What a stage port answers. The fakes are deterministic; a real one is an agent or a service. */
export const StageOutcome = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('completed'),
    output_hash: Sha256Hex,
    /** 6.0: the lease epoch the admission granted (M13 owns leases; the engine only counts them). */
    lease_epoch: z.number().int().min(1).optional(),
    /** The assumptions the planner reports in its output (spec, design, plan). */
    assumptions: z.array(AssumptionReport).optional(),
    /** S5 (M12.4): the merged commit the plan was made against. G3's subject hash binds it. */
    base_sha: GitSha.optional(),
  }),
  /** 6.0 admission refused: the item is HELD (H1 approver pool, H2 capacity, H3 env, WIP). */
  z.strictObject({ outcome: z.literal('held'), reason: AdmissionHold }),
  /**
   * A back-edge the step raised (B2, B3, B6-B12). `loop` names which of the edge's catalogue limits this
   * round counts against (B7: `et3_rounds`, `et2_ci_rounds`, `et2_time_multiple`); `observed` is the
   * measure for a limit that is not a count (the time multiple); `variant` picks B15's a or b.
   */
  z.strictObject({
    outcome: z.literal('rework'),
    edge: BackEdgeId,
    variant: z.enum(['a', 'b']).optional(),
    loop: z.string().min(1).optional(),
    observed: z.number().optional(),
    reason_code: z.string().min(1).max(64),
  }),
  /**
   * A re-lane the step found necessary: R1 up (free and logged, from 6.5, 7.3 or 7.4/X2) or R2 down
   * (needs E1, from 2.3). `to_lane` is the lane it says the work belongs to.
   */
  z.strictObject({
    outcome: z.literal('relane'),
    edge: z.enum(['R1', 'R2']),
    trigger: RelaneTrigger,
    to_lane: Lane,
    reason_code: z.string().min(1).max(64),
  }),
  /** An ET trigger the step hit (ET1 budget, ET2 time, ET3 repeat fail, ET8 gave up...): a handoff. */
  z.strictObject({
    outcome: z.literal('trigger'),
    trigger: TriggerId,
    reason_code: z.string().min(1).max(64),
    /** The Handoff Pack (D1, A11) or the quarantine's evidence (ET10) this trigger carries: bound into the pack's hash. */
    output_hash: Sha256Hex.optional(),
  }),
  /** 1.3: the lane the classifier proposes. G0 binds it; 1.4 checks it. */
  z.strictObject({ outcome: z.literal('classified'), lane: Lane, output_hash: Sha256Hex }),
  /** 1.5: questions for the requester. */
  z.strictObject({ outcome: z.literal('questions'), questions: z.array(QuestionDraft).min(1) }),
  /** A gate the step needs before it can go on. */
  z.strictObject({
    outcome: z.literal('gate_needed'),
    gate: RaisableGate,
    reason_code: z.string().min(1).max(64),
    /** The artefact the gate decides (4.5's constitution report for E2): bound into the gate's subject hash. */
    output_hash: Sha256Hex.optional(),
    /** P1-8: what an X1 or a G3o at 6.3 is about; core binds it into the gate's facts and subject hash. */
    detail: GateNeededDetail.optional(),
  }),
  z.strictObject({ outcome: z.literal('failed'), code: z.string().min(1).max(64) }),
]);
export type StageOutcome = z.infer<typeof StageOutcome>;

/** What a stage port is asked: ids and hashes, never request text. */
export const StageRequest = z.strictObject({
  /** The command's idempotency key: a port that is asked twice with it does the work once. */
  command_key: z.string().min(1),
  item_id: WorkItemId,
  project_id: ProjectId,
  repo: RepoFullName,
  lane: Lane,
  step: StepId,
  attempt: z.number().int().min(1),
  /** Gates already approved for this item at this step (a resume after X1, X3, G3o...). */
  approved_gates: z.array(GateId),
  /** Gates denied at this step: the stage must find another way (X3 "find an alternative", G3o). */
  denied_gates: z.array(GateId).default([]),
  catalogue_ref: CatalogueRef,
  /**
   * M11.2: set when the step is agent-acted: which agent, contract and prompt run it and the id of the
   * per-Unit virtual key minted for it (the secret is never here). Absent for a step no agent acts at.
   */
  agent: AgentBinding.optional(),
});
export type StageRequest = z.infer<typeof StageRequest>;

// ---------------------------------------------------------------- Commands

/**
 * The commands the interpreter emits. Each has a deterministic `key` (a function of the item, the
 * station and the attempt), so the same command is the same key on every replay and a port or the
 * decision kernel can refuse to do it twice.
 */
export const ItemCommand = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('run_stage'),
    key: z.string().min(1),
    port: StagePortName,
    step: StepId,
    attempt: z.number().int().min(1),
    lane: Lane,
    approved_gates: z.array(GateId),
    denied_gates: z.array(GateId).default([]),
  }),
  /** 1.4: `eligibility(repo, lane)` of the repo's PRR, deterministic, never a port to an agent. */
  z.strictObject({ type: z.literal('check_eligibility'), key: z.string().min(1), lane: Lane }),
  /** Opens the human gates of one station as one card where the project is a single operator. */
  z.strictObject({
    type: z.literal('open_gates'),
    key: z.string().min(1),
    gates: z.array(GateId).min(1),
    attempt: z.number().int().min(1),
    subject_hash: Sha256Hex,
    /** Facts for the card: lane profile, request text hash and the B27 injection report. */
    facts: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    type: z.literal('withdraw_gates'),
    key: z.string().min(1),
    gate_instance_ids: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
  }),
  /**
   * One count toward the ET14 circuit breaker of this item's project and lane (Q1, E4 abandon or
   * takeover, rework budget). Core appends it to the breaker's stream under this key, once.
   */
  z.strictObject({
    type: z.literal('breaker_signal'),
    key: z.string().min(1),
    source: BreakerSource,
    lane: Lane,
  }),
  /** A NEW linked item (B16-B19, RELHOLD, R4). */
  z.strictObject({
    type: z.literal('spawn_item'),
    key: z.string().min(1),
    edge: SpawnEdge,
    kind: SpawnKind,
    lane: Lane,
    index: z.number().int().min(0),
    origin_seq: z.number().int().min(1),
  }),
]);
export type ItemCommand = z.infer<typeof ItemCommand>;
export type ItemCommandType = ItemCommand['type'];

/** The cause code of a G0 rejection (B22: ineligible or unsuitable), told to the requester. */
export const CAUSE_B22_DECLINED = 'b22.g0_rejected';

/** The outbox destination the commands go to. */
export const WORK_COMMAND_DESTINATION = 'work.commands';

// ---------------------------------------------------------------- Item events

export const ITEM_EVENT = {
  created: 'item.created',
  submitted: 'item.submitted',
  stage_completed: 'item.stage_completed',
  stage_failed: 'item.stage_failed',
  stage_gate_needed: 'item.stage_gate_needed',
  questions_raised: 'item.questions_raised',
  question_answered: 'item.question_answered',
  eligibility_checked: 'item.eligibility_checked',
  ready_decided: 'item.ready_decided',
  scheduled: 'item.scheduled',
  merge_observed: 'item.merge_observed',
  human_work_done: 'item.human_work_done',
  gates_opened: 'item.gates_opened',
  gate_decided: 'item.gate_decided',
  hold_placed: 'item.hold_placed',
  hold_released: 'item.hold_released',
  abandoned: 'item.abandoned',
  withdrawn: 'item.withdrawn',
  spawn_requested: 'item.spawn_requested',
  spawned: 'item.spawned',
  command_done: 'item.command_done',
  stage_held: 'item.stage_held',
  rework_requested: 'item.rework_requested',
  relane_requested: 'item.relane_requested',
  trigger_fired: 'item.trigger_fired',
  timer_fired: 'item.timer_fired',
  handoff_chosen: 'item.handoff_chosen',
  hand_back: 'item.hand_back',
  env_fixed: 'item.env_fixed',
  release_re_requested: 'item.release_re_requested',
  assumption_raised: 'item.assumption_raised',
  assumption_decided: 'item.assumption_decided',
} as const;
export type ItemEventType = (typeof ITEM_EVENT)[keyof typeof ITEM_EVENT];
export const ItemEventTypeValues: readonly ItemEventType[] = Object.values(ITEM_EVENT);

/** The result events carry the key of the command they answer; a result for another key is stale. */
const Answers = { command_key: z.string().min(1) };

/** Where a spawned item came from, carried on its `item.created`. */
export const SpawnOrigin = z.strictObject({
  origin_item_id: WorkItemId,
  origin_seq: z.number().int().min(1),
  index: z.number().int().min(0),
  edge: SpawnEdge,
  kind: SpawnKind,
});
export type SpawnOrigin = z.infer<typeof SpawnOrigin>;

/** What S1 1.1, 1.2 and the first 1.4 already did when the item was made (deterministic, at intake). */
export const ItemIntake = z.strictObject({
  /** sha256 of the normalised request text (the de-dupe key with the repo); `null` for a factory-raised item. */
  text_sha256: Sha256Hex.nullable(),
  injection: InjectionReport.nullable(),
  /** 1.2: open items of the same repo with the same text. Linked, never merged. */
  dedupe_links: z.array(WorkItemId),
  /** 1.2: open agent-lane items on the same repo that may touch the same files. Informational. */
  conflict_candidates: z.array(WorkItemId),
  /** 1.4 at intake: where the requested lane goes. */
  route: z.enum(['normal', 'l8']),
  eligibility_reason: z.string().min(1),
});
export type ItemIntake = z.infer<typeof ItemIntake>;

export const ItemCreatedPayload = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  request_id: WorkRequestId,
  repo: RepoFullName,
  requester: PrincipalId,
  channel: EntryChannel,
  /** The catalogue pin (M1.6): the item keeps it for life. */
  catalogue_ref: CatalogueRef,
  /** The project's gating profile the item started with; a change applies to new items only (OB §1C). */
  gating_profile: PrrGatingProfile,
  tier: Tier,
  /** The PRR this item was created under. */
  prr: z.strictObject({ version: z.number().int().min(1), record_hash: Sha256Hex }),
  /** The lane the request asked for, or 1.3 proposes. Nothing is bound until G0 (FIX 7). */
  proposed_lane: Lane,
  /** M17 (DEC-25): the area the request named; 1.4 asks its lanes. Absent: the repo as a whole. */
  area: AreaId.optional(),
  intake: ItemIntake,
  origin: SpawnOrigin.nullable(),
});
export type ItemCreatedPayload = z.infer<typeof ItemCreatedPayload>;

const EmptyPayload = z.strictObject({});

export const ItemStagePayloads = {
  [ITEM_EVENT.stage_completed]: z.strictObject({
    ...Answers,
    step: StepId,
    output_hash: Sha256Hex,
    lane: Lane.optional(),
    lease_epoch: z.number().int().min(1).optional(),
    assumptions: z.array(AssumptionReport).optional(),
    base_sha: GitSha.optional(),
  }),
  [ITEM_EVENT.stage_failed]: z.strictObject({ ...Answers, step: StepId, code: z.string().min(1) }),
  [ITEM_EVENT.stage_gate_needed]: z.strictObject({
    ...Answers,
    step: StepId,
    gate: RaisableGate,
    reason_code: z.string().min(1),
    output_hash: Sha256Hex.optional(),
    detail: GateNeededDetail.optional(),
  }),
  [ITEM_EVENT.questions_raised]: z.strictObject({
    ...Answers,
    step: StepId,
    round: z.number().int().min(1),
    questions: z.array(
      z.strictObject({
        question_id: z.string().min(1),
        text: z.string().min(1),
        material: QuestionMateriality,
      }),
    ),
  }),
  [ITEM_EVENT.eligibility_checked]: z.strictObject({
    ...Answers,
    lane: Lane,
    route: z.enum(['normal', 'n8_hold', 'l8']),
    eligible: z.boolean(),
    reason: z.string().min(1),
    prr_version: z.number().int().min(1).nullable(),
  }),
} as const;

export const GateOutcome = z.enum([
  'approve',
  'reject',
  'request_changes',
  'expired',
  'closed',
  'superseded',
]);
export type GateOutcome = z.infer<typeof GateOutcome>;

export const ItemEventPayloads = {
  [ITEM_EVENT.created]: ItemCreatedPayload,
  [ITEM_EVENT.submitted]: EmptyPayload,
  ...ItemStagePayloads,
  [ITEM_EVENT.question_answered]: z.strictObject({
    question_id: z.string().min(1),
    answer: TaintedText,
    by: PrincipalId,
  }),
  /** 1.6, the human Ready decision. */
  [ITEM_EVENT.ready_decided]: z.strictObject({ by: PrincipalId }),
  /** 5.7 when the project opted into human scheduling. */
  [ITEM_EVENT.scheduled]: z.strictObject({ by: PrincipalId }),
  /** 8.2: the human merged on GitHub and the factory observed it (the factory never merges). */
  [ITEM_EVENT.merge_observed]: z.strictObject({ merged_sha: z.string().min(7) }),
  /** L8: the developer finished (D5): the item goes on to 7.1. */
  [ITEM_EVENT.human_work_done]: z.strictObject({
    by: PrincipalId,
    /**
     * B5 "a human writes the plan" (M12.4): the plan artefacts the human stored (their steps' hashes) and the
     * merged commit they planned against. The engine takes them as the outputs of 5.1 to 5.6, so G3 binds
     * exactly what the human wrote. Absent for L8's D5.
     */
    outputs: z.partialRecord(StepId, Sha256Hex).optional(),
    base_sha: GitSha.optional(),
    /** D5 (L8): the pull request or commit the developer names as the work (absent: not named). */
    reference: HumanWorkReference.optional(),
  }),
  [ITEM_EVENT.gates_opened]: z.strictObject({
    ...Answers,
    gates: z.array(z.strictObject({ gate: GateId, gate_instance_id: z.string().min(1) })).min(1),
    card_ids: z.array(z.string().min(1)),
    subject_hash: Sha256Hex,
  }),
  /** A gate instance left `pending`: read from the ledger, never from a read model. */
  [ITEM_EVENT.gate_decided]: z.strictObject({
    gate_instance_id: z.string().min(1),
    gate: GateId,
    outcome: GateOutcome,
    ledger_entry_id: z.string().min(1).nullable(),
  }),
  [ITEM_EVENT.hold_placed]: z.strictObject({
    hold_id: z.string().min(1),
    reason: HoldReason,
    origin: z.string().min(1).nullable(),
  }),
  [ITEM_EVENT.hold_released]: z.strictObject({ hold_id: z.string().min(1) }),
  [ITEM_EVENT.abandoned]: z.strictObject({ cause: AbandonCause, by: PrincipalId }),
  [ITEM_EVENT.withdrawn]: z.strictObject({ by: PrincipalId }),
  [ITEM_EVENT.spawn_requested]: z.strictObject({
    edge: SpawnEdge,
    kind: SpawnKind,
    lane: Lane,
    index: z.number().int().min(0),
  }),
  [ITEM_EVENT.spawned]: z.strictObject({ ...Answers, link: SpawnLink }),
  /** A command with no result of its own (withdrawing gates) was carried out. */
  [ITEM_EVENT.command_done]: z.strictObject({ ...Answers }),
  /** 6.0 admission said no: the item is held (H1, H2, H3, WIP) until the release loop frees it. */
  [ITEM_EVENT.stage_held]: z.strictObject({
    ...Answers,
    step: StepId,
    reason: AdmissionHold,
  }),
  /**
   * A back-edge was asked for: by a stage (with its `command_key`), or observed (a merge conflict, a
   * requester's amendment, an approver who is unsure). The catalogue's limit decides what happens.
   */
  [ITEM_EVENT.rework_requested]: z.strictObject({
    edge: BackEdgeId,
    step: StepId.nullable(),
    command_key: z.string().min(1).optional(),
    variant: z.enum(['a', 'b']).optional(),
    loop: z.string().min(1).optional(),
    observed: z.number().optional(),
    reason_code: z.string().min(1).max(64),
    by: PrincipalId.optional(),
  }),
  /**
   * R1 or R2 asked for: by a stage (with its `command_key`), or observed at the design review (4.6,
   * while G3d is open). R1 is free and logged, R2 needs an E1 decision (FL FIX 3).
   */
  [ITEM_EVENT.relane_requested]: z.strictObject({
    edge: z.enum(['R1', 'R2']),
    trigger: RelaneTrigger,
    to_lane: Lane,
    step: StepId,
    command_key: z.string().min(1).optional(),
    reason_code: z.string().min(1).max(64),
    by: PrincipalId.optional(),
  }),
  /** An ET trigger fired (a stage, the gateway or a monitor): the item is handed off (D1, D2 or D3). */
  [ITEM_EVENT.trigger_fired]: z.strictObject({
    trigger: TriggerId,
    step: StepId,
    command_key: z.string().min(1).optional(),
    reason_code: z.string().min(1).max(64),
    output_hash: Sha256Hex.optional(),
  }),
  /**
   * A timer of the item ran out. Core computes `due_at` on the business calendar from the facts the
   * item's own stream holds (`since`, the frozen time), so the fold stays deterministic.
   */
  [ITEM_EVENT.timer_fired]: z.strictObject({
    timer: z.enum(['park', 'clarify_silence', 'item_age']),
    since: IsoDateTime,
    due_at: IsoDateTime,
    frozen_ms: z.number().int().min(0),
  }),
  /** The owner of record's E4 choice. It is taken only once E4 itself is decided in the ledger. */
  [ITEM_EVENT.handoff_chosen]: z.strictObject({
    handoff_id: HandoffUuid,
    choice: HandoffChoice,
    by: PrincipalId,
    /** `extend`: how much more envelope, in percent (at most the catalogue's `max_percent`). */
    extension_percent: z.number().positive().optional(),
    via: z.enum(['E3', 'E5']).optional(),
    /** `abandon`: the cause code (default `e4.abandon`). */
    cause: AbandonCause.optional(),
  }),
  /** D4: the developer hands the item back, once. `plan_changed` sends it through G3 again. */
  [ITEM_EVENT.hand_back]: z.strictObject({ by: PrincipalId, plan_changed: z.boolean() }),
  /** BLOCKED's exit: the environment is fixed; the item goes on at 6.1. */
  [ITEM_EVENT.env_fixed]: z.strictObject({ by: PrincipalId }),
  /** RELHOLD's exit: re-request the release (G5 again) after the fix window. */
  [ITEM_EVENT.release_re_requested]: z.strictObject({ by: PrincipalId }),
  [ITEM_EVENT.assumption_raised]: z.strictObject({
    origin: AssumptionOrigin,
    kind: AssumptionKind,
    origin_run: z.string().min(1).nullable(),
    text_hash: Sha256Hex,
  }),
  [ITEM_EVENT.assumption_decided]: z.strictObject({
    assumption_id: z.string().min(1),
    state: z.enum(['accepted', 'overridden']),
    by: PrincipalId,
  }),
} as const satisfies Record<ItemEventType, z.ZodType>;

export type ItemEventPayload<T extends ItemEventType> = z.infer<(typeof ItemEventPayloads)[T]>;

/** An item event as the interpreter sees it: the type, the validated payload, and where it sits. */
export type ItemEvent = {
  [T in ItemEventType]: {
    readonly type: T;
    readonly payload: ItemEventPayload<T>;
    /** The stream's seq: 1 for `item.created`. */
    readonly seq: number;
    readonly at: string;
  };
}[ItemEventType];

// ---------------------------------------------------------------- Request API and item view

/** `POST /v1/requests`: the body core takes; the portal's `on_behalf_of` is the session's, the channel its own. */
export const SubmitRequestBody = z.strictObject({
  project_id: ProjectId,
  repo: RepoFullName,
  /** The lane asked for or proposed (1.3 may change it; G0 binds it). */
  lane: Lane,
  /**
   * M17 (DEC-25): the area of the repo the work is in, as its system map names it; an area the governing record does
   * not hold is refused. Absent: the repo as a whole, which runs only what its lowest area may.
   */
  area: AreaId.optional(),
  /** N1 portal Ask and N3 API are open (`OPEN_INTAKE_CHANNELS`). */
  channel: EntryChannel,
  text: z.string().min(1).max(100_000),
  /** A retry key: the same key is the same request and the same item. */
  request_id: z.uuid().optional(),
  on_behalf_of: PrincipalId,
});
export type SubmitRequestBody = z.infer<typeof SubmitRequestBody>;

/** An item for a reader: position, what it waits for and its questions; never request text. */
/**
 * P2-16: where S1's clarifying questions stand (B1): the round asked, the catalogue's limit, the open blocking questions,
 * and the business-day deadline the requester's silence runs to (Clarifying: it parks then; Parked: it is abandoned
 * then). `deadline` is `null` when the pinned catalogue names no limit.
 */
export const ItemClarifyState = z.strictObject({
  round: z.number().int().min(1),
  rounds_max: z.number().int().min(1).nullable(),
  open: z.number().int().min(0),
  since: IsoDateTime,
  deadline: IsoDateTime.nullable(),
  then: z.enum(['parks', 'abandons']),
});
export type ItemClarifyState = z.infer<typeof ItemClarifyState>;

/** P3-5: a pull request the Push Broker opened for the item (`core.pull_request`): the link and the head. */
export const ItemPullRequest = z.strictObject({
  repo: RepoFullName,
  number: z.number().int().min(1),
  unit_key: z.string().min(1).max(128),
  head_ref: z.string().min(1),
  head_sha: GitSha,
  state: PullRequestState,
  draft: z.boolean(),
});
export type ItemPullRequest = z.infer<typeof ItemPullRequest>;

export const ItemView = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  repo: RepoFullName,
  request_id: WorkRequestId,
  phase: z.string().min(1),
  lane: Lane.nullable(),
  proposed_lane: Lane,
  terminal: z.string().nullable(),
  waiting: z.string().nullable(),
  holds: z.array(ItemHold),
  questions: z.array(
    Question.omit({ answer: true }).extend({ answered: z.boolean(), answer_flagged: z.boolean() }),
  ),
  gates: z.array(
    z.strictObject({
      gate: GateId,
      gate_instance_id: z.string(),
      status: z.enum(['pending', 'decided']),
      outcome: z.string().nullable(),
      /** The decision card the gate is decided on (from the record's `card.opened`); `null` when none is known. */
      card_id: CardId.nullable(),
      /** The ledger entry of the decision; `null` while pending (or for a decision recorded without one). */
      ledger_entry_id: z.string().min(1).nullable(),
    }),
  ),
  outstanding: z.number().int().min(0),
  /** The cause code of a terminal state (Declined, Abandoned...), told to the requester. */
  terminal_cause: z.string().nullable(),
  /** The item's rework count (FIX 14): back-edges taken against its budget. */
  rework_total: z.number().int().min(0),
  /** The open handoff, if any. */
  handoff: Handoff.nullable(),
  assumptions: z.array(Assumption),
  catalogue_ref: CatalogueRef,
  /** B27: the request text was flagged (the card says which rules). */
  injection_suspected: z.boolean(),
  dedupe_links: z.array(WorkItemId),
  /**
   * P2-10: the human gates of the item's route under the catalogue and gating profile it pinned (`on`, catalogue
   * order), and the gates its lane could have that the profile has off (`off`: off for this project when the item was
   * pinned). Conditional gates (raised by a step) are in neither. `null`: the pinned catalogue cannot be read.
   */
  profile_gates: z.strictObject({ on: z.array(GateId), off: z.array(GateId) }).nullable(),
  /** P2-16: the clarifying round while S1 waits for answers or is parked on them; `null` otherwise. */
  clarify: ItemClarifyState.nullable(),
  /** P3-5: the item's pull requests and their heads, by number. */
  pull_requests: z.array(ItemPullRequest),
});
export type ItemView = z.infer<typeof ItemView>;
