import { bindProject, grantFleetRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { startFakeCore, type FakeCore } from './portal-fixtures.js';

// The portal's operate and govern gaps (docs/design/portal-review.md §12): budgets and cost (P2-8), breakers (P2-11),
// banners (P2-12), the provider test and reload at the gateway (P2-5) and the onboard repo picker (P2-21). The PDP
// decides here for the signed-in person before core or the gateway is asked; the person is always the session's.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Who = 'alice' | 'bob' | 'carol' | 'root';

let s: BffStack;
let core: FakeCore;
let gw: FakeCore;
const sessions = new Map<Who, { browser: Browser; csrf: string }>();

async function as(who: Who) {
  const known = sessions.get(who);
  if (known) return known;
  const { browser } = await signIn(s, who);
  const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
  const v = { browser, csrf: me.csrf_token as string };
  sessions.set(who, v);
  return v;
}

async function api(who: Who, method: 'GET' | 'POST', path: string, body?: unknown) {
  const v = await as(who);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = v.csrf;
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

const T = '2026-11-12T10:00:00.000Z';
const budgets = {
  as_of: T,
  gateway: true,
  groups: [
    {
      budget_group: 'unit-1',
      project_ids: ['acme'],
      item_ids: [],
      calls: 2,
      refused: 1,
      used_tokens: 120,
      used_cost_micro_usd: 900,
      last_call_at: T,
      exhausted_at: T,
      exhausted_limit: 'tokens',
      live: null,
    },
  ],
};
const cost = {
  as_of: T,
  since: '2026-11-06T00:00:00.000Z',
  days: 7,
  by_day: [
    {
      day: '2026-11-12',
      project_id: 'acme',
      calls: 2,
      tokens_in: 100,
      tokens_out: 20,
      cost_micro_usd: 900,
    },
  ],
  by_outcome: [{ outcome: 'ok', calls: 2, cost_micro_usd: 900 }],
  merged_items: [],
};
const breaker = {
  project_id: 'acme',
  lane: 'L3',
  counts: { rework_budget: 3 },
  total: 3,
  threshold: 3,
  tripped: true,
  tripped_at: T,
  pending_reset: null,
  resets: 0,
};
const GATE = '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a92';

beforeAll(async () => {
  core = await startFakeCore();
  gw = await startFakeCore();
  s = await startBffStack({ override: { core: core.client, gateway: gw.client } });
  // alice: acme's admin; bob: an acme requester; root: factory admin; carol: nothing
  await bindProject(s.identity, 'acme', { admin: ['alice'], requesters: ['bob'] });
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
});
afterAll(async () => {
  await s?.stop();
  await core?.stop();
  await gw?.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
  gw.seen.length = 0;
  gw.override.clear();
});

describe('budgets and cost (P2-8)', () => {
  it('a factory admin reads them; someone without ops.read or quality.read is refused before core is asked', async () => {
    core.override.set('GET /v1/budgets?on_behalf_of=root', { status: 200, json: budgets });
    core.override.set('GET /v1/cost?on_behalf_of=root&days=7', { status: 200, json: cost });
    const b = await api('root', 'GET', '/api/budgets');
    expect(b.status).toBe(200);
    expect(b.json.groups[0]).toMatchObject({ budget_group: 'unit-1', exhausted_limit: 'tokens' });
    const c = await api('root', 'GET', '/api/cost?days=7');
    expect(c.status).toBe(200);
    expect(c.json.by_day[0].cost_micro_usd).toBe(900);
    core.seen.length = 0;
    expect((await api('carol', 'GET', '/api/budgets')).status).toBe(403);
    expect((await api('bob', 'GET', '/api/cost')).status).toBe(403);
    expect(core.seen).toHaveLength(0);
    expect((await api('root', 'GET', '/api/cost?days=0')).status).toBe(400);
  });

  it('a core answer that is not the contract’s shape is a 502, never shown in part', async () => {
    core.override.set('GET /v1/budgets?on_behalf_of=root', {
      status: 200,
      json: { ...budgets, groups: [{ budget_group: 'x' }] },
    });
    expect((await api('root', 'GET', '/api/budgets')).status).toBe(502);
  });
});

describe('breakers (P2-11)', () => {
  it('project.view reads them; the reset is a config.propose there and opens the M5 gate', async () => {
    core.override.set('GET /v1/projects/acme/breakers?on_behalf_of=alice', {
      status: 200,
      json: { breakers: [breaker] },
    });
    const r = await api('alice', 'GET', '/api/projects/acme/breakers');
    expect(r.status).toBe(200);
    expect(r.json.breakers[0]).toMatchObject({ lane: 'L3', tripped: true });
    expect((await api('carol', 'GET', '/api/projects/acme/breakers')).status).toBe(403);

    core.override.set('POST /v1/projects/acme/breakers/L3/reset', {
      status: 201,
      json: { gate_instance_id: GATE, subject_hash: 'a'.repeat(64) },
    });
    const reset = await api('alice', 'POST', '/api/projects/acme/breakers/L3/reset', {});
    expect(reset.status).toBe(201);
    expect(reset.json.gate_instance_id).toBe(GATE);
    expect(core.seen.find((x) => x.method === 'POST')?.body).toEqual({ on_behalf_of: 'alice' });
    core.seen.length = 0;
    expect((await api('bob', 'POST', '/api/projects/acme/breakers/L3/reset', {})).status).toBe(403);
    expect((await api('alice', 'POST', '/api/projects/acme/breakers/L99/reset', {})).status).toBe(
      400,
    );
    expect(core.seen).toHaveLength(0);
  });
});

describe('banners (P2-12)', () => {
  const body = (scope: unknown) => ({
    scope,
    severity: 'warning',
    text: 'Maintenance tonight at 22:00',
    expires_at: '2026-11-13T22:00:00.000Z',
  });

  it('banner.publish on the scope here, then core with the person named', async () => {
    core.override.set('POST /v1/banners', {
      status: 201,
      json: { banner_id: GATE, text: 'Maintenance tonight at 22:00' },
    });
    const ok = await api('alice', 'POST', '/api/banners', body({ kind: 'project', ref: 'acme' }));
    expect(ok.status).toBe(201);
    expect(core.seen.at(-1)?.body).toMatchObject({
      on_behalf_of: 'alice',
      scope: { kind: 'project', ref: 'acme' },
    });
    core.seen.length = 0;
    // a project admin is not a fleet admin; a requester publishes nothing; the body never names someone else
    expect(
      (await api('alice', 'POST', '/api/banners', body({ kind: 'fleet', ref: '*' }))).status,
    ).toBe(403);
    expect(
      (await api('bob', 'POST', '/api/banners', body({ kind: 'project', ref: 'acme' }))).status,
    ).toBe(403);
    expect(
      (
        await api('alice', 'POST', '/api/banners', {
          ...body({ kind: 'project', ref: 'acme' }),
          on_behalf_of: 'root',
        })
      ).status,
    ).toBe(400);
    expect(core.seen).toHaveLength(0);
    expect(
      (await api('root', 'POST', '/api/banners', body({ kind: 'fleet', ref: '*' }))).status,
    ).toBe(201);
  });
});

describe('the onboard repo picker (P2-21)', () => {
  it('project.onboard on the fleet, then core’s list of the installation’s repos', async () => {
    core.override.set('GET /v1/onboarding/repos?on_behalf_of=root', {
      status: 200,
      json: {
        repos: [
          {
            full_name: 'acme/web',
            default_branch: 'main',
            private: true,
            archived: false,
            registered: true,
          },
        ],
      },
    });
    const r = await api('root', 'GET', '/api/onboard/repos');
    expect(r.status).toBe(200);
    expect(r.json.repos[0]).toMatchObject({ full_name: 'acme/web', registered: true });
    expect((await api('carol', 'GET', '/api/onboard/repos')).status).toBe(403);
  });
});

describe('model providers at the gateway (P2-5)', () => {
  const result = {
    integration_id: 'anthropic',
    model_id: 'claude-haiku',
    outcome: 'ok',
    code: null,
    tokens_in: 3,
    tokens_out: 1,
    cost_micro_usd: 8,
    latency_ms: 120,
    at: T,
  };

  it('test and reload are config.propose on the fleet; the gateway is told who asked', async () => {
    gw.override.set('POST /v1/admin/providers/anthropic/test', { status: 200, json: result });
    gw.override.set('POST /v1/admin/reload', {
      status: 200,
      json: {
        revision: 'r1',
        integrations: [
          { integration_id: 'anthropic', adapter: 'anthropic', state: 'built', detail: 'ok' },
        ],
      },
    });
    const t = await api('root', 'POST', '/api/models/providers/anthropic/test', {});
    expect(t.status).toBe(200);
    expect(t.json).toMatchObject({ outcome: 'ok', tokens_in: 3 });
    expect(gw.seen.at(-1)?.body).toEqual({ tested_by: 'root' });
    const rl = await api('root', 'POST', '/api/models/reload', { force: true });
    expect(rl.status).toBe(200);
    expect(gw.seen.at(-1)?.body).toEqual({ force: true });
    gw.seen.length = 0;
    expect((await api('alice', 'POST', '/api/models/providers/anthropic/test', {})).status).toBe(
      403,
    );
    expect((await api('alice', 'POST', '/api/models/reload', {})).status).toBe(403);
    expect((await api('root', 'POST', '/api/models/providers/Bad%20Id/test', {})).status).toBe(400);
    expect(gw.seen).toHaveLength(0);
  });

  it('the adapter list carries the bounds; a gateway that does not answer is a 502', async () => {
    gw.override.set('GET /v1/admin/integrations', {
      status: 200,
      json: {
        revision: 'r1',
        integrations: [],
        bounds: {
          secret_refs: ['file:/run/secrets/anthropic'],
          egress_hosts: ['api.anthropic.com'],
        },
      },
    });
    const r = await api('root', 'GET', '/api/models/providers');
    expect(r.status).toBe(200);
    expect(r.json.bounds.egress_hosts).toEqual(['api.anthropic.com']);
    gw.override.set('GET /v1/admin/integrations', { status: 500, json: {} });
    expect((await api('root', 'GET', '/api/models/providers')).status).toBe(502);
    expect((await api('carol', 'GET', '/api/models/providers')).status).toBe(403);
  });
});
