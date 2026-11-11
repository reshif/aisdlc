import { z } from 'zod';
import { DataClass, STEPS, StepId, type ActorKind } from '../values.js';
import { JsonObject, Sha256Hex, WorkItemId } from './ids.js';

// Planning and Agents, the definition half (PLAN M11.1; DM §3.5, §8 gaps 6 and 17): who the agents
// are, what each may do and where. The data itself (the 13 definitions, their prompts, their output
// schemas) is `@aisdlc/agents`; the vocabulary is here, once, so core, the gateway's client, the
// stage ports and the portal import the same shapes.

// ---------------------------------------------------------------- Agent ids

/**
 * Every agent the specs name. A1 to A6 and `coder` are the ids of DM §3.5 (`AGENT_NAMES`); A9 and A12
 * are named by OB (S0 steps 0.2, 0.3) and A11 by the flow (the Handoff Pack at D1). A7, A8 and A10
 * appear nowhere else in the specs, so they are ids with no name and no role (`@aisdlc/agents`
 * records that, and gives them no step).
 */
export const AgentId = z.enum([
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'A7',
  'A8',
  'A9',
  'A10',
  'A11',
  'A12',
  'coder',
]);
export type AgentId = z.infer<typeof AgentId>;
export const AgentIdValues: readonly AgentId[] = AgentId.options;

/**
 * The tools an agent can be given. The gateway's virtual key carries exactly this list (`tools` of
 * `VKeyMint`); a request cannot widen it. Names are the Claude Agent SDK's tool names.
 */
export const AgentTool = z.enum([
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash',
  'KnowledgeSearch',
]);
export type AgentTool = z.infer<typeof AgentTool>;
export const AgentToolValues: readonly AgentTool[] = AgentTool.options;

/** The artefacts an agent may be given as input (DM `AgentContract.inputs`: "artefact whitelist"). */
export const ArtefactType = z.enum([
  'request',
  'intent_block',
  'context_brief',
  'decision_brief',
  'spec_delta',
  'oracle_specs',
  'design',
  'plan',
  'diff',
  'evidence_pack',
  'session_log',
  'repo_snapshot',
  'config_history',
  // M12 (S2, S3): what the planning steps store (`@aisdlc/contracts` `STEP_ARTEFACT`)
  'reverse_engineering',
  'impact',
  'initiative',
  'affected_requirements',
  'validation_report',
  'spec_review',
  // M12.3 (S4) and M12.4 (S5), and S1's two agent steps: what they store (`STEP_ARTEFACT`)
  'classification',
  'adr',
  'contracts',
  'data_migration',
  'nfr_threat_ops',
  'constitution_report',
  'unit_split',
  'unit_sequence',
  'verification_binding',
  'budget_envelope',
  'capacity_input',
  // M13.6: what S6 stores: the oracle test files A6 wrote at 6.3, the patch an X2 decides at 6.6, the L7 spike report
  'oracle_code',
  'patch',
  'spike_report',
]);
export type ArtefactType = z.infer<typeof ArtefactType>;
export const ArtefactTypeValues: readonly ArtefactType[] = ArtefactType.options;

/** Steps whose actor is an agent, alone or with a deterministic or human partner: A, D+A, A+H. */
export const AGENT_ACTORS: readonly ActorKind[] = ['A', 'D+A', 'A+H'];
export const isAgentStep = (step: StepId): boolean => AGENT_ACTORS.includes(STEPS[step].actor);

// ---------------------------------------------------------------- Contract

/** The key's budget: tokens and cost are hard stops at the gateway; `ttl_seconds` is how long the key lives. */
export const AgentBudgetDefaults = z.strictObject({
  max_tokens: z.number().int().min(1).max(1_000_000_000),
  /** Micro-USD (1 USD = 1_000_000), as the gateway counts it. */
  max_cost_micro_usd: z.number().int().min(1).max(1_000_000_000_000),
  ttl_seconds: z.number().int().min(60).max(86_400),
});
export type AgentBudgetDefaults = z.infer<typeof AgentBudgetDefaults>;

const Semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'semver');

/**
 * What an agent is held to. `input_schema` and `output_schema` are JSON Schema (2020-12) generated from
 * the Zod schemas in `@aisdlc/agents`; an output is checked by `validateOutput`, never trusted. Nothing
 * in an output schema can name a lane, a gate, tools, egress or a budget: those are decided by the
 * factory (the contract below, the catalogue, the gateway), never by what an agent writes (FL FIX 15).
 */
export const AgentContract = z.strictObject({
  contract_version: Semver,
  input_schema_id: z.string().regex(/^[a-z][a-z0-9_]*\.v[0-9]+$/),
  input_schema: JsonObject,
  output_schema_id: z.string().regex(/^[a-z][a-z0-9_]*\.v[0-9]+$/),
  output_schema: JsonObject,
  /** The allow-list the gateway key carries. A1 has none (DM: "A1 may not have tools or retrieval"). */
  tools: z.array(AgentTool).max(16),
  /** The most sensitive class the agent's key may carry. D3 is never routed, so never here. */
  data_class_max: DataClass.exclude(['D3']),
  /** Factory model ids (`gateway.models`) the agent prefers, in order; the key allows these. */
  models: z.array(z.string().min(1).max(64)).min(1).max(8),
  budget: AgentBudgetDefaults,
});
export type AgentContract = z.infer<typeof AgentContract>;

/** The prompt, by reference: `name@version`, the file, and its sha256 as `prompts.lock.json` holds it. */
export const PromptRef = z.strictObject({
  /** `a3_plan@1.0.0` */
  ref: z.string().regex(/^[a-z][a-z0-9_]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  sha256: Sha256Hex,
});
export type PromptRef = z.infer<typeof PromptRef>;

/**
 * An agent. `role` and `name` are `null` where the specs give only an id (A7, A8, A10); `note` says
 * where the words come from or what the specs leave open. `steps` are the steps it may act at,
 * and a step must be one whose actor is A, D+A or A+H (checked here and again by the registry's tests).
 */
export const AgentDefinition = z
  .strictObject({
    agent_id: AgentId,
    name: z.string().min(1).max(64).nullable(),
    role: z.string().min(1).max(64).nullable(),
    note: z.string().min(1).max(500).nullable(),
    steps: z.array(StepId).max(64),
    /**
     * Steps a DETERMINISTIC (D) step calls the agent in for (M13.6: 6.3 "D check: matches the G2-approved oracle specs":
     * the check and the lock are the factory's, A6 writes the test files). The work driver binds this agent and mints
     * its key at the step like any agent's, but the step stays a D step in the flow and the catalogue.
     */
    specialist_steps: z.array(StepId).max(8).default([]),
    contract: AgentContract,
    prompt: PromptRef,
  })
  .refine((d) => d.steps.every(isAgentStep), {
    message: 'an agent may only be bound to a step whose actor is A, D+A or A+H',
    path: ['steps'],
  })
  .refine((d) => new Set(d.steps).size === d.steps.length, {
    message: 'duplicate step',
    path: ['steps'],
  })
  .refine((d) => d.specialist_steps.every((s) => !d.steps.includes(s) && !isAgentStep(s)), {
    message: 'a specialist step is a deterministic step no agent is the primary of',
    path: ['specialist_steps'],
  });
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/**
 * What a stage port is told about the agent that runs its command (`StageRequest.agent`): which agent,
 * which contract and prompt, and the virtual key minted for it. The key's SECRET is not here: it goes
 * to the sandbox by the channel M13 defines and is never kept (gateway-api.md §1).
 */
export const AgentBinding = z.strictObject({
  run_id: z.string().min(1),
  agent_id: AgentId,
  contract_version: Semver,
  prompt_ref: PromptRef.shape.ref,
  prompt_sha256: Sha256Hex,
  /** `null` only where the deployment mints no keys (a test of something else). */
  vkey_id: z.string().min(1).nullable(),
  /** Exactly the allow-list the key carries. */
  tools: z.array(AgentTool),
  data_class_max: DataClass,
});
export type AgentBinding = z.infer<typeof AgentBinding>;

/** The input every agent is given: ids and hashes of whitelisted artefacts, never their text. */
export const AgentInputArtefact = z.strictObject({
  type: ArtefactType,
  ref: z.string().min(1).max(256),
  sha256: Sha256Hex,
});
export type AgentInputArtefact = z.infer<typeof AgentInputArtefact>;

export const AgentInputBase = z.strictObject({
  item_id: WorkItemId,
  step: StepId,
  attempt: z.number().int().min(1),
  artefacts: z.array(AgentInputArtefact).max(64),
});
export type AgentInputBase = z.infer<typeof AgentInputBase>;
