import {
  CENSUS_AREA,
  LF6_MIN_AFFIRMED_OR_UNKNOWN,
  levelRank,
  type ClaimVerdict,
  type Level,
  type PrrAreaFloor,
  type SystemMap,
} from '@aisdlc/contracts';

// Per-area levels (DEC-25(a); OB §2.1 "Per area", §3.2 "Light floors (LF), per area"): levels and floors are judged per
// area, a monorepo part (the system map's areas: the nearest directory with a manifest). Pure. The repo-wide floors
// (LF1-LF8, FF2) were judged for the whole repo before M4 and give the signed level; the per-area floors can only LOWER
// an area below it, never raise it:
//
//   LF3 in the area  the area holds a test file (without one the agent cannot check its work there)    Light and Full
//   LF5 in the area  affirmed instruction text covers the area (the root's covers every area)          Light and Full
//   LF6 in the area  at least 90% of the card 2 claims ABOUT the area (a claim's evidence is in it)      Light and Full
//                    are affirmed or `unknown`; an area no claim is about has an unchecked baseline:
//                    `unknown`
//   FF1 in the area  the area is on a whole code graph and has a living-spec seed                      Full
//
// The other Light floors are about the repo, not a part of it (security findings, protect-main, the harness
// inventory, operations, egress), so they hold or fail for every area alike and are judged once, repo-wide. The probe
// runs once for the repo (one run is the floor, OB §3.3): LF3 in an area is the presence of its tests.
//
// Until a Full baseline maps the areas there is one repo-wide area, `.`, at the signed level (the testbed signs one
// repo-wide area). Unknown is unmet: a truncated graph is FF1 `unknown`, and the area is not Full; an LF5 or LF6 the
// record cannot judge (no card 2 facts given) is `unknown`, and the area is Census.

/** One card 2 claim as its verdict and the repo paths of its evidence. */
export interface AreaClaim {
  readonly verdict: ClaimVerdict;
  readonly paths: readonly string[];
}

export interface AreaLevelInput {
  readonly system_map: SystemMap;
  /** The areas that have a spec seed (any status: FF1 holds `observed` seeds too). */
  readonly seeded_areas: readonly string[];
  /** The code graph was cut at its limits: what it does not hold is unknown. */
  readonly graph_truncated: boolean;
  /** The areas of the affirmed instruction files (card 2, LF5); `null` or absent: not known. */
  readonly instruction_areas?: readonly string[] | null;
  /** Card 2's claims with their verdicts and evidence paths (LF6); `null` or absent: not known. */
  readonly claims?: readonly AreaClaim[] | null;
}

export interface AreaLevel {
  readonly area: string;
  readonly level: Level;
  readonly floors: readonly PrrAreaFloor[];
}

/** The area of `path`: the longest area that is a directory prefix of it, else `.`. */
export function areaOfPath(path: string, areas: readonly string[]): string {
  let best = CENSUS_AREA;
  for (const a of areas) {
    if (a === CENSUS_AREA) continue;
    if ((path === a || path.startsWith(`${a}/`)) && a.length > best.length) best = a;
  }
  return best;
}

/** An instruction file's area covers `area` when it is the root (`.`, or `*` for all) or a parent directory of it. */
const covers = (instructionArea: string, area: string): boolean =>
  instructionArea === CENSUS_AREA ||
  instructionArea === '*' ||
  instructionArea === area ||
  area.startsWith(`${instructionArea}/`);

function lf5Of(area: string, input: AreaLevelInput): PrrAreaFloor {
  const ia = input.instruction_areas;
  if (ia === null || ia === undefined) {
    return { id: 'LF5', state: 'unknown', reason: 'the affirmed instruction text is not known' };
  }
  return ia.some((x) => covers(x, area))
    ? { id: 'LF5', state: 'met', reason: null }
    : { id: 'LF5', state: 'unmet', reason: 'no affirmed instruction text covers the area' };
}

function lf6Of(area: string, input: AreaLevelInput, names: readonly string[]): PrrAreaFloor {
  const claims = input.claims;
  if (claims === null || claims === undefined) {
    return { id: 'LF6', state: 'unknown', reason: 'the card 2 claims are not known' };
  }
  const about = claims.filter((c) => c.paths.some((p) => areaOfPath(p, names) === area));
  if (about.length === 0) {
    return { id: 'LF6', state: 'unknown', reason: 'no card 2 claim is about the area' };
  }
  const share = about.filter((c) => c.verdict !== 'correct').length / about.length;
  return share >= LF6_MIN_AFFIRMED_OR_UNKNOWN
    ? { id: 'LF6', state: 'met', reason: null }
    : {
        id: 'LF6',
        state: 'unmet',
        reason: `${Math.round(share * 100)}% of the claims about the area are affirmed or unknown`,
      };
}

/** The per-area table for a signed level; `null` input: one repo-wide area at the signed level. */
export function areaLevelsOf(signed: Level, input: AreaLevelInput | null): AreaLevel[] {
  if (input === null) return [{ area: CENSUS_AREA, level: signed, floors: [] }];
  const seeded = new Set(input.seeded_areas);
  const names = input.system_map.areas.map((a) => a.area);
  return input.system_map.areas.map((a) => {
    const floors: PrrAreaFloor[] = [];
    let level: Level = signed;
    if (levelRank(signed) >= levelRank('light')) {
      const lf3: PrrAreaFloor =
        a.test_files > 0
          ? { id: 'LF3', state: 'met', reason: null }
          : { id: 'LF3', state: 'unmet', reason: 'no test file in the area' };
      const light = [lf3, lf5Of(a.area, input), lf6Of(a.area, input, names)];
      floors.push(...light);
      if (light.some((f) => f.state !== 'met')) level = 'census';
    }
    if (signed === 'full') {
      const ff1: PrrAreaFloor = input.graph_truncated
        ? { id: 'FF1', state: 'unknown', reason: 'the code graph was truncated' }
        : seeded.has(a.area)
          ? { id: 'FF1', state: 'met', reason: null }
          : { id: 'FF1', state: 'unmet', reason: 'no spec seed for the area' };
      floors.push(ff1);
      if (ff1.state !== 'met' && level === 'full') level = 'light';
    }
    return { area: a.area, level, floors };
  });
}

/** The lowest level of a per-area table: what the repo as a whole may run (fail closed). */
export const lowestAreaLevel = (rows: readonly AreaLevel[]): Level =>
  rows.reduce<Level>((m, r) => (levelRank(r.level) < levelRank(m) ? r.level : m), 'full');
