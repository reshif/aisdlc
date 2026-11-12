import {
  CENSUS_AREA,
  levelRank,
  type Level,
  type PrrAreaFloor,
  type SystemMap,
} from '@aisdlc/contracts';

// Per-area levels (DEC-25(a); OB §2.1 "Per area"): levels and floors are judged per area, a monorepo part (the system
// map's areas: the nearest directory with a manifest). Pure. The repo-wide floors (LF1-LF8, FF2) were judged for the
// whole repo before M4 and give the signed level; the per-area floors can only LOWER an area below it, never raise it:
//
//   LF3 in the area  the area holds a test file (without one the agent cannot check its work there)  Light and Full
//   FF1 in the area  the area is on a whole code graph and has a living-spec seed                    Full
//
// Until a Full baseline maps the areas there is one repo-wide area, `.`, at the signed level (the testbed signs one
// repo-wide area). Unknown is unmet: a truncated graph is FF1 `unknown`, and the area is not Full.

export interface AreaLevelInput {
  readonly system_map: SystemMap;
  /** The areas that have a spec seed (any status: FF1 holds `observed` seeds too). */
  readonly seeded_areas: readonly string[];
  /** The code graph was cut at its limits: what it does not hold is unknown. */
  readonly graph_truncated: boolean;
}

export interface AreaLevel {
  readonly area: string;
  readonly level: Level;
  readonly floors: readonly PrrAreaFloor[];
}

/** The per-area table for a signed level; `null` input: one repo-wide area at the signed level. */
export function areaLevelsOf(signed: Level, input: AreaLevelInput | null): AreaLevel[] {
  if (input === null) return [{ area: CENSUS_AREA, level: signed, floors: [] }];
  const seeded = new Set(input.seeded_areas);
  return input.system_map.areas.map((a) => {
    const floors: PrrAreaFloor[] = [];
    let level: Level = signed;
    if (signed === 'full') {
      const ff1: PrrAreaFloor = input.graph_truncated
        ? { id: 'FF1', state: 'unknown', reason: 'the code graph was truncated' }
        : seeded.has(a.area)
          ? { id: 'FF1', state: 'met', reason: null }
          : { id: 'FF1', state: 'unmet', reason: 'no spec seed for the area' };
      floors.push(ff1);
      if (ff1.state !== 'met') level = 'light';
    }
    if (levelRank(signed) >= levelRank('light')) {
      const lf3: PrrAreaFloor =
        a.test_files > 0
          ? { id: 'LF3', state: 'met', reason: null }
          : { id: 'LF3', state: 'unmet', reason: 'no test file in the area' };
      floors.unshift(lf3);
      if (lf3.state !== 'met') level = 'census';
    }
    return { area: a.area, level, floors };
  });
}

/** The lowest level of a per-area table: what the repo as a whole may run (fail closed). */
export const lowestAreaLevel = (rows: readonly AreaLevel[]): Level =>
  rows.reduce<Level>((m, r) => (levelRank(r.level) < levelRank(m) ? r.level : m), 'full');
