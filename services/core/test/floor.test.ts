import { CATALOGUE, currentCatalogueRef } from '@aisdlc/catalogue';
import { FloorView } from '@aisdlc/contracts';
import { bindProject, grantFleetRole, grantRole, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { FakeStagePorts } from '@aisdlc/ports';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { floorPlanOf } from '@aisdlc/work';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, type CoreScope } from '../src/index.js';
import { FLOOR_PROJECTION, floorProjection, shortKey } from '../src/floor.js';
import { publishSettings, setAdmins, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
  type Seeded,
} from './work-fixtures.js';

// The floor's live read model (PLAN M19): a fold of the item streams under each item's pinned catalogue, rebuilt from
// the record alone; served PDP-guarded (floor.read on the project, item.view_floor per item); stale when it cannot
// catch up. Real Postgres, the real PDP over the real identity read model, items driven by the real work driver.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by their contracts
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
let p: Seeded;
let other: Seeded;
let gated: string;
let blocked: string;
const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard', 'portal', 'work'],
  reader: ['read'],
};

async function call(token: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}
const get = (path: string, token = TOKENS.bff) => call(token, 'GET', path);
const ask = async (who: string, at: Seeded, text: string): Promise<string> => {
  const r = await call(TOKENS.bff, 'POST', '/v1/requests', {
    project_id: at.project,
    repo: at.repo,
    lane: 'L3',
    channel: 'N1',
    text,
    on_behalf_of: who,
  });
  if (r.status !== 201) throw new Error(`request: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.item_id as string;
};

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ada', 'ria', 'vic', 'eve', 'bob']);
  await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
  p = await seedActivePrr(s, { level: 'light' });
  other = await seedActivePrr(s, { level: 'light' });
  await bindProject(s.id, p.project, { requesters: ['ria'] });
  await bindProject(s.id, other.project, { requesters: ['ria'] });
  await grantRole(s.id.deps, 'vic', 'project.viewer', { kind: 'project', ref: p.project });
  approvers(s, p.project);
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: CALLERS,
    registry: s.registry,
    clock: s.clock,
    pdp,
    config: s.config,
  });
  url = await listen(app);

  // one item waits at its first gates (G0+G1); one meets a red baseline in S6 (B6) and is blocked
  const ports = new FakeStagePorts();
  ports.script((r) =>
    r.step === '6.2' && r.attempt === 1
      ? { outcome: 'rework', edge: 'B6', reason_code: 'red_baseline' }
      : undefined,
  );
  const d = driverOver(s, { ports });
  gated = await ask('ria', p, 'Export invoices as CSV\nwith the totals per month.');
  await runItem(s, d, gated, { decide: () => 'hold', stop: (st) => st.gates.length > 0 });
  blocked = await ask('ria', p, 'Rename the orders table');
  await runItem(s, d, blocked, { stop: (st) => st.waiting?.kind === 'blocked' });
  // an item of another project never shows on this floor
  await ask('ria', other, 'Something elsewhere');
});
afterAll(async () => {
  await app?.close();
  await s.stop();
});

describe('the floor read model', () => {
  it('is a fold of the record: dropping it and refolding gives the same rows', async () => {
    const f = FloorView.parse((await get(`/v1/floor/${p.project}?on_behalf_of=ada`)).json);
    expect(f.items.length).toBeGreaterThanOrEqual(2);
    await expectRebuildEqualsLive(s.record.pool, floorProjection);
  });

  it('places an item at its gate position with who decides it, and one blocked in S6 with its back-edge', async () => {
    const r = await get(`/v1/floor/${p.project}?on_behalf_of=ada`);
    expect(r.status).toBe(200);
    const f = FloorView.parse(r.json);
    expect(f.plan).toEqual(floorPlanOf(CATALOGUE, currentCatalogueRef()));
    const g = f.items.find((i) => i.item_id === gated)!;
    expect(g).toMatchObject({
      key: shortKey(gated),
      lane: 'L3',
      node: { kind: 'gate', key: 'G0+G1' },
      stage: 'S1',
      status: 'waiting',
      title: 'Export invoices as CSV',
      requester: 'ria',
      mine: false,
    });
    expect(g.waiting_gates.map((w) => [w.gate, w.slot, w.deciders])).toEqual([
      ['G0', 'intent', ['bob']],
      ['G1', 'intent', ['bob']],
    ]);
    // the route of the item is its pinned lane's, from the catalogue
    expect(g.route).toEqual(
      floorPlanOf(CATALOGUE, currentCatalogueRef()).lanes.find((l) => l.lane === 'L3')!.route,
    );
    const b = f.items.find((i) => i.item_id === blocked)!;
    expect(b).toMatchObject({
      stage: 'S6',
      status: 'stuck',
      node: { kind: 'station', stage: 'S6' },
    });
    expect(f.recent.some((m) => m.item_id === blocked && m.kind === 'B' && m.edge === 'B6')).toBe(
      true,
    );
    const total = f.flow.reduce((n, h) => n + h.F + h.B + h.R, 0);
    expect(total).toBeGreaterThan(0);
    expect(f.flow).toHaveLength(24);
    // the other project's item is not here; nothing is stale
    expect(f.items.every((i) => i.route.length > 0)).toBe(true);
    expect(f.freshness.stale).toBe(false);
    expect(f.freshness.as_of_seq).toBeGreaterThan(0);
  });

  it('marks the requester and the people a gate waits on', async () => {
    const ria = FloorView.parse((await get(`/v1/floor/${p.project}?on_behalf_of=ria`)).json);
    expect(ria.items.find((i) => i.item_id === gated)).toMatchObject({
      mine: true,
      waits_on_me: false,
    });
  });
});

describe("P2-10: the gates the project's profile has off", () => {
  it('none while the project has no published settings; the ones no lane has under a published profile', async () => {
    const f = FloorView.parse((await get(`/v1/floor/${p.project}?on_behalf_of=ada`)).json);
    expect(f.gates_off).toEqual([]);
    setAdmins(s, other.project, ['ada']);
    await publishSettings(
      s,
      other.project,
      {
        gating_profile: {
          gates: { g0g1: 'on', g2: 'off', g3d: 'off', g3_g3s: 'off', g5: 'off', g6: 'off' },
          schedule: 'auto',
          tier_floor_applied: false,
        },
      },
      'ada',
    );
    const o = FloorView.parse((await get(`/v1/floor/${other.project}?on_behalf_of=ada`)).json);
    const keys = o.plan.gates.map((g) => g.key);
    expect(o.gates_off.length).toBeGreaterThan(0);
    expect(o.gates_off.every((k) => keys.includes(k))).toBe(true);
    expect(o.gates_off).not.toContain('G0+G1');
    expect(o.gates_off).toContain('G6');
  });
});

describe('the PDP guard', () => {
  it('needs floor.read on the project, the work scope and a person; a viewer may open it', async () => {
    expect((await get(`/v1/floor/${p.project}?on_behalf_of=vic`)).status).toBe(200);
    expect((await get(`/v1/floor/${p.project}?on_behalf_of=eve`)).status).toBe(403);
    expect((await get(`/v1/floor/${other.project}?on_behalf_of=vic`)).status).toBe(403);
    expect((await get(`/v1/floor/${p.project}`)).status).toBe(400);
    expect((await get(`/v1/floor/Bad%20Id?on_behalf_of=ada`)).status).toBe(400);
    expect((await get(`/v1/floor/${p.project}?on_behalf_of=ada`, TOKENS.reader)).status).toBe(403);
  });
});

describe('a stale read model', () => {
  it('is served as it is, marked stale with the reason, when it cannot catch up', async () => {
    await s.record.pool.query(
      `UPDATE record.projection_checkpoint SET version = version + 100 WHERE name = $1`,
      [FLOOR_PROJECTION],
    );
    try {
      await ask('ria', p, 'A request the stale floor has not seen');
      const f = FloorView.parse((await get(`/v1/floor/${p.project}?on_behalf_of=ada`)).json);
      expect(f.freshness.stale).toBe(true);
      expect(f.freshness.reason).toMatch(/rebuild/);
      expect(f.freshness.head_seq).toBeGreaterThan(f.freshness.as_of_seq);
      expect(f.items.some((i) => i.title === 'A request the stale floor has not seen')).toBe(false);
    } finally {
      await s.record.pool.query(
        `UPDATE record.projection_checkpoint SET version = version - 100 WHERE name = $1`,
        [FLOOR_PROJECTION],
      );
    }
    const f = FloorView.parse((await get(`/v1/floor/${p.project}?on_behalf_of=ada`)).json);
    expect(f.freshness.stale).toBe(false);
    expect(f.items.some((i) => i.title === 'A request the stale floor has not seen')).toBe(true);
  });
});
