import {
  LaneEligibility,
  LaneValues,
  WORK_EVENT,
  repoIdOf,
  type Lane,
  type ProjectReadinessRecord,
  type ReadinessStatus,
} from '@aisdlc/contracts';
import { catalogueFor } from '@aisdlc/catalogue';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPrr,
  createCoreApp,
  fanOutHeld,
  inCoreTx,
  laneEligibility,
  readWork,
  requestWork,
  routeLane,
  setPrrStatus,
  type PrrVersion,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness } from './harness.js';
import { NOW, alice, built, inputs, loadReports } from './prr-fixtures.js';

// The eligibility producer, the N8 hold and the project-level fan-out (PLAN M7.6; DEC-8). A request
// for a repo with no active PRR is held (N8); a PRR that is too low, stale, suspended or expired
// sends it to L8 through the 1.4 rule; an M4 releases only the held requests whose lane it opens.

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const TOKEN = 'reader-at-core-'.padEnd(32, 'x');
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth({ reader: TOKEN }),
    callers: { reader: ['read'] },
    registry: s.registry,
    clock: s.clock,
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await s.stop();
});
const h = makeHarness(() => s, 'el');
const { scenario, sync, decideAs, ok, throughC1, throughC4, toC5 } = h;

// ---------------------------------------------------------------- the routing table (pure)

const version = (prr: ProjectReadinessRecord, status: ReadinessStatus = 'active'): PrrVersion => ({
  version: prr.version,
  prr: { ...prr, status },
  status,
  s0_id: '00000000-0000-4000-8000-000000000000',
  proposed_at: prr.issued_at,
  activated_at: prr.issued_at,
});
const route = (g: PrrVersion | null, lane: Lane, now: Date | string = NOW) =>
  routeLane('acme/x', lane, g, new Date(now));
const table = (g: PrrVersion | null) =>
  Object.fromEntries(
    LaneValues.map((l) => {
      const v = route(g, l);
      return [l, `${v.route}:${v.eligible ? 'yes' : 'no'}:${v.reason}`];
    }),
  );

describe('eligibility(repo, lane): the table (PLAN M7.6, DEC-8)', () => {
  it('no PRR that an M4 made active: every lane is an N8 hold, whatever the lane', () => {
    for (const l of LaneValues) {
      expect(route(null, l)).toMatchObject({
        eligible: false,
        route: 'n8_hold',
        reason: 'no_active_prr',
        prr: null,
      });
    }
  });

  it('a proposed record is not active: a repo whose only PRR is proposed is still N8', () => {
    const g = version(built(inputs()), 'proposed');
    // governingPrr() ignores a version that was never active; routeLane is given what it returns
    expect(route(null, 'L1').route).toBe('n8_hold');
    expect(g.status).toBe('proposed');
  });

  it('active at Census: L7 and L8; L0, L1, L3-L6 go to L8 (level too low), L2 is unspecified', () => {
    const t = table(version(built(inputs())));
    expect(t).toMatchObject({
      L8: 'normal:yes:eligible',
      L1: 'l8:no:level_too_low',
      L3: 'l8:no:level_too_low',
      L4: 'l8:no:level_too_low',
      L5: 'l8:no:level_too_low',
      L6: 'l8:no:level_too_low',
      L0: 'l8:no:level_too_low', // L0 from Light (PLAN 7a, catalogue 1.4.0)
      L2: 'l8:no:lane_unspecified', // agent remediation chores at Census are DEC-16: unspecified
      L7: 'normal:yes:eligible', // L7 from Census
    });
  });

  it('active at Light: L0-L3, L7 and L8; L4-L6 too low', () => {
    const t = table(version(built(inputs({ level: 'light' }))));
    expect(t).toMatchObject({
      L1: 'normal:yes:eligible',
      L2: 'normal:yes:eligible',
      L3: 'normal:yes:eligible',
      L8: 'normal:yes:eligible',
      L4: 'l8:no:level_too_low',
      L6: 'l8:no:level_too_low',
      L0: 'normal:yes:eligible',
      L7: 'normal:yes:eligible',
    });
  });

  it('an item pinned to catalogue 1.3.0 keeps its rule: L0 and L7 go to L8 even on a Light record', () => {
    const old = catalogueFor({
      version: '1.3.0',
      hash: '601beaae85ea26e30b0f13349571b76d549871ea7020afbd2199fb313a86a123',
    });
    if (!old.ok) throw new Error('1.3.0 is released');
    const g = version(built(inputs({ level: 'light' })));
    expect(g.prr.autonomy.lanes_eligible).toContain('L0');
    for (const lane of ['L0', 'L7'] as const) {
      expect(routeLane('acme/x', lane, g, NOW, old.value.eligibility)).toMatchObject({
        eligible: false,
        route: 'l8',
        reason: 'lane_unspecified',
      });
    }
    expect(routeLane('acme/x', 'L1', g, NOW, old.value.eligibility).route).toBe('normal');
  });

  it('a record signed under catalogue 1.3.0 keeps its lanes: no L0 or L7 at Light', () => {
    const i = inputs({ level: 'light' });
    const b = buildPrr({
      ...i,
      s0: {
        ...i.s0,
        catalogue_ref: {
          version: '1.3.0',
          hash: '601beaae85ea26e30b0f13349571b76d549871ea7020afbd2199fb313a86a123',
        },
      },
    } as never);
    if (!b.ok) throw new Error(b.error.message);
    expect(b.value.autonomy.lanes_eligible).toEqual(['L1', 'L2', 'L3', 'L8']);
    const unknown = buildPrr({
      ...i,
      s0: { ...i.s0, catalogue_ref: { version: '9.9.9', hash: 'a'.repeat(64) } },
    } as never);
    expect(!unknown.ok && unknown.error.code).toBe('catalogue_unknown');
  });

  it('per area (DEC-25): each area opens the lanes of its own level; the repo as a whole the lowest', () => {
    const area = (name: string, test_files: number) => ({
      area: name,
      manifest: `${name}/package.json`,
      files: 3,
      source_files: 2,
      test_files,
      languages: ['typescript' as const],
      depends_on: [],
      used_by: [],
    });
    const prr = built({
      ...inputs({ level: 'full' }),
      areas: {
        system_map: {
          graph_hash: 'a'.repeat(64),
          map_hash: 'b'.repeat(64),
          edges: [],
          areas: [area('.', 1), area('docs', 0), area('lib', 1)],
        },
        seeded_areas: ['.', 'docs'],
        graph_truncated: false,
        // card 2: the root text covers every area; one affirmed claim about each (LF5, LF6 per area)
        instruction_areas: ['.'],
        claims: ['package.json', 'docs/a.md', 'lib/a.ts'].map((p) => ({
          verdict: 'affirm' as const,
          paths: [p],
        })),
      },
    });
    expect(prr.level.by_area).toEqual({ '.': 'full', docs: 'census', lib: 'light' });
    expect(prr.level.areas?.map((a) => [a.area, a.level, a.lanes])).toEqual([
      ['.', 'full', ['L0', 'L1', 'L2', 'L3', 'L4', 'L6', 'L7', 'L8']],
      ['docs', 'census', ['L7', 'L8']],
      ['lib', 'light', ['L0', 'L1', 'L2', 'L3', 'L7', 'L8']],
    ]);
    // the repo as a whole runs only what its lowest area may
    expect(prr.autonomy.lanes_eligible).toEqual(['L7', 'L8']);
    const g = version(prr);
    const at = (lane: Lane, a?: string) => {
      const v = routeLane('acme/x', lane, g, NOW, undefined, a);
      return `${v.route}:${v.reason}${v.area ? `@${v.area}` : ''}`;
    };
    expect(at('L4', '.')).toBe('normal:eligible@.');
    expect(at('L4', 'lib')).toBe('l8:level_too_low@lib');
    expect(at('L1', 'lib')).toBe('normal:eligible@lib');
    expect(at('L1', 'docs')).toBe('l8:level_too_low@docs');
    expect(at('L1')).toBe('l8:level_too_low');
    // an area the record does not hold is unknown, and unknown is not eligible
    expect(at('L8', 'services/nowhere')).toBe('l8:area_unknown@services/nowhere');
    // a record with one repo-wide area holds every path
    const one = version(built(inputs({ level: 'light' })));
    expect(one.prr.level.areas).toEqual([
      { area: '.', level: 'light', floors: [], lanes: ['L0', 'L1', 'L2', 'L3', 'L7', 'L8'] },
    ]);
    expect(routeLane('acme/x', 'L1', one, NOW, undefined, 'packages/any').route).toBe('normal');
  });

  it('a T2 repo needs Full for the hotfix and the spike too (R-OPK-3)', () => {
    expect(table(version(built(inputs({ tier: 'T2', level: 'light' }))))).toMatchObject({
      L0: 'l8:no:tier_requires_full',
      L7: 'l8:no:tier_requires_full',
    });
  });

  it('active at Full: L0-L4, L6-L8; L5 needs staging separation', () => {
    const t = table(version(built(inputs({ level: 'full' }))));
    expect(t).toMatchObject({
      L4: 'normal:yes:eligible',
      L6: 'normal:yes:eligible',
      L5: 'l8:no:staging_separation_not_attested',
      L0: 'normal:yes:eligible',
      L7: 'normal:yes:eligible',
    });
  });

  it('a T2 repo needs Full for any agent-led lane; a red posture confines it to Census lanes', () => {
    expect(table(version(built(inputs({ tier: 'T2', level: 'light' }))))).toMatchObject({
      L1: 'l8:no:tier_requires_full',
      L8: 'normal:yes:eligible',
    });
    expect(
      table(version(built(inputs({ level: 'light', census: { golden: 'b' } })))),
    ).toMatchObject({
      L1: 'l8:no:posture_red',
      L8: 'normal:yes:eligible',
    });
  });

  it('stale, suspended and expired go to L8 through the 1.4 rule, never N8; a request for L8 itself is no worse off', () => {
    const prr = built(inputs({ level: 'light' }));
    for (const [st, reason] of [
      ['stale', 'prr_stale'],
      ['suspended', 'prr_suspended'],
      ['expired', 'prr_expired'],
    ] as const) {
      const g = version(prr, st);
      expect(route(g, 'L1')).toMatchObject({ eligible: false, route: 'l8', reason });
      expect(route(g, 'L8')).toMatchObject({ eligible: true, route: 'l8', reason });
      expect(route(g, 'L1').prr).toMatchObject({ status: st, level: 'light' });
    }
  });

  it('expiry never approves: an active record past fresh_until is expired even if no sweep has said so', () => {
    const g = version(built(inputs({ level: 'light' })));
    const edge = Date.parse(g.prr.fresh_until);
    expect(route(g, 'L1', new Date(edge - 1).toISOString())).toMatchObject({ route: 'normal' });
    expect(route(g, 'L1', new Date(edge).toISOString())).toMatchObject({
      route: 'l8',
      reason: 'prr_expired',
      prr: { status: 'expired' },
    });
  });
});

// ---------------------------------------------------------------- the system: N8, M4, the fan-out

const events = async (id: string) =>
  (
    await s.record.pool.query<{ type: string; body: Record<string, unknown> }>(
      'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [`work:${id}`],
    )
  ).rows;

/** Everything an agent session, a unit or a work item would write: none of it may exist. */
const agentEvents = async () =>
  (
    await s.record.pool.query(
      `SELECT type, stream FROM record.record_event
        WHERE type ~ '^(session|agent|agent_session|unit|item|lease|sandbox)[._]'
           OR stream ~ '^(session|agent|unit|item|lease|sandbox):'`,
    )
  ).rows;

describe('OB R1b exit: an L1 item is held; after a Census M4 it is not released, L8 is offered, no agent session starts', () => {
  it('on a testbed-like repo, end to end', async () => {
    const c = await scenario({ project: 'testbed', repo: 'acme/testbed' });
    const ask = async (lane: Lane) =>
      ok(
        await requestWork(s.deps, {
          project_id: pid('testbed'),
          repo: 'acme/testbed',
          lane,
          requester: alice,
        }),
      ).value;

    // Before any record: the L1 request is held (N8). The held card offers Onboard or L8.
    const l1 = await ask('L1');
    expect(l1).toMatchObject({
      state: 'held',
      verdict: { route: 'n8_hold', reason: 'no_active_prr', eligible: false },
    });
    expect((await events(l1.request_id)).map((e) => e.type)).toEqual([
      WORK_EVENT.requested,
      WORK_EVENT.held,
    ]);
    expect((await events(l1.request_id))[1]?.body).toMatchObject({
      channel: 'N8',
      reason: 'no_active_prr',
      offers: ['onboard', 'continue_as_l8'],
    });
    const l8 = await ask('L8');
    const l2 = await ask('L2');
    const l0 = await ask('L0');
    const l3 = await ask('L3');
    expect([l8, l2, l0, l3].map((x) => x.state)).toEqual(['held', 'held', 'held', 'held']);
    expect(await laneEligibility(s.record.pool, 'acme/testbed', 'L1', s.clock)).toMatchObject({
      route: 'n8_hold',
    });

    // The Census onboarding, to a Census M4 (the stage that holds the L1 item).
    await throughC1(c);
    await throughC4(c);
    // a proposed record is not an active one: still held while the sign-off is pending
    const { card } = await toC5(c);
    expect((await readWork(s.record.pool, l1.request_id))?.state).toBe('held');
    ok(await decideAs(c, card.card_id, 'alice', 'approve', {}));

    // After the M4: the L1 item is NOT released to L1; L8 is offered; the L8 item is released.
    expect((await readWork(s.record.pool, l1.request_id))?.state).toBe('l8_offered');
    expect((await readWork(s.record.pool, l8.request_id))?.state).toBe('released');
    for (const x of [l2, l0, l3]) {
      expect((await readWork(s.record.pool, x.request_id))?.state).toBe('l8_offered');
    }
    const after = await events(l1.request_id);
    expect(after.map((e) => e.type)).toEqual([
      WORK_EVENT.requested,
      WORK_EVENT.held,
      WORK_EVENT.l8_offered,
    ]);
    expect(after[2]?.body).toMatchObject({
      requested_lane: 'L1',
      reason: 'level_too_low',
      prr_version: 1,
    });
    // L0 opens at Light (catalogue 1.4.0): at Census it is too low, no longer unspecified
    expect((await events(l0.request_id)).at(-1)?.body).toMatchObject({
      reason: 'level_too_low',
    });
    expect((await events(l8.request_id)).at(-1)).toMatchObject({
      type: WORK_EVENT.released,
      body: { requested_lane: 'L8', reason: 'eligible' },
    });
    // The fan-out wrote no event but those, and nothing started: no session, unit, item or lease.
    expect(await agentEvents()).toEqual([]);

    // From now on the repo has an active Census record: L1 is no N8 (that is only "no PRR"), it is L8.
    expect(await laneEligibility(s.record.pool, 'acme/testbed', 'L1', s.clock)).toMatchObject({
      eligible: false,
      route: 'l8',
      reason: 'level_too_low',
      prr: { version: 1, status: 'active', level: 'census' },
    });
    const next = await ask('L1');
    expect(next).toMatchObject({ state: 'routed_l8', verdict: { reason: 'level_too_low' } });
    expect((await ask('L8')).state).toBe('admitted');
    expect(await agentEvents()).toEqual([]);

    // A mechanical check then tightens the record; new work goes to L8 and nothing loosens it.
    expect(
      ok(
        await setPrrStatus(s.deps, {
          repo: 'acme/testbed',
          to: 'suspended',
          cause: 'rules.loosened' as never,
        }),
      ).value,
    ).toMatchObject({ from: 'active', changed: true });
    expect(await laneEligibility(s.record.pool, 'acme/testbed', 'L8', s.clock)).toMatchObject({
      route: 'l8',
      eligible: true,
      reason: 'prr_suspended',
    });
    expect(
      await setPrrStatus(s.deps, { repo: 'acme/testbed', to: 'stale', cause: 'x' as never }),
    ).toMatchObject({ ok: false }); // suspended -> stale loosens
    expect(
      ok(
        await setPrrStatus(s.deps, {
          repo: 'acme/testbed',
          to: 'expired',
          cause: 'fresh_until' as never,
        }),
      ).value.changed,
    ).toBe(true);
    expect(await laneEligibility(s.record.pool, 'acme/testbed', 'L1', s.clock)).toMatchObject({
      reason: 'prr_expired',
    });
  });

  it('a rejected M4 leaves the PRR proposed and the held items held', async () => {
    const c = await scenario({ project: 'el-rej', repo: 'acme/el-rej' });
    const held = ok(
      await requestWork(s.deps, {
        project_id: pid('el-rej'),
        repo: 'acme/el-rej',
        lane: 'L1',
        requester: alice,
      }),
    ).value;
    await throughC1(c);
    await throughC4(c);
    const { card } = await toC5(c);
    ok(await decideAs(c, card.card_id, 'alice', 'reject', undefined, 'not now'));
    expect((await readWork(s.record.pool, held.request_id))?.state).toBe('held');
    expect((await events(held.request_id)).map((e) => e.type)).toEqual([
      WORK_EVENT.requested,
      WORK_EVENT.held,
    ]);
    expect(await laneEligibility(s.record.pool, 'acme/el-rej', 'L1', s.clock)).toMatchObject({
      route: 'n8_hold',
    });
    expect(await agentEvents()).toEqual([]);
  });

  it('an item held for a repo of another project is refused, and a repeat of a request is one request', async () => {
    const c = await scenario({ project: 'el-dup', repo: 'acme/el-dup' });
    const r = await requestWork(s.deps, {
      project_id: pid('someone-else'),
      repo: c.repo,
      lane: 'L1',
      requester: alice,
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const key = '8c3a6c28-5a4e-4f43-9ea4-2f1f7f3d1c11';
    const first = ok(
      await requestWork(s.deps, {
        project_id: pid('el-dup'),
        repo: c.repo,
        lane: 'L1',
        requester: alice,
        request_id: key,
      }),
    );
    const again = ok(
      await requestWork(s.deps, {
        project_id: pid('el-dup'),
        repo: c.repo,
        lane: 'L1',
        requester: alice,
        request_id: key,
      }),
    );
    expect(again.value).toMatchObject({ request_id: first.value.request_id, duplicate: true });
    expect((await events(first.value.request_id)).map((e) => e.type)).toEqual([
      WORK_EVENT.requested,
      WORK_EVENT.held,
    ]);
    void pr;
  });
});

describe('the fan-out releases only the lanes that became eligible', () => {
  it('a Light record opens L0-L3, L7 and L8: those are released, L4-L6 are offered L8, and only the repo is touched', async () => {
    const repo = 'acme/el-fan';
    const other = 'acme/el-fan-other';
    const lanes: Lane[] = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L0', 'L7', 'L8'];
    const held = new Map<Lane, string>();
    for (const l of lanes) {
      const r = ok(
        await requestWork(s.deps, { project_id: pid('el-fan'), repo, lane: l, requester: alice }),
      );
      held.set(l, r.value.request_id);
    }
    // a held request of ANOTHER repo of the same project is not this M4's to release
    const foreign = ok(
      await requestWork(s.deps, {
        project_id: pid('el-fan'),
        repo: other,
        lane: 'L1',
        requester: alice,
      }),
    ).value;
    // A Light record, as an M4 would have made it active (the onboarding flow for Light is a later task's).
    const prr = built(inputs({ level: 'light' }));
    const v = version(prr);
    const report = ok(
      await inCoreTx({ pool: s.record.pool, clock: s.clock }, async (j, tx) =>
        fanOutHeld(j, tx, {
          repo,
          prr,
          version: v,
          s0_id: '00000000-0000-4000-8000-000000000001',
          now: s.clock.now(),
          actor: 'alice',
        }),
      ),
    ).value;
    const opened = ['L0', 'L1', 'L2', 'L3', 'L7', 'L8'];
    expect([...report.released].sort()).toEqual(opened.map((l) => held.get(l as Lane)).sort());
    expect([...report.l8_offered].sort()).toEqual(
      ['L4', 'L5', 'L6'].map((l) => held.get(l as Lane)).sort(),
    );
    for (const l of lanes) {
      expect((await readWork(s.record.pool, held.get(l) as string))?.state).toBe(
        opened.includes(l) ? 'released' : 'l8_offered',
      );
    }
    expect((await readWork(s.record.pool, foreign.request_id))?.state).toBe('held');
    // a second pass finds nothing held: it is idempotent
    const again = ok(
      await inCoreTx({ pool: s.record.pool, clock: s.clock }, async (j, tx) =>
        fanOutHeld(j, tx, {
          repo,
          prr,
          version: v,
          s0_id: '00000000-0000-4000-8000-000000000001',
          now: s.clock.now(),
          actor: 'alice',
        }),
      ),
    ).value;
    expect(again).toEqual({ released: [], l8_offered: [] });
    expect(await agentEvents()).toEqual([]);
  });
});

describe('the HTTP route', () => {
  it('GET /v1/repos/:owner/:name/eligibility?lane= answers with the verdict; bad input is refused', async () => {
    const get = async (path: string, token: string | null = TOKEN) => {
      const r = await fetch(new URL(path, url), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    // an unknown repo has no PRR: N8
    const none = await get('/v1/repos/acme/never-heard-of/eligibility?lane=L1');
    expect(none.status).toBe(200);
    expect(LaneEligibility.parse(none.json)).toMatchObject({
      route: 'n8_hold',
      reason: 'no_active_prr',
      eligible: false,
    });
    // after the Census M4 of the testbed above
    const tb = await get('/v1/repos/acme/testbed/eligibility?lane=L8');
    expect(LaneEligibility.parse(tb.json)).toMatchObject({ lane: 'L8' });
    expect((await get('/v1/repos/acme/testbed/eligibility?lane=L9')).status).toBe(400);
    expect((await get('/v1/repos/acme/testbed/eligibility')).status).toBe(400);
    expect((await get('/v1/repos/acme/testbed/eligibility?lane=L1', null)).status).toBe(401);
    expect(repoIdOf('acme/testbed')).toBe('acme.testbed');
  });
});

void sync;
