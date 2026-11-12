import { createServer, type Server } from 'node:http';
import { bypassListHash } from '@aisdlc/contracts';
import { bindProject, grantRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpCoreClient } from '../src/core-client.js';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { CORE_TOKEN } from './portal-fixtures.js';

// The portal's after-onboarding routes (PLAN M16; OB §8; DEC-21): the drift view needs `project.view` and carries what
// the person may do; a restore and a re-affirmation need `project.settings.edit`, "Poll now" `config.propose`, a
// level-up `project.onboard`. Core is told the session's principal, never one the browser names; a refusal keeps its
// code. A fake core over HTTP stands in for core.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const H = 'a'.repeat(40);
const SHA = 'b'.repeat(64);
const repoView = () => ({
  repo: 'acme/web',
  prr: {
    version: 1,
    status: 'suspended',
    level: 'light',
    fresh_until: '2027-02-07T10:00:00.000Z',
    expired: false,
  },
  head_sha: H,
  files_polled_at: '2026-11-12T10:00:00.000Z',
  rules_polled_at: '2026-11-12T10:00:00.000Z',
  findings: [
    {
      kind: 'protect_main',
      effect: 'suspend',
      subject: 'main',
      reasons: ['gate_check_not_pinned'],
      expected: null,
      observed: null,
    },
  ],
  files: [{ path: 'AGENTS.md', state: 'affirmed', served_sha256: SHA, observed_sha256: SHA }],
  suspension: { at: '2026-11-12T10:00:00.000Z', findings: [] },
  restore: {
    ready: false,
    why_not: 'still loosened',
    bypass: { logins: ['carol'], list_hash: bypassListHash(['carol']) },
  },
  level_up: ['full'],
  security: null,
  krl: null,
  history: [],
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
      if (req.method === 'GET' && path.startsWith('/v1/projects/acme/drift?'))
        return send(200, { project_id: 'acme', repos: [repoView()] });
      if (req.method === 'GET' && path.startsWith('/v1/projects/acme/drift/reaffirm?'))
        return send(200, {
          repo: 'acme/web',
          path: 'AGENTS.md',
          head_sha: H,
          affirmed_sha256: SHA,
          affirmed_text: '# a\n',
          repo_sha256: 'c'.repeat(64),
          repo_text: '# b\n',
          lint: [],
          secret_hit: false,
          bound_hash: 'c'.repeat(64),
          why_not: null,
        });
      if (path === '/v1/projects/acme/drift/restore')
        return send(403, { error: { code: 'refused', message: 'still loosened' } });
      if (path === '/v1/projects/acme/drift/recheck') return send(200, repoView());
      if (path === '/v1/projects/acme/drift/reaffirm')
        return send(201, {
          path: 'AGENTS.md',
          text_sha256: 'c'.repeat(64),
          ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe44',
        });
      if (path === '/v1/projects/acme/drift/security/confirm')
        return send(201, {
          installation_hash: 'e'.repeat(64),
          ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe66',
        });
      if (path === '/v1/projects/acme/onboarding-versions')
        return send(201, {
          s0_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe55',
          level: 'full',
          reason: 'level_up',
          duplicate: false,
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
  // alice: project admin; dora: viewer; carol: nothing on acme
  await bindProject(s.identity, 'acme', { admin: ['alice'] });
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
  who: 'alice' | 'carol' | 'dora',
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

describe('GET /api/projects/:id/drift', () => {
  it('project.view; `may` is the PDP’s answers; core is asked as the session’s principal; a stranger gets nothing', async () => {
    const a = await api('alice', 'GET', '/api/projects/acme/drift');
    expect(a.status).toBe(200);
    expect(a.json.may).toMatchObject({ restore: true, reaffirm: true, recheck: true });
    expect(a.json.repos[0].prr.status).toBe('suspended');
    expect(seen.map((x) => x.path)).toEqual(['/v1/projects/acme/drift?on_behalf_of=alice']);
    expect((await api('dora', 'GET', '/api/projects/acme/drift')).json.may).toEqual({
      restore: false,
      reaffirm: false,
      recheck: false,
      request_version: false,
    });
    seen.length = 0;
    expect((await api('carol', 'GET', '/api/projects/acme/drift')).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('the re-affirm card passes the repo and path through and names the principal', async () => {
    const r = await api(
      'alice',
      'GET',
      '/api/projects/acme/drift/reaffirm?repo=acme/web&path=AGENTS.md',
    );
    expect(r.status).toBe(200);
    expect(r.json.bound_hash).toBe('c'.repeat(64));
    expect(seen[0]?.path).toBe(
      '/v1/projects/acme/drift/reaffirm?repo=acme%2Fweb&path=AGENTS.md&on_behalf_of=alice',
    );
  });
});

describe('the writes', () => {
  const restore = {
    repo: 'acme/web',
    bypass: { logins: ['carol'], list_hash: bypassListHash(['carol']) },
    attestation: { bypass_matches_list: true, bypass_has_no_app: true },
  };

  it('a restore: project.settings.edit; the attestation must be given; core’s refusal keeps its code', async () => {
    expect((await api('dora', 'POST', '/api/projects/acme/drift/restore', restore)).status).toBe(
      403,
    );
    expect(
      (
        await api('alice', 'POST', '/api/projects/acme/drift/restore', {
          ...restore,
          attestation: { bypass_matches_list: false, bypass_has_no_app: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('alice', 'POST', '/api/projects/acme/drift/restore', {
          ...restore,
          on_behalf_of: 'dora',
        })
      ).status,
    ).toBe(400);
    expect(seen).toEqual([]);
    const r = await api('alice', 'POST', '/api/projects/acme/drift/restore', restore);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('refused');
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/v1/projects/acme/drift/restore',
        body: { ...restore, on_behalf_of: 'alice' },
      },
    ]);
  });

  it('a re-affirmation and a poll: as the session’s principal', async () => {
    const ra = await api('alice', 'POST', '/api/projects/acme/drift/reaffirm', {
      repo: 'acme/web',
      path: 'AGENTS.md',
      text_sha256: 'c'.repeat(64),
      step_up: { proof: 'p' },
    });
    expect(ra.status).toBe(201);
    expect(seen.at(-1)?.body.on_behalf_of).toBe('alice');
    const rc = await api('alice', 'POST', '/api/projects/acme/drift/recheck', { repo: 'acme/web' });
    expect(rc.status).toBe(200);
    expect(rc.json.repo).toBe('acme/web');
    expect(
      (await api('dora', 'POST', '/api/projects/acme/drift/recheck', { repo: 'acme/web' })).status,
    ).toBe(403);
  });

  it('the security card (OB §8): project.settings.edit, the hash shown, as the session’s principal', async () => {
    const body = { repo: 'acme/web', installation_hash: 'e'.repeat(64) };
    expect(
      (await api('dora', 'POST', '/api/projects/acme/drift/security/confirm', body)).status,
    ).toBe(403);
    expect(
      (
        await api('alice', 'POST', '/api/projects/acme/drift/security/confirm', {
          ...body,
          on_behalf_of: 'dora',
        })
      ).status,
    ).toBe(400);
    expect(seen).toEqual([]);
    const r = await api('alice', 'POST', '/api/projects/acme/drift/security/confirm', body);
    expect(r.status).toBe(201);
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/v1/projects/acme/drift/security/confirm',
        body: { ...body, on_behalf_of: 'alice' },
      },
    ]);
  });
});
