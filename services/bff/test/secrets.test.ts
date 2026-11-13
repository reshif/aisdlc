import { SECRET_NAMES } from '@aisdlc/contracts';
import { grantFleetRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { startFakeCore, type FakeCore } from './portal-fixtures.js';

// The portal's write-only secret fields (portal v2 N15): the PDP decides for the signed-in person (config.propose on
// the fleet), the value goes to core exactly once with the session's principal, the browser gets metadata back, and
// the value is in no response, no log line and no row of the bff's database. Core's side (the store, the record, the
// ledger, its own grep) is services/core/test/secrets.test.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Who = 'alice' | 'root';

const VALUE = 'sk-ant-api03-BFF-SECRET-TEST-VALUE-0a1b2c3d4e5f';
let s: BffStack;
let core: FakeCore;
const sessions = new Map<Who, { browser: Browser; csrf: string }>();
const lines: string[] = [];
const bodies: string[] = [];
const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };

async function as(who: Who) {
  const known = sessions.get(who);
  if (known) return known;
  const { browser } = await signIn(s, who);
  const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
  const v = { browser, csrf: me.csrf_token as string };
  sessions.set(who, v);
  return v;
}

async function api(
  who: Who,
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  csrf = true,
) {
  const v = await as(who);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = v.csrf;
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, text, json: text ? (JSON.parse(text) as Json) : null };
}

const LIST = {
  store_reachable: true,
  secrets: SECRET_NAMES.map((name) => ({
    name,
    owner: name === 'anthropic-api-key' ? 'gateway' : 'codehost',
    label: name,
    format: 'token',
    ref: `vault:x/${name}#value`,
    set: false,
    version: null,
    updated_at: null,
    updated_by: null,
  })),
};

beforeAll(async () => {
  for (const k of ['log', 'error', 'warn', 'info'] as const) {
    console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  }
  core = await startFakeCore();
  s = await startBffStack({ override: { core: core.client } });
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
  await grantFleetRole(s.identity.deps, 'alice', 'factory.auditor');
});
afterAll(async () => {
  Object.assign(console, orig);
  await s?.stop();
  await core?.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
  core.override.set('GET /v1/secrets?on_behalf_of=root', { status: 200, json: LIST });
  core.override.set('PUT /v1/secrets/anthropic-api-key', {
    status: 200,
    json: { name: 'anthropic-api-key', version: 3, updated_at: '2026-11-13T10:00:00.000Z' },
  });
  core.override.set('DELETE /v1/secrets/anthropic-api-key', {
    status: 200,
    json: { name: 'anthropic-api-key', version: null, updated_at: '2026-11-13T10:01:00.000Z' },
  });
});

describe('/api/secrets', () => {
  it('a factory admin puts a value: core gets it once with the session principal; the browser gets metadata', async () => {
    const r = await api('root', 'PUT', '/api/secrets/anthropic-api-key', { value: VALUE });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      name: 'anthropic-api-key',
      version: 3,
      updated_at: '2026-11-13T10:00:00.000Z',
    });
    expect(core.seen).toHaveLength(1);
    expect(core.seen[0]).toMatchObject({
      method: 'PUT',
      path: '/v1/secrets/anthropic-api-key',
      body: { value: VALUE, on_behalf_of: 'root' },
    });
  });

  it('the person is the session, never the body; extra fields and unknown names are refused', async () => {
    const forged = await api('root', 'PUT', '/api/secrets/anthropic-api-key', {
      value: VALUE,
      on_behalf_of: 'alice',
    });
    expect(forged.status).toBe(400);
    expect(forged.text).not.toContain(VALUE);
    expect((await api('root', 'PUT', '/api/secrets/root-password', { value: VALUE })).status).toBe(
      404,
    );
    expect((await api('root', 'PUT', '/api/secrets/anthropic-api-key', { value: '' })).status).toBe(
      400,
    );
    expect(core.seen).toEqual([]);
  });

  it('without the CSRF token, or for a person the PDP refuses, nothing reaches core', async () => {
    expect(
      (await api('root', 'PUT', '/api/secrets/anthropic-api-key', { value: VALUE }, false)).status,
    ).toBe(403);
    expect(
      (await api('alice', 'PUT', '/api/secrets/anthropic-api-key', { value: VALUE })).status,
    ).toBe(403);
    expect((await api('alice', 'GET', '/api/secrets')).status).toBe(403);
    expect((await api('alice', 'DELETE', '/api/secrets/anthropic-api-key')).status).toBe(403);
    expect(core.seen).toEqual([]);
  });

  it('lists names and metadata; deletes', async () => {
    const l = await api('root', 'GET', '/api/secrets');
    expect(l.status).toBe(200);
    expect(l.json.secrets.map((x: Json) => x.name)).toEqual([...SECRET_NAMES]);
    const d = await api('root', 'DELETE', '/api/secrets/anthropic-api-key');
    expect(d.status).toBe(200);
    expect(core.seen.at(-1)?.body).toEqual({ on_behalf_of: 'root' });
  });

  it("core's refusal keeps its status and code; core down is 502; neither echoes the value", async () => {
    core.override.set('PUT /v1/secrets/anthropic-api-key', {
      status: 400,
      json: {
        error: {
          code: 'invalid_input',
          message: 'anthropic-api-key: a token holds no white space',
        },
      },
    });
    const r = await api('root', 'PUT', '/api/secrets/anthropic-api-key', { value: VALUE });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_input');
    core.override.set('PUT /v1/secrets/anthropic-api-key', { status: 500, json: { error: {} } });
    const down = await api('root', 'PUT', '/api/secrets/anthropic-api-key', { value: VALUE });
    expect(down.status).toBe(502);
  });

  it('GREP: the value is in no response, no log line and no row of the database', async () => {
    const tables = await s.identity.record.pool.query<{ t: string }>(
      `SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
    );
    let db = '';
    for (const { t } of tables.rows)
      db += JSON.stringify((await s.identity.record.pool.query(`SELECT * FROM ${t}`)).rows);
    for (const hay of [bodies.join('\n'), lines.join('\n'), db]) {
      expect(hay).not.toContain(VALUE);
      expect(hay).not.toContain('BFF-SECRET-TEST');
    }
  });
});
