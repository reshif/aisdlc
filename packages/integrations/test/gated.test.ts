import {
  ConfigReader,
  ConfigRegistry,
  configProjection,
  configPublish,
  loadEffective,
  proposeRevision,
  registerGatewayConfig,
  type ConfigDeps,
} from '@aisdlc/config';
import {
  FACTORY_SCOPE,
  GATEWAY_CONFIG_KEYS,
  INTEGRATION_CONFIG_KEYS,
  INTEGRATION_FORBIDDEN,
} from '@aisdlc/contracts';
import { runProjection } from '@aisdlc/record';
import { makeCanary } from '@aisdlc/secrets-rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTiles,
  codeHostRow,
  integrationScope,
  listIntegrationEvents,
  modelProviderRow,
  readHealth,
  readRegistry,
  recordHealth,
} from '../src/index.js';
import { decideGate, pr, startM1Stack, type M1Stack } from './m1-stack.js';

// The registry is config: every change is a revision with an M1 gate, nothing is effective until a
// human decides it and `config_publish` runs, and the audit trail is the ledger entry of that decision.

let s: M1Stack;
beforeAll(async () => {
  s = await startM1Stack();
});
afterAll(() => s.stop());

const key = (id: string) => ({
  credential_id: id,
  secret_ref: `file:/run/secrets/${id}`,
  kind: 'api_key' as const,
});
const anthropic = (over = {}) =>
  modelProviderRow('anthropic', 'anthropic', { credentials: [key('anthropic-api-key')], ...over });
const github = (over = {}) =>
  codeHostRow(
    'github-app',
    'github_app',
    { app_id: '123456', installation_id: 1 },
    {
      credentials: [
        {
          credential_id: 'app-key',
          secret_ref: 'file:/run/secrets/github-app.pem',
          kind: 'app_key',
        },
      ],
      ...over,
    },
  );
const model = {
  model_id: 'claude-sonnet',
  provider_id: 'anthropic',
  provider_model: 'claude-sonnet-5-5',
  tools_capable: true,
  max_tokens_cap: 4096,
  usd_in_per_mtok: 3,
  usd_out_per_mtok: 15,
};

const propose = (doc: Record<string, unknown>) =>
  proposeRevision(s.deps as ConfigDeps, { layer: 'factory', proposed_by: pr('dev'), doc });
async function ok(doc: Record<string, unknown>) {
  const p = await propose(doc);
  if (!p.ok) throw new Error(`${p.error.code}: ${p.error.message}`);
  return p.value;
}
async function approve(p: { rev_hash: string; gate_instance_id: string }) {
  expect((await decideGate(s, p.gate_instance_id, 'root', 'approve')).ok).toBe(true);
  expect((await configPublish(s.deps, { rev_hash: p.rev_hash })).ok).toBe(true);
}
const effective = async () => {
  await runProjection(s.record.pool, configProjection);
  return (
    (await loadEffective(s.record.pool, { layer: 'factory', scope: FACTORY_SCOPE }))?.doc ?? {}
  );
};

describe('what the registry refuses at the door (before an approver sees it)', () => {
  const refused = async (doc: Record<string, unknown>, mention: RegExp) => {
    const p = await propose(doc);
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.error.message).toMatch(mention);
      expect(p.error.message).not.toContain('AISDLC_CANARY');
    }
  };
  it('a secret pasted anywhere in a row: the finding names the rule, never the value', async () => {
    const c = makeCanary('registry');
    await refused(
      { [INTEGRATION_CONFIG_KEYS.registry]: [anthropic({ display_name: `Anthropic ${c}` })] },
      /looks like a secret \(rule aisdlc-canary\)/,
    );
    await refused(
      {
        [INTEGRATION_CONFIG_KEYS.registry]: [
          github({
            config: { app_id: '1', installation_id: 1, api_url: `https://x:${c}@h.example` },
          }),
        ],
      },
      /secret|URL/,
    );
  });
  it('a credential that is not a reference, a scope without the forbidden list, a scope that is a forbidden verb', async () => {
    await refused(
      {
        [INTEGRATION_CONFIG_KEYS.registry]: [
          anthropic({
            credentials: [
              { credential_id: 'k', secret_ref: 'sk-ant-api03-abcdefghijklmnop', kind: 'api_key' },
            ],
          }),
        ],
      },
      /reference/,
    );
    await refused(
      {
        [INTEGRATION_CONFIG_KEYS.registry]: [
          anthropic({
            scopes: [{ scope: 'chat_complete', data_class_max: 'D2', forbidden: ['merge'] }],
          }),
        ],
      },
      /forbidden/,
    );
    await refused(
      {
        [INTEGRATION_CONFIG_KEYS.registry]: [
          github({
            scopes: [
              { scope: 'merge', data_class_max: 'D0', forbidden: [...INTEGRATION_FORBIDDEN] },
            ],
          }),
        ],
      },
      /scope|Invalid/i,
    );
  });
  it('dangling names: an install of an unknown or not-enabled integration, a model of no provider, a route to no model', async () => {
    const install = {
      install_id: 'i1',
      integration_id: 'nope',
      project_id: 'p1',
      enabled: true,
      overrides: {},
    };
    await refused(
      {
        [INTEGRATION_CONFIG_KEYS.registry]: [anthropic()],
        [INTEGRATION_CONFIG_KEYS.installs]: [install],
      },
      /unknown integration nope/,
    );
    await refused(
      {
        [INTEGRATION_CONFIG_KEYS.registry]: [anthropic({ status: 'draft' })],
        [INTEGRATION_CONFIG_KEYS.installs]: [{ ...install, integration_id: 'anthropic' }],
      },
      /enabled but anthropic is draft/,
    );
    await refused(
      { [INTEGRATION_CONFIG_KEYS.registry]: [], [GATEWAY_CONFIG_KEYS.models]: [model] },
      /not a model_provider integration/,
    );
    await refused(
      {
        [INTEGRATION_CONFIG_KEYS.registry]: [anthropic()],
        [GATEWAY_CONFIG_KEYS.models]: [model],
        [GATEWAY_CONFIG_KEYS.routes]: [
          { environment: 'local', data_class: 'D2', model_id: 'ghost' },
        ],
      },
      /unknown model ghost/,
    );
  });
  it('a project cannot set the registry: it is factory-only', async () => {
    const p = await proposeRevision(s.deps as ConfigDeps, {
      layer: 'project',
      scope: { kind: 'project', ref: 'p1' },
      proposed_by: pr('dev'),
      doc: { [INTEGRATION_CONFIG_KEYS.registry]: [] },
    });
    expect(p.ok).toBe(false);
  });
});

describe('enabling, widening and adding a route are gated revisions', () => {
  let r1: string;
  let g1: string;
  it('enabling opens an M1 gate and is not effective until it is decided and published', async () => {
    const p = await ok({ [INTEGRATION_CONFIG_KEYS.registry]: [anthropic(), github()] });
    r1 = p.rev_hash;
    g1 = p.gate_instance_id;
    expect(g1).toBeTruthy();
    expect(await effective()).toEqual({}); // proposed, gate open: nothing in force
    // publishing without a decision is refused
    expect((await configPublish(s.deps, { rev_hash: r1 })).ok).toBe(false);
    expect(await effective()).toEqual({});
    await approve(p);
    expect(((await effective())[INTEGRATION_CONFIG_KEYS.registry] as unknown[]).length).toBe(2);
  });

  it('widening a scope (D1 to D2) is another revision with its own gate', async () => {
    const narrow = {
      [INTEGRATION_CONFIG_KEYS.registry]: [
        anthropic({ scopes: [integrationScope('chat_complete', 'D1')] }),
        github(),
      ],
    };
    await approve(await ok(narrow));
    const wide = {
      [INTEGRATION_CONFIG_KEYS.registry]: [
        anthropic({ scopes: [integrationScope('chat_complete', 'D2')] }),
        github(),
      ],
    };
    const p = await ok(wide);
    expect(p.gate_instance_id).not.toBe(g1);
    // until decided, the narrow scope stays in force
    const inForce = (await effective())[INTEGRATION_CONFIG_KEYS.registry] as Array<{
      integration_id: string;
      scopes: Array<{ data_class_max: string }>;
    }>;
    expect(inForce.find((i) => i.integration_id === 'anthropic')?.scopes[0]?.data_class_max).toBe(
      'D1',
    );
    await approve(p);
  });

  it('adding a model route (to D2 or lower) is a gated revision; a D3 route cannot even be written', async () => {
    const withRoute = {
      [INTEGRATION_CONFIG_KEYS.registry]: [anthropic(), github()],
      [GATEWAY_CONFIG_KEYS.models]: [model],
      [GATEWAY_CONFIG_KEYS.routes]: [
        { environment: 'local', data_class: 'D2', model_id: 'claude-sonnet' },
      ],
    };
    const p = await ok(withRoute);
    expect(p.gate_instance_id).toBeTruthy();
    await approve(p);
    const bad = await propose({
      ...withRoute,
      [GATEWAY_CONFIG_KEYS.routes]: [
        { environment: 'local', data_class: 'D3', model_id: 'claude-sonnet' },
      ],
    });
    expect(bad.ok).toBe(false);
  });

  it('an install enables an integration for one project (and only narrows what the fleet row offers)', async () => {
    const doc = {
      [INTEGRATION_CONFIG_KEYS.registry]: [anthropic(), github()],
      [GATEWAY_CONFIG_KEYS.models]: [model],
      [GATEWAY_CONFIG_KEYS.routes]: [
        { environment: 'local', data_class: 'D2', model_id: 'claude-sonnet' },
      ],
      [INTEGRATION_CONFIG_KEYS.installs]: [
        {
          install_id: 'gh-p1',
          integration_id: 'github-app',
          project_id: 'p1',
          enabled: true,
          overrides: { repos_allowed: ['acme/app'] },
        },
      ],
    };
    await approve(await ok(doc));
    const inForce = (await effective())[INTEGRATION_CONFIG_KEYS.installs] as Array<{
      install_id: string;
    }>;
    expect(inForce.map((i) => i.install_id)).toEqual(['gh-p1']);
  });

  it('the audit trail: every change names the ledger entry of the M1 decision that made it effective', async () => {
    const events = await listIntegrationEvents(s.record.pool);
    const kinds = events.map((e) => `${e.integration_id}:${e.event}`);
    expect(kinds).toContain('anthropic:created');
    expect(kinds).toContain('anthropic:enabled');
    expect(kinds).toContain('github-app:created');
    expect(kinds).toContain('anthropic:scope_widened');
    expect(kinds).toContain('anthropic:route_added');
    expect(kinds).toContain('github-app:install_added');
    const entries = await s.record.pool.query(
      `SELECT entry_id FROM ledger.ledger_entry WHERE gate_id = 'M1' AND decision = 'approve'`,
    );
    const ledgered = new Set(entries.rows.map((r) => r.entry_id as string));
    for (const e of events)
      expect(ledgered.has(e.ledger_entry_id), `${e.event} of ${e.integration_id}`).toBe(true);
    expect(await listIntegrationEvents(s.record.pool, { integration_id: 'github-app' })).toSatisfy(
      (l: Array<{ integration_id: string }>) => l.every((e) => e.integration_id === 'github-app'),
    );
  });

  it('a registry that was refused or rejected never becomes effective, and a reader sees only published revisions', async () => {
    const p = await ok({
      [INTEGRATION_CONFIG_KEYS.registry]: [anthropic({ status: 'disabled' }), github()],
    });
    expect((await decideGate(s, p.gate_instance_id, 'root', 'reject')).ok).toBe(true);
    expect((await configPublish(s.deps, { rev_hash: p.rev_hash })).ok).toBe(false);
    const reader = await ConfigReader.create({
      pool: s.record.pool,
      registry: registerGatewayConfig(new ConfigRegistry()),
    });
    const view = readRegistry(reader.current());
    expect(view.integrations.find((i) => i.integration_id === 'anthropic')?.status).toBe('enabled');
    expect(view.revision).toBeTruthy();
  });
});

describe('health tiles read from the registry', () => {
  it('one tile per integration with the shared shape; no report is unknown; a stale report is unknown and says so', async () => {
    const reader = await ConfigReader.create({
      pool: s.record.pool,
      registry: registerGatewayConfig(new ConfigRegistry()),
    });
    const view = readRegistry(reader.current());
    const T = new Date('2026-11-09T10:00:00.000Z');
    await recordHealth(
      s.record.pool,
      {
        reporter: 'gateway',
        reports: [{ integration_id: 'anthropic', state: 'ok', detail_code: 'ok' }],
      },
      T,
    );
    await recordHealth(
      s.record.pool,
      {
        reporter: 'codehost',
        reports: [{ integration_id: 'github-app', state: 'ok', detail_code: 'ok' }],
      },
      new Date(T.getTime() - 300_000),
    );
    const health = await readHealth(s.record.pool);
    const tiles = buildTiles(view, health, new Date(T.getTime() + 60_000));
    const by = Object.fromEntries(tiles.tiles.map((t) => [t.integration_id, t]));
    expect(Object.keys(by).sort()).toEqual(['anthropic', 'github-app']);
    expect(by['anthropic']).toMatchObject({
      kind: 'model_provider',
      state: 'ok',
      stale: false,
      detail_code: 'ok',
    });
    expect(by['github-app']).toMatchObject({
      kind: 'code_host',
      state: 'unknown',
      stale: true,
      detail_code: 'stale',
    });
    expect(by['github-app']?.reporters[0]).toMatchObject({
      reported_state: 'ok',
      state: 'unknown',
    });
    expect(tiles.registry_revision).toBe(view.revision);
    // two minutes after the gateway's report it reads unknown too
    const later = buildTiles(view, health, new Date(T.getTime() + 125_000));
    expect(later.tiles.find((t) => t.integration_id === 'anthropic')).toMatchObject({
      state: 'unknown',
      stale: true,
    });
    // nobody reported on a third integration: unknown, "no_report"
    const none = buildTiles(
      { ...view, integrations: [...view.integrations, modelProviderRow('codex', 'fake')] },
      health,
      T,
    );
    expect(none.tiles.find((t) => t.integration_id === 'codex')).toMatchObject({
      state: 'unknown',
      detail_code: 'no_report',
      as_of: null,
    });
  });
});
