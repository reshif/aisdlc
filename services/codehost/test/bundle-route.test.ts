import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundleManifest } from '@aisdlc/contracts';
import { emptySeed } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeIdentityLinks } from '../src/index.js';
import { GitHttpTestServer, createFixtureRepo, git, type FixtureRepo } from '../src/testing.js';
import { TOKENS, startCodeHostApp, type CodeHostTestApp } from './stack.js';

// GET /v1/repos/:owner/:name/bundle (scope census): the bundle streamed with X-Base-Sha and
// X-Bundle-Manifest, through the real broker, adapter, allow-list and Fastify app.

const ROOT = mkdtempSync(join(tmpdir(), 'aisdlc-route-'));
const TMP_ROOT = join(ROOT, 'tmp');
mkdirSync(TMP_ROOT);
let s: CodeHostTestApp;
let server: GitHttpTestServer;
let app: FixtureRepo;
const accepted = new Set<string>();

beforeAll(async () => {
  const reposDir = join(ROOT, 'repos');
  app = createFixtureRepo(reposDir, {
    name: 'acme/app',
    commits: 2,
    branches: [{ name: 'dev' }],
    tags: ['v1'],
    pulls: [{ number: 5, branch: 'dev' }],
  });
  createFixtureRepo(reposDir, { name: 'acme/lib', default_branch: 'trunk' });
  server = await new GitHttpTestServer({
    root: reposDir,
    isAuthorized: (h) => h !== undefined && accepted.has(h),
  }).start();
  s = await startCodeHostApp(
    new FakeIdentityLinks(),
    emptySeed({
      installation: {
        installation_id: 4242,
        account_login: 'acme',
        repository_selection: 'selected',
        permissions: { contents: 'read', metadata: 'read' },
        suspended: false,
      },
      repos: [
        { full_name: 'acme/app', default_branch: 'main', private: false, archived: false },
        { full_name: 'acme/lib', default_branch: 'trunk', private: false, archived: false },
      ],
    }),
    [{ project_id: 'acme', repo: 'acme/app' }],
    { gitBaseUrl: server.baseUrl, tmpRoot: TMP_ROOT, extraEnv: { NO_PROXY: '127.0.0.1' } },
  );
  const t = await s.gh.broker.token('hub');
  if (!t.ok) throw new Error('no token');
  accepted.add(
    `Basic ${Buffer.from(`x-access-token:${t.value.secret.reveal()}`).toString('base64')}`,
  );
}, 60_000);

afterAll(async () => {
  await s.stop();
  await server.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

const get = (token: string | null, path: string) =>
  fetch(new URL(path, s.url), { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('GET /v1/repos/:owner/:name/bundle', () => {
  it('streams the bundle with X-Base-Sha and X-Bundle-Manifest', async () => {
    const res = await get(TOKENS.census, '/v1/repos/acme/app/bundle?refs=all');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-git-bundle');
    const manifest = BundleManifest.parse(JSON.parse(res.headers.get('x-bundle-manifest') ?? ''));
    expect(res.headers.get('x-base-sha')).toBe(app.head);
    expect(manifest).toMatchObject({
      repo: 'acme/app',
      head_sha: app.head,
      refs_covered: 'all',
      ref_count: 4,
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBe(manifest.bytes);
    expect(Number(res.headers.get('content-length'))).toBe(manifest.bytes);
    const file = join(ROOT, 'app.bundle');
    writeFileSync(file, bytes);
    const out = execFileSync('git', ['bundle', 'list-heads', file], { encoding: 'utf8' });
    expect(out).toContain(`${app.head} HEAD`);
    expect(out).toContain('refs/pull/5/head');
    const empty = mkdtempSync(join(ROOT, 'v-'));
    git(empty, 'init', '--quiet');
    expect(git(empty, 'bundle', 'verify', file)).toContain('complete history');
    // Nothing of any credential in what the service said.
    const token = [...accepted][0] as string;
    expect(res.headers.get('x-bundle-manifest')).not.toContain(token.slice(6));
    expect(readdirSync(TMP_ROOT)).toEqual([]);
  });

  it('refs=default_only and base_sha are honoured; a moved head is 409', async () => {
    const one = await get(
      TOKENS.census,
      `/v1/repos/acme/app/bundle?refs=default_only&base_sha=${app.head}`,
    );
    expect(one.status).toBe(200);
    expect(JSON.parse(one.headers.get('x-bundle-manifest') ?? '')).toMatchObject({
      refs_covered: 'default_only',
      ref_count: 1,
    });
    await one.arrayBuffer();
    const moved = await get(TOKENS.census, `/v1/repos/acme/app/bundle?base_sha=${'e'.repeat(40)}`);
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ state: 'unreadable', reason: 'head_moved' });
  });

  it('needs the census scope and a registered repo; bad input is 400', async () => {
    expect((await get(null, '/v1/repos/acme/app/bundle')).status).toBe(401);
    expect((await get(TOKENS.posture, '/v1/repos/acme/app/bundle')).status).toBe(403);
    // acme/lib is installed but has no S0 record: refused before any git runs.
    const before = server.requests.length;
    const lib = await get(TOKENS.census, '/v1/repos/acme/lib/bundle');
    expect(lib.status).toBe(403);
    expect(await lib.json()).toMatchObject({ reason: 'repo_not_allowed' });
    expect(server.requests.length).toBe(before);
    expect((await get(TOKENS.census, '/v1/repos/acme/app/bundle?refs=everything')).status).toBe(
      400,
    );
    expect((await get(TOKENS.census, '/v1/repos/acme/app/bundle?base_sha=zz')).status).toBe(400);
  });
});
