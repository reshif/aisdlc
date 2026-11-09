import type { AgentRunOutcome, EvalRunRecord } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  choose,
  foldAgentScores,
  passPowK,
  runPassK,
  runPassRate,
  scoreSignals,
  summaryRows,
  taskStatus,
  type RunWithOutcome,
} from '../src/index.js';

const SHA = 'a'.repeat(64);
const D = 'c'.repeat(64);
let n = 0;
const run = (
  passing: number[],
  o: Partial<
    Pick<EvalRunRecord, 'suite_id' | 'provider' | 'model' | 'prompt_sha256' | 'agent_id'>
  > & { k?: number; at?: string } = {},
): EvalRunRecord => {
  n += 1;
  const k = o.k ?? 3;
  const at = o.at ?? `2026-11-09T10:0${n}:00.000Z`;
  return {
    eval_run_id:
      `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}` as EvalRunRecord['eval_run_id'],
    suite_id: o.suite_id ?? 's',
    project_tag: null,
    agent_id: o.agent_id ?? 'A1',
    profile: 'A1.classify',
    prompt_ref: 'a1_triage@1.0.0',
    prompt_sha256: o.prompt_sha256 ?? SHA,
    contract_version: '1.0.0',
    provider: o.provider ?? 'fake',
    model: o.model ?? 'm',
    harness_version: 'h',
    trigger: 'ci',
    git_sha: null,
    store_id: 'st',
    manifest_digest: D,
    k,
    cases: passing.map((p, i) => ({
      case_id: `c${i}`,
      kind: 'regression',
      security_tagged: false,
      trials: Array.from({ length: k }, (_, t) => ({
        trial: t + 1,
        passed: t < p,
        failure_code: t < p ? null : 'grader_failed',
        infra_error: false,
        tokens_in: 1,
        tokens_out: 1,
        cost_micro_usd: 10,
      })),
    })),
    cost_micro_usd: passing.length * k * 10,
    errored: 0,
    started_at: at,
    ended_at: at,
  } as EvalRunRecord;
};

const prod = (
  verdict: AgentRunOutcome['verdict'],
  o: { provider?: string | null; model?: string | null } = {},
): RunWithOutcome => {
  n += 1;
  const run_id = `0190a000-0000-7000-9000-${String(n).padStart(12, '0')}`;
  return {
    run_id,
    agent_id: 'A1',
    prompt_sha256: SHA,
    provider: o.provider === undefined ? 'fake' : o.provider,
    model: o.model === undefined ? 'm' : o.model,
    outcome: { run_id, verdict, judgements: [], back_edges: [], triggers: [] },
  } as unknown as RunWithOutcome;
};

describe('pass^k', () => {
  it('is the unbiased C(passes,k)/C(trials,k); with trials = k it is all-or-nothing; fewer trials than k is 0', () => {
    expect(choose(5, 2)).toBe(10);
    expect(passPowK(3, 3, 3)).toBe(1);
    expect(passPowK(2, 3, 3)).toBe(0);
    expect(passPowK(4, 5, 2)).toBeCloseTo(6 / 10, 12);
    expect(passPowK(2, 2, 3)).toBe(0);
    expect(taskStatus(3, 3)).toBe('pass');
    expect(taskStatus(0, 3)).toBe('fail');
    expect(taskStatus(1, 3)).toBe('flaky');
    expect(runPassRate(run([3, 0]))).toBe(0.5);
    expect(runPassK(run([3, 2]))).toBe(0.5);
  });
});

describe('summaryRows', () => {
  it('takes the newest run of each suite and provider; the rows have the allow-listed keys only', () => {
    const rows = summaryRows([
      run([0, 0], { at: '2026-11-09T09:00:00.000Z' }),
      run([3, 1]),
      run([3], { provider: 'o' }),
    ]);
    expect(rows.map((r) => [r.suite, r.provider, r.task_id, r.status])).toEqual([
      ['s', 'fake', 'c0', 'pass'],
      ['s', 'fake', 'c1', 'flaky'],
      ['s', 'o', 'c0', 'pass'],
    ]);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        [
          'k',
          'pass_k',
          'pass_rate',
          'passes',
          'profile',
          'provider',
          'status',
          'suite',
          'task_id',
          'trials',
        ].sort(),
      );
    }
  });
});

describe('AgentScore and ScoreSignal', () => {
  it('scores per (agent, prompt sha, provider, model) and joins production outcomes of the same key', () => {
    const runs = [run([3, 3]), run([3, 1], { model: 'm2' })];
    const production = [
      prod('accepted'),
      prod('accepted'),
      prod('sent_back'),
      prod('reworked'),
      prod('rejected'),
      prod('pending'),
      prod('accepted', { model: null }),
      prod('accepted', { model: 'm2' }),
    ];
    const scores = foldAgentScores(runs, production);
    const m = scores.find((s) => s.model === 'm');
    const m2 = scores.find((s) => s.model === 'm2');
    expect(scores).toHaveLength(2);
    expect(m).toMatchObject({
      status: 'pass',
      pass_rate: 1,
      production_runs: 6,
      production_judged: 5,
      accept_rate: 2 / 5,
      sent_back_rate: 2 / 5,
      rework_rate: 1 / 5,
    });
    expect(m2).toMatchObject({
      status: 'flaky',
      pass_rate: 4 / 6,
      accept_rate: 1,
      production_runs: 1,
    });
    expect(m?.cost_per_pass_micro_usd).toBe(10);
  });

  it('a key with production runs and no eval is unknown, with null eval rates; none at all is null, never 0', () => {
    const [s] = foldAgentScores([], [prod('pending')]);
    expect(s).toMatchObject({
      status: 'unknown',
      pass_rate: null,
      pass_k: null,
      eval_runs: 0,
      accept_rate: null,
    });
    expect(foldAgentScores([], [])).toEqual([]);
  });

  it('only the newest run of a suite counts toward the rates; all count toward eval_runs', () => {
    const [s] = foldAgentScores([run([0, 0], { at: '2026-11-09T08:00:00.000Z' }), run([3, 3])]);
    expect(s).toMatchObject({ eval_runs: 2, pass_rate: 1, status: 'pass' });
  });

  it('signals: every eval trial and every judged production run, under the score they belong to', () => {
    const runs = [run([1], { k: 2 })];
    const signals = scoreSignals(runs, [prod('accepted'), prod('pending')]);
    expect(signals.filter((x) => x.source === 'eval').map((x) => x.verdict)).toEqual([
      'pass',
      'fail',
    ]);
    expect(signals.filter((x) => x.source === 'production').map((x) => x.verdict)).toEqual([
      'accepted',
    ]);
    const ids = new Set(signals.map((x) => x.score_id));
    expect(ids.size).toBe(1);
    expect(foldAgentScores(runs, [prod('accepted')])[0]?.score_id).toBe([...ids][0]);
  });
});
