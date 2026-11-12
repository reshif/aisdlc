import { createServer, type Server } from 'node:http';
import { bindProject, grantRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpCoreClient } from '../src/core-client.js';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { CORE_TOKEN } from './portal-fixtures.js';

// The portal's issue twin (PLAN M16): the view needs `project.view` and carries what the person may do (the PDP's
// answers as hints); approving a batch and linking a duplicate need `config.propose`, a remediation request
// `work.request`. Every write needs the session's CSRF token, and core is told the principal of the session, never
// one the browser names. A fake core over HTTP stands in for core.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const GAP = 'gap:acme.web:RS-DX-3:.';
const REQ_ID = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe11';
const view = () => ({
  project_id: 'acme',
  repos: [
    {
      repo: 'acme/web',
      visibility: 'private',
      prr_version: 1,
      twins: [
        {
          gap_id: GAP,
          criterion: 'RS-DX-3',
          severity: 'tracked',
          title: '[onboarding] .env.example (RS-DX-3)',
          number: 431,
          state: 'open',
          via: 'created',
          recheck: null,
          batch_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe22',
          request: null,
        },
      ],
      private_only: [{ gap_id: 'gap:acme.web:RS-SEC:.', criterion: 'RS-SEC' }],
      batches: [],
      candidates: [],
      polled_at: null,
    },
  ],
});

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: Json;
}

let s: BffStack;
let server: Server;
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '/';
      seen.push({ method: req.method ?? 'GET', path, body: raw ? JSON.parse(raw) : undefined });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${CORE_TOKEN}`) return send(401, {});
      if (req.method === 'GET' && path.startsWith('/v1/projects/acme/issue-twin?'))
        return send(200, view());
      if (path === '/v1/projects/acme/issue-twin/batches')
        return send(201, {
          batch_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe33',
          filed: 1,
          tracked: 0,
          bodies_hash: 'a'.repeat(64),
          ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe44',
        });
      if (path === '/v1/projects/acme/issue-twin/links')
        return send(409, { error: { code: 'conflict', message: 'already linked' } });
      if (path === '/v1/projects/acme/issue-twin/requests')
        return send(201, {
          request_id: REQ_ID,
          item_id: null,
          duplicate: false,
          injection_suspected: false,
        });
      return send(404, { error: { code: 'not_found', message: 'no' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  s = await startBffStack({
    override: {
      core: new HttpCoreClient({ baseUrl: `http://127.0.0.1:${port}`, token: CORE_TOKEN }),
    },
  });
  // alice: project admin; bob: a requester; dora: viewer; carol: nothing on acme
  await bindProject(s.identity, 'acme', { admin: ['alice'], requesters: ['bob'] });
  await grantRole(s.identity.deps, 'dora', 'project.viewer', { kind: 'project', ref: 'acme' });
});
afterAll(async () => {
  await s.stop();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  seen.length = 0;
});

const sessions = new Map<string, { browser: Browser; csrf: string }>();
async function api(
  who: 'alice' | 'bob' | 'carol' | 'dora',
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) {
  let v = sessions.get(who);
  if (!v) {
    const { browser } = await signIn(s, who);
    const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
    v = { browser, csrf: me.csrf_token as string };
    sessions.set(who, v);
  }
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

describe('GET /api/projects/:id/issue-twin', () => {
  it('project.view; the answer carries what the person may do; core is asked as the session’s principal', async () => {
    const a = await api('alice', 'GET', '/api/projects/acme/issue-twin');
    expect(a.status).toBe(200);
    expect(a.json.may).toEqual({ propose: true, request: true });
    expect(a.json.repos[0].twins[0].number).toBe(431);
    expect(seen.map((x) => x.path)).toEqual(['/v1/projects/acme/issue-twin?on_behalf_of=alice']);
    expect((await api('dora', 'GET', '/api/projects/acme/issue-twin')).json.may).toEqual({
      propose: false,
      request: false,
    });
    expect((await api('bob', 'GET', '/api/projects/acme/issue-twin')).json.may).toEqual({
      propose: false,
      request: true,
    });
    seen.length = 0;
    const c = await api('carol', 'GET', '/api/projects/acme/issue-twin');
    expect(c.status).toBe(403);
    expect(seen).toEqual([]);
  });
});

describe('the writes', () => {
  it('a batch: config.propose; on_behalf_of is the session’s and a body that names one is refused', async () => {
    const body = { repo: 'acme/web', rows: [{ gap_id: GAP, disposition: 'file_issue' }] };
    expect((await api('bob', 'POST', '/api/projects/acme/issue-twin/batches', body)).status).toBe(
      403,
    );
    expect(
      (
        await api('alice', 'POST', '/api/projects/acme/issue-twin/batches', {
          ...body,
          on_behalf_of: 'bob',
        })
      ).status,
    ).toBe(400);
    expect(seen).toEqual([]);
    const ok = await api('alice', 'POST', '/api/projects/acme/issue-twin/batches', body);
    expect(ok.status).toBe(201);
    expect(ok.json.filed).toBe(1);
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/v1/projects/acme/issue-twin/batches',
        body: { ...body, on_behalf_of: 'alice' },
      },
    ]);
  });

  it('a request: work.request; a link keeps core’s refusal and its code', async () => {
    const req = { repo: 'acme/web', gap_id: GAP };
    expect((await api('dora', 'POST', '/api/projects/acme/issue-twin/requests', req)).status).toBe(
      403,
    );
    const r = await api('bob', 'POST', '/api/projects/acme/issue-twin/requests', req);
    expect(r.status).toBe(201);
    expect(r.json.request_id).toBe(REQ_ID);
    expect(seen.at(-1)?.body).toEqual({ ...req, on_behalf_of: 'bob' });
    const l = await api('alice', 'POST', '/api/projects/acme/issue-twin/links', {
      ...req,
      number: 7,
    });
    expect(l.status).toBe(409);
    expect(l.json.error.code).toBe('conflict');
  });
});
