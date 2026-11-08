import { afterEach, describe, expect, it } from 'vitest';
import { ALLOW_LIST, checkRequest } from '../src/allow-list.js';
import { startTestCodeHost, type TestCodeHost } from '../src/testing.js';
import { contractSeed } from '@aisdlc/ports/testing';

const allowed = (target: string) => checkRequest('census', 'GET', target);

describe('checkRequest (the request allow-list)', () => {
  it('allows exactly the read rows, with the role each one uses', () => {
    const rows: Array<[string, string]> = [
      ['/installation/repositories?per_page=100&page=2', 'installation_repos'],
      ['/app/installations/4242', 'app_installation'],
      ['/repos/acme/app/contents/docs/a%20b.md?ref=' + 'a'.repeat(40), 'contents'],
      ['/repos/acme/app/git/ref/heads/feature/x', 'git_ref'],
      ['/repos/acme/app/git/matching-refs/heads/feat', 'git_matching_refs'],
      ['/repos/acme/app/commits/main', 'commit'],
      ['/repos/acme/app/rules/branches/feature%2Fx', 'rules_for_branch'],
      ['/repos/acme/app/codeowners/errors?ref=main', 'codeowners_errors'],
      ['/repos/acme/app/collaborators?affiliation=all&per_page=100&page=1', 'collaborators'],
    ];
    for (const [target, id] of rows) {
      const v = allowed(target);
      expect(v.ok && v.row.id, target).toBe(id);
    }
    expect(ALLOW_LIST.every((r) => r.method === 'GET')).toBe(true);
    expect(ALLOW_LIST.map((r) => r.id)).toHaveLength(9);
  });

  it('refuses GET /rulesets in every spelling, by name', () => {
    for (const t of [
      '/repos/acme/app/rulesets',
      '/repos/acme/app/rulesets/12',
      '/repos/acme/app/rulesets?per_page=1',
      '/orgs/acme/rulesets',
    ]) {
      const v = allowed(t);
      expect(!v.ok && v.code, t).toBe('ruleset_listing_refused');
    }
  });

  it('refuses every method but GET', () => {
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'get', '']) {
      const v = checkRequest('census', m, '/repos/acme/app/collaborators');
      expect(!v.ok && v.code, m).toBe('method_refused');
    }
    // The forbidden verbs as the GitHub endpoints that perform them.
    for (const [m, t] of [
      ['PUT', '/repos/acme/app/pulls/1/merge'],
      ['POST', '/repos/acme/app/pulls/1/reviews'],
      ['PUT', '/repos/acme/app/collaborators/bob'],
      ['DELETE', '/repos/acme/app/git/refs/heads/x'],
      ['POST', '/repos/acme/app/rulesets'],
      ['PATCH', '/repos/acme/app/branches/main/protection'],
      ['PUT', '/repos/acme/app/actions/secrets/X'],
    ] as const) {
      expect(checkRequest('census', m, t).ok, `${m} ${t}`).toBe(false);
    }
  });

  it('refuses what is not a row: other repo endpoints, traversal, full URLs, unknown query', () => {
    const cases: Array<[string, string]> = [
      ['/repos/acme/app', 'not_allow_listed'],
      ['/repos/acme/app/branches/main/protection', 'not_allow_listed'],
      ['/repos/acme/app/actions/secrets', 'not_allow_listed'],
      ['/repos/acme/app/hooks', 'not_allow_listed'],
      ['/repos/acme/app/pulls/1', 'not_allow_listed'],
      ['/repos/acme/app/rules/branches/main/extra', 'not_allow_listed'],
      ['/user', 'not_allow_listed'],
      ['/repos/acme/app/contents/../../admin', 'bad_path'],
      ['/repos/acme/app/contents/a/%2e%2e/b', 'bad_path'],
      ['/repos/acme/app/contents/a//b', 'bad_path'],
      ['/repos/acme/app/rules/branches/..', 'bad_path'],
      ['https://evil.example/repos/acme/app/collaborators', 'bad_path'],
      ['//evil.example/repos/acme/app/collaborators', 'bad_path'],
      ['repos/acme/app/collaborators', 'bad_path'],
      ['/repos/acme/app/collaborators#x', 'bad_path'],
      ['/repos/acme/app/collaborators?permission=admin', 'bad_query'],
      ['/repos/acme/app/rules/branches/main?includes_parents=false', 'bad_query'],
    ];
    for (const [t, code] of cases) {
      const v = allowed(t);
      expect(!v.ok && v.code, t).toBe(code);
    }
  });
});

describe('the transport enforces the allow-list before the network', () => {
  let t: TestCodeHost | undefined;
  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  it('a refused request mints no token and sends nothing', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    for (const [m, p] of [
      ['GET', '/repos/acme/app/rulesets'],
      ['GET', '/repos/acme/app/rulesets/1'],
      ['POST', '/repos/acme/app/rulesets'],
      ['PATCH', '/repos/acme/app/rulesets/1'],
      ['PUT', '/repos/acme/app/pulls/1/merge'],
      ['DELETE', '/repos/acme/app/git/refs/heads/main'],
      ['GET', '/repos/acme/app/actions/secrets'],
    ] as const) {
      const r = await t.transport.request(m, p);
      expect(!r.ok && r.error).toMatchObject({ state: 'unreadable', reason: 'refused' });
    }
    expect(t.server.requests).toEqual([]);
    expect(t.broker.mintCount).toBe(0);
    expect(t.transport.refused).toBe(7);
  });

  it('the adapter has no way to ask for a ruleset: its reads are GETs on allow-listed rows', async () => {
    t = await startTestCodeHost({ seed: contractSeed() });
    await t.rest.rules_for_branch({ repo: 'acme/app', branch: 'main' });
    expect(t.server.apiRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /repos/acme/app/rules/branches/main',
    ]);
  });
});
