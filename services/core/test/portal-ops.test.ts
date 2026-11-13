import {
  BudgetsView,
  CostView,
  ITEM_EVENT,
  OnboardReposView,
  type InstallationRepo,
  type Lane,
} from '@aisdlc/contracts';
import { hello, startTestGateway, type TestGateway } from '@aisdlc/gateway/testing';
import { bindProject, grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { withTransaction } from '@aisdlc/db';
import { appendEvents } from '@aisdlc/record';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetFromClient, createCoreApp, submitRequest, type CoreScope } from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import { loadReports, seedActivePrr, type Seeded } from './work-fixtures.js';

// P2-8 and P2-21 (docs/design/portal-review.md §12): budgets, cost and the onboard repo picker. Real Postgres, the
// real PDP over the real identity read model, and the REAL gateway on the same record database (fake provider):
// its metered `gateway.model_call` events are what the reads sum, and its admin API is the live view of a group.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by their contracts
type Json = any;

let s: CoreStack;
let gw: TestGateway;
let app: FastifyInstance;
let url: string;
let seeded: Seeded;
let repos: InstallationRepo[] | null = [];
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x'), reader: 'reader-at-core-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard', 'portal', 'work'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  gw = await startTestGateway({ database: s.record });
  await seedPrincipals(s.id.deps, ['ada', 'aud', 'ria']);
  await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
  await grantFleetRole(s.id.deps, 'aud', 'factory.auditor');
  seeded = await seedActivePrr(s, { level: 'light' });
  await bindProject(s.id, seeded.project, { requesters: ['ria'] });
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
    budgets: budgetFromClient(gw.admin()),
    installationRepos: {
      list_repos: async () =>
        repos === null
          ? { state: 'unknown', reason: 'server_error', message: 'down' }
          : { state: 'ok', value: repos },
    } as never,
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await gw?.stop();
  await s?.stop();
});

async function get(path: string, token = TOKENS.bff) {
  const res = await fetch(new URL(path, url), { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

describe('GET /v1/budgets (P2-8)', () => {
  it('sums what settled calls spent per group, says when ET1 was raised, and adds the gateway’s limits and reservations', async () => {
    const a = await gw.mint({
      budget_group: 'unit-spend-a',
      project_id: pid(seeded.project),
      budget: { max_tokens: 120, max_cost_micro_usd: 1_000_000 },
    });
    gw.provider.enqueue({ usage: { input_tokens: 70, output_tokens: 50 } });
    expect((await gw.messages(a.key, hello({ max_tokens: 60 }))).status).toBe(200);
    expect((await gw.messages(a.key, hello())).status).toBe(429); // spent: refused, nothing charged
    const b = await gw.mint({ budget_group: 'unit-spend-b', project_id: pid(seeded.project) });
    gw.provider.enqueue({ usage: { input_tokens: 10, output_tokens: 5 } });
    expect((await gw.messages(b.key, hello())).status).toBe(200);
    await gw.mint({ budget_group: 'unit-idle', project_id: pid(seeded.project) });

    const r = await get('/v1/budgets?on_behalf_of=ada');
    expect(r.status).toBe(200);
    const v = BudgetsView.parse(r.json);
    expect(v.gateway).toBe(true);
    const by = new Map(v.groups.map((g) => [g.budget_group, g]));
    const ga = by.get('unit-spend-a');
    expect(ga).toMatchObject({
      calls: 1,
      refused: 1,
      used_tokens: 120,
      exhausted_limit: 'tokens',
      project_ids: [seeded.project],
    });
    expect(ga?.exhausted_at).not.toBeNull();
    expect(ga?.live).toMatchObject({ max_tokens: 120, used_tokens: 120, reserved_tokens: 0 });
    expect(by.get('unit-spend-b')).toMatchObject({ calls: 1, used_tokens: 15, exhausted_at: null });
    // a group with a key and no call yet is listed, with nothing spent
    expect(by.get('unit-idle')).toMatchObject({ calls: 0, used_tokens: 0, last_call_at: null });
  });

  it('is ops.read on the fleet: an auditor reads it, a requester and a missing person do not', async () => {
    expect((await get('/v1/budgets?on_behalf_of=aud')).status).toBe(200);
    const ria = await get('/v1/budgets?on_behalf_of=ria');
    expect(ria.status).toBe(403);
    expect(ria.json.error.message).toBe('ops.read denied');
    expect((await get('/v1/budgets')).status).toBe(400);
    expect((await get('/v1/budgets?on_behalf_of=ada', TOKENS.reader)).status).toBe(403);
  });
});

describe('GET /v1/cost (P2-8)', () => {
  it('spend per day and project, per outcome, and per merged item', async () => {
    const created = await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: 'L3' as Lane,
      requester: pr('ria'),
      channel: 'N1',
      text: 'Export the invoices as CSV.',
    });
    if (!created.ok) throw new Error(created.error.message);
    const item = created.value.item_id as string;
    const k = await gw.mint({
      budget_group: `unit-${item}`,
      project_id: pid(seeded.project),
      item_id: item,
    });
    gw.provider.enqueue({ usage: { input_tokens: 100, output_tokens: 20 } });
    expect((await gw.messages(k.key, hello())).status).toBe(200);
    gw.provider.enqueue({ usage: { input_tokens: 30, output_tokens: 10 } });
    expect((await gw.messages(k.key, hello())).status).toBe(200);
    // 8.2: the human merged and the factory observed it (the merge itself is never the factory's)
    const head = await s.record.pool.query<{ n: string }>(
      `SELECT max(seq)::text AS n FROM record.record_event WHERE stream = $1`,
      [`item:${item}`],
    );
    const appended = await withTransaction(s.record.pool, (tx) =>
      appendEvents(tx, `item:${item}`, Number(head.rows[0]?.n), [
        {
          type: ITEM_EVENT.merge_observed,
          body: { merged_sha: 'a'.repeat(40) },
          actor: 'system.codehost',
        },
      ]),
    );
    expect(appended.ok).toBe(true);

    const r = await get('/v1/cost?on_behalf_of=aud&days=7');
    expect(r.status).toBe(200);
    const v = CostView.parse(r.json);
    expect(v.days).toBe(7);
    const mine = v.merged_items.find((m) => m.item_id === item);
    expect(mine).toMatchObject({ project_id: seeded.project, calls: 2, tokens: 160, lane: 'L3' });
    const day = v.by_day.find((d) => d.project_id === seeded.project);
    expect(day?.calls).toBeGreaterThanOrEqual(2);
    expect(v.by_outcome.map((o) => o.outcome)).toContain('ok');
    // only merged items are costed per item
    expect(v.merged_items.every((m) => m.item_id === item)).toBe(true);
  });

  it('is quality.read on the fleet, and days is 1 to 366', async () => {
    expect((await get('/v1/cost?on_behalf_of=ria')).status).toBe(403);
    expect((await get('/v1/cost?on_behalf_of=ada&days=0')).status).toBe(400);
    expect((await get('/v1/cost?on_behalf_of=ada&days=400')).status).toBe(400);
    expect((await get('/v1/cost?on_behalf_of=ada')).json.days).toBe(30);
  });
});

describe('GET /v1/onboarding/repos (P2-21)', () => {
  it('lists the installation’s repos, sorted, with the ones a project already holds marked', async () => {
    const [owner, name] = seeded.repo.split('/') as [string, string];
    repos = [
      { full_name: 'zeta/app', default_branch: 'main', private: true, archived: false },
      {
        full_name: `${owner.toUpperCase()}/${name}` as never,
        default_branch: 'main',
        private: false,
        archived: false,
      },
    ];
    const r = await get('/v1/onboarding/repos?on_behalf_of=ada');
    expect(r.status).toBe(200);
    const v = OnboardReposView.parse(r.json);
    expect(v.repos.map((x) => [x.full_name, x.registered])).toEqual([
      [`${owner.toUpperCase()}/${name}`, true],
      ['zeta/app', false],
    ]);
  });

  it('is project.onboard on the fleet; a code host that does not answer is a 502, never an empty list', async () => {
    expect((await get('/v1/onboarding/repos?on_behalf_of=ria')).status).toBe(403);
    repos = null;
    expect((await get('/v1/onboarding/repos?on_behalf_of=ada')).status).toBe(502);
    repos = [];
  });
});
