import { z } from 'zod';
import { AgentId } from './agent-definitions.js';
import { GitSha, IsoDateTime, JsonObject, ProjectId, Sha256Hex, uuidId } from './ids.js';

// Agent evals and scoring (PLAN M11.3; DM §5.2; PLAN §7a: evals are FACTORY-WIDE with an optional
// project tag). Two halves:
//   a) the eval STORE, which lives on disk outside the repo (`asf-eval-store/v1`): cases, hidden
//      graders, holdouts, baselines and a signed manifest. Nothing in it is a record.
//   b) the eval RUN HISTORY, which IS a record: every run is one `eval.run_recorded` event on
//      `eval:<suite>` carrying ids, hashes, per-case pass vectors and counts, never a prompt or an
//      output. `core.eval_run` and `core.eval_trial` are read models of it; AgentScore is a read
//      model over those and the production AgentRunOutcomes.

export const EVAL_STORE_FORMAT = 'asf-eval-store/v1';
export const EVAL_BASELINES_FORMAT = 'asf-eval-baselines/v1';
/** The confidence level of `compare` (DM §5.1: bootstrap, level 0.90). */
export const EVAL_COMPARE_LEVEL = 0.9;

const Slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'letters, digits, . _ -');

// ---------------------------------------------------------------- cases and graders

/** `regression` is the golden task of DM §5.1 (the spec's word for a case that must keep passing). */
export const EvalCaseKind = z.enum(['regression', 'holdout', 'pooled', 'canary', 'seeded_defect']);
export type EvalCaseKind = z.infer<typeof EvalCaseKind>;
export const EvalCaseKindValues: readonly EvalCaseKind[] = EvalCaseKind.options;

/**
 * How an output is judged after `validateOutput` accepted it. All deterministic (an LLM judge is out
 * of scope). `path` is a dotted path into the output (`findings.0.message`); without one the whole
 * output is used (a regex then sees its canonical JSON).
 */
export const EvalGrader = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('exact'), value: z.unknown() }),
  z.strictObject({
    type: z.literal('regex'),
    pattern: z.string().min(1).max(500),
    flags: z
      .string()
      .regex(/^[ims]{0,3}$/)
      .optional(),
    path: z.string().min(1).max(200).optional(),
  }),
  /** Every key of `value` is in the output with a matching value; each array element of `value` matches some element. */
  z.strictObject({ type: z.literal('json_subset'), value: z.unknown() }),
  /** A JSON Schema subset: type, enum, const, required, properties, additionalProperties:false, items, min/max. */
  z.strictObject({ type: z.literal('schema'), schema: JsonObject }),
]);
export type EvalGrader = z.infer<typeof EvalGrader>;

/** A pointer into the store's hidden files: the sha256 of the grader's canonical JSON. */
export const EvalHiddenRef = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type EvalHiddenRef = z.infer<typeof EvalHiddenRef>;

/**
 * A case as it is stored in `tasks/` (or `holdouts/`). It holds the INPUT and a reference to the
 * expected answer, never the answer: `expected` is not a field (strict), `hidden_ref` is (DM §5.1
 * `hidden_tests_ref`, D36).
 */
export const EvalCase = z.strictObject({
  case_id: Slug,
  suite_id: Slug,
  kind: EvalCaseKind,
  agent_id: AgentId,
  /** `A3.plan`: the agent's profile (DM `AgentContractRef.profile`). */
  profile: Slug,
  project_tag: ProjectId.nullable(),
  /** A failure of a security-tagged case fails the gate whatever the pass rate is. */
  security_tagged: z.boolean(),
  /** What the agent is given (the user message). Never the expected answer. */
  input: JsonObject,
  hidden_ref: EvalHiddenRef,
});
export type EvalCase = z.infer<typeof EvalCase>;

/** The hidden file a `hidden_ref` names. */
export const EvalHidden = z.strictObject({ grader: EvalGrader });
export type EvalHidden = z.infer<typeof EvalHidden>;

/** A suite is derived from its cases: one agent profile, one tag. */
export const EvalSuite = z.strictObject({
  suite_id: Slug,
  agent_id: AgentId,
  profile: Slug,
  project_tag: ProjectId.nullable(),
  case_ids: z.array(Slug),
  holdout_case_ids: z.array(Slug),
  store_id: z.string().min(1),
  manifest_digest: Sha256Hex,
  /** Always `false` when the suite has a holdout case: holdouts are never loaded where agents run. */
  local_prod_loadable: z.boolean(),
});
export type EvalSuite = z.infer<typeof EvalSuite>;

// ---------------------------------------------------------------- the signed manifest

export const EvalManifest = z.strictObject({
  format: z.literal(EVAL_STORE_FORMAT),
  store_id: z.string().min(1).max(128),
  created_at: IsoDateTime,
  /** The custody key id the manifest is signed with (`dev:eval-store`). */
  key_id: z.string().min(1),
  /** Every file of the store but `manifest.json`: path (`tasks/x.json`) -> sha256 of its bytes. */
  files: z.record(z.string().min(1), Sha256Hex),
});
export type EvalManifest = z.infer<typeof EvalManifest>;

export const EvalSignedManifest = z.strictObject({
  manifest: EvalManifest,
  signature: z.strictObject({
    alg: z.literal('ES256'),
    kid: z.string().min(1),
    /** base64url, raw r||s over sha256 of the manifest's canonical JSON. */
    value: z.string().min(1),
  }),
});
export type EvalSignedManifest = z.infer<typeof EvalSignedManifest>;

// ---------------------------------------------------------------- trials, runs, baselines

export const EvalFailureCode = z.enum([
  /** The agent's answer was not one JSON object. */
  'output_not_json',
  /** `validateOutput` refused it. */
  'output_invalid',
  /** It validated and the case's grader said no. */
  'grader_failed',
  /** The gateway refused the call (budget, tool, kill, route). */
  'refused',
  /** The gateway or provider could not be reached. Counts as a failed trial (fail closed) and as errored. */
  'infra_error',
]);
export type EvalFailureCode = z.infer<typeof EvalFailureCode>;

export const EvalTrialResult = z.strictObject({
  trial: z.number().int().min(1),
  passed: z.boolean(),
  failure_code: EvalFailureCode.nullable(),
  infra_error: z.boolean(),
  tokens_in: z.number().int().min(0),
  tokens_out: z.number().int().min(0),
  cost_micro_usd: z.number().int().min(0),
});
export type EvalTrialResult = z.infer<typeof EvalTrialResult>;

export const EvalCaseResult = z.strictObject({
  case_id: Slug,
  kind: EvalCaseKind,
  security_tagged: z.boolean(),
  trials: z.array(EvalTrialResult).min(1),
});
export type EvalCaseResult = z.infer<typeof EvalCaseResult>;

export const EvalRunId = uuidId<'EvalRun'>();
export type EvalRunId = z.infer<typeof EvalRunId>;

export const EvalTrigger = z.enum([
  'ci',
  'prompt_change',
  'model_change',
  'schedule',
  'regression',
  'manual',
]);
export type EvalTrigger = z.infer<typeof EvalTrigger>;

/** A trial as a row (DM `EvalTrial`): the run's trial with its case. */
export const EvalTrial = EvalTrialResult.extend({ eval_run_id: EvalRunId, case_id: Slug });
export type EvalTrial = z.infer<typeof EvalTrial>;

/**
 * One run of a suite against one agent, prompt, provider and model (DM `EvalRun`). This is the
 * payload of `eval.run_recorded` and the body of `POST /v1/evals/runs`: ids, hashes, pass vectors
 * and counts. It never holds a prompt, an input or an output.
 */
export const EvalRunRecord = z
  .strictObject({
    eval_run_id: EvalRunId,
    suite_id: Slug,
    project_tag: ProjectId.nullable(),
    agent_id: AgentId,
    profile: Slug,
    /** `name@version` and the sha256 of the prompt file as `prompts.lock.json` held it. */
    prompt_ref: z.string().min(1),
    prompt_sha256: Sha256Hex,
    contract_version: z.string().min(1),
    provider: Slug,
    model: z.string().min(1).max(128),
    harness_version: z.string().min(1).max(64),
    trigger: EvalTrigger,
    git_sha: GitSha.nullable(),
    store_id: z.string().min(1),
    manifest_digest: Sha256Hex,
    /** Trials per case. */
    k: z.number().int().min(1).max(50),
    cases: z.array(EvalCaseResult).min(1),
    cost_micro_usd: z.number().int().min(0),
    /** Trials that ended in an infrastructure error (they count as failures too). */
    errored: z.number().int().min(0),
    started_at: IsoDateTime,
    ended_at: IsoDateTime,
  })
  .refine((r) => r.cases.every((c) => c.trials.length === r.k), {
    message: 'every case has exactly k trials',
    path: ['cases'],
  })
  .refine(
    (r) => r.errored === r.cases.flatMap((c) => c.trials).filter((t) => t.infra_error).length,
    {
      message: 'errored is the number of trials with an infrastructure error',
      path: ['errored'],
    },
  )
  .refine(
    (r) =>
      r.cost_micro_usd ===
      r.cases.flatMap((c) => c.trials).reduce((n, t) => n + t.cost_micro_usd, 0),
    { message: 'cost is the sum of the trials', path: ['cost_micro_usd'] },
  )
  .refine((r) => new Set(r.cases.map((c) => c.case_id)).size === r.cases.length, {
    message: 'duplicate case',
    path: ['cases'],
  });
export type EvalRunRecord = z.infer<typeof EvalRunRecord>;

/** DM `EvalBaseline`: the pass vectors a later run is compared with, per provider. */
export const EvalBaseline = z.strictObject({
  baseline_id: Slug,
  provider: Slug,
  suite_id: Slug,
  agent_id: AgentId,
  profile: Slug,
  model: z.string().min(1).max(128),
  prompt_sha256: Sha256Hex,
  manifest_digest: Sha256Hex,
  k: z.number().int().min(1).max(50),
  cases: z.array(z.strictObject({ case_id: Slug, passes: z.array(z.boolean()).min(1) })).min(1),
  source_run_id: EvalRunId.nullable(),
  /** The ledger entry that approved this baseline (a gated change); `null` until one exists. */
  approved_by_entry: z.string().min(1).nullable(),
  created_at: IsoDateTime,
});
export type EvalBaseline = z.infer<typeof EvalBaseline>;

/** `baselines/<provider>.json`. */
export const EvalBaselineFile = z.strictObject({
  format: z.literal(EVAL_BASELINES_FORMAT),
  provider: Slug,
  baselines: z.array(EvalBaseline),
});
export type EvalBaselineFile = z.infer<typeof EvalBaselineFile>;

// ---------------------------------------------------------------- the record

export const EVAL_EVENT = { run_recorded: 'eval.run_recorded' } as const;
export type EvalEventType = (typeof EVAL_EVENT)[keyof typeof EVAL_EVENT];
export const EVAL_STREAM_PREFIX = 'eval:';
export const evalStream = (suiteId: string): string => `${EVAL_STREAM_PREFIX}${suiteId}`;
export const EvalEventPayloads = {
  [EVAL_EVENT.run_recorded]: EvalRunRecord,
} as const satisfies Record<EvalEventType, z.ZodType>;

// ---------------------------------------------------------------- read models

/** A run without its trials: what the history lists (a trend needs nothing more). */
export const EvalRunHeader = z.strictObject({
  eval_run_id: EvalRunId,
  suite_id: Slug,
  project_tag: ProjectId.nullable(),
  agent_id: AgentId,
  profile: Slug,
  prompt_ref: z.string(),
  prompt_sha256: Sha256Hex,
  contract_version: z.string(),
  provider: Slug,
  model: z.string(),
  harness_version: z.string(),
  trigger: EvalTrigger,
  git_sha: GitSha.nullable(),
  manifest_digest: Sha256Hex,
  k: z.number().int().min(1),
  cases: z.number().int().min(1),
  trials: z.number().int().min(1),
  passes: z.number().int().min(0),
  pass_rate: z.number().min(0).max(1),
  cost_micro_usd: z.number().int().min(0),
  errored: z.number().int().min(0),
  started_at: IsoDateTime,
  ended_at: IsoDateTime,
});
export type EvalRunHeader = z.infer<typeof EvalRunHeader>;

export const EvalRunsView = z.strictObject({ runs: z.array(EvalRunHeader) });
export type EvalRunsView = z.infer<typeof EvalRunsView>;

export const EvalTaskStatus = z.enum(['pass', 'flaky', 'fail']);
export type EvalTaskStatus = z.infer<typeof EvalTaskStatus>;

/**
 * One row of `GET /v1/evals/summary` (DM §5.1: allow-listed fields only). A `strictObject`: a field
 * that is not here cannot be served. Never a prompt, an input, an output or a per-task cost.
 */
export const EvalSummaryRow = z.strictObject({
  task_id: Slug,
  profile: Slug,
  suite: Slug,
  provider: Slug,
  trials: z.number().int().min(1),
  passes: z.number().int().min(0),
  pass_rate: z.number().min(0).max(1),
  /** Unbiased pass^k: C(passes, k) / C(trials, k). */
  pass_k: z.number().min(0).max(1),
  k: z.number().int().min(1),
  status: EvalTaskStatus,
});
export type EvalSummaryRow = z.infer<typeof EvalSummaryRow>;
export const EVAL_SUMMARY_FIELDS: readonly string[] = Object.keys(EvalSummaryRow.shape);

export const EvalSummaryView = z.strictObject({ rows: z.array(EvalSummaryRow) });
export type EvalSummaryView = z.infer<typeof EvalSummaryView>;

export const ScoreSource = z.enum(['eval', 'production']);
export type ScoreSource = z.infer<typeof ScoreSource>;

/** One fact behind a score: an eval trial, or the outcome of a production AgentRun. */
export const ScoreSignal = z.strictObject({
  score_id: z.string().min(1),
  source: ScoreSource,
  /** `<eval_run_id>/<case_id>/<trial>` or the production run id. */
  run_ref: z.string().min(1),
  /** `pass` / `fail` for an eval trial; the AgentRunVerdict for a production run. */
  verdict: z.string().min(1),
});
export type ScoreSignal = z.infer<typeof ScoreSignal>;

/** DM `AgentScore`: per (agent, prompt sha, provider, model). Rates are `null` while their denominator is 0. */
export const AgentScore = z.strictObject({
  score_id: z.string().min(1),
  agent_id: AgentId,
  prompt_sha256: Sha256Hex,
  provider: z.string().min(1),
  model: z.string().min(1),
  eval_runs: z.number().int().min(0),
  /** Of the newest eval run of each suite: trials, passes, rates. */
  eval_trials: z.number().int().min(0),
  pass_rate: z.number().min(0).max(1).nullable(),
  pass_k: z.number().min(0).max(1).nullable(),
  cost_per_pass_micro_usd: z.number().min(0).nullable(),
  status: z.enum(['pass', 'flaky', 'fail', 'unknown']),
  last_eval_at: IsoDateTime.nullable(),
  /** From production AgentRunOutcomes (M11.2) of the same agent, prompt, provider and model. */
  production_runs: z.number().int().min(0),
  production_judged: z.number().int().min(0),
  accept_rate: z.number().min(0).max(1).nullable(),
  sent_back_rate: z.number().min(0).max(1).nullable(),
  rework_rate: z.number().min(0).max(1).nullable(),
});
export type AgentScore = z.infer<typeof AgentScore>;

export const AgentScoresView = z.strictObject({ agent_id: AgentId, scores: z.array(AgentScore) });
export type AgentScoresView = z.infer<typeof AgentScoresView>;

// ---------------------------------------------------------------- compare and gate (the tool's verdicts)

export const EvalCompareResult = z.strictObject({
  level: z.number().gt(0).lt(1),
  baseline_id: z.string().nullable(),
  /** Cases compared (the baseline's; a case the run lacks counts as failed). */
  cases: z.number().int().min(0),
  candidate_pass_rate: z.number().min(0).max(1),
  baseline_pass_rate: z.number().min(0).max(1).nullable(),
  /** candidate minus baseline, mean over cases. */
  delta: z.number().nullable(),
  ci_low: z.number().nullable(),
  ci_high: z.number().nullable(),
  verdict: z.enum(['regression', 'improvement', 'no_change', 'no_baseline']),
});
export type EvalCompareResult = z.infer<typeof EvalCompareResult>;

export const EvalGateReason = z.enum([
  'significant_regression',
  'below_floor',
  'security_case_failed',
  'no_baseline',
  'errored_trials',
]);
export type EvalGateReason = z.infer<typeof EvalGateReason>;

export const EvalGateResult = z.strictObject({
  passed: z.boolean(),
  reasons: z.array(EvalGateReason),
  floor: z.number().min(0).max(1),
  pass_rate: z.number().min(0).max(1),
  compare: EvalCompareResult,
});
export type EvalGateResult = z.infer<typeof EvalGateResult>;
