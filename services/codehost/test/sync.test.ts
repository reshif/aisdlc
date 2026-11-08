import { identityProjection } from '@aisdlc/identity/read';
import {
  bindProject,
  linkGithubLogin,
  seedPrincipals,
  settingsOf,
  startIdentityStack,
  startTestIdentityApi,
  type IdentityStack,
} from '@aisdlc/identity/testing';
import { runProjection } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpIdentityLinks } from '../src/index.js';
import {
  SHA_HEAD,
  TOKENS,
  seedWithOwners,
  startCodeHostApp,
  type CodeHostTestApp,
} from './stack.js';

const OWNERS = [
  '# code owners',
  '* @Alice @bob @ghost @acme/core-team carol@example.com',
  '*.md @alice',
  'docs/ @carol-gh',
  'broken line here !!',
].join('\n');

let id: IdentityStack;
let idApi: { url: string; stop(): Promise<void> };
let idUrl: string;
let s: CodeHostTestApp;
const ID_TOKEN = 'codehost-at-identity-'.padEnd(32, 'x');

beforeAll(async () => {
  id = await startIdentityStack();
  await seedPrincipals(id.deps, ['alice', 'bob', 'carol', 'dave']);
  // GitHub logins are linked to principals in identity; 'ghost' and 'carol-gh' are not linked.
  for (const [principal, login] of [
    ['alice', 'ALICE'],
    ['bob', 'bob'],
  ] as const) {
    await linkGithubLogin(id.deps, principal, login);
  }
  await bindProject(id, 'acme', { admin: ['alice'] }); // g4 is `codeowners`
  await bindProject(id, 'other', { admin: ['dave'] });
  idApi = await startTestIdentityApi(id, {
    codehost: { token: ID_TOKEN, scopes: ['read', 'codeowners'] },
  });
  idUrl = idApi.url;
  s = await startCodeHostApp(
    new HttpIdentityLinks({ baseUrl: idUrl, token: ID_TOKEN }),
    seedWithOwners(OWNERS),
    [
      { project_id: 'acme', repo: 'acme/app' },
      { project_id: 'other', repo: 'acme/lib' },
    ],
  );
});
afterAll(async () => {
  await s.stop();
  await idApi.stop();
  await id.stop();
});

const members = async (group: string): Promise<string[]> => {
  await runProjection(id.record.pool, identityProjection);
  const q = await id.record.pool.query<{ principal_id: string }>(
    'SELECT principal_id FROM identity.membership WHERE group_id = $1 ORDER BY 1',
    [group],
  );
  return q.rows.map((r) => r.principal_id);
};
const sync = (project: string, repos: Array<{ repo: string; sha?: string }>, token = TOKENS.sync) =>
  s.call(token, 'POST', `/v1/projects/${project}/codeowners/sync`, { repos });
const eventCount = async (): Promise<number> =>
  Number(
    (
      await id.record.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM record.record_event',
      )
    ).rows[0]?.n,
  );

describe('CODEOWNERS feed into the g4 group', () => {
  it('starts with nobody in g4 (the role map generates the group and leaves membership alone)', async () => {
    expect(await members('rm.acme.g4')).toEqual([]);
  });

  it('maps owner logins to principals, reports unmapped ones, and records teams and e-mails as unresolved', async () => {
    const r = await sync('acme', [{ repo: 'acme/app' }]);
    expect(r.status).toBe(200);
    expect(r.json.mapped).toEqual([
      { login: 'alice', principal_id: 'alice' },
      { login: 'bob', principal_id: 'bob' },
    ]);
    // Never invented: no link, no principal.
    expect(r.json.unmapped_logins).toEqual(['carol-gh', 'ghost']);
    expect(r.json.unresolved_teams).toEqual(['acme/core-team']);
    expect(r.json.unresolved_emails).toEqual(['carol@example.com']);
    expect(r.json.members).toEqual(['alice', 'bob']);
    expect(r.json.added).toEqual(['alice', 'bob']);
    expect(r.json.removed).toEqual([]);
    expect(r.json.repos).toHaveLength(1);
    expect(r.json.repos[0]).toMatchObject({
      repo: 'acme/app',
      sha: SHA_HEAD,
      path: '.github/CODEOWNERS',
    });
    expect(r.json.repos[0].parse_errors).toEqual([
      { line: 5, message: expect.stringContaining('invalid owner') },
    ]);
    expect(r.json.repos[0].github_errors).toHaveLength(1); // what GitHub itself reports
    expect(await members('rm.acme.g4')).toEqual(['alice', 'bob']);
    const src = await id.record.pool.query<{ source: string }>(
      "SELECT DISTINCT source FROM identity.membership WHERE group_id = 'rm.acme.g4'",
    );
    expect(src.rows).toEqual([{ source: 'codeowners' }]);
  });

  it('is idempotent: a second run writes nothing', async () => {
    const before = await eventCount();
    const r = await sync('acme', [{ repo: 'acme/app', sha: SHA_HEAD }]);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ added: [], removed: [], members: ['alice', 'bob'] });
    expect(await eventCount()).toBe(before);
  });

  it('follows CODEOWNERS: an owner who leaves the file leaves the group; a link added later joins', async () => {
    s.gh.server.load(seedWithOwners('* @alice\n'));
    const r = await sync('acme', [{ repo: 'acme/app' }]);
    expect(r.json).toMatchObject({ members: ['alice'], removed: ['bob'], added: [] });
    expect(await members('rm.acme.g4')).toEqual(['alice']);

    s.gh.server.load(seedWithOwners('* @alice @carol-gh\n'));
    expect((await sync('acme', [{ repo: 'acme/app' }])).json.unmapped_logins).toEqual(['carol-gh']);
    await linkGithubLogin(id.deps, 'carol', 'Carol-GH');
    const r2 = await sync('acme', [{ repo: 'acme/app' }]);
    expect(r2.json).toMatchObject({
      members: ['alice', 'carol'],
      added: ['carol'],
      unmapped_logins: [],
    });
  });

  it('only teams and unmapped logins: nobody holds g4 (fail closed), and that is reported', async () => {
    s.gh.server.load(seedWithOwners('* @acme/core @stranger\n'));
    const r = await sync('acme', [{ repo: 'acme/app' }]);
    expect(r.json).toMatchObject({
      members: [],
      removed: ['alice', 'carol'],
      unresolved_teams: ['acme/core'],
      unmapped_logins: ['stranger'],
    });
    expect(await members('rm.acme.g4')).toEqual([]);
  });

  it('no CODEOWNERS file at the head: the group is emptied and path is null', async () => {
    s.gh.server.load(seedWithOwners('* @alice\n'));
    await sync('acme', [{ repo: 'acme/app' }]);
    expect(await members('rm.acme.g4')).toEqual(['alice']);
    const seed = seedWithOwners('x');
    seed.files = seed.files.filter((f) => !f.path.endsWith('CODEOWNERS'));
    s.gh.server.load(seed);
    const r = await sync('acme', [{ repo: 'acme/app' }]);
    expect(r.json.repos[0]).toMatchObject({ path: null, blob_sha: null });
    expect(r.json.members).toEqual([]);
  });
});

describe('the feed fails closed', () => {
  it('a transient GitHub failure changes nothing (the group is not emptied)', async () => {
    s.gh.server.load(seedWithOwners('* @alice\n'));
    await sync('acme', [{ repo: 'acme/app' }]);
    const before = await eventCount();
    for (const status of [500, 403, 404]) {
      s.gh.server.answerWith(status);
      const r = await sync('acme', [{ repo: 'acme/app' }]);
      expect(r.status, String(status)).toBeGreaterThanOrEqual(400);
    }
    s.gh.server.answerNormally();
    expect(await eventCount()).toBe(before);
    expect(await members('rm.acme.g4')).toEqual(['alice']);
  });

  it('a sha that is not the default-branch head is refused (409), so a PR branch cannot set owners', async () => {
    const r = await sync('acme', [{ repo: 'acme/app', sha: 'e'.repeat(40) }]);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('stale_sha');
  });

  it('a repo registered to another project, or not registered, or not installed, is refused', async () => {
    expect((await sync('acme', [{ repo: 'acme/lib' }])).json.error.code).toBe('repo_not_allowed');
    expect((await sync('other', [{ repo: 'acme/app' }])).json.error.code).toBe('repo_not_allowed');
    expect((await sync('acme', [{ repo: 'evil/other' }])).json.error.code).toBe('repo_not_allowed');
    expect((await sync('acme', [{ repo: 'acme/app' }, { repo: 'ACME/app' }])).status).toBe(400);
  });

  it('an unavailable registry allows nothing', async () => {
    s.registered.breakIt();
    const r = await sync('acme', [{ repo: 'acme/app' }]);
    expect(r.status).toBe(503);
    expect((await s.call(TOKENS.census, 'GET', '/v1/repos')).status).toBe(503);
    s.registered.breakIt(false);
  });

  it('identity refusing the command (a project whose g4 is held by principals) changes nothing', async () => {
    id.settings.set(settingsOf('named', { g4: ['dave'] }), 'T1');
    s.registered.set([{ project_id: 'named', repo: 'acme/lib' }] as never);
    const before = await eventCount();
    const r = await sync('named', [{ repo: 'acme/lib' }]);
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe('identity_refused');
    expect(await eventCount()).toBe(before);
    s.registered.set([
      { project_id: 'acme', repo: 'acme/app' },
      { project_id: 'other', repo: 'acme/lib' },
    ] as never);
  });

  it('an unavailable identity is a 503 and nothing is written', async () => {
    const broken = await startCodeHostApp(
      new HttpIdentityLinks({ baseUrl: 'http://127.0.0.1:1', token: ID_TOKEN }),
      seedWithOwners('* @alice\n'),
    );
    try {
      const r = await broken.call(TOKENS.sync, 'POST', '/v1/projects/acme/codeowners/sync', {
        repos: [{ repo: 'acme/app' }],
      });
      expect(r.status).toBe(503);
      expect(r.json.error.code).toBe('identity_unavailable');
    } finally {
      await broken.stop();
    }
  });

  it('validates the body and needs the codeowners_sync scope', async () => {
    expect(
      (await s.call(TOKENS.sync, 'POST', '/v1/projects/acme/codeowners/sync', {})).status,
    ).toBe(400);
    expect(
      (await s.call(TOKENS.sync, 'POST', '/v1/projects/acme/codeowners/sync', { repos: [] }))
        .status,
    ).toBe(400);
    expect(
      (
        await s.call(TOKENS.sync, 'POST', '/v1/projects/acme/codeowners/sync', {
          repos: [{ repo: 'a' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await s.call(TOKENS.sync, 'POST', '/v1/projects/acme/codeowners/sync', {
          repos: [{ repo: 'acme/app', extra: 1 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await s.call(TOKENS.census, 'POST', '/v1/projects/acme/codeowners/sync', {
          repos: [{ repo: 'acme/app' }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await s.call(null, 'POST', '/v1/projects/acme/codeowners/sync', {
          repos: [{ repo: 'acme/app' }],
        })
      ).status,
    ).toBe(401);
  });

  it('merges the owners of several repos of one project', async () => {
    s.registered.set([
      { project_id: 'acme', repo: 'acme/app' },
      { project_id: 'acme', repo: 'acme/lib' },
    ] as never);
    const seed = seedWithOwners('* @alice\n');
    seed.files = seed.files.map((f) => (f.repo === 'acme/lib' ? { ...f, content: '* @bob\n' } : f));
    s.gh.server.load(seed);
    const r = await sync('acme', [{ repo: 'acme/app' }, { repo: 'acme/lib' }]);
    expect(r.json.members).toEqual(['alice', 'bob']);
    expect(r.json.repos.map((x: { repo: string }) => x.repo)).toEqual(['acme/app', 'acme/lib']);
    // One unreadable repo aborts the whole sync: bob is not dropped, alice is not alone.
    const before = await eventCount();
    seed.heads = seed.heads.filter((h) => h.repo !== 'acme/lib');
    s.gh.server.load(seed);
    expect(
      (await sync('acme', [{ repo: 'acme/app' }, { repo: 'acme/lib' }])).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await eventCount()).toBe(before);
  });
});

describe('the App key and tokens in the record', () => {
  it('appear in no record event, ledger entry or identity row after a full sync', async () => {
    await id.sync();
    const text = (
      await id.record.pool.query<{ t: string }>(
        `SELECT coalesce(string_agg(body::text, E'\\n'), '') AS t FROM record.record_event
         UNION ALL SELECT coalesce(string_agg(body::text, E'\\n'), '') FROM ledger.ledger_entry
         UNION ALL SELECT coalesce(string_agg(m::text, E'\\n'), '') FROM identity.membership m`,
      )
    ).rows
      .map((r) => r.t)
      .join('\n');
    expect(text.length).toBeGreaterThan(500);
    expect(text).toContain('codeowners');
    const body = s.gh.keyPem.replace(/-----[^-]+-----|\s/g, '');
    for (const n of [
      body.slice(0, 48),
      body.slice(300, 360),
      'PRIVATE KEY',
      ...s.gh.server.seenBearers,
    ]) {
      expect(text.includes(n), n.slice(0, 10)).toBe(false);
    }
  });
});
