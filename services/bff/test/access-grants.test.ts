import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { MyAccessView } from '@aisdlc/contracts';
import {
  bindProject,
  grantFleetRole,
  grantRole,
  startTestIdentityApi,
} from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpCoreClient } from '../src/core-client.js';
import { signIn, startBffStack, type BffStack, type Browser } from '../src/testing.js';
import { CORE_TOKEN } from './portal-fixtures.js';

// P1-6 in the bff: every grant, revoke and decision asks the PDP here for `access.manage` on the change's scope first
// (a deny is a 403 and core is never asked), then core with the session's principal as `on_behalf_of`. An access
// request needs no action (anyone signed in may ask; the M1 decides it). The inbox shows a pending grant only to those
// who hold access.manage on its scope. And a revoke takes effect on the next `/api/me/access`.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const GRANT = '01900000-0000-7000-8000-0000000000a1';
const GATE = '01900000-0000-7000-8000-0000000000b1';
const SHA = 'a'.repeat(64);

let s: BffStack;
let server: Server;
const seen: Array<{ method: string; path: string; body: Json }> = [];

const grantView = (scope: object) => ({
  grant_id: GRANT,
  change: {
    op: 'grant',
    target: { kind: 'principal', principal_id: 'dora' },
    role_id: 'project.viewer',
    scope,
    expiry: null,
  },
  origin: 'admin',
  reason: 'needs it',
  proposed_by: 'carol',
  project_id: 'acme',
  gate_instance_id: GATE,
  subject_hash: SHA,
  gate_status: 'pending',
  outcome: null,
  status: 'pending',
  deciders: ['alice'],
  quorum: 1,
  proposed_at: '2026-11-09T10:00:00.000Z',
  applied: null,
});
const inboxItem = {
  kind: 'access_grant',
  id: GRANT,
  project_id: 'factory',
  s0_id: null,
  label: null,
  slot: 'admin',
  opened_at: '2026-11-09T10:00:00.000Z',
  sla_due_at: null,
  overdue: false,
  escalated: false,
  holders: ['root'],
  item_id: null,
  gate: 'M1',
  card_id: null,
  feasibility: 'feasible',
  feasibility_reason: null,
};

function route(method: string, path: string): { status: number; json: unknown } {
  const p = path.split('?')[0];
  if (method === 'GET' && p === '/v1/inbox') return { status: 200, json: [inboxItem] };
  if (method === 'GET' && p === `/v1/access/grants/${GRANT}`)
    return { status: 200, json: grantView({ kind: 'project', ref: 'acme' }) };
  if (method === 'GET' && p === '/v1/access/grants')
    return { status: 200, json: { grants: [grantView({ kind: 'project', ref: 'acme' })] } };
  if (method === 'POST' && (p === '/v1/access/grants' || p === '/v1/access/requests'))
    return { status: 201, json: { grant_id: GRANT, gate_instance_id: GATE, deciders: ['alice'] } };
  if (p === `/v1/access/grants/${GRANT}/prepare`)
    return {
      status: 200,
      json: { nonce: 'n', expires_at: '2026-11-09T11:00:00.000Z', evidence_hash: SHA },
    };
  if (p === `/v1/access/grants/${GRANT}/decide`)
    return {
      status: 200,
      json: { outcome: 'approve', status: 'applied', applied: true, apply_error: null },
    };
  if (p === '/v1/access/bindings') return { status: 200, json: { bindings: [] } };
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
  const coreUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  s = await startBffStack({
    override: { core: new HttpCoreClient({ baseUrl: coreUrl, token: CORE_TOKEN }) },
  });
  // alice: acme's admin slot; dora: a viewer of acme; root: factory admin; carol: nobody
  await bindProject(s.identity, 'acme', { admin: ['alice'], requesters: ['carol'] });
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

type Who = 'alice' | 'carol' | 'dora' | 'root';
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

const viewer = (scope: object) => ({
  change: {
    op: 'grant',
    target: { kind: 'principal', principal_id: 'dora' },
    role_id: 'factory.auditor',
    scope,
    expiry: null,
  },
  reason: 'audit',
});

describe('proposing a grant asks the PDP for access.manage on its scope', () => {
  it('a project admin on their project: allowed, core gets the session principal', async () => {
    const r = await api('alice', 'POST', '/api/access/grants', {
      ...viewer({ kind: 'project', ref: 'acme' }),
      change: {
        ...viewer({}).change,
        role_id: 'project.viewer',
        scope: { kind: 'project', ref: 'acme' },
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(wrote('/v1/access/grants')[0]?.body.on_behalf_of).toBe('alice');
  });

  it('the project admin on the fleet, a viewer and a person with no role: 403, core never asked', async () => {
    for (const who of ['alice', 'dora', 'carol'] as const) {
      const r = await api(who, 'POST', '/api/access/grants', viewer({ kind: 'fleet', ref: '*' }));
      expect(r.status, who).toBe(403);
    }
    expect(wrote('/v1/access/grants')).toEqual([]);
  });

  it('a factory admin on the fleet: allowed; a body that names on_behalf_of is refused', async () => {
    expect(
      (await api('root', 'POST', '/api/access/grants', viewer({ kind: 'fleet', ref: '*' }))).status,
    ).toBe(201);
    const named = await api('root', 'POST', '/api/access/grants', {
      ...viewer({ kind: 'fleet', ref: '*' }),
      on_behalf_of: 'alice',
    });
    expect(named.status).toBe(400);
  });
});

describe('access requests and decisions', () => {
  it('anyone signed in may ask for a role for themselves', async () => {
    const r = await api('carol', 'POST', '/api/access/requests', {
      role_id: 'project.viewer',
      scope: { kind: 'project', ref: 'acme' },
      expiry: null,
      reason: 'reviewing',
    });
    expect(r.status).toBe(201);
    expect(wrote('/v1/access/requests')[0]?.body.on_behalf_of).toBe('carol');
  });

  it('deciding asks access.manage on the grant scope: the viewer is refused, the admin goes through', async () => {
    expect((await api('dora', 'POST', `/api/access/grants/${GRANT}/prepare`, {})).status).toBe(403);
    expect(wrote(`/v1/access/grants/${GRANT}`)).toEqual([]);
    const p = await api('alice', 'POST', `/api/access/grants/${GRANT}/prepare`, {});
    expect(p.status).toBe(200);
    const d = await api('alice', 'POST', `/api/access/grants/${GRANT}/decide`, {
      nonce: 'n',
      decision: 'approve',
    });
    expect(d.json).toMatchObject({ status: 'applied' });
    const v = await api('alice', 'GET', `/api/access/grants/${GRANT}`);
    expect(v.json.may_decide).toBe(true);
    expect((await api('dora', 'GET', `/api/access/grants/${GRANT}`)).json.may_decide).toBe(false);
  });

  it('the bindings of a scope: access.manage only', async () => {
    expect((await api('alice', 'GET', '/api/access/bindings?scope=project:acme')).status).toBe(200);
    expect((await api('dora', 'GET', '/api/access/bindings?scope=project:acme')).status).toBe(403);
    expect((await api('alice', 'GET', '/api/access/bindings?scope=fleet:*')).status).toBe(403);
    expect((await api('root', 'GET', '/api/access/bindings?scope=lane:acme/L1')).status).toBe(400);
  });

  it('a fleet grant waits in the inbox of a factory admin, and nobody else sees it', async () => {
    const root = await api('root', 'GET', '/api/inbox');
    expect(root.json.decide.map((i: Json) => i.id)).toEqual([GRANT]);
    const alice = await api('alice', 'GET', '/api/inbox');
    expect([...alice.json.decide, ...alice.json.view].map((i: Json) => i.id)).not.toContain(GRANT);
  });
});

describe('a revoke takes effect on the next /api/me/access', () => {
  it('identity grant scope writes a binding, then ends it; the person sees it, then does not', async () => {
    const id = await startTestIdentityApi(s.identity, {
      core: { token: 'core-at-identity-'.padEnd(32, 'x'), scopes: ['grant'] },
    });
    try {
      const post = async (path: string, body: unknown) => {
        const res = await fetch(new URL(path, id.url), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${'core-at-identity-'.padEnd(32, 'x')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        return (await res.json()) as Json;
      };
      const g = await post('/v1/grants', {
        grant_id: randomUUID(),
        target: { kind: 'principal', principal_id: 'carol' },
        role_id: 'factory.auditor',
        scope: { kind: 'fleet', ref: '*' },
        expiry: null,
        m_gate_ref: GATE,
        on_behalf_of: 'root',
      });
      const roles = async () =>
        MyAccessView.parse((await api('carol', 'GET', '/api/me/access')).json)
          .bindings.filter((b) => b.blockers.length === 0)
          .map((b) => b.role_id);
      expect(await roles()).toContain('factory.auditor');
      await post('/v1/grants/revoke', {
        grant_id: randomUUID(),
        binding_id: g.binding_id,
        m_gate_ref: GATE,
        reason: 'audit done',
        on_behalf_of: 'root',
      });
      expect(await roles()).not.toContain('factory.auditor');
    } finally {
      await id.stop();
    }
  });
});
