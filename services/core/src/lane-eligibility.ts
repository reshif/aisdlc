import {
  ELIGIBILITY,
  isLaneEligible,
  laneEligibility as tableOf,
  type EligibilityCatalogue,
} from '@aisdlc/catalogue';
import {
  levelRank,
  type EligibilityReason,
  type Lane,
  type Level,
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
//   the caller's catalogue does not open the lane
//     at the record's level (an item pinned to 1.3.0
//     asks for L0 or L7: `unspecified` there)       -> L8, through the same rule
//   otherwise                                     -> `normal`
//
// The record's `lanes_eligible` was computed from the S0 record's pinned catalogue; the caller's table
// (an item's pinned one, a new request's the current) must ALSO open the lane at the record's level,
// so an item keeps the rule of the catalogue it was created under.
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

/** Why an active record does not open `lane` at `level` (the area's, or the lowest area's). */
function whyClosed(
  v: PrrVersion,
  lane: Lane,
  table: EligibilityCatalogue,
  level: Level,
): EligibilityReason {
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
 * DEC-25(a): the level and lanes a request gets. Naming an area: that area's row of the per-area table (a
 * record with one repo-wide area `.` holds every path, so any area is `.`; `null` for an area a mapped record
 * does not hold). Naming none: the repo as a whole, the LOWEST area's level and the record's `lanes_eligible`.
 */
export function areaOf(
  prr: PrrVersion['prr'],
  area: string | undefined,
): { level: Level; lanes: readonly Lane[] } | null {
  const rows = prr.level.areas ?? [
    { area: '.', level: prr.level.signed, floors: [], lanes: prr.autonomy.lanes_eligible },
  ];
  if (area === undefined) {
    const level = rows.reduce<Level>(
      (m, r) => (levelRank(r.level) < levelRank(m) ? r.level : m),
      prr.level.signed,
    );
    return { level, lanes: prr.autonomy.lanes_eligible };
  }
  const only = rows.length === 1 && rows[0]?.area === '.' ? rows[0] : undefined;
  const row = only ?? rows.find((r) => r.area === area);
  return row ? { level: row.level, lanes: row.lanes } : null;
}

/**
 * The verdict for one governing version (or none) and a lane. Pure. `table` is the eligibility table
 * of the catalogue the caller is bound to: an item's is its pinned one, a new request's the current.
 * `area` (DEC-25) asks for one area of the repo; absent, the repo as a whole.
 */
export function routeLane(
  repo: string,
  lane: Lane,
  governing: PrrVersion | null,
  now: Date,
  table: EligibilityCatalogue = ELIGIBILITY,
  area?: string,
): LaneEligibility {
  const at = area === undefined ? {} : { area };
  if (!governing) {
    return {
      repo: repo as LaneEligibility['repo'],
      lane,
      ...at,
      eligible: false,
      route: 'n8_hold',
      reason: 'no_active_prr',
      prr: null,
    };
  }
  const expired =
    governing.status === 'active' && now.getTime() >= Date.parse(governing.prr.fresh_until);
  const status: ReadinessStatus = expired ? 'expired' : governing.status;
  const base = {
    repo: repo as LaneEligibility['repo'],
    lane,
    ...at,
    prr: SUMMARY(governing, status),
  };
  if (status !== 'active') {
    const reason: EligibilityReason =
      status === 'stale' ? 'prr_stale' : status === 'suspended' ? 'prr_suspended' : 'prr_expired';
    // Human-led L8 is where everything goes; a request for L8 itself is no worse off.
    return { ...base, eligible: lane === 'L8', route: 'l8', reason };
  }
  const scope = areaOf(governing.prr, area);
  if (scope === null) return { ...base, eligible: false, route: 'l8', reason: 'area_unknown' };
  const opened = tableOf(scope.level, lane, table);
  if (scope.lanes.includes(lane)) {
    if (opened === 'eligible') {
      return { ...base, eligible: true, route: 'normal', reason: 'eligible' };
    }
    return {
      ...base,
      eligible: false,
      route: 'l8',
      reason: opened === 'unspecified' ? 'lane_unspecified' : 'level_too_low',
    };
  }
  return {
    ...base,
    eligible: false,
    route: 'l8',
    reason: whyClosed(governing, lane, table, scope.level),
  };
}

/** `eligibility(repo, lane)` from the repo's PRR stream. */
export async function laneEligibility(
  db: Executor,
  repo: string,
  lane: Lane,
  clock: Clock = systemClock,
  table: EligibilityCatalogue = ELIGIBILITY,
  area?: string,
): Promise<LaneEligibility> {
  const g = await readGoverning(db, repo);
  return routeLane(g?.repo_ref ?? repo, lane, g?.governing ?? null, clock.now(), table, area);
}
