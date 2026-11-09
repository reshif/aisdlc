import { runPassK, runPassRate } from '@aisdlc/agents';
import type { EvalRunRecord } from '@aisdlc/contracts';
import { EvalRunRecord as RunSchema } from '@aisdlc/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { baselineFor, baselineFrom, compareRuns, gateRun } from '../src/compare.js';
import { FakeAgentRunner, type AgentRunnerFailure } from '../src/runner-port.js';
import { runSuite } from '../src/runner.js';
import { MemoryEvalSink } from '../src/sink.js';
import { loadSuite } from '../src/suite.js';
import { badAnswer, buildStore, cleanup, clock, goodAnswer } from './helpers.js';

afterAll(cleanup);

async function runWith(
  answer: ConstructorParameters<typeof FakeAgentRunner>[0],
  o: { k?: number; holdout?: boolean } = {},
): Promise<{ run: EvalRunRecord; runner: FakeAgentRunner }> {
  const s = await buildStore({ holdout: o.holdout ?? false });
  const st = await s.open();
  if (!st.ok) throw new Error(st.error.message);
  const suite = loadSuite(st.value, 'triage', { includeHoldout: o.holdout ?? false });
  if (!suite.ok) throw new Error(suite.error.message);
  const runner = new FakeAgentRunner(answer);
  const run = await runSuite({
    suite: suite.value.suite,
    cases: suite.value.cases,
    graderOf: suite.value.graderOf,
    runner,
    k: o.k ?? 3,
    store_id: st.value.store_id,
    manifest_digest: st.value.manifest_digest,
    clock: clock(),
  });
  return { run, runner };
}

describe('run_suite', () => {
  it('runs every case k times and grades with validateOutput and the case grader', async () => {
    const { run, runner } = await runWith((r) => goodAnswer(r), { k: 3 });
    expect(RunSchema.safeParse(run).success).toBe(true);
    expect(run.cases).toHaveLength(5);
    expect(run.cases.every((c) => c.trials.length === 3 && c.trials.every((t) => t.passed))).toBe(
      true,
    );
    expect(runner.requests).toHaveLength(15);
    expect(runPassRate(run)).toBe(1);
    expect(runPassK(run)).toBe(1);
    expect(run).toMatchObject({
      agent_id: 'A1',
      provider: 'fake',
      model: 'fake-model',
      k: 3,
      errored: 0,
      suite_id: 'triage',
      project_tag: null,
    });
    expect(run.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.prompt_ref).toBe('a1_triage@1.0.0');
    expect(run.contract_version).toBe('1.0.0');
  });

  it('classifies each way a trial can fail, and counts infrastructure errors as failed AND errored', async () => {
    let n = 0;
    const kinds: Array<string | AgentRunnerFailure> = [
      'not json at all',
      JSON.stringify({
        kind: 'classification',
        candidate: 'L3',
        lane: 'L0',
        confidence: 0.8,
        rationale: 'x',
      }),
      JSON.stringify({ kind: 'classification', candidate: 'L9', confidence: 0.8, rationale: 'x' }),
      { code: 'infra_error', message: 'down' },
      { code: 'refused', message: 'budget' },
    ];
    const { run } = await runWith(() => kinds[n++ % kinds.length] as string | AgentRunnerFailure, {
      k: 1,
    });
    const codes = run.cases.flatMap((c) => c.trials.map((t) => t.failure_code));
    expect(codes).toEqual([
      'output_not_json',
      'output_invalid',
      'output_invalid',
      'infra_error',
      'refused',
    ]);
    expect(run.cases.every((c) => c.trials.every((t) => !t.passed))).toBe(true);
    expect(run.errored).toBe(1);
  });

  it('a valid but wrong answer fails with grader_failed', async () => {
    const { run } = await runWith(() => badAnswer(), { k: 2 });
    const t = run.cases.find((c) => c.case_id === 't-exact')?.trials[0];
    expect(t).toMatchObject({ passed: false, failure_code: 'grader_failed' });
  });

  it('computes pass^k from the trials', async () => {
    let n = 0;
    // t-exact passes 2 of 3 trials, the rest always pass
    const { run } = await runWith((r) => {
      if (r.input['id'] === 't-exact') return n++ % 3 === 2 ? badAnswer() : goodAnswer(r);
      return goodAnswer(r);
    });
    const c = run.cases.find((x) => x.case_id === 't-exact');
    expect(c?.trials.filter((t) => t.passed)).toHaveLength(2);
    expect(runPassK(run)).toBeCloseTo((4 + 0) / 5, 10);
  });

  it('every run is recorded to a sink as history', async () => {
    const sink = new MemoryEvalSink();
    const a = await runWith((r) => goodAnswer(r));
    const b = await runWith(() => badAnswer());
    await sink.record(a.run);
    await sink.record(b.run);
    expect(sink.runs.map((r) => r.eval_run_id)).toEqual([a.run.eval_run_id, b.run.eval_run_id]);
    expect(a.run.eval_run_id).not.toBe(b.run.eval_run_id);
  });
});

describe('compare and gate', () => {
  it('compare: bootstrap at 0.90, deterministic, against the provider baseline', async () => {
    const good = (await runWith((r) => goodAnswer(r))).run;
    const baseline = baselineFrom(good, { baseline_id: 'b1', created_at: good.ended_at });
    const same = compareRuns(good, baseline);
    expect(same).toMatchObject({
      level: 0.9,
      verdict: 'no_change',
      delta: 0,
      ci_low: 0,
      ci_high: 0,
    });
    const bad = (await runWith(() => badAnswer())).run;
    const worse = compareRuns(bad, baseline);
    expect(worse.verdict).toBe('regression');
    expect(worse.ci_high as number).toBeLessThan(0);
    // the regex case still passes with L6, the other four do not
    expect(worse.delta).toBeCloseTo(-0.8, 10);
    expect(compareRuns(bad, baseline)).toEqual(worse);
    // a mild, noisy drop is not significant at this width
    let n = 0;
    const flaky = (await runWith((r) => (n++ === 0 ? badAnswer() : goodAnswer(r)))).run;
    expect(compareRuns(flaky, baseline).verdict).toBe('no_change');
    // an improvement over a poor baseline
    const poor = baselineFrom(bad, { baseline_id: 'b0', created_at: bad.ended_at });
    expect(compareRuns(good, poor).verdict).toBe('improvement');
    expect(compareRuns(good, null).verdict).toBe('no_baseline');
  });

  it('a case the run lacks counts as failed', async () => {
    const good = (await runWith((r) => goodAnswer(r))).run;
    const baseline = baselineFrom(good, { baseline_id: 'b1', created_at: good.ended_at });
    const fewer: EvalRunRecord = { ...good, cases: good.cases.slice(0, 1) };
    const c = compareRuns(fewer, baseline);
    expect(c.cases).toBe(5);
    expect(c.delta).toBeCloseTo(-0.8, 10);
  });

  it('gate: a deterministic regression fails; the same agent passes; each reason alone fails', async () => {
    const good = (await runWith((r) => goodAnswer(r))).run;
    const baseline = baselineFrom(good, { baseline_id: 'b1', created_at: good.ended_at });
    expect(gateRun(good, baseline)).toMatchObject({ passed: true, reasons: [] });

    const bad = (await runWith(() => badAnswer())).run;
    const g = gateRun(bad, baseline);
    expect(g.passed).toBe(false);
    expect(g.reasons).toEqual(expect.arrayContaining(['significant_regression', 'below_floor']));

    expect(gateRun(good, null).reasons).toEqual(['no_baseline']);
    // below the absolute floor with no regression against a baseline that is just as bad
    const poorBase = baselineFrom(bad, { baseline_id: 'b0', created_at: bad.ended_at });
    expect(gateRun(bad, poorBase).reasons).toEqual(['below_floor', 'security_case_failed']);
    // a failed security-tagged case fails even with a high pass rate
    const sec: EvalRunRecord = {
      ...good,
      cases: good.cases.map((c) =>
        c.security_tagged
          ? {
              ...c,
              trials: c.trials.map((t, i) =>
                i === 0 ? { ...t, passed: false, failure_code: 'grader_failed' as const } : t,
              ),
            }
          : c,
      ),
    };
    expect(gateRun(sec, baseline, { floor: 0.5 }).reasons).toContain('security_case_failed');
    // an errored trial fails (an error is a refusal, never an approval)
    const errored: EvalRunRecord = {
      ...good,
      errored: 1,
      cases: good.cases.map((c, i) =>
        i === 0
          ? {
              ...c,
              trials: c.trials.map((t, j) =>
                j === 0
                  ? { ...t, passed: false, infra_error: true, failure_code: 'infra_error' as const }
                  : t,
              ),
            }
          : c,
      ),
    };
    expect(gateRun(errored, baseline, { floor: 0.5 }).reasons).toContain('errored_trials');
  });

  it('baselineFor picks by suite, agent and profile', async () => {
    const good = (await runWith((r) => goodAnswer(r))).run;
    const b = baselineFrom(good, { baseline_id: 'b1', created_at: good.ended_at });
    expect(baselineFor({ baselines: [b] }, good)).toBe(b);
    expect(baselineFor({ baselines: [b] }, { ...good, profile: 'other' })).toBeNull();
    expect(baselineFor(null, good)).toBeNull();
  });
});
