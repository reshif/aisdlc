import { AGENT_EVENT, ITEM_EVENT, type RecordEvent } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { agentStats, foldAgentRuns, refusalEdge, type CallFact } from '../src/index.js';

const ITEM = '0190a000-0000-7000-8000-000000000001';
const SHA = 'b'.repeat(64);
let g = 0;
const at = () => new Date(Date.UTC(2026, 10, 9, 10, 0, g)).toISOString();
/** An event as the fold sees it (only type, payload, stream, global and stream seq matter). */
const ev = (stream: string, type: string, payload: object): RecordEvent =>
  ({
    event_id: `e${++g}`,
    stream_id: stream,
    stream_seq: g,
    global_seq: g,
    type,
    payload,
    actor: 'test',
    occurred_at: at(),
    idempotency_key: null,
    prev_hash: SHA,
    hash: SHA,
  }) as unknown as RecordEvent;

const binding = (agent_id: string, vkey_id: string | null) => ({
  run_id: '',
  agent_id,
  contract_version: '1.0.0',
  prompt_ref: 'x@1.0.0',
  prompt_sha256: SHA,
  vkey_id,
  tools: [],
  data_class_max: 'D2',
});
const base = (key: string, step: string, agent: string, vkey: string | null = null) => ({
  run_id: `0190a000-0000-7000-8000-${key.padStart(12, '0')}`,
  item_id: ITEM,
  project_id: 'p',
  command_key: `k${key}`,
  step,
  attempt: 1,
  lane: 'L4',
  binding: { ...binding(agent, vkey), run_id: `r${key}` },
});
const dispatch = (key: string, step: string, agent: string, vkey: string | null = null) =>
  ev(`agent:${ITEM}`, AGENT_EVENT.run_dispatched, {
    ...base(key, step, agent, vkey),
    budget: { max_tokens: 1, max_cost_micro_usd: 1, ttl_seconds: 60 },
    scope: null,
    unit_id: null,
  });
const done = (key: string, step: string, extra: object = {}) =>
  ev(`item:${ITEM}`, ITEM_EVENT.stage_completed, {
    command_key: `k${key}`,
    step,
    output_hash: SHA,
    ...extra,
  });
const opened = (id: string) =>
  ev(`item:${ITEM}`, ITEM_EVENT.gates_opened, {
    command_key: 'open',
    gates: [{ gate: 'G2', gate_instance_id: id }],
    card_ids: [],
    subject_hash: SHA,
  });
const decided = (id: string, gate: string, outcome: string) =>
  ev(`item:${ITEM}`, ITEM_EVENT.gate_decided, {
    gate_instance_id: id,
    gate,
    outcome,
    ledger_entry_id: outcome === 'approve' ? 'led-1' : null,
  });
const call = (vkey: string, n: number, over: Partial<CallFact> = {}): CallFact => ({
  call_id: `c${n}`,
  vkey_id: vkey,
  tokens_in: 10,
  tokens_out: 5,
  cost_micro_usd: 100,
  provider_id: 'fake',
  model_id: 'fake-model',
  outcome: 'ok',
  global_seq: 1000 + n,
  ...over,
});

describe('foldAgentRuns', () => {
  it('a run is dispatched, answered, and judged by the gate decision on its output', () => {
    g = 0;
    const runs = foldAgentRuns(
      [
        dispatch('1', '3.2', 'A2', 'vk1'),
        done('1', '3.2'),
        opened('gi-1'),
        decided('gi-1', 'G2', 'approve'),
      ],
      [
        call('vk1', 1),
        call('vk1', 2),
        call('vk1', 3, {
          outcome: 'refused',
          tokens_in: 0,
          tokens_out: 0,
          cost_micro_usd: 0,
          provider_id: null,
        }),
      ],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      agent_id: 'A2',
      step: '3.2',
      state: 'finished',
      result: 'completed',
      vkey_id: 'vk1',
      calls: 2,
      tokens_in: 20,
      tokens_out: 10,
      cost_micro_usd: 200,
      provider: 'fake',
      model: 'fake-model',
    });
    expect(runs[0]?.outcome).toMatchObject({
      verdict: 'accepted',
      back_edges: [],
      judgements: [
        { kind: 'gate', gate: 'G2', outcome: 'approve', ledger_entry_id: 'led-1', edge: null },
      ],
    });
  });

  it('a refusal is a verdict and names the back-edge the interpreter took; expiry judges nothing', () => {
    g = 0;
    const runs = foldAgentRuns([
      dispatch('1', '3.2', 'A2'),
      done('1', '3.2'),
      opened('gi-1'),
      decided('gi-1', 'G2', 'expired'),
      opened('gi-2'),
      decided('gi-2', 'G2', 'request_changes'),
    ]);
    expect(runs[0]?.outcome.judgements).toHaveLength(1);
    expect(runs[0]?.outcome).toMatchObject({ verdict: 'sent_back', back_edges: ['B23'] });
    expect(refusalEdge('G3', 'reject')).toBe('B5');
    expect(refusalEdge('G4', 'request_changes')).toBe('B13');
    expect(refusalEdge('G2', 'approve')).toBeNull();
  });

  it('a back-edge is attributed to the run that produced the artefact, not the one that raised it', () => {
    g = 0;
    const runs = foldAgentRuns([
      dispatch('1', '3.2', 'A2'),
      done('1', '3.2'),
      // 3.3 (deterministic) finds the spec invalid: B3 returns to 3.2
      ev(`item:${ITEM}`, ITEM_EVENT.rework_requested, {
        edge: 'B3',
        step: '3.3',
        command_key: 'k-validate',
        reason_code: 'schema',
      }),
      { ...dispatch('2', '3.2', 'A2') },
      done('2', '3.2'),
      opened('gi-1'),
      decided('gi-1', 'G2', 'approve'),
    ]);
    expect(runs.map((r) => r.outcome.verdict)).toEqual(['reworked', 'accepted']);
    expect(runs[0]?.outcome.back_edges).toEqual(['B3']);
    expect(runs[1]?.outcome.back_edges).toEqual([]);
  });

  it('a trigger without a command (ET1 from the gateway) lands on the latest run at its step', () => {
    g = 0;
    const runs = foldAgentRuns([
      dispatch('1', '6.4', 'coder', 'vk1'),
      ev(`item:${ITEM}`, ITEM_EVENT.trigger_fired, {
        trigger: 'ET1',
        step: '6.4',
        reason_code: 'gateway.budget_tokens',
      }),
    ]);
    expect(runs[0]).toMatchObject({ state: 'dispatched' });
    expect(runs[0]?.outcome).toMatchObject({ verdict: 'handed_off', triggers: ['ET1'] });
  });

  it('a gate the run raised judges that run (X3 approved)', () => {
    g = 0;
    const runs = foldAgentRuns([
      dispatch('1', '6.4', 'coder'),
      ev(`item:${ITEM}`, ITEM_EVENT.stage_gate_needed, {
        command_key: 'k1',
        step: '6.4',
        gate: 'X3',
        reason_code: 'new_dependency',
      }),
      ev(`item:${ITEM}`, ITEM_EVENT.gates_opened, {
        command_key: 'o',
        gates: [{ gate: 'X3', gate_instance_id: 'gi-x' }],
        card_ids: [],
        subject_hash: SHA,
      }),
      decided('gi-x', 'X3', 'reject'),
    ]);
    expect(runs[0]).toMatchObject({ result: 'gate_needed', state: 'finished' });
    expect(runs[0]?.outcome.verdict).toBe('rejected');
  });

  it('a failure with no dispatch still makes the run; a stage answer beats an earlier failure', () => {
    g = 0;
    const failed = ev(`agent:${ITEM}`, AGENT_EVENT.run_failed, {
      ...base('1', '6.4', 'coder'),
      code: 'key_mint_refused',
      detail: 'gateway down',
    });
    expect(foldAgentRuns([failed])[0]).toMatchObject({
      state: 'failed',
      failure_code: 'key_mint_refused',
      vkey_id: null,
    });
    g = 0;
    const retry = foldAgentRuns([
      ev(`agent:${ITEM}`, AGENT_EVENT.run_failed, {
        ...base('1', '6.4', 'coder'),
        code: 'port_error',
        detail: 'x',
      }),
      done('1', '6.4'),
    ]);
    expect(retry[0]).toMatchObject({ state: 'finished', result: 'completed', failure_code: null });
  });

  it('is independent of the order the events are handed in', () => {
    g = 0;
    const all = [
      dispatch('1', '3.2', 'A2'),
      done('1', '3.2'),
      opened('gi-1'),
      decided('gi-1', 'G2', 'approve'),
    ];
    expect(foldAgentRuns([...all].reverse())).toEqual(foldAgentRuns(all));
  });
});

describe('agentStats', () => {
  it('acceptance rate, back-edge rate and cost per run; null while there is nothing to divide by', () => {
    g = 0;
    const runs = foldAgentRuns(
      [
        dispatch('1', '3.2', 'A2', 'vk1'),
        done('1', '3.2'),
        ev(`item:${ITEM}`, ITEM_EVENT.rework_requested, {
          edge: 'B3',
          step: '3.3',
          command_key: 'kv',
          reason_code: 's',
        }),
        dispatch('2', '3.2', 'A2', 'vk2'),
        done('2', '3.2'),
        opened('gi-1'),
        decided('gi-1', 'G2', 'approve'),
      ],
      [call('vk1', 1), call('vk2', 2, { cost_micro_usd: 300 })],
    );
    const s = agentStats('A2', runs);
    expect(s).toMatchObject({
      runs: 2,
      finished: 2,
      judged: 2,
      accepted: 1,
      reworked: 1,
      with_back_edge: 1,
    });
    expect(s.acceptance_rate).toBe(0.5);
    expect(s.back_edge_rate).toBe(0.5);
    expect(s.cost_per_run_micro_usd).toBe(200);
    const none = agentStats('A5', runs);
    expect(none).toMatchObject({
      runs: 0,
      acceptance_rate: null,
      back_edge_rate: null,
      cost_per_run_micro_usd: null,
    });
  });
});
