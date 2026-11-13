import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubAppPermissions } from '@aisdlc/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEnvValues, setEnvValues, startWizard, type Wizard } from '../src/app-wizard.js';
import { FakeGitHubServer, generateTestAppKey } from '../src/fake-github-server.js';
import { testbedSeed } from '../src/fake-github-testbed.js';

// The GitHub App setup wizard (platform/compose/setup-github-apps) driven end to end against the fake GitHub's
// manifest flow, at the HTTP level a browser would: the helper's page, the manifest form posted to "github.com", the
// redirect back with a code, the conversion, the install page, the setup_url with the installation id, the check.

const root = join(import.meta.dirname, '..', '..', '..');
const REPO = 'reshif/asf-factory-testbed';
const HEAD = 'a'.repeat(40);

const unescapeHtml = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

interface Form {
  action: string;
  manifest: string;
  kind: string;
}

const formsOf = (html: string): Form[] =>
  [
    ...html.matchAll(
      /<form method="post" action="([^"]+)"><input type="hidden" name="manifest" value="([^"]+)"><button type="submit" data-kind="([^"]+)">/g,
    ),
  ].map((m) => ({
    action: unescapeHtml(m[1] as string),
    manifest: unescapeHtml(m[2] as string),
    kind: m[3] as string,
  }));

const go = async (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { ...init, redirect: 'manual' });

/** What the browser does for one App: post the manifest, follow every redirect, back to the helper's page. */
async function browse(form: Form): Promise<string[]> {
  const visited: string[] = [];
  let r = await go(form.action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ manifest: form.manifest }).toString(),
  });
  let at = form.action;
  for (let i = 0; i < 10 && r.status === 302; i++) {
    at = new URL(r.headers.get('location') as string, at).toString();
    visited.push(at);
    r = await go(at);
  }
  expect(r.status).toBe(200);
  return visited;
}

let dir: string;
let gh: FakeGitHubServer;
let wizard: Wizard | undefined;
const lines: string[] = [];

function composeDir(): string {
  const d = join(dir, 'compose');
  rmSync(d, { recursive: true, force: true });
  // the real init-secrets, in a directory of its own (it writes secrets/ and .env beside itself)
  mkdirSync(d, { recursive: true });
  copyFileSync(join(root, 'platform', 'compose', 'init-secrets'), join(d, 'init-secrets'));
  return d;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aisdlc-wizard-'));
  lines.length = 0;
  const main = generateTestAppKey();
  gh = await new FakeGitHubServer({
    appId: '123456',
    appPublicKeyPem: main.publicPem,
    seed: testbedSeed({ repo: REPO, head: HEAD, installationId: 1 }),
  }).start();
});
afterEach(async () => {
  await wizard?.stop();
  wizard = undefined;
  await gh.stop();
  rmSync(dir, { recursive: true, force: true });
});

const start = (d: string, extra: Partial<Parameters<typeof startWizard>[0]> = {}) =>
  startWizard({
    composeDir: d,
    apiUrl: gh.baseUrl,
    webUrl: gh.baseUrl,
    factory: {},
    kinds: ['factory', 'gate-check'],
    rotate: false,
    prefix: 'aisdlc',
    homepageUrl: 'https://github.com/apps',
    log: (l) => lines.push(l),
    ...extra,
  });

describe('setup-github-apps against the fake GitHub', () => {
  it('creates the two Apps, writes the keys and ids, and checks both installations', async () => {
    const d = composeDir();
    wizard = await start(d);
    expect(wizard.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    const forms = formsOf(await (await fetch(wizard.url)).text());
    expect(forms.map((f) => f.kind)).toEqual(['factory', 'gate-check']);
    for (const f of forms) {
      expect(f.action).toMatch(new RegExp(`^${gh.baseUrl}/settings/apps/new\\?state=`));
      await browse(f);
    }
    const apps = await wizard.done;

    // what was asked of GitHub: the contract's sets, nothing more; private, no webhook, no events
    const [mf, mg] = gh.manifestFlow.manifests;
    expect(mf?.default_permissions).toEqual(githubAppPermissions('factory'));
    expect(mf?.default_permissions).toEqual({
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
    });
    expect(mg?.default_permissions).toEqual({
      checks: 'write',
      metadata: 'read',
      pull_requests: 'read',
    });
    for (const m of [mf, mg]) {
      expect(m?.public).toBe(false);
      expect(m?.hook_attributes.active).toBe(false);
      expect(m?.default_events).toEqual([]);
      expect(m?.name).toMatch(/^aisdlc-(factory|gate-check)-[0-9a-f]{6}$/);
      expect(m?.redirect_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/created\//);
      expect(m?.setup_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/installed\//);
    }

    const [factory, gate] = gh.manifestFlow.apps;
    expect(apps.map((a) => [a.kind, a.appId, a.installationId])).toEqual([
      ['factory', factory?.id, gh.manifestFlow.installations[0]?.id],
      ['gate-check', gate?.id, gh.manifestFlow.installations[1]?.id],
    ]);
    expect(apps[0]?.repositories).toEqual([REPO]);

    // the keys: one factory key in both files, the gate-check key apart, each the App's own, mode 600
    const key = (f: string) => readFileSync(join(d, 'secrets', f), 'utf8');
    expect(key('github-app.pem')).toBe(key('push-broker-app.pem'));
    expect(key('gate-check-app.pem')).not.toBe(key('github-app.pem'));
    const pub = (pem: string) =>
      createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }).toString();
    expect(pub(key('github-app.pem'))).toBe(factory?.publicKeyPem);
    expect(pub(key('gate-check-app.pem'))).toBe(gate?.publicKeyPem);
    for (const f of ['github-app.pem', 'push-broker-app.pem', 'gate-check-app.pem']) {
      expect(statSync(join(d, 'secrets', f)).mode & 0o777).toBe(0o600);
    }
    // the throwaway markers of the replaced keys are gone (init-secrets now says "real"); the others stay
    expect(existsSync(join(d, 'secrets', '.github-app-fake'))).toBe(false);
    expect(existsSync(join(d, 'secrets', '.push-broker-app-fake'))).toBe(false);
    expect(existsSync(join(d, 'secrets', '.gate-check-app-fake'))).toBe(false);
    expect(existsSync(join(d, 'secrets', '.tracker-app-fake'))).toBe(true);
    // the public halves were refreshed by init-secrets
    expect(readFileSync(join(d, 'secrets', 'push-broker-app.pub.pem'), 'utf8')).toBe(
      factory?.publicKeyPem,
    );

    const env = readEnvValues(join(d, '.env'));
    const bot = `${factory?.slug}[bot]`;
    expect(env).toMatchObject({
      GITHUB_APP_ID: String(factory?.id),
      GITHUB_INSTALLATION_ID: String(apps[0]?.installationId),
      PUSH_BROKER_APP_ID: String(factory?.id),
      PUSH_BROKER_INSTALLATION_ID: String(apps[0]?.installationId),
      PUSH_BROKER_LOGIN: bot,
      GATE_CHECK_PUSH_BROKER_LOGIN: bot,
      GATE_CHECK_APP_ID: String(gate?.id),
      GATE_CHECK_INSTALLATION_ID: String(apps[1]?.installationId),
    });
    expect(statSync(join(d, '.env')).mode & 0o777).toBe(0o600);

    // the key never reached the terminal, nor the helper's page
    const text = lines.join('\n') + (await (await fetch(wizard.url)).text());
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(key('github-app.pem').split('\n')[1]);
    expect(text).toContain('All done');
  });

  it('refuses an installation on all repositories or with extra permissions, and checks again when fixed', async () => {
    const d = composeDir();
    wizard = await start(d, { kinds: ['factory'] });
    gh.manifestFlow.installAs = { selection: 'all', extra: { administration: 'write' } };
    const [form] = formsOf(await (await fetch(wizard.url)).text());
    await browse(form as Form);
    const html = await (await fetch(wizard.url)).text();
    expect(html).toContain('ALL repositories');
    expect(html).toContain('forbidden administration:write');
    expect(readEnvValues(join(d, '.env'))['GITHUB_INSTALLATION_ID']).toBe('REPLACE_ME');

    // the person fixes the installation on GitHub, then "Check again"
    const inst = gh.manifestFlow.installations[0];
    if (!inst) throw new Error('no installation');
    inst.repository_selection = 'selected';
    inst.permissions = { ...githubAppPermissions('factory') };
    const again = /href="(\/recheck\/factory\?state=[^"]+)"/.exec(html)?.[1];
    const r = await go(new URL(unescapeHtml(again as string), wizard.url).toString());
    expect(r.status).toBe(302);
    const [app] = await wizard.done;
    expect(readEnvValues(join(d, '.env'))['GITHUB_INSTALLATION_ID']).toBe(
      String(app?.installationId),
    );
  });

  it('refuses to start over a real key, and every callback without the run token', async () => {
    const d = composeDir();
    // a first run of init-secrets, then a "real" key: no throwaway marker
    wizard = await start(d, { kinds: ['gate-check'] });
    await wizard.stop();
    wizard = undefined;
    rmSync(join(d, 'secrets', '.github-app-fake'));
    await expect(start(d)).rejects.toThrow(/github-app\.pem already hold a real key.*--rotate/);
    // gate-check alone does not touch the factory key
    wizard = await start(d, { kinds: ['gate-check'] });
    const base = new URL(wizard.url).origin;
    for (const p of [
      '/',
      '/created/gate-check?code=x',
      '/installed/gate-check?installation_id=1',
    ]) {
      expect((await go(`${base}${p}`)).status).toBe(403);
      expect((await go(`${base}${p}${p.includes('?') ? '&' : '?'}state=wrong`)).status).toBe(403);
    }
  });

  it('opts the factory App into tracker issues and gate-relay deployments', async () => {
    const d = composeDir();
    wizard = await start(d, { kinds: ['factory'], factory: { tracker: true, gateRelay: true } });
    const [form] = formsOf(await (await fetch(wizard.url)).text());
    await browse(form as Form);
    await wizard.done;
    expect(gh.manifestFlow.manifests[0]?.default_permissions).toEqual(
      githubAppPermissions('factory', { tracker: true, gateRelay: true }),
    );
    const key = (f: string) => readFileSync(join(d, 'secrets', f), 'utf8');
    for (const f of ['push-broker-app.pem', 'tracker-app.pem', 'gate-relay-app.pem']) {
      expect(key(f)).toBe(key('github-app.pem'));
    }
    const env = readEnvValues(join(d, '.env'));
    const app = gh.manifestFlow.apps[0];
    expect(env['TRACKER_APP_ID']).toBe(String(app?.id));
    expect(env['TRACKER_LOGIN']).toBe(`${app?.slug}[bot]`);
    expect(env['GATE_RELAY_APP_ID']).toBe(String(app?.id));
  });
});

describe('the .env editor', () => {
  it('replaces the keys it is given in place and keeps every other line', () => {
    const d = mkdtempSync(join(tmpdir(), 'aisdlc-env-'));
    try {
      const f = join(d, '.env');
      writeFileSync(f, '# a comment\nAISDLC_UID=1000\nGITHUB_APP_ID=123456\nOTHER=x\n');
      setEnvValues(f, { GITHUB_APP_ID: '42', PUSH_BROKER_LOGIN: 'a[bot]' });
      expect(readFileSync(f, 'utf8')).toBe(
        '# a comment\nAISDLC_UID=1000\nGITHUB_APP_ID=42\nOTHER=x\n# Written by ./setup-github-apps.\nPUSH_BROKER_LOGIN=a[bot]\n',
      );
      expect(() => setEnvValues(f, { X: 'a\nB=1' })).toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('platform/compose/setup-github-apps (the launcher)', () => {
  let child: ChildProcess | undefined;
  afterAll(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  });

  it('bundles the wizard, prints the URL, and exits 0 once both Apps are checked', async () => {
    const d = composeDir();
    child = spawn(
      join(root, 'platform', 'compose', 'setup-github-apps'),
      ['--compose-dir', d, '--api-url', gh.baseUrl, '--web-url', gh.baseUrl, '--no-open'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr?.on('data', (b: Buffer) => (out += b.toString()));
    const exited = new Promise<number | null>((resolve) => child?.on('exit', (c) => resolve(c)));
    let url: string | undefined;
    for (let i = 0; i < 200 && url === undefined; i++) {
      url = /(http:\/\/127\.0\.0\.1:\d+\/\?t=\S+)/.exec(out)?.[1];
      if (url === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    expect(url, out).toBeDefined();
    for (const f of formsOf(await (await fetch(url as string)).text())) await browse(f);
    expect(await exited).toBe(0);
    expect(out).toContain('setup-github-apps: done');
    expect(out).toContain('aisdlc/gate');
    expect(out).not.toContain('PRIVATE KEY');
    expect(readEnvValues(join(d, '.env'))['GATE_CHECK_PUSH_BROKER_LOGIN']).toBe(
      `${gh.manifestFlow.apps[0]?.slug}[bot]`,
    );
  }, 60_000);
});
