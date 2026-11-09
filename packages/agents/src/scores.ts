import type {
  AgentId,
  AgentScore,
  EvalCaseResult,
  EvalRunRecord,
  EvalSummaryRow,
  EvalTaskStatus,
  ScoreSignal,
} from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import type { RunWithOutcome } from './stats.js';

// Scores (PLAN M11.3; DM §5.2 AgentScore, ScoreSignal, §5.1 summary rows). Pure over eval runs and
// production runs with their outcomes, so core's HTTP read, the eval tool's gate and the tests
// compute it one way. Scoring never approves, selects or promotes anything.

/** C(n, k) as a float; 0 when k > n. Exact enough for trial counts (n <= 50). */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= Math.min(k, n - k); i += 1) r = (r * (n - i + 1)) / i;
  return r;
}

/**
 * The unbiased pass^k estimate: the chance that k trials drawn from the `trials` all passed,
 * C(passes, k) / C(trials, k). With `trials === k` it is 1 only if every trial passed. Fewer trials
 * than k is 0 (unknown means unmet).
 */
export function passPowK(passes: number, trials: number, k: number): number {
  if (trials < k || k < 1) return 0;
  return choose(passes, k) / choose(trials, k);
}

/** `pass`: every trial passed; `fail`: none did; `flaky`: some did. */
export function taskStatus(passes: number, trials: number): EvalTaskStatus {
  if (trials > 0 && passes === trials) return 'pass';
  return passes === 0 ? 'fail' : 'flaky';
}

export const caseCounts = (c: Pick<EvalCaseResult, 'trials'>) => ({
  trials: c.trials.length,
  passes: c.trials.filter((t) => t.passed).length,
});

/** Passes over trials of a whole run. */
export function runPassRate(run: Pick<EvalRunRecord, 'cases'>): number {
  let t = 0;
  let p = 0;
  for (const c of run.cases) {
    const n = caseCounts(c);
    t += n.trials;
    p += n.passes;
  }
  return t === 0 ? 0 : p / t;
}

/** Mean over cases of the per-case pass^k. */
export function runPassK(run: Pick<EvalRunRecord, 'cases' | 'k'>): number {
  if (run.cases.length === 0) return 0;
  const sum = run.cases.reduce((n, c) => {
    const x = caseCounts(c);
    return n + passPowK(x.passes, x.trials, run.k);
  }, 0);
  return sum / run.cases.length;
}

const byEnd = (a: EvalRunRecord, b: EvalRunRecord): number =>
  a.ended_at < b.ended_at
    ? -1
    : a.ended_at > b.ended_at
      ? 1
      : a.eval_run_id.localeCompare(b.eval_run_id);

/** The newest run of each (suite, provider, agent, profile): what the quality board shows. */
export function latestRuns(runs: readonly EvalRunRecord[]): EvalRunRecord[] {
  const m = new Map<string, EvalRunRecord>();
  for (const r of [...runs].sort(byEnd)) {
    m.set(JSON.stringify([r.suite_id, r.provider, r.agent_id, r.profile]), r);
  }
  return [...m.values()];
}

/**
 * The rows of `GET /v1/evals/summary`: one per task of the newest run of each suite and provider.
 * Allow-listed fields only; a caller cannot get a prompt, an output or a per-task cost from here
 * because they are not read.
 */
export function summaryRows(runs: readonly EvalRunRecord[]): EvalSummaryRow[] {
  const rows: EvalSummaryRow[] = [];
  for (const r of latestRuns(runs)) {
    for (const c of r.cases) {
      const { trials, passes } = caseCounts(c);
      rows.push({
        task_id: c.case_id,
        profile: r.profile,
        suite: r.suite_id,
        provider: r.provider,
        trials,
        passes,
        pass_rate: passes / trials,
        pass_k: passPowK(passes, trials, r.k),
        k: r.k,
        status: taskStatus(passes, trials),
      });
    }
  }
  return rows.sort(
    (a, b) =>
      a.suite.localeCompare(b.suite) ||
      a.provider.localeCompare(b.provider) ||
      a.task_id.localeCompare(b.task_id),
  );
}

const scoreKey = (agent: string, sha: string, provider: string, model: string): string =>
  JSON.stringify([agent, sha, provider, model]);
export const scoreIdOf = (agent: string, sha: string, provider: string, model: string): string =>
  hashCanonical([agent, sha, provider, model]).slice(0, 32);

/**
 * AgentScore per (agent, prompt sha, provider, model): the eval half from the newest run of each
 * suite under that key (all runs counted in `eval_runs`), the production half from the AgentRuns'
 * outcomes of the same key (M11.2). A rate whose denominator is 0 is `null`. `sent_back_rate` counts
 * `sent_back` and `rejected` verdicts (a gate that did not accept what the run produced).
 */
export function foldAgentScores(
  runs: readonly EvalRunRecord[],
  production: readonly RunWithOutcome[] = [],
  only: AgentId | null = null,
): AgentScore[] {
  const keys = new Map<string, { agent: AgentId; sha: string; provider: string; model: string }>();
  const evalBy = new Map<string, EvalRunRecord[]>();
  for (const r of runs) {
    if (only !== null && r.agent_id !== only) continue;
    const k = scoreKey(r.agent_id, r.prompt_sha256, r.provider, r.model);
    keys.set(k, { agent: r.agent_id, sha: r.prompt_sha256, provider: r.provider, model: r.model });
    evalBy.set(k, [...(evalBy.get(k) ?? []), r]);
  }
  const prodBy = new Map<string, RunWithOutcome[]>();
  for (const p of production) {
    if (p.provider === null || p.model === null) continue;
    if (only !== null && p.agent_id !== only) continue;
    const k = scoreKey(p.agent_id, p.prompt_sha256, p.provider, p.model);
    keys.set(k, { agent: p.agent_id, sha: p.prompt_sha256, provider: p.provider, model: p.model });
    prodBy.set(k, [...(prodBy.get(k) ?? []), p]);
  }
  const out: AgentScore[] = [];
  for (const [k, id] of keys) {
    const all = evalBy.get(k) ?? [];
    const latest = latestRuns(all);
    let trials = 0;
    let passes = 0;
    let cost = 0;
    let kSum = 0;
    let cases = 0;
    let anyFail = false;
    let anyFlaky = false;
    for (const r of latest) {
      for (const c of r.cases) {
        const n = caseCounts(c);
        trials += n.trials;
        passes += n.passes;
        cost += c.trials.reduce((s, t) => s + t.cost_micro_usd, 0);
        kSum += passPowK(n.passes, n.trials, r.k);
        cases += 1;
        const st = taskStatus(n.passes, n.trials);
        if (st === 'fail') anyFail = true;
        if (st === 'flaky') anyFlaky = true;
      }
    }
    const prod = prodBy.get(k) ?? [];
    const judged = prod.filter((p) => p.outcome.verdict !== 'pending').length;
    const n = (v: string) => prod.filter((p) => p.outcome.verdict === v).length;
    out.push({
      score_id: scoreIdOf(id.agent, id.sha, id.provider, id.model),
      agent_id: id.agent,
      prompt_sha256: id.sha,
      provider: id.provider,
      model: id.model,
      eval_runs: all.length,
      eval_trials: trials,
      pass_rate: trials === 0 ? null : passes / trials,
      pass_k: cases === 0 ? null : kSum / cases,
      cost_per_pass_micro_usd: passes === 0 ? null : cost / passes,
      status: latest.length === 0 ? 'unknown' : anyFail ? 'fail' : anyFlaky ? 'flaky' : 'pass',
      last_eval_at:
        latest
          .map((r) => r.ended_at)
          .sort()
          .at(-1) ?? null,
      production_runs: prod.length,
      production_judged: judged,
      accept_rate: judged === 0 ? null : n('accepted') / judged,
      sent_back_rate: judged === 0 ? null : (n('sent_back') + n('rejected')) / judged,
      rework_rate: judged === 0 ? null : n('reworked') / judged,
    });
  }
  return out.sort((a, b) => a.score_id.localeCompare(b.score_id));
}

/** The facts behind the scores: every eval trial and every judged production run, by score. */
export function scoreSignals(
  runs: readonly EvalRunRecord[],
  production: readonly RunWithOutcome[] = [],
): ScoreSignal[] {
  const out: ScoreSignal[] = [];
  for (const r of runs) {
    const score_id = scoreIdOf(r.agent_id, r.prompt_sha256, r.provider, r.model);
    for (const c of r.cases) {
      for (const t of c.trials) {
        out.push({
          score_id,
          source: 'eval',
          run_ref: `${r.eval_run_id}/${c.case_id}/${t.trial}`,
          verdict: t.passed ? 'pass' : 'fail',
        });
      }
    }
  }
  for (const p of production) {
    if (p.provider === null || p.model === null || p.outcome.verdict === 'pending') continue;
    out.push({
      score_id: scoreIdOf(p.agent_id, p.prompt_sha256, p.provider, p.model),
      source: 'production',
      run_ref: p.run_id,
      verdict: p.outcome.verdict,
    });
  }
  return out;
}
