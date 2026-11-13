import { z } from 'zod';
import { BackEdgeId, GateId, TriggerId } from '../flow.js';
import { Lane, StepId } from '../values.js';
import { AgentBinding, AgentBudgetDefaults, AgentId } from './agent-definitions.js';
import { IsoDateTime, ProjectId, WorkItemId } from './ids.js';
import { GateOutcome } from './work-lifecycle.js';
import { VKeyScopeKind } from './gateway.js';

// Planning and Agents, the run half (PLAN M11.2; DM §3.5 AgentRun, AgentRunOutcome, ModelCall; §5.2;
// §8 gap 6). An AgentRun is a READ MODEL: a fold of the record, never a table of its own authority.
// It is built from three sources and nothing else:
//   a) the dispatch (`agent.run_dispatched`) core records when it hands a stage command to an agent,
//      and the item stream's results for that command (`item.stage_completed`, `item.stage_failed`, ...);
//   b) the gateway's `gateway.model_call` events, joined by the run's virtual key;
//   c) failures core records itself (`agent.run_failed`, in the spirit of the old `job.failed`).
// Its AgentRunOutcome is what happened NEXT to the item: the gate decisions read from the ledger
// (carried by `item.gate_decided`), the back-edges taken and the ET triggers hit.

// ---------------------------------------------------------------- Streams and events

/** `agent:<item_id>`: the agent facts of one item. Core appends; the item's own stream is untouched. */
export const agentStream = (itemId: string): string => `agent:${itemId}`;
export const AGENT_STREAM_PREFIX = 'agent:';

export const AGENT_EVENT = {
  run_dispatched: 'agent.run_dispatched',
  run_failed: 'agent.run_failed',
} as const;
export type AgentEventType = (typeof AGENT_EVENT)[keyof typeof AGENT_EVENT];

/**
 * The run id is a function of the command's key: one command, one run, however often it is delivered.
 * (A redelivery after a lost answer is the same run, with the key it already has.)
 */
export const AgentRunId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export type AgentRunId = z.infer<typeof AgentRunId>;

/**
 * Core handed the command to an agent: which agent, contract and prompt, and the key minted for it
 * (its id, never its secret) with exactly what the key carries. Recorded BEFORE the stage port is called.
 */
export const AgentRunDispatchedPayload = z.strictObject({
  run_id: AgentRunId,
  item_id: WorkItemId,
  project_id: ProjectId,
  command_key: z.string().min(1),
  step: StepId,
  attempt: z.number().int().min(1),
  lane: Lane,
  binding: AgentBinding,
  /** The budget the key was minted with. */
  budget: AgentBudgetDefaults,
  /** The key's scope: a Unit's (S6) or the command's own job. `null` when no key was minted. */
  scope: z.strictObject({ kind: VKeyScopeKind, ref: z.string().min(1) }).nullable(),
  unit_id: z.string().min(1).nullable(),
});
export type AgentRunDispatchedPayload = z.infer<typeof AgentRunDispatchedPayload>;

/** Why core records a run as failed itself (the stage's own `failed` outcome is on the item stream). */
export const AgentRunFailureCode = z.enum([
  /** The gateway refused or could not be asked for a key: the agent is not run without one. */
  'key_mint_refused',
  /** The stage port could not be reached or did not answer; the command is delivered again. */
  'port_error',
  /** The agent's output did not validate against its OutputSchema (`validateOutput`). */
  'output_invalid',
  /** The output held a secret (the shared ruleset hit): refused before it was stored (M12). */
  'secret_in_output',
  /**
   * Portal v2 (`agents.config`): the agent is switched off, or the settings cannot be read. Nothing runs; the command
   * is delivered again later and runs once the agent is on.
   */
  'agent_disabled',
]);
export type AgentRunFailureCode = z.infer<typeof AgentRunFailureCode>;

export const AgentRunFailedPayload = z.strictObject({
  run_id: AgentRunId,
  item_id: WorkItemId,
  project_id: ProjectId,
  command_key: z.string().min(1),
  step: StepId,
  attempt: z.number().int().min(1),
  lane: Lane,
  /** Present so a run that failed before it was dispatched (no key) still has an agent. */
  binding: AgentBinding,
  code: AgentRunFailureCode,
  /** A short reason for people (never output text). */
  detail: z.string().max(300),
});
export type AgentRunFailedPayload = z.infer<typeof AgentRunFailedPayload>;

export const AgentEventPayloads = {
  [AGENT_EVENT.run_dispatched]: AgentRunDispatchedPayload,
  [AGENT_EVENT.run_failed]: AgentRunFailedPayload,
} as const satisfies Record<AgentEventType, z.ZodType>;

// ---------------------------------------------------------------- AgentRun

/**
 * `dispatched`: handed to the agent, no result yet. `finished`: the stage answered (see `result`).
 * `failed`: the stage answered `failed`, or core recorded a failure and no answer followed.
 */
export const AgentRunState = z.enum(['dispatched', 'finished', 'failed']);
export type AgentRunState = z.infer<typeof AgentRunState>;
export const AgentRunStateValues: readonly AgentRunState[] = AgentRunState.options;

/** What the stage answered: the item stream's result for the run's command. */
export const AgentRunResult = z.enum([
  'completed',
  'classified',
  'questions',
  'gate_needed',
  'held',
  'rework',
  'relane',
  'trigger',
  'failed',
]);
export type AgentRunResult = z.infer<typeof AgentRunResult>;
export const AgentRunResultValues: readonly AgentRunResult[] = AgentRunResult.options;

export const AgentRun = z.strictObject({
  run_id: AgentRunId,
  item_id: WorkItemId,
  project_id: ProjectId,
  unit_id: z.string().nullable(),
  step: StepId,
  attempt: z.number().int().min(1),
  lane: Lane,
  agent_id: AgentId,
  contract_version: z.string().min(1),
  /** `name@version` and the sha256 of the prompt file as the lock held it at dispatch. */
  prompt_ref: z.string().min(1),
  prompt_sha256: z.string().length(64),
  /** From the run's metered calls (the last one's route); `null` before any call. */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  vkey_id: z.string().nullable(),
  /** Summed from the gateway's ModelCall events of this key. */
  calls: z.number().int().min(0),
  tokens_in: z.number().int().min(0),
  tokens_out: z.number().int().min(0),
  cost_micro_usd: z.number().int().min(0),
  state: AgentRunState,
  result: AgentRunResult.nullable(),
  /** The stage's failure code, or core's `AgentRunFailureCode`. */
  failure_code: z.string().nullable(),
  started_at: IsoDateTime,
  ended_at: IsoDateTime.nullable(),
});
export type AgentRun = z.infer<typeof AgentRun>;

// ---------------------------------------------------------------- AgentRunOutcome

/**
 * What a run came to. `accepted`: a gate approved what it produced. `rejected`, `sent_back`: a gate
 * rejected it or asked for changes. `reworked`: a back-edge took the item back to it without a gate.
 * `handed_off`: an ET trigger handed the item off. `pending`: nothing has happened to it yet (or only
 * gates that ended without a decision: expiry never approves, and never judges either).
 */
export const AgentRunVerdict = z.enum([
  'pending',
  'accepted',
  'rejected',
  'sent_back',
  'reworked',
  'handed_off',
]);
export type AgentRunVerdict = z.infer<typeof AgentRunVerdict>;
export const AgentRunVerdictValues: readonly AgentRunVerdict[] = AgentRunVerdict.options;

export const AgentJudgement = z.discriminatedUnion('kind', [
  /** A gate decision on the artefact, as the ledger holds it (`item.gate_decided` names the entry). */
  z.strictObject({
    kind: z.literal('gate'),
    gate: GateId,
    gate_instance_id: z.string().min(1),
    outcome: GateOutcome,
    ledger_entry_id: z.string().nullable(),
    /** The back-edge the interpreter takes on this refusal (B5, B13, B23, B24), else `null`. */
    edge: BackEdgeId.nullable(),
    seq: z.number().int().min(1),
  }),
  /** A back-edge taken toward the step that produced the artefact (B3, B7, B9, ...). */
  z.strictObject({
    kind: z.literal('back_edge'),
    edge: BackEdgeId,
    seq: z.number().int().min(1),
  }),
  /** An ET trigger hit while this run was the agent at work (ET1 from the gateway, ET8, ...). */
  z.strictObject({ kind: z.literal('trigger'), trigger: TriggerId, seq: z.number().int().min(1) }),
]);
export type AgentJudgement = z.infer<typeof AgentJudgement>;

export const AgentRunOutcome = z.strictObject({
  run_id: AgentRunId,
  verdict: AgentRunVerdict,
  /** In the order they happened on the item's stream. */
  judgements: z.array(AgentJudgement),
  /** Every back-edge among the judgements (a gate refusal's edge included), once each, in order. */
  back_edges: z.array(BackEdgeId),
  triggers: z.array(TriggerId),
});
export type AgentRunOutcome = z.infer<typeof AgentRunOutcome>;

export const AgentRunView = AgentRun.extend({ outcome: AgentRunOutcome });
export type AgentRunView = z.infer<typeof AgentRunView>;

/** `GET /v1/agent-runs?item=`. */
export const AgentRunsView = z.strictObject({
  item_id: WorkItemId,
  /** The item's project: what the caller's `project.view` is decided on. */
  project_id: ProjectId,
  runs: z.array(AgentRunView),
});
export type AgentRunsView = z.infer<typeof AgentRunsView>;

// ---------------------------------------------------------------- Stats

/**
 * `GET /v1/agents/:id/stats`. Rates are `null` while their denominator is 0 (never 0 or 1 by default).
 * `acceptance_rate` = accepted / judged, where judged is every verdict but `pending`.
 * `back_edge_rate` = finished runs that had at least one back-edge / finished runs.
 * `cost_per_run_micro_usd` = metered cost / runs that made at least one call.
 */
export const AgentStats = z.strictObject({
  agent_id: AgentId,
  /** Set when the stats are of one project. */
  project_id: ProjectId.nullable(),
  runs: z.number().int().min(0),
  finished: z.number().int().min(0),
  failed: z.number().int().min(0),
  judged: z.number().int().min(0),
  accepted: z.number().int().min(0),
  rejected: z.number().int().min(0),
  sent_back: z.number().int().min(0),
  reworked: z.number().int().min(0),
  handed_off: z.number().int().min(0),
  with_back_edge: z.number().int().min(0),
  acceptance_rate: z.number().min(0).max(1).nullable(),
  back_edge_rate: z.number().min(0).max(1).nullable(),
  calls: z.number().int().min(0),
  tokens_in: z.number().int().min(0),
  tokens_out: z.number().int().min(0),
  cost_micro_usd: z.number().int().min(0),
  cost_per_run_micro_usd: z.number().min(0).nullable(),
});
export type AgentStats = z.infer<typeof AgentStats>;
