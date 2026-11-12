import { LaneValues, type Lane, type Level, type Tier } from '@aisdlc/contracts';
import type { Eligibility, EligibilityCatalogue } from './schema.js';

// Level -> lane eligibility (OB §2.1). OB §2.1 leaves L0 (hotfix) and L7 (spike) open (§13.3); the
// user decided it (PLAN §7a, "L0, L7 eligibility"): L0 from Light, L7 from Census. Catalogue 1.3.0 and
// earlier carry them `unspecified` at every level, and an item pinned to one keeps that rule (1.4.0
// released the decision). Callers must treat `unspecified` as not eligible.

const row = (over: Partial<Record<Lane, Eligibility>>): Record<Lane, Eligibility> =>
  Object.fromEntries(LaneValues.map((l) => [l, over[l] ?? 'not_eligible'])) as Record<
    Lane,
    Eligibility
  >;

/**
 * Census unlocks S1-S5 planning, L7 spikes and L8 human-led. "Agent remediation chores are DEC-16":
 * whether L2 runs at Census is undecided, so `unspecified`. Light adds L0 hotfixes and L1-L3 (incl.
 * L2 remediation). Full adds L4-L6. Each level keeps what the lower one unlocked ("Adds"). A T2 repo
 * still needs Full for every agent-led lane, L0 and L7 among them (R-OPK-3).
 */
export const ELIGIBILITY: EligibilityCatalogue = {
  by_level: {
    census: row({ L2: 'unspecified', L7: 'eligible', L8: 'eligible' }),
    light: row({
      L0: 'eligible',
      L1: 'eligible',
      L2: 'eligible',
      L3: 'eligible',
      L7: 'eligible',
      L8: 'eligible',
    }),
    full: row({
      L0: 'eligible',
      L1: 'eligible',
      L2: 'eligible',
      L3: 'eligible',
      L4: 'eligible',
      L5: 'eligible',
      L6: 'eligible',
      L7: 'eligible',
      L8: 'eligible',
    }),
  },
  lane_requires_floor: { L5: 'FF2' },
  tier_min_level: {
    T2: { level: 'full', lanes: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] },
  },
};

export type EligibilityContext = {
  readonly tier: Tier;
  /** `staging_separation: yes` attested (FF2), which L5 needs. */
  readonly stagingSeparationAttested: boolean;
};

/** The table row, with no context applied. */
export function laneEligibility(
  level: Level,
  lane: Lane,
  table: EligibilityCatalogue = ELIGIBILITY,
): Eligibility {
  return table.by_level[level][lane];
}

/**
 * True only for an `eligible` row whose conditions hold. `unspecified` is not eligible. A T2 repo
 * needs Full for any agent-led lane; L5 also needs staging separation attested.
 */
export function isLaneEligible(
  level: Level,
  lane: Lane,
  ctx: EligibilityContext,
  table: EligibilityCatalogue = ELIGIBILITY,
): boolean {
  if (laneEligibility(level, lane, table) !== 'eligible') return false;
  const min = table.tier_min_level[ctx.tier];
  if (min !== undefined && min.lanes.includes(lane) && level !== min.level) return false;
  if (table.lane_requires_floor[lane] === 'FF2' && !ctx.stagingSeparationAttested) return false;
  return true;
}

/** Lanes a project may run at a level and tier. */
export function eligibleLanes(
  level: Level,
  ctx: EligibilityContext,
  table: EligibilityCatalogue = ELIGIBILITY,
): Lane[] {
  return LaneValues.filter((l) => isLaneEligible(level, l, ctx, table));
}
