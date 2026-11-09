import { describe, expect, it } from 'vitest';
import {
  EVAL_SUMMARY_FIELDS,
  EvalCase,
  EvalGrader,
  EvalRunRecord,
  EvalSummaryRow,
  KnowledgeDefect,
} from '../../src/index.js';

const SHA = 'a'.repeat(64);
const trial = (n: number, passed = true) => ({
  trial: n,
  passed,
  failure_code: passed ? null : 'grader_failed',
  infra_error: false,
  tokens_in: 1,
  tokens_out: 1,
  cost_micro_usd: 2,
});
const run = (over: Record<string, unknown> = {}) => ({
  eval_run_id: '0190a000-0000-7000-8000-000000000001',
  suite_id: 's',
  project_tag: null,
  agent_id: 'A1',
  profile: 'A1.classify',
  prompt_ref: 'a1_triage@1.0.0',
  prompt_sha256: SHA,
  contract_version: '1.0.0',
  provider: 'fake',
  model: 'm',
  harness_version: 'h',
  trigger: 'ci',
  git_sha: null,
  store_id: 'st',
  manifest_digest: SHA,
  k: 2,
  cases: [
    {
      case_id: 'c1',
      kind: 'regression',
      security_tagged: false,
      trials: [trial(1), trial(2, false)],
    },
  ],
  cost_micro_usd: 4,
  errored: 0,
  started_at: '2026-11-09T10:00:00.000Z',
  ended_at: '2026-11-09T10:00:01.000Z',
  ...over,
});

describe('evals contracts', () => {
  it('a run carries ids, hashes, vectors and counts, and is checked for consistency', () => {
    expect(EvalRunRecord.safeParse(run()).success).toBe(true);
    expect(EvalRunRecord.safeParse(run({ errored: 1 })).success).toBe(false);
    expect(EvalRunRecord.safeParse(run({ cost_micro_usd: 5 })).success).toBe(false);
    expect(EvalRunRecord.safeParse(run({ k: 3 })).success).toBe(false);
    expect(EvalRunRecord.safeParse(run({ output: 'text' })).success).toBe(false);
    expect(EvalRunRecord.safeParse(run({ prompt: 'text' })).success).toBe(false);
  });

  it('a case has an input and a hidden ref, and no field for the expected answer', () => {
    const c = {
      case_id: 'c1',
      suite_id: 's',
      kind: 'holdout',
      agent_id: 'A1',
      profile: 'A1.classify',
      project_tag: null,
      security_tagged: false,
      input: { request: 'x' },
      hidden_ref: `sha256:${SHA}`,
    };
    expect(EvalCase.safeParse(c).success).toBe(true);
    expect(EvalCase.safeParse({ ...c, expected: { candidate: 'L3' } }).success).toBe(false);
    expect(EvalCase.safeParse({ ...c, grader: { type: 'exact', value: 1 } }).success).toBe(false);
    expect(EvalCase.safeParse({ ...c, hidden_ref: 'inline' }).success).toBe(false);
    expect(EvalCase.safeParse({ ...c, kind: 'golden' }).success).toBe(false);
  });

  it('graders are the four deterministic kinds', () => {
    for (const g of [
      { type: 'exact', value: { a: 1 } },
      { type: 'regex', pattern: 'a', path: 'x' },
      { type: 'json_subset', value: [] },
      { type: 'schema', schema: { type: 'object' } },
    ]) {
      expect(EvalGrader.safeParse(g).success).toBe(true);
    }
    expect(EvalGrader.safeParse({ type: 'llm_judge' }).success).toBe(false);
  });

  it('the summary row is exactly the allow-listed fields (DM §5.1)', () => {
    expect([...EVAL_SUMMARY_FIELDS]).toEqual([
      'task_id',
      'profile',
      'suite',
      'provider',
      'trials',
      'passes',
      'pass_rate',
      'pass_k',
      'k',
      'status',
    ]);
    const row = {
      task_id: 't',
      profile: 'p',
      suite: 's',
      provider: 'x',
      trials: 3,
      passes: 3,
      pass_rate: 1,
      pass_k: 1,
      k: 3,
      status: 'pass',
    };
    expect(EvalSummaryRow.safeParse(row).success).toBe(true);
    expect(EvalSummaryRow.safeParse({ ...row, cost_micro_usd: 1 }).success).toBe(false);
  });

  it('a knowledge defect names rules and a path, and has no field for text', () => {
    const d = { kind: 'level_conflict', level: 5, path: 'a.md', rules: ['L-LANE'], detail: 'x' };
    expect(KnowledgeDefect.safeParse(d).success).toBe(true);
    expect(KnowledgeDefect.safeParse({ ...d, text: 'quoted' }).success).toBe(false);
    expect(KnowledgeDefect.safeParse({ ...d, level: 8 }).success).toBe(false);
  });
});
