import { IntegrationRegistryView } from '@aisdlc/contracts';
import { codeHostRow, integrationScope } from '@aisdlc/integrations';
import { FakeRegisteredRepos } from '@aisdlc/ports';
import { contractSeed } from '@aisdlc/ports/testing';
import { ServiceAuth, listen, newApp } from '@aisdlc/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootCodeHost, createCodeHostApp } from '../src/index.js';
import { RegistryHostSelector, reportHealth } from '../src/registry-runtime.js';
import { TEST_APP_ID, startTestCodeHost, type TestCodeHost } from '../src/testing.js';

// The codehost's adapter selected by the integration registry (PLAN M10.4): a row read from core, followed
// by config revision (a poll, and a reload endpoint) without a restart, with the key in its own file.

let gh: TestCodeHost;
let coreUrl: string;
let core: ReturnType<typeof newApp>;
const TOKEN = 'core-token-'.padEnd(32, 'x');
const state = {
  view: {
    revision: null as string | null,
    integrations: [] as unknown[],
    installs: [] as unknown[],
  },
  down: false,
  health: [] as unknown[],
  registeredCalls: 0,
};
const registered = new FakeRegisteredRepos();

beforeAll(async () => {
  gh = await startTestCodeHost({ seed: contractSeed() });
  core = newApp();
  core.get('/v1/integrations', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply.code(401).send({});
    if (state.down) return reply.code(503).send({});
    return state.view;
  });
  core.post('/v1/integrations/health', async (req) => {
    state.health.push(req.body);
    return { recorded: 1 };
  });
  core.get('/v1/registered-repos', async () => {
    state.registeredCalls += 1;
    const r = await registered.list();
    return r.ok ? r.value : [];
  });
  coreUrl = await listen(core);
});
afterAll(async () => {
  await core.close();
  await gh.stop();
});

const row = (over = {}) =>
  codeHostRow(
    'github-app',
    'github_app',
    {
      app_id: TEST_APP_ID,
      installation_id: 4242,
      api_url: gh.server.baseUrl,
      git_url: gh.server.baseUrl,
    },
    {
      credentials: [
        { credential_id: 'app-key', secret_ref: `file:${gh.keyFile}`, kind: 'app_key' },
      ],
      scopes: [integrationScope('read_repos', 'D2')],
      ...over,
    },
  );
const publish = (
  integrations: unknown[],
  installs: unknown[] = [],
  revision = `rev-${Math.random()}`,
) => {
  state.view = IntegrationRegistryView.parse({
    revision: revision.replace(/^rev-/, '').padEnd(64, '0').slice(0, 64),
    integrations,
    installs,
  });
};
const selector = (over: Partial<ConstructorParameters<typeof RegistryHostSelector>[0]> = {}) =>
  new RegistryHostSelector({
    integrationId: 'github-app',
    core: { url: coreUrl, token: TOKEN },
    policy: {
      env: {},
      secretRefs: new Set([`file:${gh.keyFile}`]),
      egressHosts: new Set([new URL(gh.server.baseUrl).hostname]),
    },
    registered: new (class {
      list() {
        return registered.list();
      }
    })(),
    bundleCapBytes: 1_000_000,
    bundleTimeoutMs: 10_000,
    ...over,
  });

describe('RegistryHostSelector', () => {
  it('serves nothing until the row is readable and enabled: every read is unknown, health is down with a code', async () => {
    registered.set([]);
    const sel = selector();
    state.down = true;
    expect(await sel.sync()).toMatchObject({
      state: 'unavailable',
      detail: 'registry_unreachable',
    });
    expect(await sel.host.list_repos()).toMatchObject({ state: 'unknown' });
    expect(sel.health()).toEqual([
      { integration_id: 'github-app', state: 'down', detail_code: 'registry_unreachable' },
    ]);
    state.down = false;
    publish([]);
    expect(await sel.sync()).toMatchObject({ detail: 'integration_missing' });
    publish([row({ status: 'disabled' })]);
    expect(await sel.sync()).toMatchObject({ detail: 'integration_not_enabled' });
    expect(await sel.host.installation()).toMatchObject({ state: 'unknown' });
  });

  it('builds its GitHub adapter from the row, with the App key from its own file, and follows a revision without a restart', async () => {
    const seed = contractSeed();
    registered.set(seed.repos.map((r) => ({ project_id: 'p1', repo: r.full_name })));
    const sel = selector();
    publish([row()]);
    expect(await sel.sync()).toMatchObject({ state: 'serving', detail: 'ok' });
    const repos = await sel.host.list_repos();
    expect(repos.state, JSON.stringify(repos)).toBe('ok');
    // evidence of a good answer: health ok
    expect(sel.health()).toEqual([
      { integration_id: 'github-app', state: 'ok', detail_code: 'ok' },
    ]);
    // the key is in no part of what the registry served
    expect(JSON.stringify(state.view)).not.toContain('PRIVATE KEY');
    // the registry changes (a new revision narrows the project's repos through an install): picked up by the next sync
    const first = (repos as { value: Array<{ full_name: string }> }).value[0]!.full_name;
    publish(
      [row()],
      [
        {
          install_id: 'gh-p1',
          integration_id: 'github-app',
          project_id: 'p1',
          enabled: true,
          overrides: { repos_allowed: [first] },
        },
      ],
    );
    await sel.sync();
    const narrowed = await sel.host.list_repos();
    expect(
      (narrowed as { value: unknown[] }).value.map((r) => (r as { full_name: string }).full_name),
    ).toEqual([first]);
    // a disabled install takes the project's repos away
    publish(
      [row()],
      [
        {
          install_id: 'gh-p1',
          integration_id: 'github-app',
          project_id: 'p1',
          enabled: false,
          overrides: {},
        },
      ],
    );
    await sel.sync();
    expect((await sel.host.list_repos()) as { value: unknown[] }).toMatchObject({ value: [] });
    // the row is switched off: the host stops serving at once
    publish([row({ status: 'disabled' })]);
    await sel.sync();
    expect(await sel.host.list_repos()).toMatchObject({ state: 'unknown' });
  });

  it('keeps serving the last good row when core cannot be reached, and rebuilds an unchanged row only when forced', async () => {
    registered.set([]);
    const sel = selector();
    publish([row()]);
    await sel.sync();
    const broker1 = sel.broker;
    await sel.sync();
    expect(sel.broker).toBe(broker1); // unchanged: the same adapter
    await sel.sync({ force: true });
    expect(sel.broker).not.toBe(broker1); // forced: rebuilt (a rotated key file is picked up this way)
    state.down = true;
    expect(await sel.sync()).toMatchObject({ state: 'serving' });
    state.down = false;
  });

  it('refuses a row that names a key file or hosts this deployment did not give it, by code, and builds nothing', async () => {
    publish([
      row({
        credentials: [
          { credential_id: 'k', secret_ref: 'file:/run/secrets/another', kind: 'app_key' },
        ],
      }),
    ]);
    expect(await selector().sync()).toMatchObject({
      state: 'unavailable',
      detail: 'secret_ref_not_allowed',
    });
    publish([row()]);
    expect(
      await selector({
        policy: {
          env: {},
          secretRefs: new Set([`file:${gh.keyFile}`]),
          egressHosts: new Set(['api.github.com', 'github.com']),
        },
      }).sync(),
    ).toMatchObject({
      detail: 'egress_not_allowed',
    });
    publish([
      row({
        credentials: [
          { credential_id: 'k', secret_ref: 'file:/nonexistent/key.pem', kind: 'app_key' },
        ],
      }),
    ]);
    expect(
      await selector({
        policy: {
          env: {},
          secretRefs: new Set(['file:/nonexistent/key.pem']),
          egressHosts: new Set([new URL(gh.server.baseUrl).hostname]),
        },
      }).sync(),
    ).toMatchObject({ detail: 'secret_unreadable' });
    // an enabled row with no credential does not even parse as a registry row: nothing to serve with
    state.view = {
      revision: 'f'.repeat(64),
      integrations: [row({ credentials: [] })],
      installs: [],
    } as never;
    expect(await selector().sync()).toMatchObject({ state: 'unavailable' });
  });

  it('reports its health to core in the shared shape', async () => {
    state.health.length = 0;
    const sel = selector();
    publish([row()]);
    await sel.sync();
    expect(await reportHealth({ url: coreUrl, token: TOKEN }, sel.health())).toBe(true);
    expect(state.health[0]).toEqual({
      reporter: 'codehost',
      reports: [
        {
          integration_id: 'github-app',
          state: expect.stringMatching(/ok|unknown/),
          detail_code: expect.any(String),
        },
      ],
    });
  });
});

describe('the reload endpoint and registry-mode boot', () => {
  const CALLER = 'reload-token-'.padEnd(32, 'x');
  it('POST /v1/admin/reload re-reads the registry now (scope reload), and swaps the host under a running app', async () => {
    const sel = selector();
    publish([row({ status: 'disabled' })]);
    await sel.sync();
    const app = createCodeHostApp({
      runtime: sel,
      identity: {
        async linkOf() {
          return null;
        },
        async link() {
          return null;
        },
      } as never,
      auth: new ServiceAuth({ ops: CALLER, census: 'census-caller-'.padEnd(32, 'x') }),
      callers: { ops: ['reload', 'census'], census: ['census'] },
      reload: async ({ force }) => sel.sync({ force }),
    });
    const url = await listen(app);
    try {
      const get = (path: string, token = CALLER) =>
        fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
      expect((await get('/v1/repos')).status).toBe(503); // no enabled row: unknown, a non-2xx
      publish([row()]);
      const noScope = await fetch(`${url}/v1/admin/reload`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'census-caller-'.padEnd(32, 'x')}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(noScope.status).toBe(403);
      const r = await fetch(`${url}/v1/admin/reload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${CALLER}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ state: 'serving', integration_id: 'github-app' });
      expect((await get('/v1/repos')).status).toBe(200); // the same app, a different host: no restart
    } finally {
      await app.close();
    }
  });

  it('boots in registry mode with no GitHub variables, refuses to mix modes, and serves unknown until its row is there', async () => {
    const env = {
      CODEHOST_REGISTRY_INTEGRATION: 'github-app',
      CODEHOST_CALLERS: JSON.stringify({
        ops: { token_ref: 'env:T_OPS', scopes: ['reload', 'census'] },
      }),
      T_OPS: CALLER,
      CODEHOST_IDENTITY_URL: coreUrl,
      CODEHOST_IDENTITY_TOKEN_REF: 'env:T_ID',
      T_ID: 'identity-token-'.padEnd(32, 'x'),
      CODEHOST_CORE_URL: coreUrl,
      CODEHOST_CORE_TOKEN_REF: 'env:T_CORE',
      T_CORE: TOKEN,
      CODEHOST_SECRET_REFS: JSON.stringify([`file:${gh.keyFile}`]),
      CODEHOST_EGRESS_HOSTS: JSON.stringify([new URL(gh.server.baseUrl).hostname]),
      CODEHOST_PORT: '0',
    };
    await expect(bootCodeHost({ ...env, CODEHOST_GITHUB_APP_ID: '1' })).rejects.toThrow(
      /two sources/,
    );
    publish([]);
    state.health.length = 0;
    const svc = await bootCodeHost(env);
    try {
      expect((await fetch(`${svc.url}/healthz`)).status).toBe(200);
      const auth = { authorization: `Bearer ${CALLER}` };
      expect((await fetch(`${svc.url}/v1/repos`, { headers: auth })).status).toBe(503);
      expect(state.health.at(-1)).toMatchObject({
        reporter: 'codehost',
        reports: [
          { integration_id: 'github-app', state: 'down', detail_code: 'integration_missing' },
        ],
      });
      publish([row()]);
      const r = await fetch(`${svc.url}/v1/admin/reload`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(((await r.json()) as { state: string }).state).toBe('serving');
      expect((await fetch(`${svc.url}/v1/repos`, { headers: auth })).status).toBe(200);
    } finally {
      await svc.close();
    }
  });
});
