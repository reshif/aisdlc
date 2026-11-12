import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindProject, grantFleetRole } from '@aisdlc/identity/testing';
import { Browser, signIn, startBffStack, type BffStack } from '../src/testing.js';
import {
  CARD_ID,
  CORE_TOKEN,
  GATE_ID,
  ITEM_ID,
  HANDOFF_ID,
  agentRunsFixture,
  handoffFixture,
  handoffViewFixture,
  itemViewFixture,
  S0_ID,
  startFakeCore,
  type FakeCore,
} from './portal-fixtures.js';

// The portal's /api routes (PLAN M8.1): every one needs a session, the CSRF token on a write, the
// PDP's yes for the signed-in principal, and sends core the bff's token and the principal from the
// session, never a cookie and never a principal the browser named.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: BffStack;
let core: FakeCore;
const sessions = new Map<string, { browser: Browser; csrf: string }>();

async function as(who: 'alice' | 'bob' | 'carol' | 'dora' | 'root') {
  const known = sessions.get(who);
  if (known) return known;
  const { browser } = await signIn(s, who);
  const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
  const v = { browser, csrf: me.csrf_token as string };
  sessions.set(who, v);
  return v;
}

async function api(
  who: 'alice' | 'bob' | 'carol' | 'dora' | 'root' | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  o: { csrf?: boolean | string } = {},
) {
  const v = who ? await as(who) : { browser: new Browser(), csrf: '' };
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST' && o.csrf !== false) {
    headers['x-csrf-token'] = typeof o.csrf === 'string' ? o.csrf : v.csrf;
  }
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null, res };
}

beforeAll(async () => {
  core = await startFakeCore();
  s = await startBffStack({ override: { core: core.client } });
  await bindProject(s.identity, 'acme', {
    admin: ['alice'],
    intent: ['bob'],
    kill: ['carol'],
    design: ['bob'],
    x: ['bob'],
  });
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
});
afterAll(async () => {
  await s.stop();
  await core.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
  core.projectOfRecords = 'acme';
});

const ONBOARD = { project_id: 'acme', repo: 'acme/web', level: 'census' };

interface RouteCase {
  readonly name: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /** Someone the PDP allows, and someone it denies. */
  readonly allowed: 'alice' | 'root' | 'bob';
  readonly denied: 'dora' | 'carol' | 'alice' | 'bob';
  readonly forwards: string;
}

const CASES: RouteCase[] = [
  {
    name: 'project detail',
    method: 'GET',
    path: '/api/projects/acme',
    allowed: 'alice',
    denied: 'dora',
    forwards: 'GET /v1/projects/acme/overview',
  },
  {
    name: 'request onboarding',
    method: 'POST',
    path: '/api/onboard',
    body: ONBOARD,
    allowed: 'root',
    denied: 'alice',
    forwards: 'POST /v1/onboard',
  },
  {
    name: 'ask for work (portal Ask)',
    method: 'POST',
    path: '/api/requests',
    body: {
      project_id: 'acme',
      repo: 'acme/web',
      lane: 'L3',
      text: 'Add pagination to the orders list.',
    },
    allowed: 'alice',
    denied: 'dora',
    forwards: 'POST /v1/requests',
  },
  {
    name: 'a work item',
    method: 'GET',
    path: `/api/items/${ITEM_ID}`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/items/${ITEM_ID}?on_behalf_of=alice`,
  },
  {
    name: 'Ready decision on an item (1.6)',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/ready`,
    body: {},
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/items/${ITEM_ID}/ready`,
  },
  {
    name: 'answer to a clarification question',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/answers`,
    body: { question_id: 'q1', text: 'the orders table' },
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/items/${ITEM_ID}/answers`,
  },
  {
    name: 'observed B4 during G3d',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/observe`,
    body: { edge: 'B4', reason_code: 'spec_gap', key: 'k1' },
    allowed: 'bob',
    denied: 'alice',
    forwards: `POST /v1/items/${ITEM_ID}/observe`,
  },
  {
    name: 'observed R2 during G3d',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/observe`,
    body: { edge: 'R2', to_lane: 'L3', reason_code: 'smaller_than_lane', key: 'k2' },
    allowed: 'bob',
    denied: 'carol',
    forwards: `POST /v1/items/${ITEM_ID}/observe`,
  },
  {
    name: 'the plan a person writes (B5)',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/plan`,
    body: { key: 'p1', split: { units: [] }, sequence: {}, tasks: {}, verification: {} },
    allowed: 'bob',
    denied: 'alice',
    forwards: `POST /v1/items/${ITEM_ID}/plan`,
  },
  {
    name: 'D5: the human-led work is done (M14.6)',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/human-done`,
    body: { key: 'd1' },
    allowed: 'bob',
    denied: 'alice',
    forwards: `POST /v1/items/${ITEM_ID}/human-done`,
  },
  {
    name: 'D4: the developer hands the item back (P1-4)',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/hand-back`,
    body: { plan_changed: false, key: 'h1' },
    allowed: 'bob',
    denied: 'alice',
    forwards: `POST /v1/items/${ITEM_ID}/hand-back`,
  },
  {
    name: 'the handoff panel of an item (P1-4)',
    method: 'GET',
    path: `/api/items/${ITEM_ID}/handoff`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/items/${ITEM_ID}/handoff?on_behalf_of=alice`,
  },
  {
    name: 'the agent runs of an item',
    method: 'GET',
    path: `/api/agent-runs?item=${ITEM_ID}`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/agent-runs?item=${ITEM_ID}&on_behalf_of=alice`,
  },
  {
    name: 'stats of an agent over one project',
    method: 'GET',
    path: '/api/agents/coder/stats?project=acme',
    allowed: 'alice',
    denied: 'dora',
    forwards: 'GET /v1/agents/coder/stats?on_behalf_of=alice&project=acme',
  },
  {
    name: 'stats of an agent over the fleet',
    method: 'GET',
    path: '/api/agents/A2/stats',
    allowed: 'root',
    denied: 'alice',
    forwards: 'GET /v1/agents/A2/stats?on_behalf_of=root',
  },
  {
    name: 'the eval summary over the fleet',
    method: 'GET',
    path: '/api/evals/summary',
    allowed: 'root',
    denied: 'alice',
    forwards: 'GET /v1/evals/summary?on_behalf_of=root',
  },
  {
    name: 'the eval summary of one project tag',
    method: 'GET',
    path: '/api/evals/summary?project=acme',
    allowed: 'alice',
    denied: 'dora',
    forwards: 'GET /v1/evals/summary?on_behalf_of=alice&project=acme',
  },
  {
    name: 'the eval history',
    method: 'GET',
    path: '/api/evals/runs?suite=triage&limit=5',
    allowed: 'root',
    denied: 'alice',
    forwards: 'GET /v1/evals/runs?on_behalf_of=root&suite=triage&limit=5',
  },
  {
    name: 'the scores of an agent',
    method: 'GET',
    path: '/api/agents/A1/scores',
    allowed: 'root',
    denied: 'alice',
    forwards: 'GET /v1/agents/A1/scores?on_behalf_of=root',
  },
  {
    name: 'S0 overview',
    method: 'GET',
    path: `/api/s0/${S0_ID}`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/s0/${S0_ID}`,
  },
  {
    name: 'card list',
    method: 'GET',
    path: `/api/s0/${S0_ID}/cards`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/s0/${S0_ID}/cards`,
  },
  {
    name: 'card detail',
    method: 'GET',
    path: `/api/cards/${CARD_ID}`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/cards/${CARD_ID}`,
  },
  {
    name: 'artefacts of a work-item gate card',
    method: 'GET',
    path: `/api/cards/${CARD_ID}/artefacts`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/cards/${CARD_ID}/artefacts`,
  },
  {
    name: 'gate card view (work item)',
    method: 'GET',
    path: `/api/cards/${CARD_ID}/gate`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/cards/${CARD_ID}/gate`,
  },
  {
    name: 'gate card prepare',
    method: 'POST',
    path: `/api/cards/${CARD_ID}/gate/prepare`,
    body: {},
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/cards/${CARD_ID}/gate/prepare`,
  },
  {
    name: 'gate card evidence',
    method: 'POST',
    path: `/api/cards/${CARD_ID}/gate/evidence`,
    body: { views: [{ nonce: 'n', evidence_hash: 'b'.repeat(64) }] },
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/cards/${CARD_ID}/gate/evidence`,
  },
  {
    name: 'gate card decide',
    method: 'POST',
    path: `/api/cards/${CARD_ID}/gate/decide`,
    body: { decision: 'reject', reason: 'why', votes: [{ nonce: 'n' }] },
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/cards/${CARD_ID}/gate/decide`,
  },
  {
    name: 'card prepare',
    method: 'POST',
    path: `/api/cards/${CARD_ID}/prepare`,
    body: {},
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/cards/${CARD_ID}/prepare`,
  },
  {
    name: 'card evidence',
    method: 'POST',
    path: `/api/cards/${CARD_ID}/evidence`,
    body: { nonce: 'n', evidence_hash: 'b'.repeat(64) },
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/cards/${CARD_ID}/evidence`,
  },
  {
    name: 'card decide',
    method: 'POST',
    path: `/api/cards/${CARD_ID}/decide`,
    body: { nonce: 'n', decision: 'approve', content: { gaps: [] } },
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/cards/${CARD_ID}/decide`,
  },
  {
    name: 're-check',
    method: 'POST',
    path: `/api/cards/${CARD_ID}/recheck`,
    body: {},
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/cards/${CARD_ID}/recheck`,
  },
  {
    name: 'card 2 instruction edit',
    method: 'POST',
    path: `/api/cards/${CARD_ID}/instructions`,
    body: { path: 'AGENTS.md', text: '# app\n', base_text_sha256: null },
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/cards/${CARD_ID}/instructions`,
  },
  {
    name: 'card 2 probe retry',
    method: 'POST',
    path: `/api/cards/${CARD_ID}/probe/retry`,
    body: {},
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/cards/${CARD_ID}/probe/retry`,
  },
  {
    name: 'settings revision of a record',
    method: 'GET',
    path: `/api/s0/${S0_ID}/revision`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/s0/${S0_ID}/revision`,
  },
  {
    name: 'settings revision by gate',
    method: 'GET',
    path: `/api/revisions/${GATE_ID}`,
    allowed: 'alice',
    denied: 'dora',
    forwards: `GET /v1/revisions/${GATE_ID}`,
  },
  {
    name: 'revision prepare',
    method: 'POST',
    path: `/api/revisions/${GATE_ID}/prepare`,
    body: {},
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/revisions/${GATE_ID}/prepare`,
  },
  {
    name: 'revision evidence',
    method: 'POST',
    path: `/api/revisions/${GATE_ID}/evidence`,
    body: { nonce: 'n', evidence_hash: 'b'.repeat(64) },
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/revisions/${GATE_ID}/evidence`,
  },
  {
    name: 'revision decide',
    method: 'POST',
    path: `/api/revisions/${GATE_ID}/decide`,
    body: { nonce: 'n', decision: 'approve' },
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/revisions/${GATE_ID}/decide`,
  },
  {
    name: 'revision publish',
    method: 'POST',
    path: `/api/revisions/${GATE_ID}/publish`,
    body: {},
    allowed: 'alice',
    denied: 'dora',
    forwards: `POST /v1/revisions/${GATE_ID}/publish`,
  },
  {
    name: 'readiness records of a project',
    method: 'GET',
    path: '/api/projects/acme/prr',
    allowed: 'alice',
    denied: 'dora',
    forwards: 'GET /v1/projects/acme/prr',
  },
  {
    name: 'ledger entries of a project',
    method: 'GET',
    path: '/api/projects/acme/ledger',
    allowed: 'alice',
    denied: 'dora',
    forwards: 'GET /v1/projects/acme/ledger',
  },
];

describe.each(CASES)('$name ($method $path)', (c) => {
  it('unauthenticated: 401 and core is never called', async () => {
    const r = await api(null, c.method, c.path, c.body, { csrf: false });
    expect(r.status).toBe(401);
    expect(core.seen).toHaveLength(0);
  });

  if (c.method === 'POST') {
    it('without the CSRF token, or with a wrong one: 403 and core is never called', async () => {
      const none = await api(c.allowed, 'POST', c.path, c.body, { csrf: false });
      expect(none.status).toBe(403);
      expect(none.json.error.code).toBe('csrf_failed');
      const wrong = await api(c.allowed, 'POST', c.path, c.body, { csrf: 'x'.repeat(43) });
      expect(wrong.status).toBe(403);
      expect(core.seen).toHaveLength(0);
    });
  }

  it('denied by the PDP: 403, and nothing is forwarded that acts', async () => {
    const r = await api(c.denied, c.method, c.path, c.body);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden');
    // Whatever was read to find the project, nothing that writes or shows the thing was called.
    expect(core.seen.filter((x) => x.method === 'POST')).toHaveLength(0);
    // (The S0 overview and the artefacts of a work-item card are themselves the read that finds the
    // project; their body is not passed on.)
    if (
      c.name !== 'S0 overview' &&
      c.name !== 'settings revision by gate' &&
      c.name !== 'artefacts of a work-item gate card' &&
      !c.name.startsWith('gate card')
    ) {
      expect(core.seen.map((x) => `${x.method} ${x.path}`)).not.toContain(c.forwards);
    }
  });

  it('allowed: forwarded with the bff token and no browser credential, answer returned', async () => {
    const r = await api(c.allowed, c.method, c.path, c.body);
    expect(r.status).toBeLessThan(300);
    const sent = core.seen.find((x) => `${x.method} ${x.path}` === c.forwards);
    expect(
      sent,
      `core saw ${core.seen.map((x) => `${x.method} ${x.path}`).join(', ')}`,
    ).toBeDefined();
    for (const x of core.seen) {
      expect(x.headers.authorization).toBe(`Bearer ${CORE_TOKEN}`);
      expect(x.headers.cookie).toBeUndefined();
      expect(x.headers['x-csrf-token']).toBeUndefined();
      expect(x.headers.origin).toBeUndefined();
    }
    if (c.method === 'POST') {
      expect((sent?.body as Json).on_behalf_of).toBe(c.allowed);
    }
  });

  if (c.method === 'POST' && c.body !== undefined && Object.keys(c.body as object).length > 0) {
    it('the browser cannot name the principal: a body with on_behalf_of is refused', async () => {
      const r = await api(c.allowed, 'POST', c.path, {
        ...(c.body as object),
        on_behalf_of: 'root',
      });
      expect(r.status).toBe(400);
      expect(core.seen.filter((x) => x.method === 'POST')).toHaveLength(0);
    });
  }
});

describe('agent runs (M11.2)', () => {
  it('refuse a bad item, a bad agent and extra query parameters before core is asked', async () => {
    expect((await api('alice', 'GET', '/api/agent-runs?item=nope')).status).toBe(400);
    expect((await api('alice', 'GET', '/api/agent-runs')).status).toBe(400);
    expect((await api('alice', 'GET', `/api/agent-runs?item=${ITEM_ID}&x=1`)).status).toBe(400);
    expect((await api('root', 'GET', '/api/agents/A99/stats')).status).toBe(400);
    expect((await api('root', 'GET', '/api/agents/coder/stats?project=Bad Id')).status).toBe(400);
    expect(core.seen).toHaveLength(0);
  });

  it('the project of a run list is decided on the project core says the item is in', async () => {
    core.override.set(`GET /v1/agent-runs?item=${ITEM_ID}&on_behalf_of=alice`, {
      status: 200,
      json: { ...agentRunsFixture(), project_id: 'secret' },
    });
    const r = await api('alice', 'GET', `/api/agent-runs?item=${ITEM_ID}`);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden');
  });
});

describe('evals (M11.3)', () => {
  it('refuse a bad query, a bad project and a bad agent before core is asked', async () => {
    expect((await api('root', 'GET', '/api/evals/summary?x=1')).status).toBe(400);
    expect((await api('root', 'GET', '/api/evals/summary?project=Bad Id')).status).toBe(400);
    expect((await api('root', 'GET', '/api/evals/runs?limit=')).status).toBe(400);
    expect((await api('root', 'GET', '/api/agents/A99/scores')).status).toBe(400);
    expect(core.seen).toHaveLength(0);
  });

  it('serve the allow-listed rows and nothing else', async () => {
    const r = await api('root', 'GET', '/api/evals/summary');
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.rows[0]).sort()).toEqual(
      [
        'k',
        'pass_k',
        'pass_rate',
        'passes',
        'profile',
        'provider',
        'status',
        'suite',
        'task_id',
        'trials',
      ].sort(),
    );
    // a core that answered with more than the contract allows is not passed on
    core.override.set('GET /v1/evals/summary?on_behalf_of=root', {
      status: 200,
      json: { rows: [{ ...r.json.rows[0], output: 'the agent said...', cost_micro_usd: 5 }] },
    });
    const leaky = await api('root', 'GET', '/api/evals/summary');
    expect(leaky.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(leaky.json)).not.toContain('the agent said');
  });
});

describe('project list', () => {
  it('unauthenticated: 401', async () => {
    expect((await api(null, 'GET', '/api/projects')).status).toBe(401);
    expect(core.seen).toHaveLength(0);
  });

  it('returns only the projects the PDP lets the principal view', async () => {
    const alice = await api('alice', 'GET', '/api/projects');
    expect(alice.status).toBe(200);
    expect(alice.json.map((p: Json) => p.project.project_id)).toEqual(['acme']);
    const root = await api('root', 'GET', '/api/projects');
    expect(root.json.map((p: Json) => p.project.project_id)).toEqual(['acme', 'secret']);
    expect((await api('dora', 'GET', '/api/projects')).json).toEqual([]);
    for (const x of core.seen) expect(x.headers.cookie).toBeUndefined();
  });
});

describe('the cards a person may decide', () => {
  it('lists with may_decide from the PDP: true for the project admin, false for a viewer', async () => {
    const alice = await api('alice', 'GET', `/api/s0/${S0_ID}/cards`);
    expect(alice.json[0]).toMatchObject({ card: 'C1', slot: 'admin', may_decide: true });
    const carol = await api('carol', 'GET', `/api/s0/${S0_ID}/cards`);
    expect(carol.status).toBe(200); // the kill slot may view acme, but no slot of hers decides a gate
    expect(carol.json[0].may_decide).toBe(false);
    const denied = await api('carol', 'POST', `/api/cards/${CARD_ID}/prepare`, {});
    expect(denied.status).toBe(403);
  });

  it('a card of a project the person cannot view is a refusal, whatever core says', async () => {
    core.projectOfRecords = 'secret';
    for (const path of [`/api/s0/${S0_ID}`, `/api/s0/${S0_ID}/cards`, `/api/cards/${CARD_ID}`]) {
      expect((await api('alice', 'GET', path)).status).toBe(403);
    }
    expect((await api('alice', 'POST', `/api/cards/${CARD_ID}/prepare`, {})).status).toBe(403);
    expect(core.seen.some((x) => x.method === 'GET' && x.path === `/v1/cards/${CARD_ID}`)).toBe(
      false,
    );
    expect(core.seen.some((x) => x.method === 'POST')).toBe(false);
  });
});

describe('failures of core, and bad input', () => {
  it("relays core's refusals, turns its failures into 502, fails closed on garbage", async () => {
    core.override.set(`GET /v1/s0/${S0_ID}`, {
      status: 404,
      json: { error: { code: 'not_found', message: 'no such record' } },
    });
    const missing = await api('alice', 'GET', `/api/s0/${S0_ID}`);
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('not_found');
    core.override.set(`GET /v1/s0/${S0_ID}`, { status: 500, json: { error: { message: 'boom' } } });
    expect((await api('alice', 'GET', `/api/s0/${S0_ID}`)).status).toBe(502);
    core.override.set(`GET /v1/s0/${S0_ID}`, { status: 200, json: { not: 'an overview' } });
    const bad = await api('alice', 'GET', `/api/s0/${S0_ID}`);
    expect(bad.status).toBe(502); // core's answer does not match the contract: nothing is passed on
    core.override.set('POST /v1/onboard', {
      status: 403,
      json: { error: { code: 'forbidden', message: 'project.onboard denied' } },
    });
    expect((await api('root', 'POST', '/api/onboard', ONBOARD)).status).toBe(403);
  });

  it('bad ids and bodies are 400 before core is called', async () => {
    expect((await api('alice', 'GET', '/api/s0/not-a-uuid')).status).toBe(400);
    expect((await api('alice', 'GET', '/api/projects/Not%20A%20Slug')).status).toBe(400);
    expect((await api('root', 'POST', '/api/onboard', { repo: 'nope' })).status).toBe(400);
    expect((await api('root', 'POST', '/api/onboard', { ...ONBOARD, level: 'huge' })).status).toBe(
      400,
    );
    expect(core.seen).toHaveLength(0);
  });

  it('an onboarding that core answers 200 (a duplicate) stays 200, a new one is 201', async () => {
    expect((await api('root', 'POST', '/api/onboard', ONBOARD)).status).toBe(201);
    core.override.set('POST /v1/onboard', { status: 200, json: { s0_id: S0_ID, duplicate: true } });
    expect((await api('root', 'POST', '/api/onboard', ONBOARD)).status).toBe(200);
  });

  it('without a core configured the routes answer 503 after the session and CSRF checks', async () => {
    const bare = await startBffStack();
    try {
      const { browser } = await signIn(bare, 'root');
      const me = (await (await browser.request(`${bare.base}/api/me`)).json()) as Json;
      const r = await browser.request(`${bare.base}/api/projects`);
      expect(r.status).toBe(503);
      const p = await browser.request(`${bare.base}/api/onboard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf_token },
        body: JSON.stringify(ONBOARD),
      });
      expect(p.status).toBe(503);
    } finally {
      await bare.stop();
    }
  });
});

describe('the inbox', () => {
  it('unauthenticated: 401 and core is never called', async () => {
    expect((await api(null, 'GET', '/api/inbox')).status).toBe(401);
    expect(core.seen).toHaveLength(0);
  });

  it('splits what the person decides from what they only see, with who decides', async () => {
    const alice = await api('alice', 'GET', '/api/inbox');
    expect(alice.status).toBe(200);
    expect(alice.json.decide.map((i: Json) => `${i.kind}:${i.label}`)).toEqual([
      'onboarding_card:C1',
      'settings_revision:null',
      'onboarding_card:C4',
    ]);
    expect(alice.json.view).toEqual([]); // the secret project is not hers to see at all
    expect(alice.json.decide[0].deciders).toEqual([
      { principal_id: 'alice', display_name: 'Person alice' },
    ]);
    for (const x of core.seen) expect(x.headers.cookie).toBeUndefined();
  });

  it('a person who sees the project but does not hold the slot sees the item as not theirs', async () => {
    const bob = await api('bob', 'GET', '/api/inbox');
    expect(bob.json.decide).toEqual([]);
    expect(bob.json.view.map((i: Json) => i.label)).toEqual(['C1', null, 'C4']);
    expect(bob.json.view[0].deciders[0].display_name).toBe('Person alice');
    expect(bob.json.view.every((i: Json) => i.may_decide === false)).toBe(true);
    // a bare factory admin sees both projects and decides neither: no project role, so the PDP says no
    const root = await api('root', 'GET', '/api/inbox');
    expect(root.json.view).toHaveLength(4);
    expect(root.json.decide).toEqual([]);
  });

  it('a stranger sees nothing; a core failure is a 502; garbage from core is refused', async () => {
    expect((await api('dora', 'GET', '/api/inbox')).json).toEqual({ decide: [], view: [] });
    core.override.set('GET /v1/inbox', { status: 503, json: { error: { message: 'down' } } });
    expect((await api('alice', 'GET', '/api/inbox')).status).toBe(502);
    core.override.set('GET /v1/inbox', { status: 200, json: [{ nope: true }] });
    expect((await api('alice', 'GET', '/api/inbox')).status).toBe(502);
  });
});

describe('may_decide on a card follows the slot holders, and a card 5 also the m4 slot', () => {
  it('is false for the project admin when core says another person decides', async () => {
    core.override.set(`GET /v1/cards/${CARD_ID}`, {
      status: 200,
      json: {
        summary: { card_id: CARD_ID },
        view: {},
        deciders: { holders: ['bob'] },
        m4_deciders: null,
      },
    });
    const r = await api('alice', 'GET', `/api/cards/${CARD_ID}`);
    expect(r.json.may_decide).toBe(false);
    expect(r.json.principal_names).toMatchObject({ bob: 'Person bob', alice: 'Person alice' });
  });
});

describe('the settings revision', () => {
  it('may_decide only for a holder of the admin slot while it is pending', async () => {
    const a = await api('alice', 'GET', `/api/revisions/${GATE_ID}`);
    expect(a.json).toMatchObject({
      gate_instance_id: GATE_ID,
      status: 'pending',
      may_decide: true,
    });
    expect(a.json.principal_names.alice).toBe('Person alice');
    const b = await api('bob', 'GET', `/api/revisions/${GATE_ID}`);
    expect(b.json.may_decide).toBe(false);
  });

  it('no revision on a record is null; a bad gate id is 400 before core is called', async () => {
    core.override.set(`GET /v1/s0/${S0_ID}/revision`, { status: 200, json: { revision: null } });
    expect((await api('alice', 'GET', `/api/s0/${S0_ID}/revision`)).json).toEqual({
      revision: null,
    });
    core.seen.length = 0;
    expect((await api('alice', 'GET', '/api/revisions/not-a-uuid')).status).toBe(400);
    expect(
      (
        await api('alice', 'POST', '/api/revisions/not-a-uuid/decide', {
          nonce: 'n',
          decision: 'approve',
        })
      ).status,
    ).toBe(400);
    expect(core.seen).toHaveLength(0);
  });

  it('a decision that is not a vote is refused before core', async () => {
    const r = await api('alice', 'POST', `/api/revisions/${GATE_ID}/decide`, {
      nonce: 'n',
      decision: 'maybe',
    });
    expect(r.status).toBe(400);
    expect(core.seen.filter((x) => x.method === 'POST')).toHaveLength(0);
  });
});

describe('the ledger view', () => {
  it('needs audit.read: a viewer of the project may not read it, an admin may; the s0 filter is passed on', async () => {
    expect((await api('bob', 'GET', '/api/projects/acme/ledger')).status).toBe(403);
    const ok = await api('alice', 'GET', `/api/projects/acme/ledger?s0=${S0_ID}&limit=50`);
    expect(ok.status).toBe(200);
    expect(core.seen.map((x) => x.path)).toContain(`/v1/projects/acme/ledger?s0=${S0_ID}&limit=50`);
    expect((await api('alice', 'GET', '/api/projects/acme/ledger?s0=nope')).status).toBe(400);
    expect((await api('alice', 'GET', '/api/projects/acme/ledger?x=1')).status).toBe(400);
  });
});

describe('what the person may do with an item (M12.5): the PDP and where the item waits', () => {
  const key = (who: string) => `GET /v1/items/${ITEM_ID}?on_behalf_of=${who}`;
  const view = (over: Record<string, unknown>) => ({ ...itemViewFixture(), ...over });
  const question = {
    question_id: 'q1',
    item_id: ITEM_ID,
    stage: 'S1',
    step: '1.5',
    round: 1,
    material: 'blocking',
    text: 'Which table?',
    state: 'open',
    asked_at: '2026-11-09T10:00:00.000Z',
    answered_at: null,
    answered: false,
    answer_flagged: false,
  };
  const gate = (g: string) => ({
    gate: g,
    gate_instance_id: 'gi-1',
    status: 'pending',
    outcome: null,
  });
  const may = async (who: 'alice' | 'bob', over: Record<string, unknown>) => {
    core.override.set(key(who), { status: 200, json: view(over) });
    const r = await api(who, 'GET', `/api/items/${ITEM_ID}`);
    expect(r.status).toBe(200);
    return r.json.may as Record<string, boolean>;
  };

  it('shows each button only where the item is where the action applies AND the PDP says yes', async () => {
    expect(await may('alice', {})).toEqual({
      ready: false,
      answer: false,
      observe: false,
      plan: false,
    });
    expect(await may('alice', { waiting: 'human:ready' })).toMatchObject({ ready: true });
    expect(await may('alice', { questions: [question] })).toMatchObject({ answer: true });
    expect(await may('alice', { questions: [{ ...question, answered: true }] })).toMatchObject({
      answer: false,
    });
    // the design slot observes at G3d and writes the plan; the admin does neither
    expect(await may('bob', { waiting: 'gates:G3d', gates: [gate('G3d')] })).toMatchObject({
      observe: true,
    });
    expect(await may('alice', { waiting: 'gates:G3d', gates: [gate('G3d')] })).toMatchObject({
      observe: false,
    });
    expect(await may('bob', { waiting: 'gates:G3', gates: [gate('G3')] })).toMatchObject({
      observe: false,
    });
    expect(await may('bob', { waiting: 'human:plan' })).toMatchObject({ plan: true });
    expect(await may('alice', { waiting: 'human:plan' })).toMatchObject({ plan: false });
  });
});

describe('the handoff panel (P1-4): what the person may do, and the E4 choice', () => {
  const itemKey = (who: string) => `GET /v1/items/${ITEM_ID}?on_behalf_of=${who}`;
  const viewKey = (who: string) => `GET /v1/items/${ITEM_ID}/handoff?on_behalf_of=${who}`;
  const may = async (who: 'alice' | 'bob', over: Record<string, unknown>) => {
    core.override.set(viewKey(who), { status: 200, json: { ...handoffViewFixture(), ...over } });
    const r = await api(who, 'GET', `/api/items/${ITEM_ID}/handoff`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.may as Record<string, boolean>;
  };
  const e4 = handoffViewFixture().e4;

  it('decide E4 and choose: the x slot only; choose also only for who approved E4 in the ledger', async () => {
    expect(await may('bob', {})).toEqual({
      decide_e4: true,
      choose: false,
      hand_back: false,
      human_done: false,
    });
    expect(await may('alice', {})).toMatchObject({ decide_e4: false });
    const decided = {
      e4: { ...e4, status: 'decided', outcome: 'approve', approvers: ['bob'] },
      choices: ['resume', 'takeover', 'abandon'],
    };
    expect(await may('bob', decided)).toMatchObject({ decide_e4: false, choose: true });
    expect(
      await may('bob', { ...decided, e4: { ...decided.e4, approvers: ['someone-else'] } }),
    ).toMatchObject({ choose: false });
  });

  it('D4 and D5: the design slot, only while a developer has the work (D4: taken over, a hand-back left)', async () => {
    const dev = {
      waiting: 'human:human_led',
      lane: 'L8',
      human_led: { taken_over: true, lane_before: 'L3', hand_backs_left: 1 },
    };
    expect(await may('bob', dev)).toMatchObject({ hand_back: true, human_done: true });
    expect(await may('alice', dev)).toMatchObject({ hand_back: false, human_done: false });
    expect(
      await may('bob', { ...dev, human_led: { ...dev.human_led, hand_backs_left: 0 } }),
    ).toMatchObject({ hand_back: false, human_done: true });
  });

  it("the choice: the PDP on the item's E4 gate first, then core with the principal from the session", async () => {
    const withHandoff = { ...itemViewFixture(), phase: 'Handoff', handoff: handoffFixture() };
    const body = { handoff_id: HANDOFF_ID, choice: 'takeover' };
    core.override.set(itemKey('alice'), { status: 200, json: withHandoff });
    const denied = await api('alice', 'POST', `/api/items/${ITEM_ID}/handoff/choose`, body);
    expect(denied.status).toBe(403);
    expect(core.seen.filter((x) => x.method === 'POST')).toHaveLength(0);
    core.override.set(itemKey('bob'), { status: 200, json: withHandoff });
    // another handoff than the open one is a conflict, and nothing is forwarded
    const other = await api('bob', 'POST', `/api/items/${ITEM_ID}/handoff/choose`, {
      ...body,
      handoff_id: ITEM_ID,
    });
    expect(other.status).toBe(409);
    // the browser cannot name who chooses
    const named = await api('bob', 'POST', `/api/items/${ITEM_ID}/handoff/choose`, {
      ...body,
      on_behalf_of: 'root',
    });
    expect(named.status).toBe(400);
    const r = await api('bob', 'POST', `/api/items/${ITEM_ID}/handoff/choose`, body);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const sent = core.seen.find((x) => x.method === 'POST');
    expect(sent?.path).toBe(`/v1/items/${ITEM_ID}/handoff/choose`);
    expect(sent?.body).toEqual({ ...body, on_behalf_of: 'bob' });
  });
});
