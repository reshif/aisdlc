import type { AgentId, AgentTool, ArtefactType, DataClass, StepId } from '@aisdlc/contracts';
import { ANTHROPIC_DEFAULT_MODELS } from '@aisdlc/contracts';
import type { OutputSchemaId } from './outputs.js';

// The agents as data (PLAN M11.1), like the catalogue: versioned, validated when the registry is built
// and by its tests. Names and roles are the specs' words (DM §3.5 and §8 gap 17: `AGENT_NAMES` A1..A6 and
// `coder`; OB 0.1-0.3: A9, A12; FL D1: A11). Where the specs give only an id the name and role are `null`
// and `note` says so. A step binding follows the stage tables of the flow and the profiles of DM §3.5
// (`A2.clarify A3.shape A2.specify A3.design A3.plan`); a note says where a binding is a choice.

export interface AgentSpec {
  readonly agent_id: AgentId;
  readonly name: string | null;
  readonly role: string | null;
  readonly note: string | null;
  readonly steps: readonly StepId[];
  /** The step-by-step contract. Bump `contract_version` with any change of schema, tools or limits. */
  readonly contract_version: string;
  readonly output_schema_id: OutputSchemaId;
  readonly artefacts: readonly ArtefactType[];
  readonly tools: readonly AgentTool[];
  readonly data_class_max: Exclude<DataClass, 'D3'>;
  readonly models: readonly string[];
  readonly budget: {
    readonly max_tokens: number;
    readonly max_cost_micro_usd: number;
    readonly ttl_seconds: number;
  };
  /** `name@version` of the prompt file in `src/prompts/`. */
  readonly prompt: string;
}

const SONNET = ANTHROPIC_DEFAULT_MODELS.sonnet;
const OPUS = ANTHROPIC_DEFAULT_MODELS.opus;
const READ: readonly AgentTool[] = ['Read', 'Grep', 'Glob'];
const RETRIEVE: readonly AgentTool[] = ['Read', 'Grep', 'Glob', 'KnowledgeSearch'];
const BUILD: readonly AgentTool[] = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
const UNBOUND =
  'The specs name this id and nothing else: no name, role or step. It has no step, so it is never run and never gets a key, until a spec gives it one.';

const planning = (max_tokens: number, usd: number, ttl_seconds: number) => ({
  max_tokens,
  max_cost_micro_usd: Math.round(usd * 1_000_000),
  ttl_seconds,
});

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    agent_id: 'A1',
    name: 'triage',
    role: 'triage',
    note: 'DM §3.5: A1 "may not have tools or retrieval". Acts at the D+A steps of S1 that are not the clarify round.',
    steps: ['1.2', '1.3', '1.4'],
    contract_version: '1.0.0',
    output_schema_id: 'triage.v1',
    artefacts: ['request'],
    tools: [],
    data_class_max: 'D1',
    models: [SONNET],
    budget: planning(20_000, 0.1, 1_800),
    prompt: 'a1_triage@1.0.0',
  },
  {
    agent_id: 'A2',
    name: 'intent',
    role: 'intent',
    note: 'Profiles A2.clarify (1.5) and A2.specify (3.1, 3.2) of DM §3.5.',
    steps: ['1.5', '3.1', '3.2'],
    contract_version: '1.0.0',
    output_schema_id: 'intent.v1',
    artefacts: ['request', 'intent_block', 'context_brief', 'spec_delta', 'repo_snapshot'],
    tools: RETRIEVE,
    data_class_max: 'D2',
    models: [SONNET],
    budget: planning(60_000, 0.5, 3_600),
    prompt: 'a2_intent@1.0.0',
  },
  {
    agent_id: 'A3',
    name: 'planner',
    role: 'plan',
    note: 'Profiles A3.shape (2.1-2.4), A3.design (4.1-4.4) and A3.plan (5.1-5.4, 5.6) of DM §3.5. 9.4 Learn is a planner proposal kind ("learn", DM Proposal.kind); the specs name no agent for it.',
    steps: [
      '2.1',
      '2.2',
      '2.3',
      '2.4',
      '4.1',
      '4.2',
      '4.3',
      '4.4',
      '4.5',
      '5.1',
      '5.2',
      '5.3',
      '5.4',
      '5.6',
      '9.4',
    ],
    contract_version: '1.0.0',
    output_schema_id: 'planner.v1',
    artefacts: [
      'request',
      'intent_block',
      'context_brief',
      'decision_brief',
      'spec_delta',
      'oracle_specs',
      'design',
      'plan',
      'repo_snapshot',
      'config_history',
    ],
    tools: RETRIEVE,
    data_class_max: 'D2',
    models: [OPUS, SONNET],
    budget: planning(150_000, 1.5, 7_200),
    prompt: 'a3_planner@1.0.0',
  },
  {
    agent_id: 'A4',
    name: 'coding',
    role: 'code',
    note: 'DM §8 gap 17: `AGENT_NAMES` calls A4 "coding" and lists `coder` beside it; the specs do not say how they differ. Both are bound to the S6 agent steps with one contract; `coder` is the one the work driver runs (STEP_PRIMARY_AGENT).',
    steps: ['6.4', '6.6'],
    contract_version: '1.0.0',
    output_schema_id: 'implementation.v1',
    artefacts: ['plan', 'spec_delta', 'oracle_specs', 'design', 'repo_snapshot', 'diff'],
    tools: BUILD,
    data_class_max: 'D2',
    models: [SONNET],
    budget: planning(2_000_000, 25, 21_600),
    prompt: 'a4_coding@1.0.0',
  },
  {
    agent_id: 'A5',
    name: 'review',
    role: 'review',
    note: 'DM §3.5 names A5 "review". Bound to the review steps of the flow: 3.5 clean-context review, 4.5 and 7.5 constitution checks, 7.3 spec conformance (the specs do not assign an agent to them).',
    steps: ['3.5', '4.5', '7.3', '7.5'],
    contract_version: '1.0.0',
    output_schema_id: 'review.v1',
    artefacts: [
      'spec_delta',
      'oracle_specs',
      'design',
      'plan',
      'diff',
      'evidence_pack',
      'repo_snapshot',
    ],
    tools: READ,
    data_class_max: 'D2',
    models: [SONNET],
    budget: planning(80_000, 0.5, 3_600),
    prompt: 'a5_review@1.0.0',
  },
  {
    agent_id: 'A6',
    name: 'test',
    role: 'test',
    note: 'DM §3.5 names A6 "test". Bound to 3.4 Oracle specs, the one agent step about tests (6.3 and 7.2 are deterministic).',
    steps: ['3.4'],
    contract_version: '1.0.0',
    output_schema_id: 'oracle.v1',
    artefacts: ['spec_delta', 'repo_snapshot'],
    tools: READ,
    data_class_max: 'D2',
    models: [SONNET],
    budget: planning(80_000, 0.5, 3_600),
    prompt: 'a6_test@1.0.0',
  },
  {
    agent_id: 'A7',
    name: null,
    role: null,
    note: UNBOUND,
    steps: [],
    contract_version: '1.0.0',
    output_schema_id: 'unspecified.v1',
    artefacts: [],
    tools: [],
    data_class_max: 'D0',
    models: [SONNET],
    budget: planning(1_000, 0.001, 60),
    prompt: 'unspecified@1.0.0',
  },
  {
    agent_id: 'A8',
    name: null,
    role: null,
    note: UNBOUND,
    steps: [],
    contract_version: '1.0.0',
    output_schema_id: 'unspecified.v1',
    artefacts: [],
    tools: [],
    data_class_max: 'D0',
    models: [SONNET],
    budget: planning(1_000, 0.001, 60),
    prompt: 'unspecified@1.0.0',
  },
  {
    agent_id: 'A9',
    name: 'reverse engineering',
    role: 're',
    note: 'OB 0.1-0.3 ("RE shallow", "A9 raise-only proposals", "A9/A12 extraction") and FL 2.1b "Focused reverse-engineering". OB DEC-15(d): a static cartographer stands in for A9 at Light until A9 is real.',
    steps: ['0.1', '0.2', '0.3', '2.1b'],
    contract_version: '1.0.0',
    output_schema_id: 'reverse_engineering.v1',
    artefacts: ['repo_snapshot', 'context_brief'],
    tools: RETRIEVE,
    data_class_max: 'D2',
    models: [SONNET],
    budget: planning(200_000, 2, 7_200),
    prompt: 'a9_reverse_engineering@1.0.0',
  },
  {
    agent_id: 'A10',
    name: null,
    role: null,
    note: UNBOUND,
    steps: [],
    contract_version: '1.0.0',
    output_schema_id: 'unspecified.v1',
    artefacts: [],
    tools: [],
    data_class_max: 'D0',
    models: [SONNET],
    budget: planning(1_000, 0.001, 60),
    prompt: 'unspecified@1.0.0',
  },
  {
    agent_id: 'A11',
    name: 'handoff pack',
    role: 'handoff',
    note: 'FL D1 "A11 Handoff Pack". D1 comes from 6.4; D2 from S7, whose agent steps are 7.3 and 7.5 (7.6 is deterministic). D3 comes from G4, a human step, so it has no agent binding.',
    steps: ['6.4', '7.3', '7.5'],
    contract_version: '1.0.0',
    output_schema_id: 'handoff_pack.v1',
    artefacts: ['session_log', 'plan', 'diff', 'evidence_pack'],
    tools: ['Read'],
    data_class_max: 'D2',
    models: [SONNET],
    budget: planning(40_000, 0.3, 1_800),
    prompt: 'a11_handoff_pack@1.0.0',
  },
  {
    agent_id: 'A12',
    name: 'extraction',
    role: 'extraction',
    note: 'OB 0.3 says "A9/A12 extraction" (living-spec seeds, golden-task candidates) and defines A12 nowhere else.',
    steps: ['0.3'],
    contract_version: '1.0.0',
    output_schema_id: 'extraction.v1',
    artefacts: ['repo_snapshot', 'context_brief'],
    tools: READ,
    data_class_max: 'D2',
    models: [SONNET],
    budget: planning(150_000, 1.5, 7_200),
    prompt: 'a12_extraction@1.0.0',
  },
  {
    agent_id: 'coder',
    name: 'coder',
    role: 'code',
    note: 'DM §3.5 `agent_id` list "A1 A2 A3 A4 coder": the S6 implementer (6.4 task loop, 6.6 draft PR via the push broker).',
    steps: ['6.4', '6.6'],
    contract_version: '1.0.0',
    output_schema_id: 'implementation.v1',
    artefacts: ['plan', 'spec_delta', 'oracle_specs', 'design', 'repo_snapshot', 'diff'],
    tools: BUILD,
    data_class_max: 'D2',
    models: [SONNET],
    budget: planning(2_000_000, 25, 21_600),
    prompt: 'coder@1.0.0',
  },
];

/**
 * The ONE agent the work driver runs at each agent-acted step (the others bound to a step are the
 * specialists a step may call on: A11 at a handoff). Every step whose actor is A, D+A or A+H appears
 * here exactly once (a test checks), and the agent must list the step.
 */
export const STEP_PRIMARY_AGENT: Readonly<Partial<Record<StepId, AgentId>>> = {
  '0.1': 'A9',
  '0.2': 'A9',
  '0.3': 'A9',
  '1.2': 'A1',
  '1.3': 'A1',
  '1.4': 'A1',
  '1.5': 'A2',
  '2.1': 'A3',
  '2.1b': 'A9',
  '2.2': 'A3',
  '2.3': 'A3',
  '2.4': 'A3',
  '3.1': 'A2',
  '3.2': 'A2',
  '3.4': 'A6',
  '3.5': 'A5',
  '4.1': 'A3',
  '4.2': 'A3',
  '4.3': 'A3',
  '4.4': 'A3',
  '4.5': 'A5',
  '5.1': 'A3',
  '5.2': 'A3',
  '5.3': 'A3',
  '5.4': 'A3',
  '5.6': 'A3',
  '6.4': 'coder',
  '6.6': 'coder',
  '7.3': 'A5',
  '7.5': 'A5',
  '9.4': 'A3',
};
