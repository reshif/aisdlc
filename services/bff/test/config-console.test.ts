import { DEFAULT_SANDBOX_CAPS, SANDBOX_CAPS_KEY } from '@aisdlc/contracts';
import { grantFleetRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { startFakeCore, type FakeCore } from './portal-fixtures.js';

// The bff's configuration console routes: the PDP decides for the signed-in person (read: audit.read
// or config.propose on the fleet; propose: config.propose), the principal sent to core is the
// session's and never the body's, and core's answers pass in the contract shapes. Core's own side
// (the lineage, the M1 gate, nothing effective until decided) is services/core/test/config-console.test.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Who = 'alice' | 'bob' | 'root';

let s: BffStack;
let core: FakeCore;
const sessions = new Map<Who, { browser: Browser; csrf: string }>();

async function as(who: Who) {
  const known = sessions.get(who);
  if (known) return known;
  const { browser } = await signIn(s, who);
  const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
  const v = { browser, csrf: me.csrf_token as string };
  sessions.set(who, v);
  return v;
}

async function api(who: Who, method: 'GET' | 'POST', path: string, body?: unknown) {
  const v = await as(who);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST') headers['x-csrf-token'] = v.csrf;
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

const SUMMARY = {
  key: SANDBOX_CAPS_KEY,
  kind: 'setting',
  description: 'the two sandbox caps',
  overridable: false,
  json_schema: { type: 'object' },
};
const VIEW = {
  key: SUMMARY,
  default: DEFAULT_SANDBOX_CAPS,
  effective: {
    value: DEFAULT_SANDBOX_CAPS,
    source: 'default',
    rev_hash: null,
    gate_instance_id: null,
    ledger_entry_id: null,
    published_at: null,
  },
  head_rev_hash: null,
  pending: [],
  history: [
    {
      rev_hash: 'b'.repeat(64),
      parent_rev_hash: null,
      state: 'proposed',
      gate_instance_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77',
      ledger_entry_id: null,
      proposed_by: 'alice',
      proposed_at: '2026-11-09T10:00:00.000Z',
      published_at: null,
      value: { total: 6, coding: 2 },
      set: true,
      changes_key: true,
    },
  ],
};

beforeAll(async () => {
  core = await startFakeCore();
  s = await startBffStack({ override: { core: core.client } });
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
  await grantFleetRole(s.identity.deps, 'alice', 'factory.auditor');
});
afterAll(async () => {
  await s?.stop();
  await core?.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
  core.override.set('GET /v1/config/keys', { status: 200, json: [SUMMARY] });
  core.override.set(`GET /v1/config/keys/${SANDBOX_CAPS_KEY}`, { status: 200, json: VIEW });
  core.override.set(`POST /v1/config/keys/${SANDBOX_CAPS_KEY}/proposals`, {
    status: 201,
    json: {
      rev_hash: 'c'.repeat(64),
      parent_rev_hash: null,
      gate_instance_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe78',
      superseded: [],
    },
  });
});

describe('/api/config', () => {
  it('reads need audit.read or config.propose on the fleet; core is not asked otherwise', async () => {
    expect((await api('bob', 'GET', '/api/config/keys')).status).toBe(403);
    expect((await api('bob', 'GET', `/api/config/keys/${SANDBOX_CAPS_KEY}`)).status).toBe(403);
    expect(core.seen).toEqual([]);
  });

  it('an auditor reads, and is told she may not propose', async () => {
    const list = await api('alice', 'GET', '/api/config/keys');
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ keys: [SUMMARY], may_propose: false });
    const one = await api('alice', 'GET', `/api/config/keys/${SANDBOX_CAPS_KEY}`);
    expect(one.json.may_propose).toBe(false);
    expect(Object.keys(one.json.principal_names)).toEqual(['alice']);
    expect(one.json.effective.source).toBe('default');
  });

  it('a factory admin may propose; the principal is the session one, never the body one', async () => {
    expect((await api('root', 'GET', '/api/config/keys')).json.may_propose).toBe(true);
    const r = await api('root', 'POST', `/api/config/keys/${SANDBOX_CAPS_KEY}/proposals`, {
      value: { total: 6, coding: 2 },
      parent_rev_hash: null,
    });
    expect(r.status).toBe(201);
    expect(core.seen.at(-1)?.body).toEqual({
      value: { total: 6, coding: 2 },
      parent_rev_hash: null,
      on_behalf_of: 'root',
    });
    const forged = await api('root', 'POST', `/api/config/keys/${SANDBOX_CAPS_KEY}/proposals`, {
      value: 1,
      parent_rev_hash: null,
      on_behalf_of: 'alice',
    });
    expect(forged.status).toBe(400);
  });

  it('a proposal by someone the PDP refuses never reaches core', async () => {
    core.seen.length = 0;
    const r = await api('alice', 'POST', `/api/config/keys/${SANDBOX_CAPS_KEY}/proposals`, {
      value: { total: 6, coding: 2 },
      parent_rev_hash: null,
    });
    expect(r.status).toBe(403);
    expect(core.seen).toEqual([]);
  });

  it("core's refusals keep their status: a stale draft is 409, a bad key 400", async () => {
    core.override.set(`POST /v1/config/keys/${SANDBOX_CAPS_KEY}/proposals`, {
      status: 409,
      json: { error: { code: 'conflict', message: 'stale_parent' } },
    });
    const r = await api('root', 'POST', `/api/config/keys/${SANDBOX_CAPS_KEY}/proposals`, {
      value: { total: 6, coding: 2 },
      parent_rev_hash: null,
    });
    expect(r.status).toBe(409);
    expect((await api('root', 'GET', '/api/config/keys/Not%20a%20key')).status).toBe(400);
  });
});
