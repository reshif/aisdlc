import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigRegistry,
  configPublish,
  proposeRevision,
  registerGatewayConfig,
} from '@aisdlc/config';
import { GATEWAY_CONFIG_KEYS, ProjectId } from '@aisdlc/contracts';
import { dbUrlRef } from '@aisdlc/db/testing';
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
  GATEWAY_PROVIDER_ADAPTERS: JSON.stringify({
    anthropic: {
      kind: 'anthropic',
      key_ref: `file:${join(dir, 'anthropic-api-key')}`,
      base_url: vendor.url,
    },
  }),
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
      [GATEWAY_CONFIG_KEYS.providers]: [
        { provider_id: 'anthropic', kind: 'anthropic', enabled: true },
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
    expect(
      await bad({
        GATEWAY_PROVIDER_ADAPTERS: JSON.stringify({
          x: { kind: 'anthropic', key_ref: 'file:/nonexistent/key' },
        }),
      }),
    ).toBeInstanceOf(ServiceConfigError);
    expect(
      await bad({
        GATEWAY_PROVIDER_ADAPTERS: JSON.stringify({
          x: { kind: 'anthropic', key_ref: 'literal-key-value-in-env' },
        }),
      }),
    ).toBeInstanceOf(ServiceConfigError);
    // the fake provider is for local and staging; production does not take it
    const noFake = await bad({
      GATEWAY_ENVIRONMENT: 'prod',
      GATEWAY_PROVIDER_ADAPTERS: JSON.stringify({ fake: { kind: 'fake' } }),
    });
    expect(noFake).toBeInstanceOf(ServiceConfigError);
    expect(String((noFake as Error).message)).toContain('prod');
    // a database URL with a password in it is refused (secrets are references)
    expect(await bad({ GATEWAY_DATABASE_URL: 'postgres://u:pw@h/db' })).toBeInstanceOf(
      ServiceConfigError,
    );
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('knows the registry it reads: only the gateway keys', () => {
    expect(registerGatewayConfig(new ConfigRegistry()).keys()).toEqual(
      Object.values(GATEWAY_CONFIG_KEYS).sort(),
    );
  });
});
