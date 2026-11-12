import { createServer, type Server } from 'node:http';
import { FleetView, FloorView } from '@aisdlc/contracts';
import { bindProject, grantFleetRole, grantRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpCoreClient } from '../src/core-client.js';
import { signIn, startBffStack, type BffStack, type Browser } from '../src/testing.js';
import { CORE_TOKEN, ITEM_ID } from './portal-fixtures.js';

// PLAN M19: the floor through the bff. floor.read on the project here (core asks again), the answer cut to the
// person's view level and data class (a viewer sees positions, never a title or the requester), the
// sandbox-controller's sessions per class (unknown when it cannot be asked), and an ETag so an unchanged floor polls
// as a 304. Fakes stand in for core and the sandbox-controller over HTTP.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SC_TOKEN = 'bff-at-sandbox-controller-'.padEnd(32, 'x');
const AT = '2026-11-12T10:00:00.000Z';

const FEASIBLE = { feasibility: 'feasible', feasibility_reason: null } as const;
const CLEAR = { state: 'clear', killed: false, kill_ids: [], message: null } as const;
const LIVENESS = { silence_minutes: 30, by_stage: {}, low_score: 0.85, source: 'default' } as const;
const PLAN = {
  catalogue: { version: '1.3.0', hash: 'a'.repeat(64) },
  stations: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'],
  gates: [{ key: 'G0+G1', gates: ['G0', 'G1'], after_stage: 'S1', after_step: '1.6' }],
  lanes: [{ lane: 'L3', route: ['S1', 'G0+G1', 'S3'], human_led: false }],
};
const row = (project_id: string, classification: 'internal' | 'confidential') => ({
  project_id,
  name: `Project ${project_id}`,
  opaque_key: '0123456789abcdef',
  team_id: null,
  classification,
  level: 'light',
  collapsed: null,
  in_flight: 3,
  done_24h: 1,
  stations: { S1: 1, S6: 1 },
  stuck_at: ['S6'],
  gates: { 'G0+G1': 1 },
  rooms: {},
  status: { working: 1, waiting: 1, held: 0, stuck: 1 },
  infeasible_gates: 1,
  lanes: ['L3'],
  kill: CLEAR,
});
const fleetFixture = () =>
  FleetView.parse({
    plan: PLAN,
    projects: [row('acme', 'internal'), row('secret', 'confidential'), row('other', 'internal')],
    sessions: null,
    liveness: LIVENESS,
    freshness: { as_of_seq: 12, head_seq: 12, stale: false, reason: null, read_at: AT },
  });

const floorFixture = (o: { stale?: boolean; read_at?: string } = {}) =>
  FloorView.parse({
    project_id: 'acme',
    plan: {
      catalogue: { version: '1.3.0', hash: 'a'.repeat(64) },
      stations: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'],
      gates: [{ key: 'G0+G1', gates: ['G0', 'G1'], after_stage: 'S1', after_step: '1.6' }],
      lanes: [{ lane: 'L3', route: ['S1', 'G0+G1', 'S3'], human_led: false }],
    },
    items: [
      {
        item_id: ITEM_ID,
        key: '33333333',
        lane: 'L3',
        lane_bound: false,
        node: { kind: 'gate', key: 'G0+G1' },
        stage: 'S1',
        step: '1.6',
        phase: 'S1',
        status: 'waiting',
        waiting: 'gates:G0+G1',
        waiting_gates: [
          { gate: 'G0', gate_instance_id: 'g-0', slot: 'intent', deciders: ['bob'], ...FEASIBLE },
          { gate: 'G1', gate_instance_id: 'g-1', slot: 'intent', deciders: ['bob'], ...FEASIBLE },
        ],
        holds: [],
        in_session: false,
        activity: null,
        route: ['S1', 'G0+G1', 'S3'],
        catalogue_version: '1.3.0',
        title: 'Export invoices as CSV',
        requester: 'carol',
        mine: false,
        waits_on_me: false,
        updated_at: AT,
      },
    ],
    recent: [],
    flow: [],
    controls: [],
    sessions: null,
    scores: [],
    kill: CLEAR,
    liveness: LIVENESS,
    freshness: {
      as_of_seq: 12,
      head_seq: o.stale ? 20 : 12,
      stale: o.stale ?? false,
      reason: o.stale ? 'the floor read model needs a rebuild' : null,
      read_at: o.read_at ?? AT,
    },
    view_level: 'V3',
    data_class: 'D2',
  });

interface Fake {
  readonly url: string;
  readonly seen: string[];
  readonly override: Map<string, { status: number; json: unknown }>;
  stop(): Promise<void>;
}

async function fakeServer(
  token: string,
  route: (path: string) => { status: number; json: unknown },
): Promise<Fake> {
  const seen: string[] = [];
  const override = new Map<string, { status: number; json: unknown }>();
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    seen.push(`${req.method} ${path}`);
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: { code: 'unauthenticated' } });
    const o = override.get(path.split('?')[0] as string);
    if (o) return send(o.status, o.json);
    const r = route(path);
    return send(r.status, r.json);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    override,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let s: BffStack;
let core: Fake;
let sc: Fake;

const slots = {
  host_id: 'runner-1',
  caps: { total: 4, coding: 1 },
  caps_source: 'config',
  used_total: 1,
  used: { K: 0, 'K-exec': 0, P: 0, W: 1, O: 0, V: 0 },
  free: { K: 3, 'K-exec': 3, P: 3, W: 0, O: 3, V: 3 },
  sessions: [{ session_id: 's-1', class: 'W', grant_id: 'g-1', started_at: AT }],
};

beforeAll(async () => {
  core = await fakeServer(CORE_TOKEN, (path) =>
    path.split('?')[0] === '/v1/floor/acme'
      ? { status: 200, json: floorFixture() }
      : path === '/v1/fleet'
        ? { status: 200, json: fleetFixture() }
        : { status: 404, json: { error: { code: 'not_found', message: 'no' } } },
  );
  sc = await fakeServer(SC_TOKEN, (path) =>
    path === '/v1/slots' ? { status: 200, json: slots } : { status: 404, json: {} },
  );
  s = await startBffStack({
    override: {
      core: new HttpCoreClient({ baseUrl: core.url, token: CORE_TOKEN }),
      sandboxController: new HttpCoreClient({ baseUrl: sc.url, token: SC_TOKEN }),
    },
  });
  // root: factory admin (V3, D2); alice: project admin (V3, D1); dora: viewer (V1, D0); carol: nothing on acme
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
  await bindProject(s.identity, 'acme', { admin: ['alice'] });
  await grantRole(s.identity.deps, 'dora', 'project.viewer', { kind: 'project', ref: 'acme' });
  await bindProject(s.identity, 'secret', { admin: ['bob'] });
  await bindProject(s.identity, 'other', { admin: ['bob'] });
});
afterAll(async () => {
  await s.stop();
  await core.stop();
  await sc.stop();
});
beforeEach(() => {
  core.seen.length = 0;
  core.override.clear();
  sc.override.clear();
});

const browsers = new Map<string, Browser>();
async function get(
  who: 'alice' | 'carol' | 'dora' | 'root',
  path: string,
  headers: Record<string, string> = {},
) {
  let b = browsers.get(who);
  if (!b) {
    b = (await signIn(s, who)).browser;
    browsers.set(who, b);
  }
  const res = await b.request(`${s.base}${path}`, { headers });
  const text = await res.text();
  let json: Json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, res };
}

describe('GET /api/floor/:project', () => {
  it('gives a project admin the titles and who requested, with the sessions per class', async () => {
    const r = await get('alice', '/api/floor/acme');
    expect(r.status).toBe(200);
    const f = FloorView.parse(r.json);
    expect(f).toMatchObject({ view_level: 'V3', data_class: 'D1' });
    expect(f.items[0]).toMatchObject({ title: 'Export invoices as CSV', requester: 'carol' });
    expect(f.sessions).toMatchObject({ caps: { coding: 1 }, used: { W: 1 } });
    expect(core.seen[0]).toBe('GET /v1/floor/acme?on_behalf_of=alice');
  });

  it('cuts a viewer to positions: no title, no requester, the gate still shows who it waits on', async () => {
    const r = await get('dora', '/api/floor/acme');
    expect(r.status).toBe(200);
    const f = FloorView.parse(r.json);
    expect(f).toMatchObject({ view_level: 'V1', data_class: 'D0' });
    expect(f.items[0]).toMatchObject({
      title: null,
      requester: null,
      node: { kind: 'gate', key: 'G0+G1' },
    });
    expect(f.items[0]?.waiting_gates.map((g) => g.deciders)).toEqual([['bob'], ['bob']]);
    expect(r.text).not.toContain('Export invoices');
    expect(r.text).not.toContain('carol');
  });

  it('refuses a person without floor.read before asking core; a bad id is a 400', async () => {
    expect((await get('carol', '/api/floor/acme')).status).toBe(403);
    expect((await get('alice', '/api/floor/Bad%20Id')).status).toBe(400);
    expect(core.seen).toEqual([]);
  });

  it('answers 304 to the ETag of an unchanged floor, and a new tag when it changed', async () => {
    const a = await get('alice', '/api/floor/acme');
    const tag = a.res.headers.get('etag') as string;
    expect(tag).toMatch(/^"[0-9a-f]{64}"$/);
    // a later read time alone is not a change
    core.override.set('/v1/floor/acme', {
      status: 200,
      json: floorFixture({ read_at: '2026-11-12T10:00:05.000Z' }),
    });
    const b = await get('alice', '/api/floor/acme', { 'if-none-match': tag });
    expect(b.status).toBe(304);
    expect(b.text).toBe('');
    core.override.set('/v1/floor/acme', { status: 200, json: floorFixture({ stale: true }) });
    const c = await get('alice', '/api/floor/acme', { 'if-none-match': tag });
    expect(c.status).toBe(200);
    expect(c.json.freshness).toMatchObject({ stale: true });
    expect(c.res.headers.get('etag')).not.toBe(tag);
  });

  it('says the sessions are unknown when the sandbox-controller does not answer, and 502 when core does not', async () => {
    sc.override.set('/v1/slots', { status: 500, json: {} });
    const r = await get('alice', '/api/floor/acme');
    expect(r.status).toBe(200);
    expect(r.json.sessions).toBeNull();
    core.override.set('/v1/floor/acme', { status: 503, json: { error: { code: 'unavailable' } } });
    expect((await get('alice', '/api/floor/acme')).status).toBe(502);
  });
});

describe('GET /api/fleet', () => {
  const names = (v: FleetView) => v.projects.map((p) => [p.project_id, p.collapsed]);

  it('gives a fleet role every project, a confidential one it has no role in collapsed to its count', async () => {
    const r = await get('root', '/api/fleet');
    expect(r.status).toBe(200);
    const v = FleetView.parse(r.json);
    expect(names(v)).toEqual([
      ['acme', null],
      ['secret', 'confidential'],
      ['other', null],
    ]);
    const secret = v.projects[1]!;
    expect(secret).toMatchObject({
      in_flight: 3,
      stations: {},
      gates: {},
      stuck_at: [],
      lanes: [],
    });
    expect(secret.status).toEqual({ working: 0, waiting: 0, held: 0, stuck: 0 });
    expect(v.sessions).toMatchObject({ caps: { coding: 1 } });
  });

  it('shows a project role its own projects only: another confidential or invisible project is not there at all', async () => {
    expect(names(FleetView.parse((await get('alice', '/api/fleet')).json))).toEqual([
      ['acme', null],
    ]);
    expect(names(FleetView.parse((await get('dora', '/api/fleet')).json))).toEqual([
      ['acme', null],
    ]);
    const carol = FleetView.parse((await get('carol', '/api/fleet')).json);
    expect(carol.projects).toEqual([]);
    expect(JSON.stringify(carol)).not.toContain('secret');
  });

  it('is a 502 when core does not answer, never an empty fleet that looks calm', async () => {
    core.override.set('/v1/fleet', { status: 503, json: { error: { code: 'unavailable' } } });
    expect((await get('root', '/api/fleet')).status).toBe(502);
  });
});
