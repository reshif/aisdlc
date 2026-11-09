import { CATALOGUE } from '@aisdlc/catalogue';
import {
  GATES,
  GateIdValues,
  LaneValues,
  WORK_ITEM_TRANSITIONS,
  type Lane,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  HUMAN_GATE_STEPS,
  buildRoute,
  effectiveProfile,
  gateSetOf,
  presentGates,
} from '../src/index.js';
import { PROFILE_ALL_OFF, PROFILE_ALL_ON } from './sim.js';

const gatesOf = (lane: Lane, p = PROFILE_ALL_ON) =>
  buildRoute(CATALOGUE.lanes[lane], effectiveProfile(p, 'T1')).flatMap((s) =>
    s.kind === 'gates' ? s.gates : [],
  );

describe('the route of a lane is the catalogue intersected with the pinned profile', () => {
  it('has every legal phase transition, for every lane and both extreme profiles', () => {
    for (const lane of LaneValues) {
      for (const p of [PROFILE_ALL_ON, PROFILE_ALL_OFF]) {
        const route = buildRoute(CATALOGUE.lanes[lane], effectiveProfile(p, 'T1'));
        let prev = 'S1';
        for (const st of route) {
          if (st.phase !== prev) {
            expect(
              WORK_ITEM_TRANSITIONS[prev as 'S1'],
              `${lane}: ${prev} -> ${st.phase}`,
            ).toContain(st.phase);
          }
          prev = st.phase;
        }
        // The last phase of a route can end the item.
        expect(WORK_ITEM_TRANSITIONS[prev as 'S1'], `${lane}: ${prev} -> Done`).toContain('Done');
      }
    }
  });

  it('an off gate is ABSENT from the route and its human step with it', () => {
    const on = gatesOf('L4');
    expect(on).toEqual(
      expect.arrayContaining(['G0', 'G1', 'G2', 'G3d', 'G3', 'G3s', 'G4', 'G5', 'G6']),
    );
    const off = gatesOf('L4', PROFILE_ALL_OFF);
    expect(off).toEqual(['G4']);
    const steps = buildRoute(CATALOGUE.lanes.L4, effectiveProfile(PROFILE_ALL_OFF, 'T1')).flatMap(
      (s) => (s.kind === 'step' ? [s.step] : []),
    );
    for (const gated of Object.keys(HUMAN_GATE_STEPS)) expect(steps).not.toContain(gated);
  });

  it('a lane override of the profile turns a gate off for that lane only', () => {
    const p = { ...PROFILE_ALL_ON, by_lane: { L4: { g2: 'off' as const } } };
    expect(gatesOf('L4', p)).not.toContain('G2');
    expect(gatesOf('L5', p)).toContain('G2');
  });

  it('the always-required gates are in every route that has them, whatever the profile says', () => {
    const always = CATALOGUE.gating.always_required;
    expect(always).toContain('G4');
    for (const lane of LaneValues) {
      const def = CATALOGUE.lanes[lane];
      for (const p of [PROFILE_ALL_OFF, PROFILE_ALL_ON]) {
        const present = presentGates(def, effectiveProfile(p, 'T1'));
        for (const g of def.profile.mandatory_gates)
          expect(present.has(g), `${lane} ${g}`).toBe(true);
        // A gate with no toggle group can never be off.
        for (const pos of def.gates) {
          if (GATES[pos.gate].projectToggle === null && pos.presence === 'required') {
            expect(present.has(pos.gate), `${lane} ${pos.gate}`).toBe(true);
          }
        }
      }
    }
    // L7 never reaches G4 (FIX 6): its profile says so, and the engine does not invent it.
    expect(gatesOf('L7')).not.toContain('G4');
    expect(gatesOf('L7', PROFILE_ALL_OFF)).toEqual([]);
    expect(gatesOf('L0', PROFILE_ALL_OFF)).toEqual(['G4']);
  });

  it('no toggle group exists for an always-required gate, so a profile cannot name one', () => {
    for (const g of CATALOGUE.gating.always_required) expect(GATES[g].projectToggle).toBeNull();
    expect(
      GateIdValues.filter((g) => GATES[g].projectToggle !== null).every(
        (g) => !CATALOGUE.gating.always_required.includes(g),
      ),
    ).toBe(true);
  });

  it('the T2 floor overrides a profile that turns off G2, G3d, G3 on L4-L6 or G5 where it deploys', () => {
    const t2 = effectiveProfile({ ...PROFILE_ALL_OFF, project_deploys: true }, 'T2');
    for (const lane of ['L4', 'L5', 'L6'] as const) {
      const g = gateSetOf(CATALOGUE.lanes[lane], t2);
      expect(g).toEqual(expect.arrayContaining(['G2', 'G3d', 'G3', 'G3s', 'G5']));
      expect(g).not.toContain('G6'); // G6 is not part of the floor
    }
    // L1-L3 are not in the floor: T2 may turn G2 off there.
    expect(gateSetOf(CATALOGUE.lanes.L2, t2)).not.toContain('G2');
    // T1 keeps its choice.
    expect(gateSetOf(CATALOGUE.lanes.L4, effectiveProfile(PROFILE_ALL_OFF, 'T1'))).toEqual(['G4']);
  });

  it('an unreadable pinned profile is every toggle on: more decisions, never fewer', () => {
    const p = effectiveProfile({ nonsense: true }, 'T1');
    expect(gateSetOf(CATALOGUE.lanes.L4, p)).toEqual(
      expect.arrayContaining(['G0', 'G1', 'G2', 'G3d', 'G3', 'G3s', 'G4', 'G5', 'G6']),
    );
  });

  it('G0 and G1 are one station, and G3 with G3s', () => {
    const route = buildRoute(CATALOGUE.lanes.L4, effectiveProfile(PROFILE_ALL_ON, 'T1'));
    const stations = route.flatMap((s) => (s.kind === 'gates' ? [s.gates.join('+')] : []));
    expect(stations).toEqual(['G0+G1', 'G2', 'G3d', 'G3+G3s', 'G4', 'G5', 'G6']);
  });

  it('human scheduling is a station only when the profile opted in; 9.5 is never one', () => {
    const steps = (schedule: 'auto' | 'human') =>
      buildRoute(
        CATALOGUE.lanes.L4,
        effectiveProfile({ ...PROFILE_ALL_ON, schedule }, 'T1'),
      ).flatMap((s) => (s.kind === 'human' ? [s.step] : []));
    expect(steps('auto')).toEqual(['1.6', '8.2']);
    expect(steps('human')).toEqual(['1.6', '5.7', '8.2']);
  });
});
