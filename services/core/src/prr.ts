import {
  AUTONOMY,
  catalogueFor,
  effectiveAutonomy,
  eligibleLanes,
  readinessCap,
} from '@aisdlc/catalogue';
import {
  AutonomyValues,
  CENSUS_AREA,
  MS_PER_DAY,
  PRR_FRESH_DAYS,
  PRR_GOVERNANCE_CAP_MAP,
  PRR_REVIEW_MONTHS,
  ProjectReadinessRecord,
  addMonthsUtc,
  levelRank,
  prrRecordId,
  sealPrr,
  toPrrPillars,
  type Autonomy,
  type CardPayloadItem,
  type CatalogueRef,
  type CensusRecord,
  type ControlsAttestation,
  type RepoPlan,
  type ControlsReport,
  type Gap,
  type GatingProfile,
  type KillDelegation,
  type Lane,
  type Level,
  type PrincipalId,
  type PrrBody,
  type PrrSecuritySummary,
  type RoleMap,
  type Tier,
  type TwoPerson,
} from '@aisdlc/contracts';
import { err, hashCanonical, ok, type Result } from '@aisdlc/kernel';

// The PRR builder (PLAN M7.4; OB §2.1-§2.4): a PURE function from what the S0 cards decided and
// what the factory observed to a sealed `prr/1` record, status `proposed`. It reads no clock (the
// caller gives `issued_at`), no database and no port. Everything the contract refines is checked
// by the contract (`ProjectReadinessRecord`); this file adds the checks that need a message a
// person can act on, and refuses rather than guesses: unknown is unmet.

export type PrrBuildCode =
  /** The code host did not tell the repo's visibility, owner type or default branch. */
  | 'repo_facts_unknown'
  | 'installation_unknown'
  /** A step the record claims done is not done. */
  | 'step_not_done'
  | 'gap_not_disposed'
  | 'blocking_gap_open'
  /** The census says M4 cannot sign until the owner attests (T0, regulatory, criticality) or the detectors finish. */
  | 'risk_unattested'
  /** Light and Full need protect-main effective (B3); only a read-only Census may sign without it. */
  | 'b3_not_met'
  | 'gating_floor'
  | 'no_signer'
  /** The S0 record's pinned catalogue is not a released one (or its hash does not match). */
  | 'catalogue_unknown'
  | 'invalid_record';

export interface PrrBuildError {
  readonly code: PrrBuildCode;
  readonly message: string;
  readonly issues: readonly string[];
}
const fail = (code: PrrBuildCode, message: string, issues: string[] = []) =>
  err<PrrBuildError>({ code, message, issues });

// ---------------------------------------------------------------- autonomy

export type Posture = 'red' | 'amber' | 'green';

export interface AutonomyBreakdown {
  readonly tier_cap: Autonomy;
  /** Light and Full state no level cap (OB §2.3): recorded as the top autonomy, which binds nothing. */
  readonly level_cap: Autonomy;
  /** RL0 is not stated and fails closed to the lowest autonomy. */
  readonly readiness_cap: Autonomy;
  /** `null` is green: no constraint. */
  readonly posture_cap: Autonomy | null;
  readonly probation_until: string;
  readonly effective: Autonomy;
  /** The caps that equal `effective` (more than one on a tie), by the names of OB §2.3. */
  readonly binding: readonly ('tier' | 'level' | 'readiness' | 'posture' | 'probation')[];
}

const TOP: Autonomy = AutonomyValues[AutonomyValues.length - 1] as Autonomy;
const arank = (a: Autonomy): number => AutonomyValues.indexOf(a);

/**
 * OB §2.3: effective autonomy = min(tier, level, readiness, posture, probation, earned). The min is
 * the catalogue's own `effectiveAutonomy`; this adds the values each cap takes in the record.
 *
 * Probation is A1 for at least `AUTONOMY.probation.min_weeks` after M4 and ends only through the
 * governance earn rule, never by the clock, so every record issues WITH it and `earned` is none.
 * `afterProbation` answers the question "which cap would bind then?" (the golden tests use it to
 * show the tier cap binding, which no record can show at issue); it is never stored.
 */
export function computeAutonomy(i: {
  tier: Tier;
  level: Level;
  composite: number;
  posture: Posture;
  issued_at: Date;
  afterProbation?: boolean;
}): AutonomyBreakdown {
  const tier_cap = AUTONOMY.tier[i.tier];
  const level_cap = AUTONOMY.level[i.level] ?? TOP;
  const readiness_cap = readinessCap(i.composite) ?? (AutonomyValues[0] as Autonomy);
  const posture_cap = AUTONOMY.posture[i.posture].cap;
  const weeks = AUTONOMY.probation.min_weeks.value ?? 4;
  const probation_until = new Date(i.issued_at.getTime() + weeks * 7 * MS_PER_DAY).toISOString();
  const onProbation = i.afterProbation !== true;
  const effective = effectiveAutonomy({
    tier: i.tier,
    level: i.level,
    readiness: i.composite,
    posture: i.posture,
    onProbation,
  });
  const caps: Array<[AutonomyBreakdown['binding'][number], Autonomy | null]> = [
    ['tier', tier_cap],
    ['level', AUTONOMY.level[i.level]],
    ['readiness', readiness_cap],
    ['posture', posture_cap],
    ['probation', onProbation ? AUTONOMY.probation.cap : null],
  ];
  return {
    tier_cap,
    level_cap,
    readiness_cap,
    posture_cap,
    probation_until,
    effective,
    binding: caps.filter(([, c]) => c !== null && arank(c) === arank(effective)).map(([n]) => n),
  };
}

// ---------------------------------------------------------------- inputs

/** The C1 decisions the PRR records. */
export interface PrrC1 {
  readonly owners: readonly PrincipalId[];
  readonly tier: Tier;
  /** The floor card 1 showed: the detectors' floor raised by what the request attested. */
  readonly floor: Tier;
  readonly t0_attested: boolean;
  readonly regulatory_attested: boolean;
  readonly criticality_attested: boolean;
  readonly gap_rows: ReadonlyArray<Extract<CardPayloadItem, { kind: 'gap_disposition' }>>;
  readonly decided_by: PrincipalId;
  readonly decided_at: Date;
}

/** The C4 decisions the PRR records. */
export interface PrrC4 {
  readonly report: ControlsReport;
  readonly attestation: ControlsAttestation;
  readonly role_map: RoleMap;
  readonly two_person: TwoPerson;
  readonly gating_profile: GatingProfile;
  readonly kill_delegations: readonly KillDelegation[];
  readonly read_at: string;
  readonly collaborators_read: 'ok' | 'unknown' | 'unreadable';
  readonly decided_by: PrincipalId;
  readonly decided_at: Date;
}

export interface PrrInputs {
  readonly project_id: string;
  /** `issued_at`. */
  readonly now: Date;
  readonly version: number;
  /** The `record_hash` of the version this one replaces, or `null` for the first. */
  readonly supersedes: string | null;
  readonly census: CensusRecord;
  readonly s0: {
    readonly requested_level: Level;
    readonly signable_level: Level;
    /** The state of steps 0.2 and 0.3 (`done` or `skip`; anything else is not finished). */
    readonly step_0_2: string;
    readonly step_0_3: string;
    readonly catalogue_ref: CatalogueRef;
  };
  /** The tier floor the request attested (raise-only), if any. */
  readonly attested_floor: Tier | null;
  readonly deploys: boolean | null;
  readonly c1: PrrC1;
  readonly c4: PrrC4;
  /** Current finding counts (the security card may have decided some since the scan). */
  readonly security: PrrSecuritySummary;
  readonly signer: ProjectReadinessRecord['signer'];
  readonly affirmed?: ProjectReadinessRecord['affirmed'];
}

const TIER_RANK: Readonly<Record<Tier, number>> = { T0: 0, T1: 1, T2: 2 };
const SIGNER_ROLE: Readonly<Record<Tier, string>> = { T0: 'TL', T1: 'EM', T2: 'FGB' };

/**
 * Who signs M4 as the PRR records it. M4 binds to the record's hash before anyone has decided, so
 * the signer is the one expected to: the requester if they hold the `m4` slot, else the first
 * holder. The M4 ledger entry names whoever actually decided. `sod_waiver` is what deciding rests
 * on: a sole holder or two-person off, never T2 (the contract refuses it there). In SOLO the role
 * is still the team-mode role that would sign (TL, EM, FGB; OB §2.2).
 */
export function expectedSigner(i: {
  tier: Tier;
  m4_holders: readonly PrincipalId[];
  requester: PrincipalId;
  two_person_enabled: boolean;
  team_mode: boolean;
}): Result<ProjectReadinessRecord['signer'], PrrBuildError> {
  const holders = [...new Set(i.m4_holders)].sort();
  if (holders.length === 0) return fail('no_signer', 'nobody holds the m4 slot');
  const principal = holders.includes(i.requester) ? i.requester : (holders[0] as PrincipalId);
  return ok({
    principal,
    role: SIGNER_ROLE[i.tier],
    mode: i.team_mode || holders.length > 1 ? 'team' : 'solo',
    sod_waiver: i.tier !== 'T2' && (holders.length === 1 || !i.two_person_enabled),
  });
}

/** Gap ledger v1 with card 1's dispositions and waivers applied. */
function disposeGaps(gaps: readonly Gap[], c1: PrrC1): Result<Gap[], PrrBuildError> {
  const rows = new Map(c1.gap_rows.map((r) => [r.gap_id, r]));
  const out: Gap[] = [];
  for (const g of gaps) {
    const r = rows.get(g.gap_id);
    if (!r) return fail('gap_not_disposed', `${g.gap_id} was not disposed of on card 1`);
    if (r.disposition === 'waive') {
      if (!r.waiver) return fail('gap_not_disposed', `${g.gap_id} is waived without a waiver`);
      out.push({
        ...g,
        disposition: 'waive',
        status: 'waived',
        waiver: {
          granted_by: c1.decided_by,
          granted_at: c1.decided_at.toISOString(),
          expires_at: r.waiver.expires_at,
          reason: r.waiver.reason,
        },
      });
    } else {
      out.push({ ...g, disposition: r.disposition, waiver: null });
    }
  }
  return ok(out);
}

/** B3 = protect-main effective on the default branch AND the bypass attestation (OB §5.1; B3 = LF2 in SOLO). */
export function b3Met(c4: PrrC4): boolean {
  const pm = c4.report.controls.find((c) => c.id === 'protect_main');
  return pm?.status === 'met' && c4.attestation.bypass_has_no_factory_app === true;
}

const controlsOf = (c4: PrrC4): Result<ProjectReadinessRecord['controls'], PrrBuildError> => {
  const r = c4.report;
  const inst = r.app_installation;
  if (inst.read !== 'ok' || inst.installation_id === null || inst.repository_selection === null) {
    return fail('installation_unknown', 'the App installation could not be read at step 0.4');
  }
  const rules = r.effective_rules.rules;
  return ok({
    effective_rules:
      rules && r.effective_rules.rules_hash
        ? {
            hash: r.effective_rules.rules_hash as never,
            required_checks: rules.required_checks.map((c) => ({
              name: c.context,
              ...(c.integration_id === null ? {} : { integration_id: c.integration_id }),
            })),
            read_at: c4.read_at as never,
          }
        : null,
    attested: {
      bypass_has_no_factory_app: c4.attestation.bypass_has_no_factory_app,
      app_scope_selected: c4.attestation.app_scope_selected,
      github_token_readonly: c4.attestation.github_token_readonly,
      at: c4.decided_at.toISOString() as never,
      by: c4.decided_by,
    },
    app_installation: {
      installation_id: inst.installation_id,
      repository_selection: inst.repository_selection,
      permissions: inst.permissions ?? {},
    },
    codeowners:
      r.codeowners.path !== null && r.codeowners.blob_sha !== null
        ? {
            path: r.codeowners.path,
            blob_sha: r.codeowners.blob_sha,
            errors: r.codeowners.github_errors,
          }
        : null,
    sensitive_paths_hash: r.sensitive_paths_hash,
    egress_request_ref: null,
  });
};

// ---------------------------------------------------------------- identity gaps closed by the cards

/**
 * RS-ID-1 to RS-ID-4 are the four identity criteria of the Census floor, and what satisfies them is
 * not in the repo: the App scoped to selected repositories (card 4's controls report), the owner
 * confirmed and the tier signed (card 1), the visibility and owner type recorded (the code host's
 * answer, kept on the Repo). The census is assembled before any card, and in the deployed wiring
 * knowledge is told none of these, so it raises all four as blocking gaps that nothing in the repo
 * can close and that card 1 would have to "fix". When the facts are on the record, they close:
 * the gap is `closed_verified` and keeps card 1's disposition. A fact that is not there leaves its
 * gap open (unknown means unmet).
 *
 * RS-ID-4 also names the owner's plan. The App cannot read it (CF4), so the code host records it as
 * `unknown` and card 4 asks the owner to state it (free, pro, team, enterprise). The gap closes only
 * when visibility and owner type are recorded AND the plan is attested; `unknown` is not an
 * attestation, so a gap whose plan the owner could not state stays open.
 */
export function closeOwnerCardGaps(
  census: CensusRecord,
  f: {
    /** Card 2 was decided: instruction text affirmed (RS-AI-4), claims (RS-KN-4), intent (RS-KN-5). */
    light_affirmed?: boolean;
    /** Card 3 was decided (M17): the full codekb, the system map and the seeds exist (RS-KN-7, FF1). */
    full_baseline?: boolean;
    owner_confirmed: boolean;
    tier_signed: boolean;
    app_scoped: boolean;
    /** The plan card 4 attested; `unknown` or absent means not attested. */
    plan_attested: RepoPlan | null;
  },
): CensusRecord {
  const satisfied: Readonly<Record<string, boolean>> = {
    'RS-ID-1': f.app_scoped && census.repo.default_branch !== null,
    'RS-ID-2': f.owner_confirmed,
    'RS-AI-4': f.light_affirmed === true,
    'RS-KN-4': f.light_affirmed === true,
    'RS-KN-5': f.light_affirmed === true,
    'RS-KN-7': f.full_baseline === true,
    'RS-ID-3': f.tier_signed,
    'RS-ID-4':
      census.repo.visibility !== null &&
      census.repo.owner_type !== null &&
      f.plan_attested !== null &&
      f.plan_attested !== 'unknown',
  };
  return {
    ...census,
    gaps: census.gaps.map((g) =>
      satisfied[g.criterion] === true && g.status === 'open'
        ? { ...g, status: 'closed_verified' as const }
        : g,
    ),
  };
}

// ---------------------------------------------------------------- the builder

export function buildPrr(i: PrrInputs): Result<ProjectReadinessRecord, PrrBuildError> {
  const { census, s0, c1, c4 } = i;
  const repo = census.repo;
  if (repo.visibility === null || repo.owner_type === null || repo.default_branch === null) {
    return fail(
      'repo_facts_unknown',
      'the code host did not say whether the repo is public or private, whose it is, or its default branch',
    );
  }
  for (const [step, state] of [
    ['0.2', s0.step_0_2],
    ['0.3', s0.step_0_3],
  ] as const) {
    if (state !== 'done' && state !== 'skip') {
      return fail('step_not_done', `step ${step} is ${state}, not done or skipped`);
    }
  }

  // ---- the risk category: what the census says M4 cannot sign without (OB §2.2, DEC-4). The
  // census was assembled before card 1, so what the owner attested there is what clears each reason.
  const unmet = census.risk_category.blocks_m4_reasons.filter((r) =>
    r === 'detectors_incomplete'
      ? true
      : r === 't0_unattested'
        ? c1.tier === 'T0' && !c1.t0_attested
        : r === 'regulatory_unattested'
          ? !c1.regulatory_attested
          : !c1.criticality_attested,
  );
  if (unmet.length > 0) {
    return fail(
      'risk_unattested',
      `M4 cannot sign yet: ${unmet.join(', ')}${unmet.includes('detectors_incomplete') ? ' (a census whose detectors did not finish gives only a lower bound for the tier)' : ''}`,
      unmet,
    );
  }

  // ---- level. Signed is at most requested; an open blocking gap at the signed level stops it.
  const signed = s0.signable_level;
  const gaps = disposeGaps(census.gaps, c1);
  if (!gaps.ok) return gaps;
  const blocking = gaps.value.filter(
    (g) =>
      g.severity === 'blocking' &&
      g.status === 'open' &&
      g.blocks_level !== null &&
      levelRank(signed) >= levelRank(g.blocks_level),
  );
  if (blocking.length > 0) {
    return fail(
      'blocking_gap_open',
      `${blocking.length} blocking gap(s) are open at ${signed}: fix them, or sign a lower level`,
      blocking.map((g) => g.gap_id),
    );
  }

  // ---- readiness and caps
  const pillars = toPrrPillars(census);
  const composite = Math.min(...pillars.map((p) => p.level));
  const posture = census.posture.state;
  const aut = computeAutonomy({
    tier: c1.tier,
    level: signed,
    composite,
    posture,
    issued_at: i.now,
  });

  // ---- lanes: what the signed level and tier unlock, confined to Census lanes while posture is red,
  // read from the eligibility table of the catalogue the S0 record is pinned to (catalogue 1.4.0
  // opened L0 at Light and L7 at Census; a record pinned before it keeps the older table).
  const pinned = catalogueFor(s0.catalogue_ref);
  if (!pinned.ok) {
    return fail(
      'catalogue_unknown',
      `the S0 record's catalogue ${s0.catalogue_ref.version} is not a released one`,
      [pinned.error._tag],
    );
  }
  const ff2 = census.floors.find((f) => f.id === 'FF2')?.status === 'met';
  const laneLevel: Level = AUTONOMY.posture[posture].census_lanes_only ? 'census' : signed;
  const lanes_eligible: Lane[] = eligibleLanes(
    laneLevel,
    { tier: c1.tier, stagingSeparationAttested: ff2 },
    pinned.value.eligibility,
  );

  // ---- writes. B3 decides whether the factory may write at all; a read-only Census signs without it.
  const b3 = b3Met(c4);
  if (!b3 && signed !== 'census') {
    return fail(
      'b3_not_met',
      `protect-main is not effective (B3): ${signed} needs it; only a read-only Census may sign without`,
    );
  }
  const agentLane = lanes_eligible.some((l) => ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].includes(l));
  const writes = !b3 ? 'none' : agentLane ? 'agent' : 'docs';

  const controls = controlsOf(c4);
  if (!controls.ok) return controls;

  const issued_at = i.now.toISOString();
  const months = PRR_REVIEW_MONTHS[signed];
  const raised_by: Array<'a9' | 'owner'> = [];
  if (census.risk_category.signals.length > 0) raised_by.push('a9');
  if (
    (i.attested_floor !== null &&
      TIER_RANK[i.attested_floor] > TIER_RANK[census.risk_category.tier_floor]) ||
    TIER_RANK[c1.tier] > TIER_RANK[c1.floor]
  ) {
    raised_by.push('owner');
  }

  const body: PrrBody = {
    schema: 'prr/1',
    record_id: prrRecordId(i.project_id, repo.repo_id),
    version: i.version,
    supersedes: i.supersedes as never,
    status: 'proposed',
    repo: {
      owner: repo.owner,
      name: repo.name,
      repo_id: repo.repo_id,
      visibility: repo.visibility,
      owner_type: repo.owner_type,
      plan: repo.plan ?? 'unknown',
      default_branch: repo.default_branch,
      archetype: repo.archetype,
    },
    baseline_sha: census.baseline_sha,
    pins: {
      catalogue: s0.catalogue_ref,
      criteria_set: census.pins.criteria_set,
      detector_set: census.pins.detector_set_version ?? 'detectors/none',
      governance_cap_map: PRR_GOVERNANCE_CAP_MAP,
    },
    level: {
      requested: s0.requested_level,
      signed,
      by_area: { [CENSUS_AREA]: signed },
      steps: {
        '0.1': 'done',
        '0.2': s0.step_0_2 === 'done' ? 'done' : 'not_requested',
        '0.3': s0.step_0_3 === 'done' ? 'done' : 'not_requested',
        '0.4': 'done',
        '0.5': 'done',
      },
    },
    tier: {
      value: c1.tier,
      floor: c1.floor,
      raised_by,
      t0_attested: c1.tier === 'T0' && c1.t0_attested,
      risk_category_hash: hashCanonical(census.risk_category) as never,
    },
    pillars,
    gating_profile: { ...c4.gating_profile, project_deploys: i.deploys },
    role_map: {
      slots: c4.role_map,
      kill_delegations: [...c4.kill_delegations],
      two_person: c4.two_person,
      source: {
        codeowners_sha: c4.report.codeowners.blob_sha,
        collaborators_read_at: c4.collaborators_read === 'ok' ? (c4.read_at as never) : null,
      },
    },
    composite,
    autonomy: {
      tier_cap: aut.tier_cap,
      level_cap: aut.level_cap,
      readiness_cap: aut.readiness_cap,
      posture_cap: aut.posture_cap,
      probation_until: aut.probation_until as never,
      effective: aut.effective,
      lanes_eligible,
      r3_zones: [],
    },
    writes,
    affirmed: i.affirmed ?? {
      instructions: [],
      claims: {
        total_high_impact: 0,
        affirmed: 0,
        corrected: 0,
        unknown: 0,
        pct: 0,
        claims_hash: hashCanonical([]) as never,
      },
      intent: {
        answers_hash: hashCanonical([]) as never,
        attested_by: c1.owners[0] as PrincipalId,
      },
      operations: null,
    },
    controls: controls.value,
    security_summary: i.security,
    gaps: gaps.value,
    signer: i.signer,
    m4: null,
    issued_at: issued_at as never,
    fresh_until: new Date(i.now.getTime() + PRR_FRESH_DAYS * MS_PER_DAY).toISOString() as never,
    review_by:
      months === undefined
        ? null
        : (new Date(addMonthsUtc(issued_at, months)).toISOString() as never),
    freshness: {
      last_mechanical_check_at: issued_at as never,
      last_check_sha: census.baseline_sha,
      stale_areas: [],
    },
  };
  const sealed = sealPrr(body);
  const checked = ProjectReadinessRecord.safeParse(sealed);
  if (!checked.success) {
    const issues = checked.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`);
    const floor = issues.filter((x) => x.startsWith('gating_profile'));
    return floor.length > 0
      ? fail('gating_floor', floor.join('; '), issues)
      : fail('invalid_record', issues.join('; '), issues);
  }
  return ok(checked.data);
}
