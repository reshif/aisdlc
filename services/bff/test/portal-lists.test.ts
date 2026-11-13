import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindProject, grantFleetRole } from '@aisdlc/identity/testing';
import { Browser, signIn, startBffStack, type BffStack } from '../src/testing.js';
import { CORE_TOKEN, ITEM_ID, startFakeCore, type FakeCore } from './portal-fixtures.js';

// The portal's list and operate routes (2026-11-12): a session, the CSRF token on a write, the PDP's yes
// in the bff for the signed-in person, then core (or the sandbox-controller) with the bff's token and the
// person from the session. Real Postgres for identity, the directory and the PDP; core is a stand-in.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked field by field
type Json = any;
type Who = 'alice' | 'bob' | 'carol' | 'dora' | 'root';

let s: BffStack;
let core: FakeCore;
let sc: FakeCore;
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

async function api(who: Who | null, method: 'GET' | 'POST', path: string, body?: unknown) {
  const v = who ? await as(who) : { browser: new Browser(), csrf: '' };
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

const T = '2026-11-12T10:00:00.000Z';
const row = (project: string, item: string) => ({
  item_id: item,
  project_id: project,
  repo: `acme/${project}`,
  lane: null,
  proposed_lane: 'L3',
  phase: 'S1',
  underlying: 'S1',
  terminal: null,
  holds: 0,
  in_flight: false,
  mine: false,
  catalogue_version: '1.3.0',
  created_at: T,
  updated_at: T,
});
const OTHER = '44444444-5555-4666-8777-999999999999';
const CONTROL_ID = '55555555-6666-4777-8888-999999999999';
const control = (scope: { kind: string; ref: string }) => ({
  control_id: CONTROL_ID,
  kind: 'hold',
  scope,
  origin_kind: 'operator',
  state: 'active',
  expires_at: null,
  params: {},
  created_by_action: CONTROL_ID,
  created_at: T,
  lifted_at: null,
});
const SLOTS = {
  host_id: 'local',
  caps: { total: 4, coding: 1 },
  caps_source: 'default',
  used_total: 0,
  used: { K: 0, 'K-exec': 0, P: 0, W: 0, O: 0, V: 0 },
  free: { K: 4, 'K-exec': 4, P: 4, W: 1, O: 4, V: 4 },
  sessions: [],
};

beforeAll(async () => {
  core = await startFakeCore();
  sc = await startFakeCore();
  s = await startBffStack({ override: { core: core.client, sandboxController: sc.client } });
  // alice administers acme; bob is acme's intent holder; root is a factory admin; carol a factory auditor; dora has
  // nothing
  await bindProject(s.identity, 'acme', { admin: ['alice'], intent: ['bob'] });
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
  await grantFleetRole(s.identity.deps, 'carol', 'factory.auditor');
});
afterAll(async () => {
  // a failed beforeAll leaves these unset: report that failure, not a second one here
  await s?.stop();
  await core?.stop();
  await sc?.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
  sc.override.clear();
});

/** PLAN §7a: Quality is `quality.read`, Operate `ops.read`, the decision log stays `audit.read` (all on the fleet). */
const fleetReads: ReadonlyArray<{ path: string; core: string; json: unknown; action: string }> = [
  {
    action: 'quality.read',
    path: '/api/agents',
    core: '/v1/agents',
    json: { lock_format: 'aisdlc-prompts-lock/v1', agents: [] },
  },
  {
    // P2-3: the agent page
    action: 'quality.read',
    path: '/api/agents/A1',
    core: '/v1/agents/A1',
    json: {
      agent: {
        agent_id: 'A1',
        name: 'triage',
        role: 'triage',
        note: null,
        steps: ['1.3'],
        specialist_steps: [],
        contract_version: '1.1.0',
        output_schema_id: 'triage_output.v1',
        tools: [],
        data_class_max: 'D1',
        models: ['fake-model'],
        prompt: { ref: 'a1_triage@1.0.0', sha256: 'a'.repeat(64) },
      },
      input_schema_id: 'a1_input.v1',
      input_schema: { type: 'object' },
      output_schema: { oneOf: [] },
      lock_format: 'aisdlc-prompts-lock/v1',
    },
  },
  {
    action: 'quality.read',
    path: '/api/agents/A1/runs',
    core: '/v1/agents/A1/runs',
    json: { agent_id: 'A1', runs: [], total: 0 },
  },
  {
    action: 'ops.read',
    path: '/api/admission',
    core: '/v1/admission',
    json: {
      as_of: T,
      coding_session_cap: 1,
      sessions_in_slot: 0,
      active: [],
      waiting: [],
      held: [],
    },
  },
  {
    action: 'ops.read',
    path: '/api/controls',
    core: '/v1/controls',
    json: { controls: [], banners: [] },
  },
  {
    action: 'ops.read',
    path: '/api/kills',
    core: '/v1/kills',
    json: { observed_head: 0, journal: [] },
  },
  {
    action: 'audit.read',
    path: '/api/audit/decisions',
    core: '/v1/audit/decisions',
    json: { decisions: [] },
  },
];

describe('fleet reads: Quality, Operate and the decision log', () => {
  it('need a session, then their action on the fleet here; core gets the bff token and the person', async () => {
    for (const r of fleetReads) {
      core.override.set(`GET ${r.core}?on_behalf_of=root`, { status: 200, json: r.json });
      core.override.set(`GET ${r.core}?on_behalf_of=carol`, { status: 200, json: r.json });
      expect((await api(null, 'GET', r.path)).status, r.path).toBe(401);
      core.seen.length = 0;
      // a project admin holds these on their project only, not on the fleet
      const refused = await api('alice', 'GET', r.path);
      expect(refused.status, r.path).toBe(403);
      expect(refused.json.error.message, r.path).toBe(`${r.action} denied`);
      expect((await api('dora', 'GET', r.path)).status, r.path).toBe(403);
      expect(core.seen, `${r.path}: a refusal never reaches core`).toEqual([]);
      const ok = await api('root', 'GET', r.path);
      expect(ok.status, r.path).toBe(200);
      expect(ok.json).toEqual(r.json);
      const seen = core.seen.at(-1);
      expect(seen?.path).toBe(`${r.core}?on_behalf_of=root`);
      expect(seen?.headers.authorization).toBe(`Bearer ${CORE_TOKEN}`);
      expect(seen?.headers.cookie).toBeUndefined();
      // the factory auditor reads every one of them (PLAN §7a: ops.read and quality.read are the auditor's too)
      expect((await api('carol', 'GET', r.path)).status, r.path).toBe(200);
    }
  });

  it('a core answer that breaks its contract is a 502, never passed through', async () => {
    core.override.set('GET /v1/kills?on_behalf_of=root', { status: 200, json: { journal: 'x' } });
    expect((await api('root', 'GET', '/api/kills')).status).toBe(502);
  });

  it('integrations: health tiles and events, quality.read or ops.read on the fleet', async () => {
    core.override.set('GET /v1/integrations/health', {
      status: 200,
      json: { as_of: T, registry_revision: null, tiles: [] },
    });
    core.override.set('GET /v1/integrations/events', { status: 200, json: [] });
    expect((await api('alice', 'GET', '/api/integrations')).status).toBe(403);
    const ok = await api('root', 'GET', '/api/integrations');
    expect(ok.status).toBe(200);
    expect(ok.json.health.tiles).toEqual([]);
  });

  it('M19 health: the service and loop tiles, audit.read on the fleet; a broken answer is a 502', async () => {
    const tiles = {
      as_of: T,
      overall: 'unknown',
      counts: { ok: 1, degraded: 0, down: 0, unknown: 1 },
      tiles: [
        {
          tile_id: 'service.notary',
          domain: 'service',
          label: 'notary',
          state: 'ok',
          detail_code: 'ok',
          sli_value: 3,
          as_of: T,
          stale: false,
        },
        {
          tile_id: 'service.core',
          domain: 'service',
          label: 'core',
          state: 'unknown',
          detail_code: 'no_report',
          sli_value: null,
          as_of: null,
          stale: false,
        },
      ],
    };
    core.override.set('GET /v1/health', { status: 200, json: tiles });
    expect((await api('alice', 'GET', '/api/health')).status).toBe(403);
    const ok = await api('root', 'GET', '/api/health');
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual(tiles);
    core.override.set('GET /v1/health', { status: 200, json: { tiles: 'x' } });
    expect((await api('root', 'GET', '/api/health')).status).toBe(502);
  });

  it('M19 degraded: only the projects the person may view are asked about', async () => {
    const view = {
      as_of: T,
      kills: [
        {
          project_id: 'acme',
          state: 'unreachable',
          killed: true,
          kill_ids: [],
          message: 'no answer',
        },
      ],
      notary: { state: 'down', detail_code: 'unreachable', as_of: T, pending_ops_actions: 2 },
      read_models: [{ name: 'work_item', as_of_seq: 3, head_seq: 3, stale: false, reason: null }],
    };
    core.override.set('GET /v1/degraded?projects=acme', { status: 200, json: view });
    core.seen.length = 0;
    const r = await api('bob', 'GET', '/api/degraded?projects=acme,secret');
    expect(r.status).toBe(200);
    expect(r.json).toEqual(view);
    expect(core.seen.at(-1)?.path).toBe('/v1/degraded?projects=acme');
    core.override.set('GET /v1/degraded?projects=acme', { status: 200, json: { kills: 1 } });
    expect((await api('bob', 'GET', '/api/degraded?projects=acme')).status).toBe(502);
  });
});

describe('items and the catalogue', () => {
  it('lists only items on projects the person may view, whatever core sent', async () => {
    core.override.set('GET /v1/items?on_behalf_of=bob', {
      status: 200,
      json: { items: [row('acme', ITEM_ID), row('secret', OTHER)] },
    });
    const r = await api('bob', 'GET', '/api/items');
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: Json) => i.item_id)).toEqual([ITEM_ID]);
    // a project filter on a project the person cannot view is refused before core is asked
    core.seen.length = 0;
    expect((await api('bob', 'GET', '/api/items?project=secret')).status).toBe(403);
    expect(core.seen).toEqual([]);
    expect((await api('bob', 'GET', '/api/items?project=Bad Id')).status).toBe(400);
  });

  it('the catalogue is for everyone signed in', async () => {
    core.override.set('GET /v1/catalogue', { status: 200, json: { versions: [] } });
    expect((await api(null, 'GET', '/api/catalogue')).status).toBe(401);
    expect((await api('dora', 'GET', '/api/catalogue')).status).toBe(200);
  });
});

describe('sandbox slots', () => {
  it('ops.read on the fleet, then the sandbox-controller; its failure is a 502, never an empty board', async () => {
    sc.override.set('GET /v1/slots', { status: 200, json: SLOTS });
    expect((await api('alice', 'GET', '/api/slots')).status).toBe(403);
    const ok = await api('root', 'GET', '/api/slots');
    expect(ok.status).toBe(200);
    expect(ok.json.caps).toEqual({ total: 4, coding: 1 });
    sc.override.set('GET /v1/slots', { status: 500, json: {} });
    expect((await api('root', 'GET', '/api/slots')).status).toBe(502);
  });
});

describe('controls: preview, apply with the nonce, lift', () => {
  it('control.apply on the scope here; the principal comes from the session', async () => {
    core.override.set('POST /v1/controls/preview', { status: 201, json: { preview_id: 'p' } });
    const body = { kind: 'hold', scope: { kind: 'project', ref: 'acme' } };
    expect((await api('bob', 'POST', '/api/controls/preview', body)).status).toBe(403);
    const ok = await api('alice', 'POST', '/api/controls/preview', body);
    expect(ok.status).toBe(201);
    expect(core.seen.at(-1)?.body).toEqual({ ...body, on_behalf_of: 'alice' });
    // the fleet is a factory admin's alone
    const fleet = { kind: 'hold', scope: { kind: 'fleet', ref: '*' } };
    expect((await api('alice', 'POST', '/api/controls/preview', fleet)).status).toBe(403);
    // a body that names a principal is refused; a scope a control does not hold is refused
    expect(
      (await api('alice', 'POST', '/api/controls/preview', { ...body, on_behalf_of: 'root' }))
        .status,
    ).toBe(400);
    expect(
      (
        await api('alice', 'POST', '/api/controls/preview', {
          kind: 'hold',
          scope: { kind: 'team', ref: 'team-a' },
        })
      ).status,
    ).toBe(400);
    core.override.set('POST /v1/controls', { status: 201, json: { action_id: 'a' } });
    const applied = await api('alice', 'POST', '/api/controls', {
      ...body,
      preview_id: CONTROL_ID,
      nonce: 'n'.repeat(32),
    });
    expect(applied.status).toBe(201);
  });

  it('lift asks control.lift on the scope of the control as core lists it', async () => {
    core.override.set('GET /v1/controls?on_behalf_of=root', {
      status: 200,
      json: { controls: [control({ kind: 'project', ref: 'acme' })], banners: [] },
    });
    core.override.set(`POST /v1/controls/${CONTROL_ID}/lift`, { status: 200, json: { ok: 1 } });
    const r = await api('root', 'POST', `/api/controls/${CONTROL_ID}/lift`, { reason: 'done' });
    expect(r.status).toBe(200);
    expect(core.seen.at(-1)?.body).toEqual({ reason: 'done', on_behalf_of: 'root' });
    expect(
      (await api('root', 'POST', `/api/controls/${OTHER}/lift`, { reason: 'done' })).status,
    ).toBe(404);
    expect(
      (await api('alice', 'POST', `/api/controls/${CONTROL_ID}/lift`, { reason: 'x' })).status,
    ).toBe(403);
  });
});

describe("admin reads from the bff's own read models", () => {
  it('the directory: audit.read on the fleet', async () => {
    expect((await api('alice', 'GET', '/api/directory')).status).toBe(403);
    const r = await api('root', 'GET', '/api/directory');
    expect(r.status).toBe(200);
    expect(r.json.principals.map((p: Json) => p.principal_id)).toContain('alice');
    expect(Array.isArray(r.json.teams)).toBe(true);
  });

  it("who can do what: access.explain on the project; holders with their roles and the PDP's actions", async () => {
    expect((await api('bob', 'GET', '/api/projects/acme/explain')).status).toBe(403);
    expect((await api('dora', 'GET', '/api/projects/acme/explain')).status).toBe(403);
    const r = await api('alice', 'GET', '/api/projects/acme/explain');
    expect(r.status).toBe(200);
    const alice = r.json.holders.find((h: Json) => h.principal_id === 'alice');
    expect(alice.actions).toContain('project.settings.edit');
    const bob = r.json.holders.find((h: Json) => h.principal_id === 'bob');
    expect(bob.actions).not.toContain('project.settings.edit');
    // root is a fleet role: it reaches the project too
    expect(r.json.holders.map((h: Json) => h.principal_id)).toContain('root');
    expect((await api('alice', 'GET', '/api/projects/Bad Id/explain')).status).toBe(400);
  });
});
