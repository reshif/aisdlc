import { describe, expect, it } from 'vitest';
import {
  GATES,
  GateIdValues,
  LaneValues,
  ProjectToggleGroup,
  T2_GATING_FLOOR,
  gatingFloorViolations,
  type GateSwitch,
  type GatingProfile,
  type Lane,
} from '@aisdlc/contracts';
import { ALWAYS_REQUIRED_GATES, CATALOGUE, GATING, LANES, gatesOff } from '../src/index.js';

const GROUPS = ProjectToggleGroup.options;

/** Every on/off assignment of the six toggle groups (64 profiles). */
function allProfiles(): GatingProfile[] {
  const out: GatingProfile[] = [];
  for (let mask = 0; mask < 1 << GROUPS.length; mask++) {
    const gates = Object.fromEntries(
      GROUPS.map((g, i) => [g, (mask >> i) & 1 ? 'off' : 'on']),
    ) as Record<(typeof GROUPS)[number], GateSwitch>;
    out.push({ gates, schedule: 'auto', tier_floor_applied: false });
  }
  return out;
}

describe('gating profile lint', () => {
  it('the always-required set is the one in contracts, and is not empty', () => {
    expect([...ALWAYS_REQUIRED_GATES].sort()).toEqual(
      GateIdValues.filter((g) => GATES[g].alwaysRequired).sort(),
    );
    expect(GATING.always_required).toEqual([...ALWAYS_REQUIRED_GATES]);
    expect(ALWAYS_REQUIRED_GATES).toEqual(
      expect.arrayContaining(['G4', 'X1', 'X2', 'X3', 'M4', 'Q1']),
    );
  });

  it('no gating profile can disable an always-required gate, in any lane', () => {
    for (const profile of allProfiles()) {
      for (const lane of [undefined, ...LaneValues] as (Lane | undefined)[]) {
        const off = gatesOff(profile, lane);
        for (const g of ALWAYS_REQUIRED_GATES) expect(off, `${g} off`).not.toContain(g);
      }
    }
    // ...even with every per-lane override off as well.
    const allOff: GatingProfile = {
      gates: Object.fromEntries(GROUPS.map((g) => [g, 'off'])) as GatingProfile['gates'],
      schedule: 'auto',
      tier_floor_applied: false,
      by_lane: Object.fromEntries(
        LaneValues.map((l) => [l, Object.fromEntries(GROUPS.map((g) => [g, 'off']))]),
      ),
    };
    for (const lane of LaneValues) {
      for (const g of ALWAYS_REQUIRED_GATES) expect(gatesOff(allOff, lane)).not.toContain(g);
    }
  });

  it('no toggle group reaches an always-required gate', () => {
    for (const g of GateIdValues) {
      if (GATES[g].alwaysRequired) expect(GATES[g].projectToggle, g).toBeNull();
    }
    expect(Object.keys(GATING.defaults).sort()).toEqual([...GROUPS].sort());
  });

  it('turning a group off removes exactly its gates; G0+G1 and G3+G3s go together', () => {
    const base = allProfiles()[0] as GatingProfile;
    const off = (g: (typeof GROUPS)[number]) =>
      gatesOff({ ...base, gates: { ...base.gates, [g]: 'off' } });
    expect(off('g0g1')).toEqual(['G0', 'G1']);
    expect(off('g3_g3s')).toEqual(['G3', 'G3s']);
    expect(off('g2')).toEqual(['G2']);
    expect(off('g3d')).toEqual(['G3d']);
    expect(off('g5')).toEqual(['G5']);
    expect(off('g6')).toEqual(['G6']);
    expect(gatesOff(base)).toEqual([]);
  });

  it('T2 floor: G2, G3d, G3(+G3s) for L4-L6 and G5 where it deploys', () => {
    expect(GATING.t2_floor).toEqual({
      lanes: ['L4', 'L5', 'L6'],
      groups: ['g2', 'g3d', 'g3_g3s'],
      deploy_group: 'g5',
    });
    expect(CATALOGUE.gating.t2_floor.groups).toEqual([...T2_GATING_FLOOR.groups]);
    const floor = new Set<string>(T2_GATING_FLOOR.groups);
    for (const profile of allProfiles()) {
      for (const deploys of [true, false, null]) {
        const expected =
          [...floor].some((g) => profile.gates[g as (typeof GROUPS)[number]] === 'off') ||
          (profile.gates.g5 === 'off' && deploys !== false);
        const v = gatingFloorViolations(profile, { tier: 'T2', deploys });
        expect(v.length > 0, JSON.stringify([profile.gates, deploys])).toBe(expected);
        // T0 and T1 may turn any of it off.
        expect(gatingFloorViolations(profile, { tier: 'T1', deploys })).toEqual([]);
        expect(gatingFloorViolations(profile, { tier: 'T0', deploys })).toEqual([]);
      }
    }
  });

  it('every lane in the T2 floor has the gates the floor protects (so the floor binds)', () => {
    const gateOf = (group: (typeof GROUPS)[number]) =>
      GateIdValues.filter((g) => GATES[g].projectToggle === group);
    for (const lane of T2_GATING_FLOOR.lanes) {
      const have = LANES[lane].gates.map((g) => g.gate);
      for (const group of T2_GATING_FLOOR.groups) {
        for (const g of gateOf(group)) expect(have, `${lane} ${g}`).toContain(g);
      }
    }
  });

  it('defaults follow OB 1C: G2/G3d/G3 on for L4-L6, G2 off for L1-L3, G5 on if it deploys, 5.7 automatic', () => {
    const d = GATING.defaults;
    expect(d.g0g1).toMatchObject({ kind: 'fixed', value: 'on' });
    expect(d.g2).toEqual({
      kind: 'by_lane',
      lanes: { L1: 'off', L2: 'off', L3: 'off', L4: 'on', L5: 'on', L6: 'on' },
    });
    expect(d.g3d).toEqual({ kind: 'by_lane', lanes: { L4: 'on', L5: 'on', L6: 'on' } });
    expect(d.g3_g3s).toEqual({ kind: 'by_lane', lanes: { L4: 'on', L5: 'on', L6: 'on' } });
    expect(d.g5).toEqual({ kind: 'by_deploys', deploys: 'on', otherwise: 'off' });
    expect(d.g6).toMatchObject({ kind: 'fixed', value: 'on', exceptions: [{ value: 'off' }] });
    expect(GATING.schedule_default).toBe('auto');
    expect(GATING.human_schedule).toBe('opt_in');
  });

  it('the defaults themselves satisfy the T2 floor', () => {
    const profile: GatingProfile = {
      gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
      schedule: GATING.schedule_default,
      tier_floor_applied: true,
    };
    expect(gatingFloorViolations(profile, { tier: 'T2', deploys: true })).toEqual([]);
    for (const [g, def] of Object.entries(GATING.defaults)) {
      if (def.kind !== 'by_lane') continue;
      for (const lane of T2_GATING_FLOOR.lanes) {
        if ((T2_GATING_FLOOR.groups as readonly string[]).includes(g)) {
          expect(def.lanes[lane], `${g} ${lane}`).toBe('on');
        }
      }
    }
  });
});
