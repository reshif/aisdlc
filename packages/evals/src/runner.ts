import { agentDefinition, validateOutput } from '@aisdlc/agents';
import {
  EvalRunRecord,
  type EvalCase,
  type EvalCaseResult,
  type EvalFailureCode,
  type EvalGrader,
  type EvalTrigger,
  type EvalTrialResult,
  type GitSha,
} from '@aisdlc/contracts';
import { newId, type Clock, type Result, systemClock } from '@aisdlc/kernel';
import { grade } from './grader.js';
import type { AgentRunner } from './runner-port.js';

// run_suite (PLAN M11.3; DM §5.1 `planning_eval.run_suite`): every case, k trials each, through the
// AgentRunner; a trial is graded by `validateOutput` and then the case's grader. Fail closed: a trial
// that errored is a failed trial (and counted as errored), never skipped. The runner is handed the
// case INPUT only; the grader is fetched after the answer and never reaches the AgentRunner.

export const HARNESS_VERSION = 'aisdlc-evals/1';

export interface RunSuiteInput {
  readonly suite: {
    readonly suite_id: string;
    readonly agent_id: EvalCase['agent_id'];
    readonly profile: string;
    readonly project_tag: EvalCase['project_tag'];
  };
  readonly cases: readonly EvalCase[];
  /** The grader of a case, fetched when its trial has an answer. A refusal fails the trial. */
  readonly graderOf: (c: EvalCase) => Result<EvalGrader, unknown>;
  readonly runner: AgentRunner;
  readonly k: number;
  readonly store_id: string;
  readonly manifest_digest: string;
  readonly trigger?: EvalTrigger;
  readonly git_sha?: GitSha | null;
  readonly clock?: Clock;
}

const failed = (
  trial: number,
  code: EvalFailureCode,
  usage: Pick<EvalTrialResult, 'tokens_in' | 'tokens_out' | 'cost_micro_usd'> = {
    tokens_in: 0,
    tokens_out: 0,
    cost_micro_usd: 0,
  },
): EvalTrialResult => ({
  trial,
  passed: false,
  failure_code: code,
  infra_error: code === 'infra_error',
  ...usage,
});

export async function runSuite(i: RunSuiteInput): Promise<EvalRunRecord> {
  const clock = i.clock ?? systemClock;
  const def = agentDefinition(i.suite.agent_id);
  const started_at = clock.now().toISOString();
  const cases: EvalCaseResult[] = [];
  let model = i.runner.model;

  for (const c of i.cases) {
    if (c.agent_id !== i.suite.agent_id) throw new Error(`case ${c.case_id} is for another agent`);
    const trials: EvalTrialResult[] = [];
    for (let trial = 1; trial <= i.k; trial += 1) {
      let answer;
      try {
        // the agent sees the input and nothing else of the case
        answer = await i.runner.run({
          agent_id: c.agent_id,
          input: structuredClone(c.input),
          trial,
        });
      } catch {
        trials.push(failed(trial, 'infra_error'));
        continue;
      }
      if (!answer.ok) {
        trials.push(failed(trial, answer.error.code));
        continue;
      }
      const a = answer.value;
      model = a.model;
      const usage = {
        tokens_in: a.tokens_in,
        tokens_out: a.tokens_out,
        cost_micro_usd: a.cost_micro_usd,
      };
      let parsed: unknown;
      try {
        parsed = JSON.parse(a.text.trim());
      } catch {
        trials.push(failed(trial, 'output_not_json', usage));
        continue;
      }
      if (!validateOutput(c.agent_id, parsed).ok) {
        trials.push(failed(trial, 'output_invalid', usage));
        continue;
      }
      const g = i.graderOf(c);
      const passed = g.ok && grade(parsed, g.value);
      trials.push({
        trial,
        passed,
        failure_code: passed ? null : 'grader_failed',
        infra_error: false,
        ...usage,
      });
    }
    cases.push({ case_id: c.case_id, kind: c.kind, security_tagged: c.security_tagged, trials });
  }

  const all = cases.flatMap((c) => c.trials);
  return EvalRunRecord.parse({
    eval_run_id: newId<'EvalRun'>(clock.now().getTime()),
    suite_id: i.suite.suite_id,
    project_tag: i.suite.project_tag,
    agent_id: i.suite.agent_id,
    profile: i.suite.profile,
    prompt_ref: def.prompt.ref,
    prompt_sha256: def.prompt.sha256,
    contract_version: def.contract.contract_version,
    provider: i.runner.provider,
    model,
    harness_version: HARNESS_VERSION,
    trigger: i.trigger ?? 'manual',
    git_sha: i.git_sha ?? null,
    store_id: i.store_id,
    manifest_digest: i.manifest_digest,
    k: i.k,
    cases,
    cost_micro_usd: all.reduce((n, t) => n + t.cost_micro_usd, 0),
    errored: all.filter((t) => t.infra_error).length,
    started_at,
    ended_at: clock.now().toISOString(),
  });
}
