import {
  AgentDefinition,
  AgentIdValues,
  STEPS,
  StepIdValues,
  isAgentStep,
  type AgentId,
  type StepId,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  AGENT_DEFINITIONS,
  AGENT_SPECS,
  PROMPTS_LOCK,
  STEP_PRIMARY_AGENT,
  agentDefinition,
  agentsForStep,
  primaryAgentFor,
} from '../src/index.js';
import { sha256File } from '../src/prompt-files.js';

describe('the agent registry (PLAN M11.1)', () => {
  it('defines every agent id the specs name, once: A1 to A12 and coder, and the M18 assistant', () => {
    expect(AGENT_DEFINITIONS.map((d) => d.agent_id).sort()).toEqual([...AgentIdValues].sort());
    expect(AgentIdValues).toHaveLength(14);
    expect(AgentIdValues).toContain('coder');
    expect(AgentIdValues).toContain('assistant');
  });

  it('takes names and roles from the specs, and leaves null where the specs give only an id', () => {
    expect(agentDefinition('A1')).toMatchObject({ name: 'triage', role: 'triage' });
    expect(agentDefinition('A2').role).toBe('intent');
    expect(agentDefinition('A3').role).toBe('plan');
    expect(agentDefinition('A4').name).toBe('coding');
    expect(agentDefinition('A5').role).toBe('review');
    expect(agentDefinition('A6').role).toBe('test');
    expect(agentDefinition('A9').role).toBe('re');
    expect(agentDefinition('A11').name).toBe('handoff pack');
    for (const id of ['A7', 'A8', 'A10'] as const) {
      const d = agentDefinition(id);
      expect(d).toMatchObject({ name: null, role: null, steps: [] });
      expect(d.note).toMatch(/specs name this id and nothing else/);
    }
  });

  it('binds an agent only to a step whose actor is A, D+A or A+H', () => {
    for (const d of AGENT_DEFINITIONS) {
      for (const s of d.steps) expect(['A', 'D+A', 'A+H']).toContain(STEPS[s].actor);
    }
    // the contract itself refuses a binding to a deterministic or human step
    const base = agentDefinition('A2');
    for (const step of ['1.1', '1.6', '3.3', '6.5', '8.1', '0.5', '0.4'] as const) {
      expect(AgentDefinition.safeParse({ ...base, steps: [step] }).success).toBe(false);
    }
    expect(AgentDefinition.safeParse({ ...base, steps: ['3.2'] }).success).toBe(true);
    expect(AgentDefinition.safeParse({ ...base, steps: ['3.2', '3.2'] }).success).toBe(false);
  });

  it('gives every agent-acted step exactly one primary agent that lists it, and no other step one', () => {
    for (const step of StepIdValues) {
      const primary = primaryAgentFor(step);
      if (!isAgentStep(step)) {
        expect(primary, step).toBeNull();
        expect(agentsForStep(step), step).toEqual([]);
      } else {
        expect(primary, step).not.toBeNull();
        expect(primary?.steps).toContain(step);
        expect(agentsForStep(step).map((d) => d.agent_id)).toContain(primary?.agent_id);
      }
    }
    expect(Object.keys(STEP_PRIMARY_AGENT).length).toBe(StepIdValues.filter(isAgentStep).length);
    expect(primaryAgentFor('6.4')?.agent_id).toBe('coder');
    expect(primaryAgentFor('1.3')?.agent_id).toBe('A1');
    expect(primaryAgentFor('2.1b')?.agent_id).toBe('A9');
  });

  it('every contract carries versioned schemas, an allow-list, a data class below D3 and a budget', () => {
    for (const d of AGENT_DEFINITIONS) {
      const c = d.contract;
      expect(c.contract_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(JSON.stringify(c.output_schema)).toContain('"kind"');
      expect(JSON.stringify(c.input_schema)).toContain('artefacts');
      expect(c.data_class_max).not.toBe('D3');
      expect(new Set(c.tools).size).toBe(c.tools.length);
      expect(c.budget.max_tokens).toBeGreaterThan(0);
    }
  });

  it('A1 has no tools or retrieval (DM §3.5); only the coders (and A6, which writes the oracle test files at 6.3, in a sandbox) can write or run anything', () => {
    expect(agentDefinition('A1').contract.tools).toEqual([]);
    for (const d of AGENT_DEFINITIONS) {
      const writes = d.contract.tools.some((t) => ['Edit', 'Write', 'Bash'].includes(t));
      expect(writes, d.agent_id).toBe(['coder', 'A4', 'A6'].includes(d.agent_id));
      // A6 writes only at 6.3 (its specialist step, a W session); nothing else it does offers a write tool
      if (d.agent_id === 'A6') expect(d.contract.tools).not.toContain('Bash');
    }
  });

  it('the assistant acts at no step, retrieves read-only and carries D1 at most (portal-config §4)', () => {
    const a = agentDefinition('assistant');
    expect(a.steps).toEqual([]);
    expect(a.specialist_steps).toEqual([]);
    expect(a.contract.tools).toEqual(['KnowledgeSearch']);
    expect(a.contract.data_class_max).toBe('D1');
    expect(
      AGENT_DEFINITIONS.filter((d) => d.steps.length > 0).map((d) => d.agent_id),
    ).not.toContain('assistant');
  });

  it('an agent with no step (but the assistant) has no tools and the lowest data class: it can do nothing', () => {
    for (const d of AGENT_DEFINITIONS.filter(
      (x) => x.steps.length === 0 && x.agent_id !== 'assistant',
    )) {
      expect(d.contract.tools).toEqual([]);
      expect(d.contract.data_class_max).toBe('D0');
    }
  });

  it('names the prompt by reference and sha256, equal to the lock and to the file on disk', () => {
    for (const d of AGENT_DEFINITIONS) {
      const locked = PROMPTS_LOCK.prompts[d.prompt.ref];
      expect(locked?.sha256).toBe(d.prompt.sha256);
      expect(locked?.contract_version).toBe(d.contract.contract_version);
      expect(sha256File(d.prompt.ref)).toBe(d.prompt.sha256);
    }
  });

  it('the input schema of an agent lists exactly its artefact whitelist', () => {
    const items = (id: AgentId) => {
      const schema = agentDefinition(id).contract.input_schema as {
        properties: { artefacts: { items: { properties?: { type: { enum: string[] } } } } };
      };
      return schema.properties.artefacts.items.properties?.type.enum;
    };
    for (const s of AGENT_SPECS) {
      if (s.artefacts.length === 0) expect(items(s.agent_id)).toBeUndefined();
      else expect(items(s.agent_id)).toEqual([...s.artefacts]);
    }
  });

  it('is the same data on every build (definitions are pure)', () => {
    const again = JSON.stringify(AGENT_DEFINITIONS);
    expect(JSON.stringify(AGENT_DEFINITIONS)).toBe(again);
    const steps: StepId[] = AGENT_DEFINITIONS.flatMap((d) => d.steps);
    expect(steps.length).toBeGreaterThan(30);
  });
});
