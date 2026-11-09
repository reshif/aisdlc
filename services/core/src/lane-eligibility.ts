import {
  ELIGIBILITY,
  isLaneEligible,
  laneEligibility as tableOf,
  type EligibilityCatalogue,
} from '@aisdlc/catalogue';
import {
  type EligibilityReason,
  type Lane,
  type LaneEligibility,
  type ReadinessStatus,
} from '@aisdlc/contracts';
import type { Clock } from '@aisdlc/kernel';
import { systemClock } from '@aisdlc/kernel';
import type { Executor } from '@aisdlc/record';
import type { PrrVersion } from './fold.js';
import { readGoverning } from './prr-store.js';

// The eligibility producer (PLAN M7.6; DEC-8; OB "N8 and L8 routing"): `eligibility(repo, lane)`
// says whether a lane runs for a repo and where a request for it goes. Deterministic, a pure
// function of the repo's Project Readiness Record and the clock.
//
//   no PRR that an M4 ever made active           -> N8 hold (`n8_hold`): the only case N8 is for
//   PRR stale, suspended or expired               -> L8 human-led, through the 1.4 rule (`l8`)
//   PRR active but the level (or tier, posture)
//     does not open the lane                      -> L8, through the same rule
//   L0 and L7                                     -> `unspecified` at every level: not eligible, L8
//   otherwise                                     -> `normal`
//
// Drift and too-low levels never use N8, and this is not the R3 circuit breaker (flow.md R3 is
// ET14 only). Expiry never approves: an `active` record past its `fresh_until` is treated as
// `expired` even if the sweep has not written the status yet. An unknown repo has no PRR: N8.

const SUMMARY = (v: PrrVersion, status: ReadinessStatus): NonNullable<LaneEligibility['prr']> => ({
  version: v.version,
  status,
  level: v.prr.level.signed,
  record_hash: v.prr.record_hash,
  fresh_until: v.prr.fresh_until,
});

/** Why an active record does not open `lane`. */
function whyClosed(v: PrrVersion, lane: Lane, table: EligibilityCatalogue): EligibilityReason {
  const level = v.prr.level.signed;
  const row = tableOf(level, lane, table);
  if (row === 'unspecified') return 'lane_unspecified';
  if (row === 'not_eligible') return 'level_too_low';
  const tier = v.prr.tier.value;
  if (!isLaneEligible(level, lane, { tier, stagingSeparationAttested: true }, table)) {
    return 'tier_requires_full';
  }
  if (!isLaneEligible('census', lane, { tier, stagingSeparationAttested: true }, table)) {
    // The table and the tier allow it, so what closes it is a red posture (Census lanes only)...
    if (v.prr.autonomy.posture_cap === 'A0') return 'posture_red';
  }
  // ...or L5's staging separation, which was not attested.
  return 'staging_separation_not_attested';
}

/**
 * The verdict for one governing version (or none) and a lane. Pure. `table` is the eligibility table
 * of the catalogue the caller is bound to: an item's is its pinned one, a new request's the current.
 */
export function routeLane(
  repo: string,
  lane: Lane,
  governing: PrrVersion | null,
  now: Date,
  table: EligibilityCatalogue = ELIGIBILITY,
): LaneEligibility {
  if (!governing) {
    return {
      repo: repo as LaneEligibility['repo'],
      lane,
      eligible: false,
      route: 'n8_hold',
      reason: 'no_active_prr',
      prr: null,
    };
  }
  const expired =
    governing.status === 'active' && now.getTime() >= Date.parse(governing.prr.fresh_until);
  const status: ReadinessStatus = expired ? 'expired' : governing.status;
  const base = { repo: repo as LaneEligibility['repo'], lane, prr: SUMMARY(governing, status) };
  if (status !== 'active') {
    const reason: EligibilityReason =
      status === 'stale' ? 'prr_stale' : status === 'suspended' ? 'prr_suspended' : 'prr_expired';
    // Human-led L8 is where everything goes; a request for L8 itself is no worse off.
    return { ...base, eligible: lane === 'L8', route: 'l8', reason };
  }
  if (governing.prr.autonomy.lanes_eligible.includes(lane)) {
    return { ...base, eligible: true, route: 'normal', reason: 'eligible' };
  }
  return { ...base, eligible: false, route: 'l8', reason: whyClosed(governing, lane, table) };
}

/** `eligibility(repo, lane)` from the repo's PRR stream. */
export async function laneEligibility(
  db: Executor,
  repo: string,
  lane: Lane,
  clock: Clock = systemClock,
  table: EligibilityCatalogue = ELIGIBILITY,
): Promise<LaneEligibility> {
  const g = await readGoverning(db, repo);
  return routeLane(g?.repo_ref ?? repo, lane, g?.governing ?? null, clock.now(), table);
}
