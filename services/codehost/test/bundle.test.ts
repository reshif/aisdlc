import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GitHttpTestServer,
  createFixtureRepo,
  generateTestAppKey,
  startTestCodeHost,
  TEST_APP_ID,
  type TestCodeHost,
} from '../src/testing.js';
import { seedWithOwners } from './stack.js';

const root = join(import.meta.dirname, '..', '..', '..');
const bundle = join(root, 'services', 'codehost', 'dist', 'main.js');

const runOnce = (env: Record<string, string>) =>
  spawnSync(process.execPath, [bundle], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });

describe('the codehost bundle fails fast on bad configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-codehost-cfg-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'k.pem');
  writeFileSync(keyFile, generateTestAppKey().privatePem, { mode: 0o600 });
  const good = {
    CODEHOST_GITHUB_APP_ID: '123456',
    CODEHOST_GITHUB_INSTALLATION_ID: '4242',
    CODEHOST_GITHUB_APP_KEY_REF: `file:${keyFile}`,
    CODEHOST_CALLERS: JSON.stringify({ core: { token_ref: 'env:T', scopes: ['census'] } }),
    T: 'a'.repeat(32),
    CODEHOST_IDENTITY_URL: 'http://127.0.0.1:1',
    CODEHOST_IDENTITY_TOKEN_REF: 'env:T',
  };

  it('every misconfiguration exits 78 with a clear message and never prints the key', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{}, /CODEHOST_GITHUB_APP_ID is required/],
      [{ ...good, CODEHOST_GITHUB_APP_ID: 'a b' }, /not an app or client id/],
      [{ ...good, CODEHOST_GITHUB_INSTALLATION_ID: 'x' }, /positive integer/],
      [{ ...good, CODEHOST_GITHUB_APP_KEY_REF: 'env:T' }, /file: reference/],
      [{ ...good, CODEHOST_GITHUB_APP_KEY_REF: `file:${join(dir, 'none')}` }, /cannot read secret/],
      [{ ...good, CODEHOST_GITHUB_API_URL: 'http://github.example.com' }, /must be https/],
      [{ ...good, CODEHOST_MODE: 'write' }, /must be census/],
      [{ ...good, CODEHOST_GIT_URL: 'http://git.example.com' }, /CODEHOST_GIT_URL must be https/],
      [{ ...good, CODEHOST_BUNDLE_CAP_BYTES: '0' }, /CODEHOST_BUNDLE_CAP_BYTES/],
      [{ ...good, CODEHOST_BUNDLE_TIMEOUT_MS: '5' }, /CODEHOST_BUNDLE_TIMEOUT_MS/],
      [
        { ...good, CODEHOST_CALLERS: '{"x":{"token_ref":"env:T","scopes":["admin"]}}' },
        /CODEHOST_CALLERS/,
      ],
      [{ ...good, CODEHOST_IDENTITY_URL: 'ftp://x' }, /http\(s\) URL/],
      [{ ...good, CODEHOST_REGISTERED_REPOS_FILE: join(dir, 'missing.json') }, /not readable/],
    ];
    for (const [env, re] of cases) {
      const r = runOnce(env);
      expect(r.status, JSON.stringify(Object.keys(env))).toBe(78);
      expect(r.stderr).toMatch(re);
      expect(r.stderr + r.stdout).not.toContain('PRIVATE KEY');
    }
  });
});

describe('the codehost bundle as a process (plain node, no TypeScript loader)', () => {
  let gh: TestCodeHost;
  let dir: string;
  let child: ChildProcess | undefined;
  let output = '';
  let keyPem = '';
  let gitServer: GitHttpTestServer;

  beforeAll(async () => {
    gh = await startTestCodeHost({ seed: seedWithOwners('* @alice\n') });
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-codehost-run-'));
  });
  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await gh.stop();
    await gitServer?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts, reads through the broker against the fake GitHub, never leaks the key, stops on SIGTERM', async () => {
    keyPem = gh.keyPem;
    // A git server for the bundle route: it accepts the installation tokens the fake GitHub issued.
    const reposDir = join(dir, 'repos');
    const fixture = createFixtureRepo(reposDir, { name: 'acme/app', commits: 2, tags: ['v1'] });
    gitServer = await new GitHttpTestServer({
      root: reposDir,
      isAuthorized: (h) =>
        h !== undefined &&
        gh.server.issued.some(
          (t) => h === `Basic ${Buffer.from(`x-access-token:${t.token}`).toString('base64')}`,
        ),
    }).start();
    const reg = join(dir, 'registered.json');
    writeFileSync(reg, JSON.stringify([{ project_id: 'acme', repo: 'acme/app' }]));
    const token = 'c'.repeat(32);
    child = spawn(process.execPath, ['--enable-source-maps', bundle], {
      env: {
        PATH: process.env['PATH'] ?? '',
        CODEHOST_GITHUB_APP_ID: TEST_APP_ID,
        CODEHOST_GITHUB_INSTALLATION_ID: '4242',
        CODEHOST_GITHUB_APP_KEY_REF: `file:${gh.keyFile}`,
        CODEHOST_GITHUB_API_URL: gh.server.baseUrl,
        CODEHOST_CALLERS: JSON.stringify({
          core: { token_ref: 'env:CH_TOKEN', scopes: ['census', 'posture'] },
        }),
        CH_TOKEN: token,
        CODEHOST_IDENTITY_URL: 'http://127.0.0.1:1',
        CODEHOST_IDENTITY_TOKEN_REF: 'env:CH_TOKEN',
        CODEHOST_REGISTERED_REPOS_FILE: reg,
        CODEHOST_GIT_URL: gitServer.baseUrl,
        NO_PROXY: '127.0.0.1',
        CODEHOST_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const base = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`codehost did not start:\n${output}`)), 20_000);
      const poll = setInterval(() => {
        const m = /codehost listening on (http:\/\/\S+)/.exec(output);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(m[1] as string);
        }
      }, 50);
      child?.once('exit', (code) => reject(new Error(`codehost exited ${code}:\n${output}`)));
    });
    const get = async (path: string, auth = true) => {
      const res = await fetch(new URL(path, base), {
        headers: auth ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: res.status, text: await res.text() };
    };
    expect((await get('/healthz', false)).status).toBe(200);
    expect((await get('/v1/repos', false)).status).toBe(401);
    const repos = await get('/v1/repos');
    expect(repos.status).toBe(200);
    expect(JSON.parse(repos.text).value.map((r: { full_name: string }) => r.full_name)).toEqual([
      'acme/app',
    ]);
    const inst = await get('/v1/installation');
    expect(JSON.parse(inst.text).value.installation_id).toBe(4242);
    const b4 = await get('/v1/repos/acme/app/b4');
    expect(JSON.parse(b4.text).report.b4b.status).toBe('blocked'); // statuses:write + an unpinned 'lint'
    // The bundle, made by git inside the bundled process: a credential-free git bundle at the head.
    const res = await fetch(new URL('/v1/repos/acme/app/bundle?refs=all', base), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-base-sha')).toBe(fixture.head);
    const bundleBytes = Buffer.from(await res.arrayBuffer());
    expect(bundleBytes.subarray(0, 16).toString()).toBe('# v2 git bundle\n');
    for (const t of gh.server.issued) expect(bundleBytes.includes(t.token)).toBe(false);
    // A different, unregistered repo is refused.
    expect((await get('/v1/repos/acme/lib/rules?branch=trunk')).status).toBe(403);

    // GETs with installation tokens only; the process minted only read subsets.
    expect(gh.server.apiRequests.every((r) => r.method === 'GET')).toBe(true);
    expect(gh.server.issued.length).toBeGreaterThan(0);

    const exited = new Promise<number | null>((resolve) => child?.once('exit', (c) => resolve(c)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(output).toMatch(/codehost: SIGTERM received, shutting down/);

    // Nothing the process printed holds the key or a credential.
    const body = keyPem.replace(/-----[^-]+-----|\s/g, '');
    for (const n of [
      body.slice(0, 48),
      body.slice(-48),
      'PRIVATE KEY',
      ...gh.server.seenBearers,
      token,
    ]) {
      expect(output.includes(n), n.slice(0, 10)).toBe(false);
    }
    expect(output).toMatch(/GET \/installation\/repositories -> 200/);
  }, 60_000);
});
