import {
  summaryRows,
  foldAgentScores,
  runPassRate,
  caseCounts,
  type RunWithOutcome,
} from '@aisdlc/agents';
import {
  EVAL_EVENT,
  EvalRunRecord,
  evalStream,
  type AgentId,
  type AgentScore,
  type EvalRunHeader,
  type EvalSummaryRow,
  type ProjectId,
  type RecordEvent,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { runProjection, type Executor, type Projection, type Tx } from '@aisdlc/record';
import type pg from 'pg';
import { listAgentRunsOf } from './agent-runs.js';
import { coreError, type CoreError } from './errors.js';
import { inCoreTx, lockKeys, type CoreDeps } from './journal.js';

// Eval history in core (PLAN M11.3; DM §5.2 EvalRun, AgentScore). The eval TOOL (the evals package, `aisdlc-evals`)
// runs outside core and posts each finished run here; core records it and folds it. Core never loads
// an eval store, a case, a grader or a holdout: it holds ids, hashes, pass vectors and counts.

export const EVAL_ACTOR = 'system.evals';

/**
 * Records a run as `eval.run_recorded` on `eval:<suite>`, once per run id (a post that is sent twice
 * is the same run). `duplicate`: it was already recorded.
 */
export async function recordEvalRun(
  d: CoreDeps,
  raw: unknown,
): Promise<Result<{ duplicate: boolean }, CoreError>> {
  const p = EvalRunRecord.safeParse(raw);
  if (!p.success)
    return err(coreError('invalid_input', `not an eval run: ${p.error.issues[0]?.message ?? ''}`));
  const run = p.data;
  return inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [evalStream(run.suite_id)]);
    const w = await j.emitAll(evalStream(run.suite_id), [
      {
        type: EVAL_EVENT.run_recorded,
        body: run as unknown as Record<string, unknown>,
        actor: EVAL_ACTOR,
        idempotency_key: `eval.run:${run.eval_run_id}`,
      },
    ]);
    return w.ok ? ok({ duplicate: w.value.duplicate === true }) : w;
  });
}

export const evalRunProjection: Projection<{ runs: unknown[] }> = {
  name: 'eval_run',
  version: 1,
  tables: ['core.eval_run'],

  async apply(tx: Tx, e: RecordEvent) {
    if (e.type !== EVAL_EVENT.run_recorded) return;
    const r = EvalRunRecord.parse(e.payload);
    await tx.query(
      `INSERT INTO core.eval_run
         (eval_run_id, suite_id, project_tag, agent_id, profile, prompt_ref, prompt_sha256,
          contract_version, provider, model, harness_version, trigger, git_sha, store_id,
          manifest_digest, k, cases, cost_micro_usd, errored, started_at, ended_at, global_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::bigint)
       ON CONFLICT (eval_run_id) DO NOTHING`,
      [
        r.eval_run_id,
        r.suite_id,
        r.project_tag,
        r.agent_id,
        r.profile,
        r.prompt_ref,
        r.prompt_sha256,
        r.contract_version,
        r.provider,
        r.model,
        r.harness_version,
        r.trigger,
        r.git_sha,
        r.store_id,
        r.manifest_digest,
        r.k,
        JSON.stringify(r.cases),
        r.cost_micro_usd,
        r.errored,
        r.started_at,
        r.ended_at,
        String(e.global_seq),
      ],
    );
  },

  async reset(tx: Tx) {
    await tx.query('DELETE FROM core.eval_run');
  },

  async snapshot(db: Executor) {
    const q = await db.query('SELECT * FROM core.eval_run ORDER BY eval_run_id');
    return { runs: q.rows };
  },
};

export async function catchUpEvalRuns(pool: pg.Pool): Promise<void> {
  const r = await runProjection(pool, evalRunProjection);
  if (!r.ok) throw new Error('the eval_run read model needs a rebuild');
}

const iso = (v: unknown): string => (v as Date).toISOString();

const toRecord = (r: Record<string, unknown>): EvalRunRecord =>
  EvalRunRecord.parse({
    eval_run_id: r['eval_run_id'],
    suite_id: r['suite_id'],
    project_tag: r['project_tag'],
    agent_id: r['agent_id'],
    profile: r['profile'],
    prompt_ref: r['prompt_ref'],
    prompt_sha256: r['prompt_sha256'],
    contract_version: r['contract_version'],
    provider: r['provider'],
    model: r['model'],
    harness_version: r['harness_version'],
    trigger: r['trigger'],
    git_sha: r['git_sha'],
    store_id: r['store_id'],
    manifest_digest: r['manifest_digest'],
    k: r['k'],
    cases: r['cases'],
    cost_micro_usd: Number(r['cost_micro_usd']),
    errored: r['errored'],
    started_at: iso(r['started_at']),
    ended_at: iso(r['ended_at']),
  });

export interface EvalFilter {
  readonly suite?: string;
  readonly agent?: AgentId;
  /** The optional project tag: only runs of suites tagged with it. `null`: the whole fleet. */
  readonly project?: ProjectId | null;
}

async function loadRuns(pool: pg.Pool, f: EvalFilter): Promise<EvalRunRecord[]> {
  await catchUpEvalRuns(pool);
  const q = await pool.query(
    `SELECT * FROM core.eval_run
      WHERE ($1::text IS NULL OR suite_id = $1)
        AND ($2::text IS NULL OR agent_id = $2)
        AND ($3::text IS NULL OR project_tag = $3)
      ORDER BY ended_at, global_seq`,
    [f.suite ?? null, f.agent ?? null, f.project ?? null],
  );
  return q.rows.map(toRecord);
}

/** `GET /v1/evals/summary`: one row per task of the newest run of each suite and provider. Allow-listed fields. */
export async function evalSummary(
  pool: pg.Pool,
  project: ProjectId | null,
): Promise<EvalSummaryRow[]> {
  return summaryRows(await loadRuns(pool, { project }));
}

/** The history of a suite (or all), newest first: a trend needs nothing but these. */
export async function evalHistory(
  pool: pg.Pool,
  f: EvalFilter & { limit?: number },
): Promise<EvalRunHeader[]> {
  const runs = await loadRuns(pool, f);
  return runs
    .map((r): EvalRunHeader => {
      let trials = 0;
      let passes = 0;
      for (const c of r.cases) {
        const n = caseCounts(c);
        trials += n.trials;
        passes += n.passes;
      }
      return {
        eval_run_id: r.eval_run_id,
        suite_id: r.suite_id,
        project_tag: r.project_tag,
        agent_id: r.agent_id,
        profile: r.profile,
        prompt_ref: r.prompt_ref,
        prompt_sha256: r.prompt_sha256,
        contract_version: r.contract_version,
        provider: r.provider,
        model: r.model,
        harness_version: r.harness_version,
        trigger: r.trigger,
        git_sha: r.git_sha,
        manifest_digest: r.manifest_digest,
        k: r.k,
        cases: r.cases.length,
        trials,
        passes,
        pass_rate: runPassRate(r),
        cost_micro_usd: r.cost_micro_usd,
        errored: r.errored,
        started_at: r.started_at,
        ended_at: r.ended_at,
      };
    })
    .reverse()
    .slice(0, f.limit ?? 100);
}

/** Every eval run the record holds, oldest first (the floor's score chips fold them with every agent's runs). */
export const loadAllEvalRuns = (pool: pg.Pool): Promise<EvalRunRecord[]> => loadRuns(pool, {});

/** AgentScore of one agent per (prompt sha, provider, model): eval runs and production outcomes (M11.2). */
export async function agentScoresOf(pool: pg.Pool, agent: AgentId): Promise<AgentScore[]> {
  const runs = await loadRuns(pool, { agent });
  const production: RunWithOutcome[] = await listAgentRunsOf(pool, agent);
  return foldAgentScores(runs, production, agent);
}
