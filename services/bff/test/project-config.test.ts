import { PROJECT_WIP_LIMIT_KEY, ProjectLayerKeyValues } from '@aisdlc/contracts';
import { bindProject } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { startFakeCore, type FakeCore } from './portal-fixtures.js';

// P1-5: the project layer of the configuration console in the bff. Reads need `project.view` on the project, a
// proposal `project.settings.edit` (core asks again); the proposal is core's `PUT /v1/projects/:id/settings` with the
// one field the key maps to, the head the draft was made against, and the session's principal, never the body's.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Who = 'alice' | 'bob' | 'dora';

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
  key: PROJECT_WIP_LIMIT_KEY,
  kind: 'setting',
  description: 'the project WIP limit',
  overridable: true,
  json_schema: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
};
const VIEW = {
  key: SUMMARY,
  default: null,
  effective: {
    value: 2,
    source: 'factory',
    rev_hash: 'a'.repeat(64),
    gate_instance_id: null,
    ledger_entry_id: null,
    published_at: null,
  },
  head_rev_hash: 'e'.repeat(64),
  pending: [],
  history: [
    {
      rev_hash: 'e'.repeat(64),
      parent_rev_hash: null,
      state: 'current',
      gate_instance_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77',
      ledger_entry_id: null,
      proposed_by: 'alice',
      proposed_at: '2026-11-09T10:00:00.000Z',
      published_at: '2026-11-09T10:05:00.000Z',
      value: null,
      set: false,
      changes_key: false,
    },
  ],
  project_id: 'acme',
  tier: 'T1',
  deploys: false,
};
const BASE = '/api/projects/acme/config/keys';

beforeAll(async () => {
  core = await startFakeCore();
  s = await startBffStack({ override: { core: core.client } });
  await bindProject(s.identity, 'acme', { admin: ['alice'], requesters: ['bob'] });
});
afterAll(async () => {
  await s?.stop();
  await core?.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
  core.override.set('GET /v1/projects/acme/config/keys', { status: 200, json: [SUMMARY] });
  core.override.set(`GET /v1/projects/acme/config/keys/${PROJECT_WIP_LIMIT_KEY}`, {
    status: 200,
    json: VIEW,
  });
  core.override.set('PUT /v1/projects/acme/settings', {
    status: 202,
    json: {
      rev_hash: 'c'.repeat(64),
      parent_rev_hash: 'e'.repeat(64),
      gate_instance_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe78',
      superseded: [],
      confirmed: true,
    },
  });
});

describe('/api/projects/:id/config (P1-5)', () => {
  it('reads need project.view on the project; core is not asked otherwise', async () => {
    expect((await api('dora', 'GET', BASE)).status).toBe(403);
    expect((await api('dora', 'GET', `${BASE}/${PROJECT_WIP_LIMIT_KEY}`)).status).toBe(403);
    expect(core.seen).toEqual([]);
  });

  it('a project member reads the value in force and is told she may not propose', async () => {
    const list = await api('bob', 'GET', BASE);
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ keys: [SUMMARY], may_propose: false });
    const one = await api('bob', 'GET', `${BASE}/${PROJECT_WIP_LIMIT_KEY}`);
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ may_propose: false, tier: 'T1', project_id: 'acme' });
    expect(one.json.effective.source).toBe('factory');
    expect(one.json.principal_names).toHaveProperty('alice');
  });

  it('only a key of the project layer is served', async () => {
    expect(ProjectLayerKeyValues).toContain(PROJECT_WIP_LIMIT_KEY);
    expect((await api('alice', 'GET', `${BASE}/sandbox.caps`)).status).toBe(404);
    expect(core.seen).toEqual([]);
  });

  it('the project admin proposes: core gets the settings PUT with the field, the head and the session principal', async () => {
    expect((await api('alice', 'GET', BASE)).json.may_propose).toBe(true);
    const r = await api('alice', 'POST', `${BASE}/${PROJECT_WIP_LIMIT_KEY}/proposals`, {
      value: 3,
      parent_rev_hash: 'e'.repeat(64),
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toEqual({
      rev_hash: 'c'.repeat(64),
      parent_rev_hash: 'e'.repeat(64),
      gate_instance_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe78',
      superseded: [],
    });
    const sent = core.seen.at(-1);
    expect(sent?.method).toBe('PUT');
    expect(sent?.path).toBe('/v1/projects/acme/settings');
    expect(sent?.body).toEqual({
      wip_limit: 3,
      parent_rev_hash: 'e'.repeat(64),
      on_behalf_of: 'alice',
    });
    const forged = await api('alice', 'POST', `${BASE}/${PROJECT_WIP_LIMIT_KEY}/proposals`, {
      value: 3,
      parent_rev_hash: null,
      on_behalf_of: 'bob',
    });
    expect(forged.status).toBe(400);
  });

  it('a proposal the PDP refuses never reaches core; core refusals keep their status', async () => {
    const r = await api('bob', 'POST', `${BASE}/${PROJECT_WIP_LIMIT_KEY}/proposals`, {
      value: 3,
      parent_rev_hash: null,
    });
    expect(r.status).toBe(403);
    expect(core.seen.filter((x) => x.method !== 'GET')).toEqual([]);
    core.override.set('PUT /v1/projects/acme/settings', {
      status: 409,
      json: { error: { code: 'conflict', message: 'stale_parent' } },
    });
    const stale = await api('alice', 'POST', `${BASE}/${PROJECT_WIP_LIMIT_KEY}/proposals`, {
      value: 3,
      parent_rev_hash: null,
    });
    expect(stale.status).toBe(409);
  });
});
