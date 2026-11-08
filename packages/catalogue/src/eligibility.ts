import { LaneValues, type Lane, type Level, type Tier } from '@aisdlc/contracts';
import type { Eligibility, EligibilityCatalogue } from './schema.js';

// Level -> lane eligibility (OB §2.1). L0 (hotfix) and L7 (spike) are `unspecified` at every level:
// "Not stated anywhere: whether L0 and L7 are allowed at each level" (OB §2.1, open item §13.3).
// Callers must treat `unspecified` as not eligible.

const row = (over: Partial<Record<Lane, Eligibility>>): Record<Lane, Eligibility> =>
  Object.fromEntries(LaneValues.map((l) => [l, over[l] ?? 'not_eligible'])) as Record<
    Lane,
    Eligibility
  >;

/**
 * Census unlocks S1-S5 planning plus L8 human-led. "Agent remediation chores are DEC-16": whether L2
 * runs at Census is undecided, so `unspecified`. Light adds L1-L3 (incl. L2 remediation). Full adds
 * L4-L6. Each level keeps what the lower one unlocked ("Adds").
 */
export const ELIGIBILITY: EligibilityCatalogue = {
  by_level: {
    census: row({ L0: 'unspecified', L2: 'unspecified', L7: 'unspecified', L8: 'eligible' }),
    light: row({
      L0: 'unspecified',
      L1: 'eligible',
      L2: 'eligible',
      L3: 'eligible',
      L7: 'unspecified',
      L8: 'eligible',
    }),
    full: row({
      L0: 'unspecified',
      L1: 'eligible',
      L2: 'eligible',
      L3: 'eligible',
      L4: 'eligible',
      L5: 'eligible',
      L6: 'eligible',
      L7: 'unspecified',
      L8: 'eligible',
    }),
  },
  lane_requires_floor: { L5: 'FF2' },
  tier_min_level: { T2: { level: 'full', lanes: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] } },
};

export type EligibilityContext = {
  readonly tier: Tier;
  /** `staging_separation: yes` attested (FF2), which L5 needs. */
  readonly stagingSeparationAttested: boolean;
};

/** The table row, with no context applied. */
export function laneEligibility(level: Level, lane: Lane): Eligibility {
  return ELIGIBILITY.by_level[level][lane];
}

/**
 * True only for an `eligible` row whose conditions hold. `unspecified` is not eligible. A T2 repo
 * needs Full for any agent-led lane; L5 also needs staging separation attested.
 */
export function isLaneEligible(level: Level, lane: Lane, ctx: EligibilityContext): boolean {
  if (laneEligibility(level, lane) !== 'eligible') return false;
  const min = ELIGIBILITY.tier_min_level[ctx.tier];
  if (min !== undefined && min.lanes.includes(lane) && level !== min.level) return false;
  if (ELIGIBILITY.lane_requires_floor[lane] === 'FF2' && !ctx.stagingSeparationAttested)
    return false;
  return true;
}

/** Lanes a project may run at a level and tier. */
export function eligibleLanes(level: Level, ctx: EligibilityContext): Lane[] {
  return LaneValues.filter((l) => isLaneEligible(level, l, ctx));
}
