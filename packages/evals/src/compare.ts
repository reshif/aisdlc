import {
  EVAL_COMPARE_LEVEL,
  type EvalBaseline,
  type EvalCompareResult,
  type EvalGateReason,
  type EvalGateResult,
  type EvalRunRecord,
} from '@aisdlc/contracts';
import { runPassRate } from '@aisdlc/agents';

// compare and gate (PLAN M11.3; DM §5.1 `planning_eval.compare`, `gate`, `absolute_floor`).
//
// compare: the per-case pass rate of the run against the provider's baseline, paired by case. The
// mean difference is bootstrapped over cases (resampling cases with replacement, a seeded PRNG so the
// same inputs always give the same answer) and the interval is the central `level` (default 0.90).
// A regression is significant when the WHOLE interval is below zero. A case the baseline has and the
// run lacks counts as failed (unknown means unmet); a case only the run has is not compared.

export const DEFAULT_FLOOR = 0.8;
export const DEFAULT_RESAMPLES = 2000;

/** mulberry32: a small seeded PRNG, so a bootstrap is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rate = (v: readonly boolean[]): number =>
  v.length === 0 ? 0 : v.filter(Boolean).length / v.length;

export function compareRuns(
  run: EvalRunRecord,
  baseline: EvalBaseline | null,
  o: { level?: number; resamples?: number; seed?: number } = {},
): EvalCompareResult {
  const level = o.level ?? EVAL_COMPARE_LEVEL;
  const candidate_pass_rate = runPassRate(run);
  if (baseline === null) {
    return {
      level,
      baseline_id: null,
      cases: 0,
      candidate_pass_rate,
      baseline_pass_rate: null,
      delta: null,
      ci_low: null,
      ci_high: null,
      verdict: 'no_baseline',
    };
  }
  const mine = new Map(run.cases.map((c) => [c.case_id, rate(c.trials.map((t) => t.passed))]));
  const deltas: number[] = [];
  let baseSum = 0;
  for (const b of baseline.cases) {
    const base = rate(b.passes);
    baseSum += base;
    deltas.push((mine.get(b.case_id) ?? 0) - base);
  }
  const n = deltas.length;
  const mean = deltas.reduce((s, x) => s + x, 0) / n;
  const rnd = prng(o.seed ?? 20261109);
  const means: number[] = [];
  const B = o.resamples ?? DEFAULT_RESAMPLES;
  for (let r = 0; r < B; r += 1) {
    let s = 0;
    for (let j = 0; j < n; j += 1) s += deltas[Math.floor(rnd() * n)] as number;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const at = (q: number) => means[Math.min(B - 1, Math.max(0, Math.floor(q * B)))] as number;
  const ci_low = at((1 - level) / 2);
  const ci_high = at(1 - (1 - level) / 2);
  return {
    level,
    baseline_id: baseline.baseline_id,
    cases: n,
    candidate_pass_rate,
    baseline_pass_rate: baseSum / n,
    delta: mean,
    ci_low,
    ci_high,
    verdict: ci_high < 0 ? 'regression' : ci_low > 0 ? 'improvement' : 'no_change',
  };
}

/**
 * The gate: it FAILS on any of: a significant regression against the baseline, an overall pass rate
 * below the absolute floor, a security-tagged case with a failed trial, an errored trial, or no
 * baseline to compare with. Nothing here approves anything: it is evidence a gated change attaches.
 */
export function gateRun(
  run: EvalRunRecord,
  baseline: EvalBaseline | null,
  o: { floor?: number; level?: number; resamples?: number; seed?: number } = {},
): EvalGateResult {
  const floor = o.floor ?? DEFAULT_FLOOR;
  const compare = compareRuns(run, baseline, o);
  const pass_rate = runPassRate(run);
  const reasons: EvalGateReason[] = [];
  if (compare.verdict === 'regression') reasons.push('significant_regression');
  if (pass_rate < floor) reasons.push('below_floor');
  if (run.cases.some((c) => c.security_tagged && c.trials.some((t) => !t.passed))) {
    reasons.push('security_case_failed');
  }
  if (run.errored > 0) reasons.push('errored_trials');
  if (compare.verdict === 'no_baseline') reasons.push('no_baseline');
  return { passed: reasons.length === 0, reasons, floor, pass_rate, compare };
}

/** A baseline from a run: its pass vectors, to be committed to the store (and signed) by a person. */
export function baselineFrom(
  run: EvalRunRecord,
  o: { baseline_id: string; created_at: string },
): EvalBaseline {
  return {
    baseline_id: o.baseline_id,
    provider: run.provider,
    suite_id: run.suite_id,
    agent_id: run.agent_id,
    profile: run.profile,
    model: run.model,
    prompt_sha256: run.prompt_sha256,
    manifest_digest: run.manifest_digest,
    k: run.k,
    cases: run.cases.map((c) => ({ case_id: c.case_id, passes: c.trials.map((t) => t.passed) })),
    source_run_id: run.eval_run_id,
    approved_by_entry: null,
    created_at: o.created_at,
  };
}

/** The baseline of a provider that fits a run (same suite, agent and profile), or `null`. */
export function baselineFor(
  file: { baselines: readonly EvalBaseline[] } | null,
  run: Pick<EvalRunRecord, 'suite_id' | 'agent_id' | 'profile'>,
): EvalBaseline | null {
  return (
    file?.baselines.find(
      (b) =>
        b.suite_id === run.suite_id && b.agent_id === run.agent_id && b.profile === run.profile,
    ) ?? null
  );
}
