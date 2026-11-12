import {
  CATALOGUE,
  catalogueFor,
  currentCatalogueRef,
  releasedCatalogues,
  type CatalogueData,
} from '@aisdlc/catalogue';
import type { CatalogueRef } from '@aisdlc/contracts';
import {
  FloorPlan,
  GateIdValues,
  LaneValues,
  STEPS,
  type GateId,
  type Lane,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  FLOOR_TITLE_MAX,
  buildRoute,
  effectiveProfile,
  floorPlanOf,
  floorPositionOf,
  floorStageOf,
  floorTitleOf,
  presentGates,
} from '../src/index.js';
import { forStep, gateNeeded, newSim } from './scen.js';
import { PROFILE_ALL_OFF, PROFILE_ALL_ON } from './sim.js';

// The floor (PLAN M19, DM gap 12): the plan and an item's place are generated from the catalogue's route, never from
// a hand-written lane list. These tests enumerate every lane of the catalogue (and every released snapshot) and hold
// the floor's stations and gates to the catalogue's own definition of the lane.

const lanesOf = (cat: CatalogueData = CATALOGUE): Lane[] =>
  LaneValues.filter((l) => cat.lanes[l] !== undefined);

/** What the catalogue says a lane's floor stations are: every stage it runs (L8's unspecified S2-S6 are the developer's, drawn at S6). */
function catalogueStations(cat: CatalogueData, lane: Lane): string[] {
  const out: string[] = [];
  for (const ls of cat.lanes[lane].stages) {
    if (ls.stage === 'S0' || ls.mode === 'skipped') continue;
    const st =
      ls.mode === 'unspecified' && ['S2', 'S3', 'S4', 'S5', 'S6'].includes(ls.stage)
        ? 'S6'
        : floorStageOf(ls.stage);
    if (st !== null && !out.includes(st)) out.push(st);
  }
  return out;
}

/** What the catalogue says a lane's floor gates are under a profile: present, not conditional. */
function catalogueGates(cat: CatalogueData, lane: Lane, profile: unknown): GateId[] {
  const present = presentGates(cat.lanes[lane], effectiveProfile(profile, 'T0'));
  const def = cat.lanes[lane];
  // a gate at a stage the lane leaves to a developer (L8) is not on the agent route
  const human = new Set(
    def.stages.filter((s) => s.mode === 'unspecified').map((s) => s.stage as string),
  );
  return GateIdValues.filter(
    (g) =>
      present.has(g) &&
      def.gates.some(
        (p) => p.gate === g && p.presence !== 'conditional' && !human.has(STEPS[p.step].stage),
      ),
  );
}

describe('the floor plan is generated from the catalogue (DM gap 12)', () => {
  const cases: Array<[string, CatalogueRef, CatalogueData]> = [
    ['current', currentCatalogueRef(), CATALOGUE],
    ...releasedCatalogues().map((ref): [string, CatalogueRef, CatalogueData] => {
      const c = catalogueFor(ref);
      if (!c.ok) throw new Error(`released catalogue ${ref.version} is not carried`);
      return [ref.version, ref, c.value];
    }),
  ];
  for (const [name, ref, cat] of cases) {
    it(`catalogue ${name}: one route per lane, its stations and gates exactly the catalogue's`, () => {
      const plan = FloorPlan.parse(floorPlanOf(cat, ref));
      expect(plan.catalogue).toEqual(ref);
      expect(plan.lanes.map((l) => l.lane)).toEqual(lanesOf(cat));
      const gateKeys = new Set(plan.gates.map((g) => g.key));
      for (const r of plan.lanes) {
        const stations = r.route.filter((k) => (plan.stations as string[]).includes(k));
        const gates = r.route.filter((k) => !(plan.stations as string[]).includes(k));
        // every key of a route is a station or a gate position of the plan
        for (const g of gates) expect(gateKeys.has(g), `${r.lane}: ${g}`).toBe(true);
        expect([...new Set(stations)], r.lane).toEqual(catalogueStations(cat, r.lane));
        expect(gates.flatMap((k) => k.split('+')).sort(), r.lane).toEqual(
          catalogueGates(cat, r.lane, PROFILE_ALL_ON).sort(),
        );
        expect(r.human_led, r.lane).toBe(
          cat.lanes[r.lane].stages.some((s) => s.mode === 'unspecified'),
        );
      }
      // a gate position sits after the station of the step the catalogue puts it at
      for (const g of plan.gates)
        expect(g.after_stage).toBe(floorStageOf(STEPS[g.after_step].stage));
    });
  }

  it('a profile that turns gates off removes them from the routes, never the stations', () => {
    const on = floorPlanOf(CATALOGUE, currentCatalogueRef(), PROFILE_ALL_ON);
    const off = floorPlanOf(CATALOGUE, currentCatalogueRef(), PROFILE_ALL_OFF);
    for (const lane of lanesOf()) {
      const a = on.lanes.find((l) => l.lane === lane)!;
      const b = off.lanes.find((l) => l.lane === lane)!;
      const st = (r: string[]) => [...new Set(r.filter((k) => /^S\d$/.test(k)))];
      expect(st(b.route), lane).toEqual(st(a.route));
      expect(
        b.route
          .filter((k) => !/^S\d$/.test(k))
          .flatMap((k) => k.split('+'))
          .sort(),
        lane,
      ).toEqual(catalogueGates(CATALOGUE, lane, PROFILE_ALL_OFF).sort());
    }
  });

  it('matches the interpreter: the route keys follow buildRoute station by station', () => {
    for (const lane of lanesOf()) {
      const route = buildRoute(CATALOGUE.lanes[lane], effectiveProfile(PROFILE_ALL_ON, 'T0'));
      const plan = floorPlanOf(CATALOGUE, currentCatalogueRef()).lanes.find(
        (l) => l.lane === lane,
      )!;
      const gateKeys = route.flatMap((s) => (s.kind === 'gates' ? [s.gates.join('+')] : []));
      expect(
        plan.route.filter((k) => !/^S\d$/.test(k)),
        lane,
      ).toEqual(gateKeys);
    }
  });
});

describe('an item on the floor', () => {
  it('waits at its first gate position with the gate instances, then works at the next station', () => {
    const s = newSim('floor-gates', { lane: 'L4' }).run({ decide: () => 'pending' });
    const p = floorPositionOf(s.state, CATALOGUE);
    expect(p.node).toEqual({ kind: 'gate', key: 'G0+G1' });
    expect(p.status).toBe('waiting');
    expect(p.stage).toBe('S1');
    expect(p.waiting_gates.map((g) => g.gate)).toEqual(['G0', 'G1']);
    expect(p.route[0]).toBe('S1');
  });

  it('leaves its pod for the holding shelf in HUMAN-WAIT (X1 in S6)', () => {
    const s = newSim('floor-x1', { lane: 'L3' }).run({
      script: forStep('6.4', [gateNeeded('X1')]),
      decide: (g) => (g === 'X1' ? 'pending' : 'approve'),
    });
    const p = floorPositionOf(s.state, CATALOGUE);
    expect(p.node).toEqual({ kind: 'room', room: 'HOLD' });
    expect(p.stage).toBe('S6');
    expect(p.waiting_gates.map((g) => g.gate)).toEqual(['X1']);
  });

  it('ends in Done', () => {
    const s = newSim('floor-done', { lane: 'L1' }).run();
    expect(s.state.terminal).toBe('Done');
    const p = floorPositionOf(s.state, CATALOGUE);
    expect(p).toMatchObject({ node: { kind: 'room', room: 'DONE' }, status: 'done', stage: null });
  });
});

describe('the title', () => {
  it('is the first non-empty line, cut to the maximum, and never a line the secret ruleset hits', () => {
    expect(floorTitleOf('\n  Export invoices as CSV  \nmore text')).toBe('Export invoices as CSV');
    const long = floorTitleOf('x'.repeat(200));
    expect(long).toHaveLength(FLOOR_TITLE_MAX);
    expect(long?.endsWith('…')).toBe(true);
    expect(floorTitleOf(null)).toBeNull();
    expect(floorTitleOf('   \n  ')).toBeNull();
    const key = ['AKIA', 'IOSFODNN7EXAMPLQ'].join('');
    expect(floorTitleOf(`use key ${key} to deploy`)).toBeNull();
  });
});
