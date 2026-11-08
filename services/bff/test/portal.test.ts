import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindProject, grantFleetRole } from '@aisdlc/identity/testing';
import { Browser, signIn, startBffStack, type BffStack } from '../src/testing.js';
import { CARD_ID, CORE_TOKEN, S0_ID, startFakeCore, type FakeCore } from './portal-fixtures.js';

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
  await bindProject(s.identity, 'acme', { admin: ['alice'], intent: ['bob'], kill: ['carol'] });
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
  readonly allowed: 'alice' | 'root';
  readonly denied: 'dora' | 'carol' | 'alice';
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
    // (The S0 overview is itself the read that finds the project; its body is not passed on.)
    if (c.name !== 'S0 overview') {
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
