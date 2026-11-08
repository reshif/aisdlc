import { catalogueHash, type CatalogueData } from '@aisdlc/catalogue';
import {
  CENSUS_ASSEMBLY_VERSION,
  CENSUS_AREA,
  CENSUS_SCHEMA_ID,
  CatalogueRef,
  CensusRecord,
  LevelValues,
  READINESS_PILLAR_OF_FAMILY,
  ReadinessPillarValues,
  censusId,
  gapId,
  sealCensus,
  type CensusAttestations,
  type CensusBody,
  type CensusCriterionResult,
  type CensusFloor,
  type CensusPillar,
  type CriterionClass,
  type Criterion,
  type Gap,
  type IntakeResult,
  type Level,
} from '@aisdlc/contracts';
import { assembleBlockers } from './blockers.js';
import { CensusContext, tidyEvidence, uniqSorted, type Evaluation } from './context.js';
import { EVALUATORS, UNOBSERVED } from './evaluate.js';
import { assembleInventory, assembleRisk } from './risk.js';

// Census assembly (PLAN M6.5): a PURE function from a job's result to the census record and gap
// ledger v1. No clock, no I/O, no randomness: the same inputs give the same canonical bytes and
// the same gap ids. See `CENSUS_NA_RULES` (the only N/A rules), `READINESS_PILLAR_OF_FAMILY`, and
// `scorePillar` below (the pre-score rule).

/** The factory's repo id: `<owner>.<name>` lowercase. GitHub owners never contain `.`, so it is unambiguous. */
export function repoIdOf(fullName: string): string {
  return fullName.toLowerCase().replace('/', '.');
}

const rankOf = (l: Level): number => LevelValues.indexOf(l);

function effectiveClass(
  c: Criterion,
  level: Level,
  ctx: CensusContext,
): { cls: CriterionClass | null; escalated: boolean } {
  const base = c.class_by_level[level] ?? null;
  if (base === null) return { cls: null, escalated: false };
  // OB §3.3 "SCORED (team: FLOOR)" and "(team + public: FLOOR)". An unknown visibility counts as public.
  const applies = (when: string): boolean =>
    ctx.mode === 'team' &&
    (when === 'team' ||
      (when === 'team_and_public' &&
        ctx.visibility !== 'private' &&
        ctx.visibility !== 'internal'));
  const esc = c.escalations.some((e) => applies(e.when));
  return esc && base !== 'FLOOR'
    ? { cls: 'FLOOR', escalated: true }
    : { cls: base, escalated: false };
}

export interface Row {
  readonly result: CensusCriterionResult;
  /** A written N/A rule other than the level one: the criterion does not count in the pre-score either. */
  readonly specialNa: boolean;
}

function evaluate(
  c: Criterion,
  ctx: CensusContext,
  blockers: ReturnType<typeof assembleBlockers>,
): Evaluation {
  const ev = EVALUATORS[c.id];
  if (ev !== undefined) return ev(ctx, blockers);
  return { observed: 'unknown', reasons: [UNOBSERVED[c.id] ?? 'no_evaluator'], evidence: [] };
}

/** Security-derived: a gap whose existence says something about a secret (OB §7: private_only, track_only). */
function securityDerived(id: string, ctx: CensusContext): boolean {
  return id === 'RS-SEC' || (id === 'RS-AI-3' && (ctx.d?.lint.by_rule['L-SECRET'] ?? 0) > 0);
}

export function assembleCensus(
  intake: IntakeResult,
  catalogue: CatalogueData,
  requestedLevel: Level,
  attestations: CensusAttestations = {},
): CensusRecord {
  const ctx = new CensusContext(intake, requestedLevel, attestations);
  const blockers = assembleBlockers(ctx);
  const repoId = attestations.repo_id ?? repoIdOf(intake.repo);
  const scoringLevel: Level = requestedLevel === 'census' ? 'light' : requestedLevel;

  // ---- every criterion of the catalogue, in catalogue order
  const rows: Row[] = catalogue.criteria.criteria.map((c) => {
    const ev = evaluate(c, ctx, blockers);
    const { cls, escalated } = effectiveClass(c, requestedLevel, ctx);
    const scoring = effectiveClass(c, scoringLevel, ctx).cls;
    const naRule = cls === null ? 'NA-LEVEL' : (ev.na ?? null);
    const status: CensusCriterionResult['status'] =
      naRule !== null
        ? 'na'
        : ev.observed === 'pass'
          ? 'met'
          : ev.observed === 'fail'
            ? 'unmet'
            : 'unknown';
    const derived = securityDerived(c.id, ctx);
    // A security-derived result carries counts and tokens only: no path, blob or line.
    const evidence = tidyEvidence(
      derived ? ev.evidence.map((e) => ({ source: e.source, ref: e.ref })) : ev.evidence,
    );
    return {
      specialNa: ev.na !== undefined,
      result: {
        id: c.id,
        family: c.pillar,
        pillar: READINESS_PILLAR_OF_FAMILY[c.pillar],
        class: cls,
        escalated,
        scoring_class: scoring,
        status,
        observed: ev.observed,
        na_rule: naRule,
        reasons: uniqSorted(ev.reasons),
        evidence,
      },
    };
  });

  // ---- gap ledger v1: one per unmet or unknown criterion; ADVISORY is proposed, never a gap
  const gaps: Gap[] = [];
  const results = rows.map((row): CensusCriterionResult => {
    const r = row.result;
    if (
      (r.status !== 'unmet' && r.status !== 'unknown') ||
      r.class === null ||
      r.class === 'ADVISORY'
    )
      return r;
    const blocking = r.class === 'FLOOR';
    const secure = securityDerived(r.id, ctx);
    const id = gapId(repoId, r.id, CENSUS_AREA);
    gaps.push({
      gap_id: id,
      repo_id: repoId as Gap['repo_id'],
      criterion: r.id,
      area: CENSUS_AREA,
      severity: blocking ? 'blocking' : 'tracked',
      blocks_level: blocking ? requestedLevel : null,
      // OB §7 defaults: blocking and public-safe -> file_issue; tracked -> track_only; security -> track_only always.
      disposition: blocking && !secure ? 'file_issue' : 'track_only',
      status: 'open',
      issue: null,
      remediation_item_ref: null,
      waiver: null,
      visibility_class: secure ? 'private_only' : 'public_safe',
    });
    return { ...r, gap_id: id as NonNullable<CensusCriterionResult['gap_id']> };
  });

  // ---- floors: CF always; LF and FF only up to the requested level, else not_evaluated
  const byId = new Map(results.map((r) => [r.id, r]));
  const floors: CensusFloor[] = catalogue.criteria.floors.map((f) => {
    if (rankOf(f.level) > rankOf(requestedLevel)) {
      return { id: f.id, status: 'not_evaluated', criteria: f.criteria };
    }
    const sts = f.criteria.map((id) => byId.get(id)?.status ?? 'unknown');
    const status = sts.includes('unmet') ? 'unmet' : sts.includes('unknown') ? 'unknown' : 'met';
    return { id: f.id, status, criteria: f.criteria };
  });

  // ---- pre-score
  const pillars = ReadinessPillarValues.map((p) => scorePillar(p, rows));
  const composite = Math.min(...pillars.map((p) => p.level));

  const d = intake.detectors;
  const body: CensusBody = {
    schema: CENSUS_SCHEMA_ID,
    census_id: censusId(repoId, intake.manifest.head_sha),
    repo: {
      full_name: intake.repo,
      owner: intake.repo.split('/')[0] ?? '',
      name: intake.repo.split('/')[1] ?? '',
      repo_id: repoId as Gap['repo_id'],
      visibility: attestations.repo?.visibility ?? null,
      owner_type: attestations.repo?.owner_type ?? null,
      plan: attestations.repo?.plan ?? null,
      default_branch: d?.default_branch ?? null,
      archetype: null,
    },
    baseline_sha: intake.manifest.head_sha,
    requested_level: requestedLevel,
    pins: {
      catalogue: CatalogueRef.parse({ version: catalogue.version, hash: catalogueHash(catalogue) }),
      criteria_set: `${catalogue.criteria.set}@${catalogue.version}`,
      detector_set_version: d?.detector_set_version ?? null,
      rules_version: intake.scan_coverage.rules_version,
      assembly: CENSUS_ASSEMBLY_VERSION,
    },
    refs_covered: intake.manifest.refs_covered,
    security_summary: intake.security_summary,
    risk_category: assembleRisk(ctx),
    posture: blockers.posture,
    blockers: blockers.list,
    criteria: results,
    floors,
    pre_score: { basis_level: scoringLevel, pillars, composite },
    probe: { state: 'pending', blocker: 'B7', counts_only_in: 'K-exec' },
    inventory: assembleInventory(ctx),
    detectors:
      d === null
        ? null
        : {
            status: d.status,
            error_codes: uniqSorted(d.errors.map((e) => `${e.detector ?? 'all'}:${e.code}`)),
            facts_truncated: d.facts_truncated,
            fact_counts: d.fact_counts,
            lint: {
              docs_linted: d.lint.docs_linted,
              blocking: d.lint.blocking,
              advisory: d.lint.advisory,
            },
          },
    coverage_counts: Object.fromEntries(
      Object.entries(intake.coverage_counts)
        .filter(([, n]) => n !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ) as Record<string, number>,
    gaps,
  };
  return CensusRecord.parse(sealCensus(body));
}

/**
 * The pillar pre-score, 0 to 4 (OB §2.3 calls RL1-RL4 and takes the composite as the MIN):
 *
 *   Scoring set  the pillar's criteria whose scoring class (the requested level's; at Census, LIGHT's:
 *                the readiness a Light request would see) is FLOOR, SCORED or RECORDED, minus those
 *                with a written N/A rule other than the level one. ADVISORY is never scored (§3.1).
 *   RL0          a criterion that is a FLOOR at the REQUESTED level is unmet or unknown (fail closed).
 *   RL1          no such floor is open.
 *   RL2          RL1, and every criterion in the scoring set is MEASURED (observed pass or fail, not
 *                unknown): RECORDED "must exist, any value passes" (§3.1).
 *   RL3          RL2, and at least 80% of the SCORED criteria pass (§3.1 "the 80% rule"; none = 100%).
 *   RL4          RL3, and every criterion in the scoring set passes.
 *
 * The probe is `pending` at Census, so RS-BT-2 and the rest of its family are unmeasured: VRL stays
 * below RL2 until a K-exec run measures them (B7).
 */
export function scorePillar(pillar: CensusPillar['pillar'], rows: readonly Row[]): CensusPillar {
  const mine = rows.filter((r) => r.result.pillar === pillar);
  const floorsOpen = mine.filter(
    (r) =>
      r.result.class === 'FLOOR' && (r.result.status === 'unmet' || r.result.status === 'unknown'),
  ).length;
  const set = mine.filter(
    (r) => !r.specialNa && r.result.scoring_class !== null && r.result.scoring_class !== 'ADVISORY',
  );
  const measured = set.filter((r) => r.result.observed !== 'unknown').length;
  const scored = set.filter((r) => r.result.scoring_class === 'SCORED');
  const scoredPass = scored.filter((r) => r.result.observed === 'pass').length;
  const allPass = set.every((r) => r.result.observed === 'pass');
  let level = 0;
  if (floorsOpen === 0) {
    level = 1;
    if (measured === set.length) {
      level = 2;
      if (scoredPass * 5 >= scored.length * 4) {
        level = 3;
        if (allPass) level = 4;
      }
    }
  }
  return {
    pillar,
    level,
    by_area: { [CENSUS_AREA]: level },
    criteria: mine.map((r) => r.result.id),
    floors_open: floorsOpen,
    measured,
    total: set.length,
    scored_pass: scoredPass,
    scored_total: scored.length,
    all_pass: allPass,
  };
}
