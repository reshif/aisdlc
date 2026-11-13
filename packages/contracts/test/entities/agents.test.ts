import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT,
  AgentBinding,
  AgentContract,
  AgentDefinition,
  AgentId,
  AgentIdValues,
  AgentJudgement,
  AgentRunDispatchedPayload,
  AgentStats,
  StepIdValues,
  StageRequest,
  agentStream,
  isAgentStep,
} from '../../src/index.js';

const SHA = 'a'.repeat(64);
const contract = {
  contract_version: '1.0.0',
  input_schema_id: 'a1_input.v1',
  input_schema: { type: 'object' },
  output_schema_id: 'triage.v1',
  output_schema: { type: 'object' },
  tools: [],
  data_class_max: 'D1',
  models: ['claude-sonnet-5-5'],
  budget: { max_tokens: 1000, max_cost_micro_usd: 1000, ttl_seconds: 600 },
};
const def = {
  agent_id: 'A1',
  name: 'triage',
  role: 'triage',
  note: null,
  steps: ['1.3'],
  contract,
  prompt: { ref: 'a1_triage@1.0.0', sha256: SHA },
};

describe('agents vocabulary (PLAN M11.1, M11.2)', () => {
  it('names the 13 agents of the specs once, and the M18 assistant', () => {
    expect(AgentIdValues).toEqual(
      [...Array(12).keys()]
        .map((i) => `A${i + 1}`)
        .concat(['coder', 'assistant', 'onboarding', 'onboarder']),
    );
    expect(AgentId.safeParse('A13').success).toBe(false);
  });

  it('an AgentDefinition binds only steps whose actor is an agent; the helper agrees with the flow', () => {
    expect(AgentDefinition.safeParse(def).success).toBe(true);
    expect(AgentDefinition.safeParse({ ...def, steps: ['1.1'] }).success).toBe(false); // D
    expect(AgentDefinition.safeParse({ ...def, steps: ['1.6'] }).success).toBe(false); // H
    expect(AgentDefinition.safeParse({ ...def, steps: ['0.4'] }).success).toBe(false); // D+H
    expect(AgentDefinition.safeParse({ ...def, steps: ['0.2', '1.2', '1.5'] }).success).toBe(true); // A+H, D+A
    expect(StepIdValues.filter(isAgentStep)).toContain('6.4');
    expect(StepIdValues.filter(isAgentStep)).not.toContain('6.5');
  });

  it('a contract is strict, never has D3, and refuses a tool the gateway would not know', () => {
    expect(AgentContract.safeParse(contract).success).toBe(true);
    expect(AgentContract.safeParse({ ...contract, data_class_max: 'D3' }).success).toBe(false);
    expect(AgentContract.safeParse({ ...contract, tools: ['Telnet'] }).success).toBe(false);
    expect(AgentContract.safeParse({ ...contract, extra: 1 }).success).toBe(false);
    expect(AgentContract.safeParse({ ...contract, contract_version: '1.0' }).success).toBe(false);
  });

  it('a stage request may carry the agent binding, and it has no field for the key secret', () => {
    const binding = {
      run_id: 'r1',
      agent_id: 'coder',
      contract_version: '1.0.0',
      prompt_ref: 'coder@1.0.0',
      prompt_sha256: SHA,
      vkey_id: 'vk',
      tools: ['Read'],
      data_class_max: 'D2',
    };
    expect(AgentBinding.safeParse(binding).success).toBe(true);
    expect(AgentBinding.safeParse({ ...binding, secret: 'aisk_x' }).success).toBe(false);
    expect(Object.keys(StageRequest.shape)).toContain('agent');
  });

  it('events live on `agent:<item>`, and a dispatch carries a binding, a budget and a scope', () => {
    expect(agentStream('abc')).toBe('agent:abc');
    expect(Object.values(AGENT_EVENT)).toEqual(['agent.run_dispatched', 'agent.run_failed']);
    const ok = {
      run_id: '0190a000-0000-7000-8000-000000000001',
      item_id: '0190a000-0000-7000-8000-000000000002',
      project_id: 'p',
      command_key: 'k',
      step: '6.4',
      attempt: 1,
      lane: 'L3',
      binding: {
        run_id: '0190a000-0000-7000-8000-000000000001',
        agent_id: 'coder',
        contract_version: '1.0.0',
        prompt_ref: 'coder@1.0.0',
        prompt_sha256: SHA,
        vkey_id: null,
        tools: [],
        data_class_max: 'D2',
      },
      budget: contract.budget,
      scope: null,
      unit_id: null,
    };
    expect(AgentRunDispatchedPayload.safeParse(ok).success).toBe(true);
    expect(AgentRunDispatchedPayload.safeParse({ ...ok, lane: 'L9' }).success).toBe(false);
  });

  it('a judgement is a gate decision, a back-edge or a trigger; rates may be null', () => {
    expect(AgentJudgement.safeParse({ kind: 'back_edge', edge: 'B3', seq: 4 }).success).toBe(true);
    expect(AgentJudgement.safeParse({ kind: 'trigger', trigger: 'ET1', seq: 4 }).success).toBe(
      true,
    );
    expect(AgentJudgement.safeParse({ kind: 'back_edge', edge: 'B99', seq: 4 }).success).toBe(
      false,
    );
    expect(
      AgentStats.safeParse({
        agent_id: 'A1',
        project_id: null,
        runs: 0,
        finished: 0,
        failed: 0,
        judged: 0,
        accepted: 0,
        rejected: 0,
        sent_back: 0,
        reworked: 0,
        handed_off: 0,
        with_back_edge: 0,
        acceptance_rate: null,
        back_edge_rate: null,
        calls: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_micro_usd: 0,
        cost_per_run_micro_usd: null,
      }).success,
    ).toBe(true);
  });
});
