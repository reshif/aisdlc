import { z } from 'zod';
import { BackEdgeId, GateId, HoldReason, AbandonCause, RelaneId } from '../flow.js';
import { EntryChannel, Lane, StageId, StepId, Tier } from '../values.js';
import { CatalogueRef } from './config.js';
import { LintRuleId } from './detectors.js';
import { PrrGatingProfile } from './readiness.js';
import {
  IsoDateTime,
  PrincipalId,
  ProjectId,
  Sha256Hex,
  WorkItemId,
  WorkRequestId,
} from './ids.js';
import { RepoFullName } from './codehost.js';

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

/** The edges that start a NEW linked item (FL `REQ` targets): B16 B17 B18 B19, RELHOLD (B26), R4. */
export const SpawnEdge = z.union([
  BackEdgeId.extract(['B16', 'B17', 'B18', 'B19', 'B26']),
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
]);
export type SpawnKind = z.infer<typeof SpawnKind>;

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

// ---------------------------------------------------------------- Stage ports

/** The four stage ports (PLAN M9.2). The step decides which one runs it (`portOfStep` in `@aisdlc/work`). */
export const StagePortName = z.enum(['planning', 'coding', 'verify', 'release']);
export type StagePortName = z.infer<typeof StagePortName>;

/** The conditional gates a stage can raise mid-step (FL: G3o, X1, X2, X3, E2; E6 is M9.4). */
export const RaisableGate = GateId.extract(['G3o', 'X1', 'X2', 'X3', 'E2']);
export type RaisableGate = z.infer<typeof RaisableGate>;

/** What a stage port answers. The fakes are deterministic; a real one is an agent or a service. */
export const StageOutcome = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('completed'),
    output_hash: Sha256Hex,
    /** 6.0: the lease epoch the admission granted (M13 owns leases; the engine only counts them). */
    lease_epoch: z.number().int().min(1).optional(),
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
  catalogue_ref: CatalogueRef,
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
  }),
  [ITEM_EVENT.stage_failed]: z.strictObject({ ...Answers, step: StepId, code: z.string().min(1) }),
  [ITEM_EVENT.stage_gate_needed]: z.strictObject({
    ...Answers,
    step: StepId,
    gate: RaisableGate,
    reason_code: z.string().min(1),
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
  [ITEM_EVENT.human_work_done]: z.strictObject({ by: PrincipalId }),
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
  /** N1 portal Ask and N3 API are open (`OPEN_INTAKE_CHANNELS`). */
  channel: EntryChannel,
  text: z.string().min(1).max(100_000),
  /** A retry key: the same key is the same request and the same item. */
  request_id: z.uuid().optional(),
  on_behalf_of: PrincipalId,
});
export type SubmitRequestBody = z.infer<typeof SubmitRequestBody>;

/** An item for a reader: position, what it waits for and its questions; never request text. */
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
    }),
  ),
  outstanding: z.number().int().min(0),
  catalogue_ref: CatalogueRef,
  /** B27: the request text was flagged (the card says which rules). */
  injection_suspected: z.boolean(),
  dedupe_links: z.array(WorkItemId),
});
export type ItemView = z.infer<typeof ItemView>;
