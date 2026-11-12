import { CENSUS_AREA, r3GlobOf, type PrrR3Zone } from '@aisdlc/contracts';
import { areaOfPath } from './areas.js';

// R3 zones (OB §2.4 `autonomy.r3_zones`, OB §8 "the PRR projects R3 state read-only"). Pure. An area is a zone while a
// knowledge-defect re-onboarding proposal about it is unresolved: the factory's baseline there is known to be wrong,
// so only the Census lanes run in it until a re-onboarding signs a new version. R3 never raises a level: a zone only
// confines lanes, and the levels stay as the floors give them.
//
// A proposal names the area of the record it was raised under; the new record may map the repo differently, so each
// is placed in the new record's area that holds it (the longest prefix; the root `.` stays the root, whose glob is
// everything).

/** An unresolved proposal: its id and the area it names. */
export interface TrippedArea {
  readonly area: string;
  readonly proposal_id: string;
}

/** The record's zones over its area names, sorted by area. */
export function r3ZonesOf(areas: readonly string[], tripped: readonly TrippedArea[]): PrrR3Zone[] {
  const by = new Map<string, Set<string>>();
  for (const t of tripped) {
    const area = t.area === CENSUS_AREA ? CENSUS_AREA : areaOfPath(t.area, areas);
    const ids = by.get(area) ?? new Set<string>();
    ids.add(t.proposal_id);
    by.set(area, ids);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([area, ids]) => ({
      area,
      glob: r3GlobOf(area),
      trigger: 'knowledge_defects' as const,
      proposal_ids: [...ids].sort(),
    }));
}

/** Whether `area` lies in a zone of `zoned` (area names): the root zone covers every area. */
export const inR3Zone = (area: string, zoned: ReadonlySet<string>): boolean =>
  zoned.has(CENSUS_AREA) || zoned.has(area);
