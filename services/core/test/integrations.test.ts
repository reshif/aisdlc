import { configPublish, proposeRevision } from '@aisdlc/config';
import {
  IntegrationEvent,
  IntegrationHealthTiles,
  IntegrationRegistryView,
  INTEGRATION_CONFIG_KEYS,
  GATEWAY_CONFIG_KEYS,
} from '@aisdlc/contracts';
import { codeHostRow, modelProviderRow } from '@aisdlc/integrations';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, type CoreScope } from '../src/index.js';
import { decideGate, pr, setAdmins, startCoreStack, type CoreStack } from '../src/testing.js';

// Health tiles read from the registry (PLAN M10.4): core serves the effective integration registry to
// the codehost, takes the codehost's health reports, and builds the tiles (one shape for a code host and
// a model provider, a stale report reads `unknown`) and the events (each with its ledger entry).

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const T = {
  codehost: 'codehost-at-core-'.padEnd(32, 'x'),
  portal: 'portal-at-core-'.padEnd(32, 'x'),
  nobody: 'nobody-at-core-'.padEnd(32, 'x'),
};

beforeAll(async () => {
  s = await startCoreStack();
  setAdmins(s, 'factory', ['root', 'rita']);
  const callers: Record<string, readonly CoreScope[]> = {
    codehost: ['registry', 'integrations'],
    portal: ['portal'],
    nobody: ['read'],
  };
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(T),
    callers,
    registry: s.registry,
    clock: s.clock,
    config: s.config,
  });
  url = await listen(app);
});
afterAll(async () => {
  await app.close();
  await s.stop();
});

const call = async (method: 'GET' | 'POST', path: string, token: string, body?: unknown) => {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
};
const publish = async (doc: Record<string, unknown>) => {
  const p = await proposeRevision(s.config, { layer: 'factory', proposed_by: pr('root'), doc });
  if (!p.ok) throw new Error(p.error.message);
  expect((await decideGate(s, p.value.gate_instance_id, 'rita', 'approve')).ok).toBe(true);
  expect((await configPublish(s.config, { rev_hash: p.value.rev_hash })).ok).toBe(true);
};
const gh = codeHostRow(
  'github-app',
  'github_app',
  { app_id: '123456', installation_id: 1 },
  {
    credentials: [
      { credential_id: 'app-key', secret_ref: 'file:/run/secrets/github-app.pem', kind: 'app_key' },
    ],
  },
);
const claude = modelProviderRow('anthropic', 'anthropic', {
  credentials: [
    { credential_id: 'k', secret_ref: 'file:/run/secrets/anthropic-api-key', kind: 'api_key' },
  ],
});
const fake = modelProviderRow('fake', 'fake');

describe('the integration API', () => {
  it('serves an empty registry before anything is published, and no tile', async () => {
    const r = await call('GET', '/v1/integrations', T.codehost);
    expect(IntegrationRegistryView.parse(r.json)).toEqual({
      revision: null,
      integrations: [],
      installs: [],
    });
    expect((await call('GET', '/v1/integrations/health', T.portal)).json.tiles).toEqual([]);
  });

  it('serves the effective registry by kind, the first rows being the GitHub App and the model providers', async () => {
    await publish({ [INTEGRATION_CONFIG_KEYS.registry]: [gh, claude, fake] });
    const all = IntegrationRegistryView.parse(
      (await call('GET', '/v1/integrations', T.codehost)).json,
    );
    expect(all.integrations.map((i) => i.integration_id)).toEqual([
      'github-app',
      'anthropic',
      'fake',
    ]);
    const hosts = IntegrationRegistryView.parse(
      (await call('GET', '/v1/integrations?kind=code_host', T.codehost)).json,
    );
    expect(hosts.integrations.map((i) => i.integration_id)).toEqual(['github-app']);
    expect(hosts.revision).toBe(all.revision);
    // references only: the view has a path to the key, never the key
    expect(JSON.stringify(all)).toContain('file:/run/secrets/github-app.pem');
    expect((await call('GET', '/v1/integrations?kind=moon', T.codehost)).status).toBe(400);
    expect((await call('GET', '/v1/integrations', T.nobody)).status).toBe(403);
    expect((await call('GET', '/v1/integrations', 'x'.repeat(40))).status).toBe(401);
  });

  it('takes the codehost health report; the tiles read from the registry, fresh ok, then stale unknown after two minutes', async () => {
    const rep = await call('POST', '/v1/integrations/health', T.codehost, {
      reporter: 'codehost',
      reports: [
        { integration_id: 'github-app', state: 'ok', detail_code: 'ok' },
        { integration_id: 'invented', state: 'ok', detail_code: 'ok' },
      ],
    });
    expect(rep.json).toEqual({ recorded: 1, ignored: 1 }); // a name nobody registered makes no tile
    // the gateway reports straight to the table (its role has the right), core reads it
    await s.record.pool.query(
      `INSERT INTO integrations.integration_health (integration_id, reporter, state, detail_code, as_of) VALUES ('anthropic', 'gateway', 'degraded', 'rate_limited', $1)`,
      [s.clock.now().toISOString()],
    );
    const tiles = IntegrationHealthTiles.parse(
      (await call('GET', '/v1/integrations/health', T.portal)).json,
    );
    const by = Object.fromEntries(tiles.tiles.map((t) => [t.integration_id, t]));
    expect(by['github-app']).toMatchObject({ kind: 'code_host', state: 'ok', stale: false });
    expect(by['anthropic']).toMatchObject({
      kind: 'model_provider',
      state: 'degraded',
      detail_code: 'rate_limited',
    });
    expect(by['fake']).toMatchObject({ state: 'unknown', detail_code: 'no_report' });
    s.clock.advance(121_000);
    const later = IntegrationHealthTiles.parse(
      (await call('GET', '/v1/integrations/health', T.portal)).json,
    );
    for (const t of later.tiles) expect(t.state, t.integration_id).toBe('unknown');
    expect(later.tiles.find((t) => t.integration_id === 'github-app')).toMatchObject({
      stale: true,
      detail_code: 'stale',
    });
  });

  it("refuses a health report that is not the codehost's, from a caller without the scope, or malformed", async () => {
    const good = { reporter: 'codehost', reports: [] };
    expect((await call('POST', '/v1/integrations/health', T.portal, good)).status).toBe(403);
    expect(
      (
        await call('POST', '/v1/integrations/health', T.codehost, {
          reporter: 'gateway',
          reports: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/v1/integrations/health', T.codehost, {
          reporter: 'codehost',
          reports: [{ integration_id: 'x', state: 'great' }],
        })
      ).status,
    ).toBe(400);
    expect((await call('GET', '/v1/integrations/health', T.codehost)).status).toBe(403);
  });

  it('lists the events with the ledger entry of the decision behind each', async () => {
    await publish({
      [INTEGRATION_CONFIG_KEYS.registry]: [gh, claude, fake],
      [GATEWAY_CONFIG_KEYS.models]: [
        {
          model_id: 'fake-model',
          provider_id: 'fake',
          provider_model: 'fake-1',
          tools_capable: true,
          max_tokens_cap: 100,
          usd_in_per_mtok: 1,
          usd_out_per_mtok: 1,
        },
      ],
      [GATEWAY_CONFIG_KEYS.routes]: [
        { environment: 'local', data_class: 'D2', model_id: 'fake-model' },
      ],
    });
    const r = await call('GET', '/v1/integrations/events', T.portal);
    const events = (r.json as unknown[]).map((e) => IntegrationEvent.parse(e));
    expect(events.map((e) => `${e.integration_id}:${e.event}`)).toEqual(
      expect.arrayContaining([
        'github-app:created',
        'github-app:enabled',
        'anthropic:enabled',
        'fake:route_added',
      ]),
    );
    const ledgered = new Set(
      (
        await s.record.pool.query(`SELECT entry_id FROM ledger.ledger_entry WHERE gate_id = 'M1'`)
      ).rows.map((x) => x.entry_id as string),
    );
    for (const e of events) expect(ledgered.has(e.ledger_entry_id)).toBe(true);
    const mine = (await call('GET', '/v1/integrations/events?integration_id=github-app', T.portal))
      .json as Array<{ integration_id: string }>;
    expect(mine.every((e) => e.integration_id === 'github-app')).toBe(true);
  });
});
