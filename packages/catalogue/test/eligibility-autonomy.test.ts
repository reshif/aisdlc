import { describe, expect, it } from 'vitest';
import { LaneValues, LevelValues, TierValues, type Lane, type Level } from '@aisdlc/contracts';
import {
  AUTONOMY,
  ELIGIBILITY,
  effectiveAutonomy,
  eligibleLanes,
  isLaneEligible,
  laneEligibility,
  readinessCap,
} from '../src/index.js';

const ctx = (tier: 'T0' | 'T1' | 'T2' = 'T1', staging = true) => ({
  tier,
  stagingSeparationAttested: staging,
});

describe('level to lane eligibility (OB 2.1)', () => {
  it('has a row for every level and lane', () => {
    for (const level of LevelValues) {
      expect(Object.keys(ELIGIBILITY.by_level[level]).sort()).toEqual([...LaneValues].sort());
    }
  });

  it('marks L0 and L7 unspecified at every level, and callers get "not eligible"', () => {
    for (const level of LevelValues) {
      for (const lane of ['L0', 'L7'] as const) {
        expect(laneEligibility(level, lane)).toBe('unspecified');
        for (const tier of TierValues) expect(isLaneEligible(level, lane, ctx(tier))).toBe(false);
      }
    }
  });

  it('Census unlocks only L8 human-led; L2 at Census is undecided (DEC-16)', () => {
    expect(eligibleLanes('census', ctx())).toEqual(['L8']);
    expect(laneEligibility('census', 'L2')).toBe('unspecified');
    for (const l of ['L1', 'L3', 'L4', 'L5', 'L6'] as const)
      expect(laneEligibility('census', l)).toBe('not_eligible');
  });

  it('Light adds L1-L3; Full adds L4-L6', () => {
    expect(eligibleLanes('light', ctx())).toEqual(['L1', 'L2', 'L3', 'L8']);
    expect(eligibleLanes('full', ctx())).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L8']);
  });

  it('each level keeps what the lower one unlocked', () => {
    const rank = (level: Level) => LevelValues.indexOf(level);
    for (const lane of LaneValues) {
      for (const lo of LevelValues) {
        for (const hi of LevelValues) {
          if (rank(lo) < rank(hi) && ELIGIBILITY.by_level[lo][lane] === 'eligible') {
            expect(ELIGIBILITY.by_level[hi][lane], `${lane} ${lo}->${hi}`).toBe('eligible');
          }
        }
      }
    }
  });

  it('L5 also needs staging separation attested', () => {
    expect(isLaneEligible('full', 'L5', ctx('T1', false))).toBe(false);
    expect(isLaneEligible('full', 'L5', ctx('T1', true))).toBe(true);
    expect(isLaneEligible('full', 'L4', ctx('T1', false))).toBe(true);
  });

  it('every T2 repo needs Full for any agent-led lane', () => {
    for (const lane of ['L1', 'L2', 'L3'] as Lane[]) {
      expect(isLaneEligible('light', lane, ctx('T2'))).toBe(false);
      expect(isLaneEligible('full', lane, ctx('T2'))).toBe(true);
    }
    expect(isLaneEligible('light', 'L1', ctx('T1'))).toBe(true);
    expect(isLaneEligible('census', 'L8', ctx('T2'))).toBe(true);
  });
});

describe('autonomy caps (OB 2.3)', () => {
  it('has the caps of the table', () => {
    expect(AUTONOMY.tier).toEqual({ T0: 'A3', T1: 'A3', T2: 'A2' });
    expect(AUTONOMY.level.census).toBe('A0');
    expect(AUTONOMY.level.light).toBeNull();
    expect(AUTONOMY.readiness).toEqual({ RL0: null, RL1: 'A0', RL2: 'A1', RL3: 'A2', RL4: 'A3' });
    expect(AUTONOMY.posture.red).toEqual({ cap: 'A0', census_lanes_only: true, g4_mode_c: false });
    expect(AUTONOMY.posture.amber).toEqual({
      cap: 'A1',
      census_lanes_only: false,
      g4_mode_c: true,
    });
    expect(AUTONOMY.posture.green.cap).toBeNull();
    expect(AUTONOMY.probation).toMatchObject({ cap: 'A1', ends_by: 'governance_earn_rule' });
    expect(AUTONOMY.probation.min_weeks.value).toBe(4);
    expect(AUTONOMY.automatic_changes).toBe('tighten_only');
    expect(AUTONOMY.loosening).toBe('human_only');
  });

  it('readiness cap follows RL1..RL4+ and is unstated at 0', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(readinessCap)).toEqual([
      null,
      'A0',
      'A1',
      'A2',
      'A3',
      'A3',
      'A3',
    ]);
  });

  const base = {
    tier: 'T0',
    level: 'full',
    readiness: 4,
    posture: 'green',
    onProbation: false,
  } as const;
  it('effective autonomy is the min of the caps', () => {
    expect(effectiveAutonomy(base)).toBe('A3');
    expect(effectiveAutonomy({ ...base, tier: 'T2' })).toBe('A2');
    expect(effectiveAutonomy({ ...base, level: 'census' })).toBe('A0');
    expect(effectiveAutonomy({ ...base, readiness: 2 })).toBe('A1');
    expect(effectiveAutonomy({ ...base, posture: 'amber' })).toBe('A1');
    expect(effectiveAutonomy({ ...base, posture: 'red' })).toBe('A0');
    expect(effectiveAutonomy({ ...base, onProbation: true })).toBe('A1');
    expect(effectiveAutonomy({ ...base, earned: 'A2' })).toBe('A2');
    expect(
      effectiveAutonomy({ ...base, tier: 'T2', readiness: 3, posture: 'amber', onProbation: true }),
    ).toBe('A1');
  });

  it('fails closed on a readiness level the spec does not state', () => {
    expect(effectiveAutonomy({ ...base, readiness: 0 })).toBe('A0');
  });
});
