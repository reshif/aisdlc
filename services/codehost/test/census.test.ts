import { forbiddenPermissionsIn } from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeIdentityLinks } from '../src/index.js';
import {
  SHA_HEAD,
  TOKENS,
  seedWithOwners,
  startCodeHostApp,
  type CodeHostTestApp,
} from './stack.js';

let s: CodeHostTestApp;
beforeAll(async () => {
  s = await startCodeHostApp(new FakeIdentityLinks(), seedWithOwners('* @alice\n'));
});
afterAll(async () => {
  await s.stop();
});

describe('a Census-style read through the codehost', () => {
  it('reads the repos, a file, the head, CODEOWNERS, installation, rules, collaborators and the B4 verdict', async () => {
    const repos = await s.call(TOKENS.census, 'GET', '/v1/repos');
    expect(repos.status).toBe(200);
    // acme/lib is installed but has no S0 record: it is not on the allow-list.
    expect(repos.json.value.map((r: { full_name: string }) => r.full_name)).toEqual(['acme/app']);
    const file = await s.call(
      TOKENS.census,
      'GET',
      `/v1/repos/acme/app/file?sha=${SHA_HEAD}&path=README.md`,
    );
    expect(file.json).toMatchObject({ state: 'ok', value: { content: '# hi\n' } });
    const head = await s.call(TOKENS.census, 'GET', '/v1/repos/acme/app/head?branch=main');
    expect(head.json).toEqual({ state: 'ok', value: SHA_HEAD });
    const co = await s.call(TOKENS.census, 'GET', `/v1/repos/acme/app/codeowners?sha=${SHA_HEAD}`);
    expect(co.json.value.path).toBe('.github/CODEOWNERS');

    expect((await s.call(TOKENS.posture, 'GET', '/v1/installation')).json.value).toMatchObject({
      installation_id: 4242,
    });
    const rules = await s.call(TOKENS.posture, 'GET', '/v1/repos/acme/app/rules?branch=main');
    expect(rules.json.value.required_checks).toEqual([
      { context: 'gate-check', integration_id: 99 },
      { context: 'lint', integration_id: null },
    ]);
    expect(
      (await s.call(TOKENS.posture, 'GET', '/v1/repos/acme/app/collaborators')).json.value,
    ).toHaveLength(2);
    expect(
      (await s.call(TOKENS.posture, 'GET', '/v1/repos/acme/app/codeowners/errors?ref=main')).json
        .value,
    ).toHaveLength(1);
    // The seed's installation holds statuses:write and the 'lint' check is unpinned: B4b blocks.
    const b4 = await s.call(TOKENS.posture, 'GET', '/v1/repos/acme/app/b4');
    expect(b4.json).toMatchObject({ repo: 'acme/app', branch: 'main' });
    expect(b4.json.report).toMatchObject({
      blocks_m4: true,
      b4a: { status: 'clear' },
      b4b: { status: 'blocked' },
      b4c: { status: 'clear' },
    });
  });

  it('the request log shows GETs only for resources; the only POSTs are JWT token mints', () => {
    const log = s.gh.server.requests;
    expect(log.length).toBeGreaterThan(8);
    for (const r of log) {
      if (r.auth === 'installation') expect(r.method, `${r.method} ${r.path}`).toBe('GET');
      if (r.method !== 'GET') {
        expect(`${r.method} ${r.path} ${r.auth}`).toMatch(
          /^POST \/app\/installations\/4242\/access_tokens jwt$/,
        );
      }
      expect(r.path).not.toMatch(/rulesets/);
      expect(r.path).not.toMatch(/acme\/lib/); // not registered: never touched
    }
    expect(s.gh.server.apiRequests.every((r) => r.method === 'GET')).toBe(true);
    // Resource requests that carried the App JWT: the installation lookup, nothing else.
    expect(log.filter((r) => r.auth === 'jwt' && r.method === 'GET').map((r) => r.path)).toEqual(
      expect.arrayContaining(['/app/installations/4242']),
    );
    expect(log.filter((r) => r.auth === 'none')).toEqual([]);
    expect(log.filter((r) => r.status >= 400)).toEqual([]);
  });

  it('mints only hub and posture tokens, each with its explicit subset', () => {
    const subsets = s.gh.server.issued.map((t) => JSON.stringify(t.permissions)).sort();
    expect(subsets).toEqual([
      JSON.stringify({ contents: 'read', metadata: 'read' }),
      JSON.stringify({ metadata: 'read' }),
    ]);
    for (const t of s.gh.server.issued) expect(forbiddenPermissionsIn(t.permissions)).toEqual([]);
  });

  it('a ruleset GET and every write verb are refused before the network', async () => {
    const before = s.gh.server.requests.length;
    for (const [m, p] of [
      ['GET', '/repos/acme/app/rulesets'],
      ['GET', '/repos/acme/app/rulesets/5'],
      ['POST', '/repos/acme/app/rulesets'],
      ['PATCH', '/repos/acme/app/rulesets/5'],
      ['PUT', '/repos/acme/app/pulls/1/merge'],
      ['DELETE', '/repos/acme/app/rulesets/5'],
    ] as const) {
      const r = await s.gh.transport.request(m, p);
      expect(!r.ok && r.error.reason, `${m} ${p}`).toBe('refused');
    }
    expect(s.gh.server.requests.length).toBe(before);
  });

  it('an unregistered repo is refused by the allow-list with no request for it', async () => {
    const before = s.gh.server.requests.length;
    for (const path of [
      `/v1/repos/acme/lib/file?sha=${'d'.repeat(40)}&path=CODEOWNERS`,
      '/v1/repos/acme/lib/head?branch=trunk',
      '/v1/repos/acme/lib/rules?branch=trunk',
      '/v1/repos/acme/lib/collaborators',
    ]) {
      const token =
        path.includes('/rules') || path.includes('/collab') ? TOKENS.posture : TOKENS.census;
      const r = await s.call(token, 'GET', path);
      expect(r.status, path).toBe(403);
      expect(r.json).toMatchObject({ state: 'unreadable', reason: 'repo_not_allowed' });
    }
    expect((await s.call(TOKENS.posture, 'GET', '/v1/repos/acme/lib/b4')).status).toBe(403);
    expect(s.gh.server.requests.slice(before).filter((r) => r.path.includes('/acme/lib'))).toEqual(
      [],
    );
  });
});

describe('scopes and fail-closed answers', () => {
  it('needs a token, and the right scope for each route', async () => {
    expect((await s.call(null, 'GET', '/v1/repos')).status).toBe(401);
    expect((await s.call('wrong-token'.padEnd(32, 'x'), 'GET', '/v1/repos')).status).toBe(401);
    expect((await s.call(TOKENS.posture, 'GET', '/v1/repos')).status).toBe(403);
    expect((await s.call(TOKENS.census, 'GET', '/v1/installation')).status).toBe(403);
    expect(
      (
        await s.call(TOKENS.census, 'POST', '/v1/projects/acme/codeowners/sync', {
          repos: [{ repo: 'acme/app' }],
        })
      ).status,
    ).toBe(403);
    expect((await s.call(TOKENS.none, 'GET', '/v1/repos')).status).toBe(403);
    expect((await s.call(null, 'GET', '/healthz')).json).toEqual({ ok: true });
  });

  it('a read that is not ok is never a 2xx: unknown is 503, unreadable 4xx', async () => {
    s.gh.server.answerWith(500);
    const unknown = await s.call(TOKENS.posture, 'GET', '/v1/installation');
    expect(unknown.status).toBe(503);
    expect(unknown.json).toMatchObject({ state: 'unknown', reason: 'server_error' });
    s.gh.server.answerWith(403);
    const denied = await s.call(TOKENS.posture, 'GET', '/v1/repos/acme/app/collaborators');
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.json.state).toBe('unreadable');
    s.gh.server.answerWith(403, { 'x-ratelimit-remaining': '0' });
    const limited = await s.call(TOKENS.posture, 'GET', '/v1/repos/acme/app/collaborators');
    expect(limited.json).toMatchObject({ state: 'unknown', reason: 'rate_limited' });
    // B4 with everything unreadable is unknown and blocks M4, never clear.
    s.gh.server.answerWith(500);
    const b4 = await s.call(TOKENS.posture, 'GET', '/v1/repos/acme/app/b4');
    expect(b4.status).toBe(503); // the repo list itself could not be read
    s.gh.server.answerNormally();
    expect((await s.call(TOKENS.posture, 'GET', '/v1/installation')).status).toBe(200);
  });

  it('validates parameters', async () => {
    expect(
      (await s.call(TOKENS.census, 'GET', '/v1/repos/acme/app/file?sha=zz&path=README.md')).status,
    ).toBe(400);
    expect(
      (await s.call(TOKENS.census, 'GET', `/v1/repos/acme/app/file?sha=${SHA_HEAD}`)).status,
    ).toBe(400);
    const trav = await s.call(
      TOKENS.census,
      'GET',
      `/v1/repos/acme/app/file?sha=${SHA_HEAD}&path=${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(trav.status).toBe(403);
    expect((await s.call(TOKENS.census, 'GET', '/v1/repos/acme/app/head')).status).toBe(400);
  });
});
