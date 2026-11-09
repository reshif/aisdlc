import {
  AgentScoresView,
  EVAL_SUMMARY_FIELDS,
  EvalRunRecord,
  EvalRunsView,
  EvalSummaryView,
  evalStream,
  type EvalCaseResult,
} from '@aisdlc/contracts';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { grantFleetRole, grantRole, seedPrincipals } from '@aisdlc/identity/testing';
import { newId } from '@aisdlc/kernel';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, evalRunProjection, type CoreScope } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// PLAN M11.3: eval run history in core. The eval tool posts finished runs; core records each as an
// `eval.run_recorded` event and folds `core.eval_run`; the summary, the history and AgentScore are
// reads of it, decided by the PDP. Real Postgres, the real PDP over the real identity read model.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const TOKENS = {
  evals: 'evals-at-core-'.padEnd(32, 'x'),
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  evals: ['evals'],
  bff: ['read', 'work'],
  reader: ['read'],
};
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const DIGEST = 'c'.repeat(64);

beforeAll(async () => {
  s = await startCoreStack();
  await seedPrincipals(s.id.deps, ['ada', 'aud', 'vic', 'eve']);
  await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
  await grantFleetRole(s.id.deps, 'aud', 'factory.auditor');
  await grantRole(s.id.deps, 'vic', 'project.viewer', { kind: 'project', ref: 'testbed' });
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: CALLERS,
    registry: s.registry,
    clock: s.clock,
    pdp,
    config: s.config,
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await s.stop();
});

async function call(token: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, json: (text ? JSON.parse(text) : null) as Json };
}
const get = (path: string, token = TOKENS.bff) => call(token, 'GET', path);

let tick = 0;
/** A run of suite `suite`: each case has `k` trials, `passing[i]` of them passing. */
function runOf(o: {
  suite: string;
  provider?: string;
  agent?: 'A1' | 'A5';
  sha?: string;
  model?: string;
  passing: number[];
  k?: number;
  tag?: string | null;
  security?: boolean;
}) {
  const k = o.k ?? 3;
  tick += 1;
  const at = new Date(Date.UTC(2026, 10, 9, 10, tick)).toISOString();
  const cases: EvalCaseResult[] = o.passing.map((p, i) => ({
    case_id: `${o.suite}-c${i + 1}`,
    kind: 'regression',
    security_tagged: o.security === true && i === 0,
    trials: Array.from({ length: k }, (_, t) => ({
      trial: t + 1,
      passed: t < p,
      failure_code: t < p ? null : ('grader_failed' as const),
      infra_error: false,
      tokens_in: 100,
      tokens_out: 20,
      cost_micro_usd: 7,
    })),
  }));
  return EvalRunRecord.parse({
    eval_run_id: newId<'EvalRun'>(Date.UTC(2026, 10, 9, 10, tick)),
    suite_id: o.suite,
    project_tag: o.tag ?? null,
    agent_id: o.agent ?? 'A1',
    profile: 'A1.classify',
    prompt_ref: 'a1_triage@1.0.0',
    prompt_sha256: o.sha ?? SHA,
    contract_version: '1.0.0',
    provider: o.provider ?? 'fake',
    model: o.model ?? 'fake-model',
    harness_version: 'aisdlc-evals/1',
    trigger: 'ci',
    git_sha: null,
    store_id: 'store-1',
    manifest_digest: DIGEST,
    k,
    cases,
    cost_micro_usd: cases.length * k * 7,
    errored: 0,
    started_at: at,
    ended_at: at,
  });
}

describe('POST /v1/evals/runs', () => {
  it('is for the eval tooling only, records a run once, and refuses anything that is not a run', async () => {
    const run = runOf({ suite: 'post', passing: [3, 3] });
    expect((await call(TOKENS.bff, 'POST', '/v1/evals/runs', run)).status).toBe(403);
    expect((await call(TOKENS.reader, 'POST', '/v1/evals/runs', run)).status).toBe(403);
    const first = await call(TOKENS.evals, 'POST', '/v1/evals/runs', run);
    expect(first.status).toBe(201);
    expect(first.json).toEqual({ recorded: true });
    const again = await call(TOKENS.evals, 'POST', '/v1/evals/runs', run);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ recorded: false });
    // it is in the record, on the suite's stream, once
    const q = await s.record.pool.query(
      'SELECT type, actor FROM record.record_event WHERE stream = $1',
      [evalStream('post')],
    );
    expect(q.rows).toEqual([{ type: 'eval.run_recorded', actor: 'system.evals' }]);
    // the contract has no field for an output or a prompt: a body that carries one is refused
    const leaky = { ...run, eval_run_id: newId<'EvalRun'>(), output: 'the agent said...' };
    expect((await call(TOKENS.evals, 'POST', '/v1/evals/runs', leaky)).status).toBe(400);
    expect((await call(TOKENS.evals, 'POST', '/v1/evals/runs', { nope: 1 })).status).toBe(400);
    expect(
      (await call(TOKENS.evals, 'POST', '/v1/evals/runs', { ...run, errored: 9 })).status,
    ).toBe(400);
  });
});

describe('history', () => {
  it('keeps every run, newest first, across runs and across a rebuild of the read model', async () => {
    const a = runOf({ suite: 'hist', passing: [3, 3, 3, 3] });
    const b = runOf({ suite: 'hist', passing: [3, 3, 2, 0] });
    const c = runOf({ suite: 'hist', passing: [3, 3, 3, 2], sha: SHA2 });
    for (const r of [a, b, c]) {
      expect((await call(TOKENS.evals, 'POST', '/v1/evals/runs', r)).status).toBe(201);
    }
    const r = await get('/v1/evals/runs?suite=hist&on_behalf_of=aud');
    expect(r.status).toBe(200);
    const view = EvalRunsView.parse(r.json);
    expect(view.runs.map((x) => x.eval_run_id)).toEqual([c, b, a].map((x) => x.eval_run_id));
    expect(view.runs.map((x) => x.pass_rate)).toEqual([11 / 12, 8 / 12, 1]);
    expect(view.runs[0]).toMatchObject({
      prompt_sha256: SHA2,
      provider: 'fake',
      model: 'fake-model',
      k: 3,
    });
    // the history is rebuildable from the record alone
    const snap = await expectRebuildEqualsLive(s.record.pool, evalRunProjection);
    expect(snap.runs.length).toBe(4);
    const after = EvalRunsView.parse(
      (await get('/v1/evals/runs?suite=hist&on_behalf_of=aud')).json,
    );
    expect(after).toEqual(view);
    expect(
      (await get('/v1/evals/runs?suite=hist&limit=2&on_behalf_of=aud')).json.runs,
    ).toHaveLength(2);
    expect((await get('/v1/evals/runs?limit=0&on_behalf_of=aud')).status).toBe(400);
    expect((await get('/v1/evals/runs?agent=A99&on_behalf_of=aud')).status).toBe(400);
  });
});

describe('GET /v1/evals/summary', () => {
  it('serves allow-listed fields only, from the newest run of each suite and provider', async () => {
    await call(TOKENS.evals, 'POST', '/v1/evals/runs', runOf({ suite: 'sum', passing: [3, 0, 2] }));
    await call(TOKENS.evals, 'POST', '/v1/evals/runs', runOf({ suite: 'sum', passing: [3, 3, 3] }));
    await call(
      TOKENS.evals,
      'POST',
      '/v1/evals/runs',
      runOf({ suite: 'sum', provider: 'other', passing: [3, 0, 2] }),
    );
    const r = await get('/v1/evals/summary?on_behalf_of=aud');
    expect(r.status).toBe(200);
    const view = EvalSummaryView.parse(r.json);
    expect(EVAL_SUMMARY_FIELDS).toEqual([
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
    for (const row of r.json.rows)
      expect(Object.keys(row).sort()).toEqual([...EVAL_SUMMARY_FIELDS].sort());
    const mine = view.rows.filter((x) => x.suite === 'sum');
    // newest fake run (all pass), plus the other provider's own newest run
    expect(mine.filter((x) => x.provider === 'fake').map((x) => x.status)).toEqual([
      'pass',
      'pass',
      'pass',
    ]);
    expect(mine.filter((x) => x.provider === 'other')).toEqual([
      expect.objectContaining({
        task_id: 'sum-c1',
        passes: 3,
        trials: 3,
        pass_rate: 1,
        pass_k: 1,
        k: 3,
        status: 'pass',
      }),
      expect.objectContaining({
        task_id: 'sum-c2',
        passes: 0,
        pass_rate: 0,
        pass_k: 0,
        status: 'fail',
      }),
      expect.objectContaining({ task_id: 'sum-c3', passes: 2, pass_k: 0, status: 'flaky' }),
    ]);
    // never a prompt, an output, a model, a hash or a cost
    const text = r.text;
    for (const banned of [
      SHA,
      DIGEST,
      'fake-model',
      'cost',
      'tokens',
      'prompt',
      'output',
      'failure',
      'grader_failed',
      'a1_triage',
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });

  it('is decided by the PDP: audit.read on the fleet; nobody else, and no scope, no read', async () => {
    for (const who of ['aud', 'ada']) {
      expect((await get(`/v1/evals/summary?on_behalf_of=${who}`)).status, who).toBe(200);
    }
    expect((await get('/v1/evals/summary?on_behalf_of=vic')).status).toBe(403);
    expect((await get('/v1/evals/summary?on_behalf_of=eve')).status).toBe(403);
    expect((await get('/v1/evals/summary')).status).toBe(400);
    expect((await get('/v1/evals/summary?on_behalf_of=aud', TOKENS.reader)).status).toBe(403);
    expect((await get('/v1/evals/summary?on_behalf_of=aud', TOKENS.evals)).status).toBe(403);
    expect((await get('/v1/evals/summary?project=Bad Id&on_behalf_of=aud')).status).toBe(400);
  });

  it('factory-wide with an optional project tag: the tag only filters', async () => {
    await call(
      TOKENS.evals,
      'POST',
      '/v1/evals/runs',
      runOf({ suite: 'tagged', passing: [3], tag: 'testbed' }),
    );
    const fleet = EvalSummaryView.parse((await get('/v1/evals/summary?on_behalf_of=aud')).json);
    expect(fleet.rows.map((x) => x.suite)).toEqual(
      expect.arrayContaining(['tagged', 'sum', 'hist']),
    );
    const tagged = await get('/v1/evals/summary?project=testbed&on_behalf_of=aud');
    expect(tagged.status).toBe(200);
    expect(EvalSummaryView.parse(tagged.json).rows.map((x) => x.suite)).toEqual(['tagged']);
    // a project viewer has no audit.read on the project
    expect((await get('/v1/evals/summary?project=testbed&on_behalf_of=vic')).status).toBe(403);
  });
});

describe('GET /v1/agents/:id/scores', () => {
  it('scores per (agent, prompt sha, provider, model) from the newest run of each suite', async () => {
    await call(
      TOKENS.evals,
      'POST',
      '/v1/evals/runs',
      runOf({ suite: 'sc', agent: 'A5', passing: [3, 3] }),
    );
    await call(
      TOKENS.evals,
      'POST',
      '/v1/evals/runs',
      runOf({ suite: 'sc', agent: 'A5', passing: [3, 1], sha: SHA2 }),
    );
    await call(
      TOKENS.evals,
      'POST',
      '/v1/evals/runs',
      runOf({ suite: 'sc', agent: 'A5', passing: [3, 3], sha: SHA2, model: 'other-model' }),
    );
    const r = await get('/v1/agents/A5/scores?on_behalf_of=aud');
    expect(r.status).toBe(200);
    const v = AgentScoresView.parse(r.json);
    expect(v.scores).toHaveLength(3);
    const by = (sha: string, model: string) =>
      v.scores.find((x) => x.prompt_sha256 === sha && x.model === model);
    expect(by(SHA, 'fake-model')).toMatchObject({
      status: 'pass',
      pass_rate: 1,
      pass_k: 1,
      eval_runs: 1,
      production_runs: 0,
      accept_rate: null,
    });
    expect(by(SHA2, 'fake-model')).toMatchObject({
      status: 'flaky',
      eval_trials: 6,
      pass_rate: 4 / 6,
      eval_runs: 1,
    });
    expect(by(SHA2, 'fake-model')?.cost_per_pass_micro_usd).toBeCloseTo((6 * 7) / 4, 10);
    expect(by(SHA2, 'other-model')?.status).toBe('pass');
    expect((await get('/v1/agents/A5/scores?on_behalf_of=vic')).status).toBe(403);
    expect((await get('/v1/agents/A99/scores?on_behalf_of=aud')).status).toBe(400);
    expect(
      AgentScoresView.parse((await get('/v1/agents/A10/scores?on_behalf_of=aud')).json).scores,
    ).toEqual([]);
  });
});
