import { createServer, type Server } from 'node:http';
import { bindProject, grantFleetRole, grantRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpCoreClient } from '../src/core-client.js';
import { signIn, startBffStack, type BffStack, type Browser } from '../src/testing.js';
import { CORE_TOKEN, ITEM_ID, itemViewFixture } from './portal-fixtures.js';

// PLAN M15.5: the portal's routes for RELHOLD, B14, B17, the close-out read, the 9.5 audit, 9.4 Learn and the factory
// M1 decide path. Each asks the PDP in the bff for the signed-in person first (a deny is a 403 and core is never
// asked), then core with the session's principal as `on_behalf_of` (a body that names one is refused).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const GATE = '01900000-0000-7000-8000-000000000001';
const SHA = 'a'.repeat(64);

let s: BffStack;
let server: Server;
let coreUrl: string;
const seen: Array<{ method: string; path: string; body: Json }> = [];

const learnView = {
  project_id: 'acme',
  proposals: [],
  earned_autonomy: null,
  mode_e_suspended: false,
};
const revisionView = {
  gate_instance_id: GATE,
  rev_hash: SHA,
  parent_rev_hash: null,
  proposed_by: 'carol',
  status: 'pending',
  outcome: null,
  published: false,
  changes: [{ key: 'factory.learn', before: null, after: { window: 10 } }],
  evidence_hash: SHA,
  policy: { role: 'factory.admin', approvers: 1 },
  deciders: ['root'],
  quorum: 1,
};

function route(method: string, path: string): { status: number; json: unknown } {
  const p = path.split('?')[0];
  if (method === 'GET' && p === `/v1/items/${ITEM_ID}`)
    return { status: 200, json: { ...itemViewFixture(), project_id: 'acme' } };
  if (p === `/v1/items/${ITEM_ID}/release/re-request`)
    return {
      status: 200,
      json: { item: { ...itemViewFixture(), project_id: 'acme' }, duplicate: false },
    };
  if (p === `/v1/items/${ITEM_ID}/review/unsure` || p === `/v1/items/${ITEM_ID}/escape`)
    return { status: 200, json: { duplicate: false } };
  if (p === `/v1/items/${ITEM_ID}/audit`)
    return { status: 200, json: { sampled: 1, missed: 0, suspended: false } };
  if (p === `/v1/items/${ITEM_ID}/closeout`) return { status: 200, json: { closeout_sha256: SHA } };
  if (p === '/v1/projects/acme/learn') return { status: 200, json: learnView };
  if (p === '/v1/projects/acme/learn/run')
    return { status: 200, json: { proposed: [], settled: [] } };
  if (p === '/v1/projects/acme/learn/mode-e-lift')
    return { status: 201, json: { proposal_id: SHA, gate_instance_id: GATE, duplicate: false } };
  if (p === `/v1/config/revisions/${GATE}`) return { status: 200, json: revisionView };
  if (p?.startsWith(`/v1/config/revisions/${GATE}/`)) return { status: 200, json: { ok: true } };
  return { status: 404, json: { error: { code: 'not_found', message: 'no' } } };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '/';
      seen.push({ method: req.method ?? '', path, body: raw ? JSON.parse(raw) : null });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${CORE_TOKEN}`) return send(401, {});
      const r = route(req.method ?? 'GET', path);
      send(r.status, r.json);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  coreUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  s = await startBffStack({
    override: { core: new HttpCoreClient({ baseUrl: coreUrl, token: CORE_TOKEN }) },
  });
  // alice: project admin; bob: code owner (g4); carol: requester; dora: viewer; root: factory admin
  await bindProject(s.identity, 'acme', {
    admin: ['alice'],
    g4: ['bob'],
    requesters: ['carol'],
    g5: ['alice'],
  });
  await grantRole(s.identity.deps, 'dora', 'project.viewer', { kind: 'project', ref: 'acme' });
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
});
afterAll(async () => {
  await s.stop();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  seen.length = 0;
});

type Who = 'alice' | 'bob' | 'carol' | 'dora' | 'root';
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
  if (method === 'POST') headers['x-csrf-token'] = v.csrf;
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}
const wrote = (path: string) => seen.filter((x) => x.method === 'POST' && x.path.startsWith(path));

const CASES: Array<{
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Json;
  allowed: Who;
  denied: Who;
}> = [
  {
    name: 'RELHOLD re-request (item.release)',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/release/re-request`,
    body: { key: 'k1' },
    allowed: 'alice',
    denied: 'bob',
  },
  {
    name: 'B14 unsure (item.unsure)',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/review/unsure`,
    body: { key: 'k1' },
    allowed: 'bob',
    denied: 'carol',
  },
  {
    name: 'B17 escape (item.escape)',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/escape`,
    body: { lane: 'L0', reason_code: 'bug', key: 'k1' },
    allowed: 'carol',
    denied: 'dora',
  },
  {
    name: '9.5 audit (audit.record)',
    method: 'POST',
    path: `/api/items/${ITEM_ID}/audit`,
    body: { outcome: 'ok', reason_code: 'reviewed' },
    allowed: 'bob',
    denied: 'alice',
  },
  {
    name: '9.3 close-out (closeout.read)',
    method: 'GET',
    path: `/api/items/${ITEM_ID}/closeout`,
    allowed: 'carol',
    denied: 'dora',
  },
  {
    name: '9.4 proposals (audit.read)',
    method: 'GET',
    path: '/api/projects/acme/learn',
    allowed: 'alice',
    denied: 'carol',
  },
  {
    name: '9.4 run (learn.propose)',
    method: 'POST',
    path: '/api/projects/acme/learn/run',
    body: {},
    allowed: 'alice',
    denied: 'bob',
  },
  {
    name: 'B19 lift request (learn.propose)',
    method: 'POST',
    path: '/api/projects/acme/learn/mode-e-lift',
    body: {},
    allowed: 'root',
    denied: 'carol',
  },
  {
    name: 'factory M1 prepare (config.decide)',
    method: 'POST',
    path: `/api/config/revisions/${GATE}/prepare`,
    body: {},
    allowed: 'root',
    denied: 'alice',
  },
  {
    name: 'factory M1 decide (config.decide)',
    method: 'POST',
    path: `/api/config/revisions/${GATE}/decide`,
    body: { nonce: 'n'.repeat(43), decision: 'approve' },
    allowed: 'root',
    denied: 'alice',
  },
];

describe('the PDP guard of every M15.5 portal route', () => {
  for (const c of CASES) {
    it(`${c.name}: denied for ${c.denied} before core is asked to act; allowed for ${c.allowed}`, async () => {
      const no = await api(c.denied, c.method, c.path, c.body);
      expect(no.status, JSON.stringify(no.json)).toBe(403);
      const target = c.path.replace('/api/', '/v1/');
      expect(seen.some((x) => x.path.split('?')[0] === target)).toBe(false);
      const yes = await api(c.allowed, c.method, c.path, c.body);
      expect(yes.status, JSON.stringify(yes.json)).toBeLessThan(300);
      const call = seen.find((x) => x.path.split('?')[0] === target);
      expect(call, JSON.stringify(seen)).toBeDefined();
      if (c.method === 'POST') expect(call?.body.on_behalf_of).toBe(c.allowed);
      else expect(call?.path).toContain(`on_behalf_of=${c.allowed}`);
    });
  }

  it('a body that names on_behalf_of is refused', async () => {
    const r = await api('bob', 'POST', `/api/items/${ITEM_ID}/review/unsure`, {
      key: 'k1',
      on_behalf_of: 'alice',
    });
    expect(r.status).toBe(400);
    expect(wrote(`/v1/items/${ITEM_ID}/review/unsure`)).toHaveLength(0);
  });

  it('the factory revision view: an auditor or a decider reads it; may_decide only for a listed decider', async () => {
    const root = await api('root', 'GET', `/api/config/revisions/${GATE}`);
    expect(root.status).toBe(200);
    expect(root.json.may_decide).toBe(true);
    expect((await api('carol', 'GET', `/api/config/revisions/${GATE}`)).status).toBe(403);
  });
});
