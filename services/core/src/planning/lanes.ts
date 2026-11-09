import type { CatalogueData } from '@aisdlc/catalogue';
import type { Lane, PrrGatingProfile, Tier } from '@aisdlc/contracts';
import { buildRoute, effectiveProfile } from '@aisdlc/work';

// The ladder R2 walks down (L0..L6; a spike L7 and a human-led L8 are neither up nor down from the rest).
const LADDER: readonly Lane[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
const PLANNING_PHASES = ['S2', 'S3', 'S4', 'S5'];

/** How much planning a lane carries under a profile: its stations in S2 to S5 (what R2 and R1 compare). */
export function planningDepth(
  cat: CatalogueData,
  profile: PrrGatingProfile,
  tier: Tier,
  lane: Lane,
): number {
  return buildRoute(cat.lanes[lane], effectiveProfile(profile, tier)).filter(
    (st) => st.kind !== 'marker' && PLANNING_PHASES.includes(st.phase),
  ).length;
}

/** The nearest lane below `from` that carries less planning, or `null` (an L0, a lane off the ladder, nothing shallower). */
export function shallowerLane(
  cat: CatalogueData,
  profile: PrrGatingProfile,
  tier: Tier,
  from: Lane,
): Lane | null {
  const i = LADDER.indexOf(from);
  if (i <= 0) return null;
  const here = planningDepth(cat, profile, tier, from);
  for (let j = i - 1; j >= 0; j -= 1) {
    const lane = LADDER[j] as Lane;
    if (planningDepth(cat, profile, tier, lane) < here) return lane;
  }
  return null;
}
