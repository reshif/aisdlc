import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigRegistry,
  configProjection,
  configPublish,
  proposeRevision,
  registerGatewayConfig,
} from '@aisdlc/config';
import { GATEWAY_CONFIG_KEYS, INTEGRATION_CONFIG_KEYS, ProjectId } from '@aisdlc/contracts';
import { modelProviderRow } from '@aisdlc/integrations';
import { dbUrlRef } from '@aisdlc/db/testing';
import { modelProviderError } from '@aisdlc/ports';
import { runProjection } from '@aisdlc/record';
import { ServiceConfigError, listen, newApp, type RunningService } from '@aisdlc/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootGateway } from '../src/boot.js';
import { startFakeMessagesServer, type FakeMessagesServer } from '../src/fake-messages-server.js';
import { FAKE_MODEL, hello } from '../src/testing.js';
import { decideGate, pr, startM1Stack, type M1Stack } from './m1-stack.js';

// The whole thing as a process boots it: environment variables, a key FILE, the record database,
// a vendor (the fake Messages API), a kill switch (a stub that says "not killed") and the routing
// table published through a real M1 gate. No call leaves the machine.

const KEY = ['sk', 'ant', 'api03', 'Qm4xT7pL'.repeat(6)].join('-');
const TOKEN_CORE = 'c'.repeat(40);
const TOKEN_KILL = 'k'.repeat(40);

let s: M1Stack;
let vendor: FakeMessagesServer;
let killUrl: string;
let killApp: ReturnType<typeof newApp>;
let dir: string;
let svc: RunningService;
const lines: string[] = [];
const orig = { log: console.log, error: console.error, warn: console.warn };

const env = (over: Record<string, string> = {}) => ({
  ...dbUrlRef('GATEWAY_DATABASE_URL', s.record.url),
  GATEWAY_ENVIRONMENT: 'local',
  GATEWAY_CALLERS: JSON.stringify({ core: { token_ref: 'env:T_CORE', scopes: ['admin', 'read'] } }),
  T_CORE: TOKEN_CORE,
  // what this deployment lets a registry row do: read its key file, send the key to the vendor's host
  GATEWAY_SECRET_REFS: JSON.stringify([`file:${join(dir, 'anthropic-api-key')}`]),
  GATEWAY_EGRESS_HOSTS: JSON.stringify([new URL(vendor.url).hostname]),
  GATEWAY_KILLSWITCH_URL: killUrl,
  GATEWAY_KILLSWITCH_TOKEN_REF: 'env:T_KILL',
  T_KILL: TOKEN_KILL,
  GATEWAY_PORT: '0',
  ...over,
});

beforeAll(async () => {
  s = await startM1Stack();
  vendor = await startFakeMessagesServer({ apiKey: KEY });
  dir = mkdtempSync(join(tmpdir(), 'gw-boot-'));
  writeFileSync(join(dir, 'anthropic-api-key'), `${KEY}\n`, { mode: 0o600 });
  killApp = newApp();
  killApp.get('/v1/status', async () => ({
    killed: false,
    kills: [],
    as_of: new Date().toISOString(),
  }));
  killUrl = await listen(killApp);
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  console.error = console.log;
  console.warn = console.log;
  // publish the routing table through its M1 gate
  const p = await proposeRevision(s.deps, {
    layer: 'factory',
    proposed_by: pr('dev'),
    doc: {
      [INTEGRATION_CONFIG_KEYS.registry]: [
        modelProviderRow('anthropic', 'anthropic', {
          config: { base_url: vendor.url },
          credentials: [
            {
              credential_id: 'key',
              secret_ref: `file:${join(dir, 'anthropic-api-key')}`,
              kind: 'api_key',
            },
          ],
        }),
      ],
      [GATEWAY_CONFIG_KEYS.models]: [
        {
          ...FAKE_MODEL,
          model_id: 'claude-sonnet',
          provider_id: 'anthropic',
          provider_model: 'claude-sonnet-5-5',
        },
      ],
      [GATEWAY_CONFIG_KEYS.routes]: [
        { environment: 'local', data_class: 'D2', model_id: 'claude-sonnet' },
      ],
    },
  });
  if (!p.ok) throw new Error(p.error.message);
  const d = await decideGate(s, p.value.gate_instance_id, 'root', 'approve');
  if (!d.ok) throw new Error(JSON.stringify(d.error));
  const r = await configPublish(s.deps, { rev_hash: p.value.rev_hash });
  if (!r.ok) throw new Error(r.error.message);
  // the gateway reads the config read model, it does not fold it (its role may not write it)
  await runProjection(s.record.pool, configProjection);
  svc = await bootGateway(env());
});
afterAll(async () => {
  Object.assign(console, orig);
  await svc.close();
  await killApp.close();
  await vendor.stop();
  rmSync(dir, { recursive: true, force: true });
  await s.stop();
});

describe('bootGateway', () => {
  it('serves a call end to end: key file, published route, kill switch, vendor, metering', async () => {
    const h = { authorization: `Bearer ${TOKEN_CORE}`, 'content-type': 'application/json' };
    const g = await fetch(`${svc.url}/v1/admin/budget-groups`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        group_id: 'boot-g',
        max_tokens: 10_000,
        max_cost_micro_usd: 1_000_000,
      }),
    });
    expect(g.status).toBe(201);
    const m = await fetch(`${svc.url}/v1/admin/vkeys`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        scope: { kind: 'unit', ref: 'u-boot' },
        project_id: ProjectId.parse('testbed'),
        data_class_max: 'D2',
        models: ['claude-sonnet'],
        tools: [],
        budget_group: 'boot-g',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    const { key } = (await m.json()) as { key: string };
    vendor.reply({ text: 'booted', usage: { input_tokens: 12, output_tokens: 3 } });
    const r = await fetch(`${svc.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(hello()),
    });
    const body = (await r.json()) as { content: Array<{ text: string }>; usage: unknown };
    expect(r.status).toBe(200);
    expect(body.content[0]?.text).toBe('booted');
    expect(body.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    // the key file's value went to the vendor, and to nobody else
    const sent = vendor.seen.at(-1)!.headers;
    expect(String(sent['x-api-key'] ?? sent['authorization'])).toContain(KEY);
    expect(vendor.seen.at(-1)!.body['model']).toBe('claude-sonnet-5-5');
    const rows = await s.record.pool.query(
      `SELECT body::text AS b FROM record.record_event WHERE type LIKE 'gateway.%'`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    const haystack = [JSON.stringify(body), ...lines, ...rows.rows.map((x) => x.b as string)].join(
      '\n',
    );
    expect(haystack).not.toContain(KEY);
    expect(haystack).not.toContain(KEY.split('-').at(-1)!);
  });

  it('refuses to start on a bad configuration, without printing a key', async () => {
    const bad = async (over: Record<string, string>) => {
      try {
        await bootGateway(env(over));
      } catch (e) {
        return e;
      }
      throw new Error('it started');
    };
    expect(await bad({ GATEWAY_ENVIRONMENT: 'moon' })).toBeInstanceOf(ServiceConfigError);
    expect(await bad({ GATEWAY_MAX_PROVIDER_CALLS: '-1' })).toBeInstanceOf(ServiceConfigError);
    expect(await bad({ GATEWAY_SECRET_REFS: 'not json' })).toBeInstanceOf(ServiceConfigError);
    expect(await bad({ GATEWAY_EGRESS_HOSTS: '["UPPER CASE"]' })).toBeInstanceOf(
      ServiceConfigError,
    );
    // a database URL with a password in it is refused (secrets are references)
    expect(await bad({ GATEWAY_DATABASE_URL: 'postgres://u:pw@h/db' })).toBeInstanceOf(
      ServiceConfigError,
    );
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('knows the registry it reads: the gateway keys and the integration registry', () => {
    expect(registerGatewayConfig(new ConfigRegistry()).keys()).toEqual(
      [...Object.values(GATEWAY_CONFIG_KEYS), ...Object.values(INTEGRATION_CONFIG_KEYS)].sort(),
    );
  });

  describe('the integration registry, followed by revision', () => {
    const row = (
      over: Parameters<typeof modelProviderRow>[2] = {},
      ref = `file:${join(dir, 'anthropic-api-key')}`,
    ) =>
      modelProviderRow('anthropic', 'anthropic', {
        config: { base_url: vendor.url },
        credentials: [{ credential_id: 'key', secret_ref: ref, kind: 'api_key' }],
        ...over,
      });
    const model = {
      ...FAKE_MODEL,
      model_id: 'claude-sonnet',
      provider_id: 'anthropic',
      provider_model: 'claude-sonnet-5-5',
    };
    const publishRegistry = async (rows: unknown[]) => {
      const p = await proposeRevision(s.deps, {
        layer: 'factory',
        proposed_by: pr('dev'),
        doc: {
          [INTEGRATION_CONFIG_KEYS.registry]: rows,
          [GATEWAY_CONFIG_KEYS.models]: [model],
          [GATEWAY_CONFIG_KEYS.routes]: [
            { environment: 'local', data_class: 'D2', model_id: 'claude-sonnet' },
          ],
        },
      });
      if (!p.ok) throw new Error(`${p.error.code}: ${p.error.message}`);
      expect((await decideGate(s, p.value.gate_instance_id, 'root', 'approve')).ok).toBe(true);
      expect((await configPublish(s.deps, { rev_hash: p.value.rev_hash })).ok).toBe(true);
      await runProjection(s.record.pool, configProjection);
      return p.value.rev_hash;
    };
    const admin = (path: string, body?: unknown) =>
      fetch(`${svc.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${TOKEN_CORE}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as any })); // eslint-disable-line @typescript-eslint/no-explicit-any
    const call = async (key: string) =>
      (
        await fetch(`${svc.url}/v1/messages`, {
          method: 'POST',
          headers: { 'x-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify(hello()),
        })
      ).status;
    const mintKey = async (group: string) => {
      await admin('/v1/admin/budget-groups', {
        group_id: group,
        max_tokens: 100_000,
        max_cost_micro_usd: 10_000_000,
      });
      const m = await admin('/v1/admin/vkeys', {
        scope: { kind: 'unit', ref: `u-${group}` },
        project_id: 'testbed',
        data_class_max: 'D2',
        models: ['claude-sonnet'],
        tools: [],
        budget_group: group,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      return m.json.key as string;
    };
    const health = async () =>
      (
        await s.record.pool.query(
          `SELECT state, detail_code FROM integrations.integration_health WHERE integration_id = 'anthropic' AND reporter = 'gateway'`,
        )
      ).rows[0] as { state: string; detail_code: string } | undefined;

    it('a published change applies without a restart: disable, and the next call is refused; enable, and it serves', async () => {
      const key = await mintKey('reg-1');
      vendor.reply({ text: 'before' });
      expect(await call(key)).toBe(200);
      await publishRegistry([row({ status: 'disabled' })]);
      const r = await admin('/v1/admin/reload', {});
      expect(r.status).toBe(200);
      expect(r.json.integrations).toEqual([]);
      expect(await call(key)).toBe(503); // route_broken: no enabled provider behind the route
      await publishRegistry([row()]);
      const again = await admin('/v1/admin/reload', {});
      expect(again.json.integrations).toEqual([
        { integration_id: 'anthropic', adapter: 'anthropic', state: 'built', detail: 'ok' },
      ]);
      expect(again.json.revision).toBeTruthy();
      vendor.reply({ text: 'after' });
      expect(await call(key)).toBe(200);
    });

    it('refuses a row that names a key file or a host this deployment did not give it, by code, and says so in its health', async () => {
      const key = await mintKey('reg-2');
      await publishRegistry([row({}, 'file:/run/secrets/some-other-secret')]);
      const r = await admin('/v1/admin/reload', {});
      expect(r.json.integrations).toEqual([
        {
          integration_id: 'anthropic',
          adapter: 'anthropic',
          state: 'refused',
          detail: 'secret_ref_not_allowed',
        },
      ]);
      expect(await call(key)).toBe(503);
      expect(await health()).toEqual({ state: 'down', detail_code: 'secret_ref_not_allowed' });
      await publishRegistry([row({ config: { base_url: 'https://attacker.example' } })]);
      expect((await admin('/v1/admin/reload', {})).json.integrations[0]).toMatchObject({
        state: 'refused',
        detail: 'egress_not_allowed',
      });
      expect(lines.join('\n')).not.toContain(KEY);
    });

    it('reports health from what the calls showed: ok after a good one, down after the vendor refuses the key', async () => {
      const key = await mintKey('reg-3');
      await publishRegistry([row()]);
      await admin('/v1/admin/reload', { force: true });
      vendor.reply({ text: 'fine' });
      expect(await call(key)).toBe(200);
      await admin('/v1/admin/reload', {}); // a reload reports straight away
      expect(await health()).toEqual({ state: 'ok', detail_code: 'ok' });
      vendor.reply({ error: modelProviderError('auth', 'bad key', 401) });
      expect(await call(key)).toBe(502);
      await admin('/v1/admin/reload', {});
      expect(await health()).toEqual({ state: 'down', detail_code: 'auth_failed' });
    });

    it('a read caller sees what the adapters are; reload is an admin act', async () => {
      const r = await admin('/v1/admin/integrations');
      expect(r.status).toBe(200);
      const noAuth = await fetch(`${svc.url}/v1/admin/reload`, { method: 'POST' });
      expect(noAuth.status).toBe(401);
    });
  });
});
