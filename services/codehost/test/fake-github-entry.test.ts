import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEHOST_ROLE_PERMISSIONS, githubAppPermissions } from '@aisdlc/contracts';
import { FakeGitHub } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TESTBED_FILES, buildTestbed, testbedSeed } from '../src/fake-github-testbed.js';
import { appJwt } from '../src/jwt.js';

// The compose stack's fake GitHub (PLAN M8.0): the seeded testbed repository is one a Census can
// read (the REST seed and the git history agree), and the bundle starts, answers its health check,
// and prints every request it is asked as one log line.

const root = join(import.meta.dirname, '..', '..', '..');
const bundle = join(root, 'services', 'codehost', 'dist', 'fake-github.js');
const REPO = 'reshif/asf-factory-testbed';
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aisdlc-fake-entry-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the seeded testbed', () => {
  it('has a git history whose head is the sha the REST seed serves its files at', async () => {
    const head = buildTestbed(join(dir, 'repos'), REPO);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const bare = join(dir, 'repos', `${REPO}.git`);
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', head], {
      cwd: bare,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(files).toEqual(Object.keys(TESTBED_FILES).sort());

    const gh = new FakeGitHub(testbedSeed({ repo: REPO, head, installationId: 1 }));
    const repos = await gh.list_repos();
    expect(repos.state === 'ok' && repos.value.map((r) => r.full_name)).toEqual([REPO]);
    expect(await gh.branch_head({ repo: REPO, branch: 'main' })).toEqual({
      state: 'ok',
      value: head,
    });
    const co = await gh.codeowners({ repo: REPO, sha: head });
    expect(co.state === 'ok' && co.value?.content).toBe('* @reshif\n');
    const inst = await gh.installation();
    expect(inst.state === 'ok' && inst.value.permissions).toEqual({
      contents: 'read',
      metadata: 'read',
    });
  });
});

describe('the fake-github bundle', () => {
  let child: ChildProcess | undefined;
  let output = '';
  afterAll(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  });

  it('serves /healthz, logs a request, refuses an unauthenticated one, and stops on SIGTERM', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pub = join(dir, 'app.pub.pem');
    writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }).toString());
    child = spawn(process.execPath, [bundle], {
      env: {
        PATH: process.env['PATH'] ?? '',
        FAKE_GITHUB_APP_ID: '123456',
        FAKE_GITHUB_INSTALLATION_ID: '1',
        FAKE_GITHUB_APP_PUBLIC_KEY_FILE: pub,
        FAKE_GITHUB_API_PORT: '0',
        FAKE_GITHUB_GIT_PORT: '0',
        FAKE_GITHUB_DIR: join(dir, 'served'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    // Port 0 is not a valid FAKE_GITHUB_*_PORT (a compose port is always fixed): it is refused.
    const code = await new Promise<number | null>((r) => child?.once('exit', (c) => r(c)));
    expect(code).toBe(78);
    expect(output).toMatch(/must be a port/);

    output = '';
    child = spawn(process.execPath, [bundle], {
      env: {
        PATH: process.env['PATH'] ?? '',
        FAKE_GITHUB_APP_ID: '123456',
        FAKE_GITHUB_INSTALLATION_ID: '1',
        FAKE_GITHUB_APP_PUBLIC_KEY_FILE: pub,
        FAKE_GITHUB_API_PORT: '18353',
        FAKE_GITHUB_GIT_PORT: '18354',
        FAKE_GITHUB_DIR: join(dir, 'served'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const until = Date.now() + 20_000;
    while (!/fake-github listening on/.test(output)) {
      if (Date.now() > until) throw new Error(`did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await fetch('http://127.0.0.1:18353/healthz')).status).toBe(200);
    expect((await fetch('http://127.0.0.1:18353/installation/repositories')).status).toBe(401);
    const logged = Date.now() + 5_000;
    while (!/fake-github api/.test(output) && Date.now() < logged) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(output).toMatch(
      /fake-github api \{"method":"GET","path":"\/installation\/repositories"/,
    );
    expect(output).not.toMatch(/healthz/);
    const exited = new Promise<number | null>((r) => child?.once('exit', (c) => r(c)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 60_000);

  it('one factory App that reads and pushes: the Push Broker id is the main App, its grant the union', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pub = join(dir, 'one.pub.pem');
    writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }).toString());
    output = '';
    child = spawn(process.execPath, [bundle], {
      env: {
        PATH: process.env['PATH'] ?? '',
        FAKE_GITHUB_APP_ID: '123456',
        FAKE_GITHUB_INSTALLATION_ID: '1',
        FAKE_GITHUB_APP_PUBLIC_KEY_FILE: pub,
        FAKE_GITHUB_PUSH_APP_ID: '123456',
        FAKE_GITHUB_PUSH_INSTALLATION_ID: '1',
        FAKE_GITHUB_PUSH_APP_PUBLIC_KEY_FILE: pub,
        FAKE_GITHUB_BOT_LOGIN: 'aisdlc-factory-abc123[bot]',
        FAKE_GITHUB_API_PORT: '18363',
        FAKE_GITHUB_GIT_PORT: '18364',
        FAKE_GITHUB_DIR: join(dir, 'served-one'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const until = Date.now() + 20_000;
    while (!/fake-github listening on/.test(output)) {
      if (Date.now() > until) throw new Error(`did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(output).toContain('one factory App reads and pushes');
    const jwt = appJwt(
      { signRs256: (d: string) => sign('RSA-SHA256', Buffer.from(d), privateKey) },
      '123456',
      new Date(),
    );
    const inst = await fetch('http://127.0.0.1:18363/app/installations/1', {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(((await inst.json()) as { permissions: unknown }).permissions).toEqual(
      githubAppPermissions('factory'),
    );
    // the Push Broker's token (the `docs` role) is minted from the same installation
    const mint = await fetch('http://127.0.0.1:18363/app/installations/1/access_tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: CODEHOST_ROLE_PERMISSIONS.docs }),
    });
    expect(mint.status).toBe(201);
    const exited = new Promise<number | null>((r) => child?.once('exit', (c) => r(c)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 60_000);
});
