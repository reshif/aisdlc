import { ReadinessPillarValues, type CensusRecord, type PrrPillar } from '@aisdlc/contracts';

/**
 * The Census's pillars in the PRR's shape (`PrrPillar`), for the PRR builder (M7.4): the criteria
 * evaluated at the requested level (N/A ones are left out: the PRR has no N/A), `met` true, false
 * or `unknown`, and the gap each unmet or unknown one opened.
 */
export function toPrrPillars(census: CensusRecord): PrrPillar[] {
  return ReadinessPillarValues.map((pillar) => {
    const score = census.pre_score.pillars.find((p) => p.pillar === pillar);
    const criteria = census.criteria
      .filter((c) => c.pillar === pillar && c.status !== 'na' && c.class !== null)
      .map((c) => {
        const e = c.evidence[0];
        return {
          id: c.id,
          class: c.class as NonNullable<typeof c.class>,
          met: c.status === 'met' ? true : c.status === 'unmet' ? false : ('unknown' as const),
          evidence_ref:
            e === undefined
              ? null
              : `${e.ref}${e.path === undefined ? '' : `@${e.path}${e.line === undefined ? '' : `:${e.line}`}`}`,
          ...(c.gap_id === undefined ? {} : { gap_id: c.gap_id }),
        };
      });
    return {
      pillar,
      level: score?.level ?? 0,
      criteria,
      by_area: score?.by_area ?? {},
    };
  });
}
