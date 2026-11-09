import {
  AgentDefinition,
  AgentInputBase,
  AgentIdValues,
  STEPS,
  isAgentStep,
  type AgentId,
  type StepId,
} from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import { z } from 'zod';
import { OUTPUT_SCHEMAS } from './outputs.js';
import lock from './prompts/prompts.lock.json' with { type: 'json' };
import { AGENT_SPECS, STEP_PRIMARY_AGENT, type AgentSpec } from './spec-data.js';

// The registry (PLAN M11.1): every agent as a validated AgentDefinition, the lookups the work driver
// needs (which agent acts at a step) and `validateOutput`. Built once, at import; a definition that
// breaks a rule throws here, so a bad edit fails every test and every start, never a run.

/** `prompts.lock.json`: sha256 per prompt file and the contract version it belongs to. */
export interface PromptsLock {
  readonly format: string;
  readonly prompts: Readonly<
    Record<
      string,
      { readonly file: string; readonly sha256: string; readonly contract_version: string }
    >
  >;
}
export const PROMPTS_LOCK: PromptsLock = lock;

const jsonSchema = (s: z.ZodType): Record<string, unknown> => {
  const doc: Record<string, unknown> = {
    ...z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input' }),
  };
  delete doc['$schema'];
  return doc;
};

/** The input schema of an agent: the common shape, with `artefacts` limited to the agent's whitelist. */
export function inputSchemaOf(spec: Pick<AgentSpec, 'artefacts'>): z.ZodType {
  const [first, ...rest] = spec.artefacts;
  const artefact =
    first === undefined
      ? z.never()
      : z.strictObject({
          type: z.enum([first, ...rest]),
          ref: z.string().min(1).max(256),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        });
  return z.strictObject({ ...AgentInputBase.shape, artefacts: z.array(artefact).max(64) });
}

function build(spec: AgentSpec): AgentDefinition {
  const locked = PROMPTS_LOCK.prompts[spec.prompt];
  if (!locked)
    throw new Error(`${spec.agent_id}: prompt ${spec.prompt} is not in prompts.lock.json`);
  const outputSchema = OUTPUT_SCHEMAS[spec.output_schema_id];
  const parsed = AgentDefinition.safeParse({
    agent_id: spec.agent_id,
    name: spec.name,
    role: spec.role,
    note: spec.note,
    steps: [...spec.steps],
    specialist_steps: [...(spec.specialist_steps ?? [])],
    contract: {
      contract_version: spec.contract_version,
      input_schema_id: `${spec.agent_id.toLowerCase()}_input.v1`,
      input_schema: jsonSchema(inputSchemaOf(spec)),
      output_schema_id: spec.output_schema_id,
      output_schema: jsonSchema(outputSchema),
      tools: [...spec.tools],
      data_class_max: spec.data_class_max,
      models: [...spec.models],
      budget: { ...spec.budget },
    },
    prompt: { ref: spec.prompt, sha256: locked.sha256 },
  });
  if (!parsed.success) throw new Error(`${spec.agent_id}: ${parsed.error.message}`);
  const d = parsed.data;
  // DM §3.5: "A1 may not have tools or retrieval".
  if (d.agent_id === 'A1' && d.contract.tools.length > 0) {
    throw new Error('A1 may not have tools or retrieval (DM §3.5)');
  }
  return d;
}

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = AGENT_SPECS.map(build);

const byId = new Map<AgentId, AgentDefinition>(AGENT_DEFINITIONS.map((d) => [d.agent_id, d]));
if (byId.size !== AGENT_DEFINITIONS.length) throw new Error('duplicate agent id');
for (const id of AgentIdValues) if (!byId.has(id)) throw new Error(`agent ${id} has no definition`);

// Every agent-acted step has exactly one primary agent, and that agent lists the step.
for (const step of Object.keys(STEPS) as StepId[]) {
  const primary = STEP_PRIMARY_AGENT[step];
  if (isAgentStep(step) !== (primary !== undefined)) {
    throw new Error(`step ${step}: a primary agent is set exactly for agent-acted steps`);
  }
  if (primary !== undefined && !byId.get(primary)?.steps.includes(step)) {
    throw new Error(`step ${step}: primary agent ${primary} does not list the step`);
  }
}

export function agentDefinition(id: AgentId): AgentDefinition {
  return byId.get(id) as AgentDefinition;
}

/**
 * The agent a DETERMINISTIC step calls in (M13.6: A6 at 6.3), or `null`. The work driver binds it and mints its key
 * when `primaryAgentFor` has none; the step stays a D step.
 */
export function specialistAgentFor(step: StepId): AgentDefinition | null {
  return AGENT_DEFINITIONS.find((d) => d.specialist_steps.includes(step)) ?? null;
}

/** Every agent that may act at `step`, in registry order. */
export function agentsForStep(step: StepId): AgentDefinition[] {
  return AGENT_DEFINITIONS.filter((d) => d.steps.includes(step));
}

/** The agent the work driver runs at `step`; `null` for a step no agent acts at (D, H, D+H). */
export function primaryAgentFor(step: StepId): AgentDefinition | null {
  const id = STEP_PRIMARY_AGENT[step];
  return id === undefined ? null : agentDefinition(id);
}

// ---------------------------------------------------------------- validateOutput

export interface OutputFieldError {
  /** `claims[0].evidence`, or `$` for the output as a whole. */
  readonly path: string;
  /** zod's issue code (`unrecognized_keys`, `invalid_type`, `too_small`, ...). */
  readonly code: string;
  readonly message: string;
}

export const OutputInvalid = taggedError('OutputInvalid');
export type OutputInvalid = TaggedError<
  'OutputInvalid',
  { readonly agent_id: AgentId; readonly errors: readonly OutputFieldError[] }
>;

const pathOf = (p: ReadonlyArray<PropertyKey>): string =>
  p.length === 0
    ? '$'
    : p.reduce<string>(
        (a, k) =>
          typeof k === 'number' ? `${a}[${k}]` : a === '' ? String(k) : `${a}.${String(k)}`,
        '',
      );

/** Flattens a zod error to one entry per field (an unrecognised key is one entry per key). */
function fieldErrors(e: z.ZodError): OutputFieldError[] {
  const out: OutputFieldError[] = [];
  const walk = (issues: readonly z.core.$ZodIssue[], base: ReadonlyArray<PropertyKey>) => {
    for (const i of issues) {
      const at = [...base, ...i.path];
      if (i.code === 'unrecognized_keys') {
        for (const k of i.keys) {
          out.push({ path: pathOf([...at, k]), code: i.code, message: `unknown field \`${k}\`` });
        }
      } else if (
        i.code === 'invalid_union' &&
        i.errors.length > 0 &&
        i.errors.every((x) => x.length > 0)
      ) {
        // the branch with the fewest problems says what is wrong
        const best = [...i.errors].sort((a, b) => a.length - b.length)[0] as z.core.$ZodIssue[];
        walk(best, at);
      } else {
        out.push({ path: pathOf(at), code: i.code, message: i.message });
      }
    }
  };
  walk(e.issues, []);
  return out;
}

/**
 * Checks an agent's output against its OutputSchema. Pure. An output that does not validate is a
 * refusal with a field-level error for each problem; nothing is repaired or defaulted. An unknown
 * agent is an error too (fail closed).
 */
export function validateOutput(agentId: string, output: unknown): Result<unknown, OutputInvalid> {
  const id = AgentIdValues.find((a) => a === agentId);
  if (id === undefined) {
    return err(
      OutputInvalid({
        agent_id: agentId as AgentId,
        errors: [{ path: '$', code: 'unknown_agent', message: `no agent ${agentId}` }],
      }),
    );
  }
  const schema =
    OUTPUT_SCHEMAS[agentDefinition(id).contract.output_schema_id as keyof typeof OUTPUT_SCHEMAS];
  const r = schema.safeParse(output);
  return r.success
    ? ok(r.data)
    : err(OutputInvalid({ agent_id: id, errors: fieldErrors(r.error) }));
}

/** The Zod input schema of an agent (the work driver builds a request with it; the JSON form is in the contract). */
export function inputSchemaFor(id: AgentId): z.ZodType {
  const spec = AGENT_SPECS.find((s) => s.agent_id === id) as AgentSpec;
  return inputSchemaOf(spec);
}
