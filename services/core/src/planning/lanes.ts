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

/** What 1.3's classifier said about the work (the facts of its output; it names no lane). */
export interface WorkClassification {
  readonly work_type: 'hotfix' | 'remediation' | 'change' | 'initiative' | 'spike';
  readonly size: 'small' | 'standard';
  readonly risk: 'standard' | 'elevated';
}

/** The catalogue lane label each labelled work type belongs to (`LANE_LABELS`: L0 hotfix ... L8 human-led). */
const LABEL_OF: Readonly<Record<WorkClassification['work_type'], string | null>> = {
  hotfix: 'hotfix',
  remediation: 'remediation',
  initiative: 'initiative',
  spike: 'spike',
  change: null,
};

/**
 * The lane the FACTORY proposes for a classification (1.3; the classifier has no field that names a lane).
 * Derived from the catalogue's own shape, nothing re-listed here:
 *   - hotfix, remediation, initiative and spike go to the lane the catalogue labels so;
 *   - an ordinary change goes to one of the lanes with no label that a request can enter (not a lane that
 *     only a follow-up reaches: L1 is the hotfix's), ordered by how much planning they carry
 *     (`planningDepth`): a small change of standard risk to the deepest of the shallow group, a change of
 *     standard size to the first of the deep group, and elevated risk to the last of the deep group (a
 *     small elevated change is a standard one). Human-led L8 is never chosen: eligibility routes there.
 * `null` when the catalogue has no such lane (the caller keeps the lane the request came in with). G0 binds
 * the lane, 1.4 checks the project may run it.
 */
export function laneForClassification(
  cat: CatalogueData,
  profile: PrrGatingProfile,
  tier: Tier,
  c: WorkClassification,
): Lane | null {
  const lanes = Object.values(cat.lanes);
  const label = LABEL_OF[c.work_type];
  if (label !== null) return lanes.find((l) => l.label === label)?.id ?? null;
  const followUps = new Set(lanes.flatMap((l) => (l.follow_up ? [l.follow_up.lane] : [])));
  const pool = lanes
    .filter((l) => l.label === null && l.enter_at !== null && !followUps.has(l.id))
    .map((l) => ({ id: l.id, depth: planningDepth(cat, profile, tier, l.id) }))
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  if (pool.length === 0) return null;
  const depths = [...new Set(pool.map((p) => p.depth))];
  const shallow = pool.filter((p) => p.depth === depths[0]);
  const deep = pool.filter((p) => p.depth === depths[depths.length - 1]);
  const pick = (g: typeof pool, at: 'first' | 'last') =>
    (at === 'first' ? g[0] : g[g.length - 1])?.id ?? null;
  if (depths.length === 1) return pick(pool, c.risk === 'elevated' ? 'last' : 'first');
  if (c.size === 'small' && c.risk === 'standard') return pick(shallow, 'last');
  if (c.risk === 'elevated' && c.size === 'standard') return pick(deep, 'last');
  return pick(deep, 'first');
}
