import { z } from 'zod';
import { hashCanonical } from '@aisdlc/kernel';
import { ReadinessStatus } from '../states/readiness.js';
import { Autonomy, AutonomyValues, Lane, Level, LevelValues, Tier, TierValues } from '../values.js';
import { CatalogueRef } from './config.js';
import { PrrAffirmedFull } from './onboarding-full.js';
import { CRITERIA_SET_ID, CriterionClass, CriterionId } from './criteria.js';
import {
  AreaId,
  GitSha,
  IsoDateTime,
  LedgerEntryId,
  PrincipalId,
  RepoId,
  Sha256Hex,
  addMonthsUtc,
  daysBetween,
} from './ids.js';
import {
  GatingProfile,
  KillDelegation,
  RepoOwnerType,
  RepoPlan,
  RepoVisibility,
  RoleMap,
  TwoPerson,
  gatingFloorViolations,
} from './projects.js';

// Gaps (OB §7) and the Project Readiness Record `prr/1` (OB §2.4).

// ---------------------------------------------------------------- Gap

export const GapSeverity = z.enum(['blocking', 'tracked']);
export type GapSeverity = z.infer<typeof GapSeverity>;

/**
 * OB §7 names `file_issue` and `track_only` (the defaults) and a waiver (P-MUST-12); `waive` is the
 * disposition that carries a waiver. `null` on a gap means not yet disposed.
 */
export const GapDisposition = z.enum(['file_issue', 'track_only', 'waive']);
export type GapDisposition = z.infer<typeof GapDisposition>;
export const GapDispositionValues: readonly GapDisposition[] = GapDisposition.options;

/**
 * OB §7: a closed issue never closes a gap; a gap closes when the factory's re-check passes
 * (`closed_verified`). `waived` is a gap under a live waiver. `closed_unverified` is a state of the
 * issue link, not of the gap ("the gap stays open").
 */
export const GapStatus = z.enum(['open', 'closed_verified', 'waived']);
export type GapStatus = z.infer<typeof GapStatus>;
export const GapStatusValues: readonly GapStatus[] = GapStatus.options;

export const IssueLinkState = z.enum(['open', 'closed_verified', 'closed_unverified', 'lost']);
export type IssueLinkState = z.infer<typeof IssueLinkState>;

export const GapVisibilityClass = z.enum(['private_only', 'public_safe']);
export type GapVisibilityClass = z.infer<typeof GapVisibilityClass>;

/** OB §7: waivers last at most 90 days. */
export const MAX_WAIVER_DAYS = 90;

export const GapWaiver = z
  .strictObject({
    granted_by: PrincipalId,
    granted_at: IsoDateTime,
    expires_at: IsoDateTime,
    reason: z.string().min(1),
  })
  .refine((w) => daysBetween(w.granted_at, w.expires_at) > 0, {
    message: 'expires_at must be after granted_at',
    path: ['expires_at'],
  })
  .refine((w) => daysBetween(w.granted_at, w.expires_at) <= MAX_WAIVER_DAYS, {
    message: `a waiver lasts at most ${MAX_WAIVER_DAYS} days`,
    path: ['expires_at'],
  });
export type GapWaiver = z.infer<typeof GapWaiver>;

const GAP_ID_RE = /^gap:([A-Za-z0-9_.-]+):(RS-[A-Z]+(?:-\d+)?)(?::(.+))?$/;

/** `gap:<repo_id>:<criterion_id>[:<area>]`; one open gap per key. */
export function gapId(repoId: string, criterion: string, area?: string | null): string {
  return area === undefined || area === null
    ? `gap:${repoId}:${criterion}`
    : `gap:${repoId}:${criterion}:${area}`;
}

export function parseGapId(
  id: string,
): { repo_id: string; criterion: string; area: string | null } | null {
  const m = GAP_ID_RE.exec(id);
  if (m === null) return null;
  return { repo_id: m[1] ?? '', criterion: m[2] ?? '', area: m[3] ?? null };
}

export const GapId = z.string().regex(GAP_ID_RE, 'gap:<repo_id>:<criterion_id>[:<area>]');
export type GapId = z.infer<typeof GapId>;

export const Gap = z
  .strictObject({
    gap_id: GapId,
    repo_id: RepoId,
    criterion: CriterionId,
    area: AreaId.nullable(),
    severity: GapSeverity,
    /** The level this gap blocks: the requested level whose FLOOR it is. */
    blocks_level: Level.nullable(),
    disposition: GapDisposition.nullable(),
    status: GapStatus,
    /** The human-facing GitHub issue twin (a ref and a state, never a body). */
    issue: z.strictObject({ number: z.number().int().min(1), state: IssueLinkState }).nullable(),
    remediation_item_ref: z.string().min(1).nullable(),
    waiver: GapWaiver.nullable(),
    visibility_class: GapVisibilityClass,
  })
  .superRefine((g, ctx) => {
    const bad = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (g.gap_id !== gapId(g.repo_id, g.criterion, g.area)) {
      bad('gap_id', 'gap_id must be gap:<repo_id>:<criterion_id>[:<area>] of this gap');
    }
    if (g.severity === 'blocking' && g.blocks_level === null) {
      bad('blocks_level', 'a blocking gap names the level it blocks');
    }
    // OB §7: a blocking gap can never be waived at its own level. Fix it, or sign a lower level.
    if (
      g.severity === 'blocking' &&
      (g.waiver !== null || g.status === 'waived' || g.disposition === 'waive')
    ) {
      bad('waiver', 'a blocking gap can never be waived at its own level');
    }
    if ((g.disposition === 'waive') !== (g.waiver !== null)) {
      bad('waiver', 'disposition waive and a waiver go together');
    }
    if (g.status === 'waived' && g.waiver === null)
      bad('status', 'a waived gap carries its waiver');
    // OB §7: security findings are private_only and track_only always.
    if (g.criterion === 'RS-SEC') {
      if (g.visibility_class !== 'private_only')
        bad('visibility_class', 'security gaps are private_only');
      if (g.disposition === 'file_issue' || g.disposition === 'waive') {
        bad('disposition', 'security gaps are track_only always');
      }
      if (g.issue !== null) bad('issue', 'no issue for a security gap');
    }
  });
export type Gap = z.infer<typeof Gap>;

// ---------------------------------------------------------------- PRR parts

/** OB §2.4 `pillars[].pillar`: the four readiness pillars (not the criterion families). */
export const ReadinessPillar = z.enum(['VRL', 'ERL', 'ORL', 'KRL']);
export type ReadinessPillar = z.infer<typeof ReadinessPillar>;
export const ReadinessPillarValues: readonly ReadinessPillar[] = ReadinessPillar.options;

/** `0.2` and `0.3` are `not_requested` when skipped; 0.1, 0.4 and 0.5 always run (DEC-3). */
export const PrrStepState = z.enum(['done', 'not_requested']);
export type PrrStepState = z.infer<typeof PrrStepState>;

export const PrrRepo = z.strictObject({
  owner: z.string().min(1),
  name: z.string().min(1),
  repo_id: RepoId,
  visibility: RepoVisibility,
  owner_type: RepoOwnerType,
  /** The plan the owner attested on card 4 (`unknown` when they could not say). */
  plan: RepoPlan,
  default_branch: z.string().min(1),
  archetype: z.string().min(1).nullable(),
});

export const PrrPins = z.strictObject({
  catalogue: CatalogueRef,
  criteria_set: z
    .string()
    .regex(new RegExp(`^${CRITERIA_SET_ID}@\\S+$`), `${CRITERIA_SET_ID}@<version>`),
  detector_set: z.string().min(1),
  governance_cap_map: z.string().min(1),
});

/**
 * The floors judged per area (DEC-25(a)): an area reaches Light only where it holds tests the factory can run
 * (LF3 in that area), and Full only where FF1 holds for it (the area is on the system map and has a spec seed).
 * The repo-wide floors (LF1-LF8, FF2) were judged for the whole repo before M4; these only lower an area.
 */
export const AreaFloorId = z.enum(['LF3', 'FF1']);
export type AreaFloorId = z.infer<typeof AreaFloorId>;
export const AreaFloorState = z.enum(['met', 'unmet', 'unknown']);
export type AreaFloorState = z.infer<typeof AreaFloorState>;

export const PrrAreaFloor = z.strictObject({
  id: AreaFloorId,
  state: AreaFloorState,
  reason: z.string().min(1).max(200).nullable(),
});
export type PrrAreaFloor = z.infer<typeof PrrAreaFloor>;

/** One row of the per-area table M4 binds to (DEC-25(a)): the area's level, its floors and the lanes it opens. */
export const PrrArea = z.strictObject({
  area: AreaId,
  level: Level,
  floors: z.array(PrrAreaFloor),
  lanes: z.array(Lane),
});
export type PrrArea = z.infer<typeof PrrArea>;

export const PrrLevel = z.strictObject({
  requested: Level,
  signed: Level,
  /** Area to level, never above `signed`. One repo-wide area `.` until a Full baseline maps the areas. */
  by_area: z.record(AreaId, Level),
  /** The per-area table (DEC-25(a)), in the order of the system map. Absent on records before M17. */
  areas: z.array(PrrArea).optional(),
  steps: z.strictObject({
    '0.1': z.literal('done'),
    '0.2': PrrStepState,
    '0.3': PrrStepState,
    '0.4': z.literal('done'),
    '0.5': z.literal('done'),
  }),
});

export const PrrTier = z.strictObject({
  value: Tier,
  floor: Tier,
  raised_by: z.array(z.enum(['a9', 'owner'])),
  t0_attested: z.boolean(),
  risk_category_hash: Sha256Hex,
});

/** `met` is true, false or `unknown`; unknown counts as unmet. */
export const PrrCriterionResult = z.strictObject({
  id: CriterionId,
  class: CriterionClass,
  met: z.union([z.boolean(), z.literal('unknown')]),
  evidence_ref: z.string().min(1).nullable(),
  gap_id: GapId.optional(),
});

const RlLevel = z.number().int().min(0).max(4);

export const PrrPillar = z.strictObject({
  pillar: ReadinessPillar,
  level: RlLevel,
  criteria: z.array(PrrCriterionResult),
  /** Per-area levels. OB §2.4 writes `by_area` without a shape; area to level. */
  by_area: z.record(AreaId, RlLevel).optional(),
});
export type PrrPillar = z.infer<typeof PrrPillar>;

/** `gating_profile` of OB §1C plus whether the project deploys, which the G5 floor needs. */
export const PrrGatingProfile = GatingProfile.extend({
  /** `null` is unknown, which the floor treats as "deploys". OB §2.4 does not carry this field. */
  project_deploys: z.boolean().nullable(),
});
export type PrrGatingProfile = z.infer<typeof PrrGatingProfile>;

export const PrrRoleMap = z.strictObject({
  slots: RoleMap,
  kill_delegations: z.array(KillDelegation),
  two_person: TwoPerson,
  source: z.strictObject({
    codeowners_sha: GitSha.nullable(),
    collaborators_read_at: IsoDateTime.nullable(),
  }),
});

export const PrrAutonomy = z.strictObject({
  tier_cap: Autonomy,
  level_cap: Autonomy,
  readiness_cap: Autonomy,
  /** `null` is green: no constraint (OB §2.3). */
  posture_cap: Autonomy.nullable(),
  probation_until: IsoDateTime.nullable(),
  effective: Autonomy,
  lanes_eligible: z.array(Lane),
  /** Area globs with a critical unknown. */
  r3_zones: z.array(z.string().min(1)),
});

export const PrrWrites = z.enum(['none', 'docs', 'agent']);
export type PrrWrites = z.infer<typeof PrrWrites>;

export const PrrAffirmedInstruction = z.strictObject({
  area: AreaId,
  path: z.string().min(1),
  text_sha256: Sha256Hex,
  source_blob_sha: GitSha.optional(),
  lint_report_hash: Sha256Hex,
  /** `null` where the step-up is a plain card confirm (DEC-11(c-ii)). */
  step_up_ref: z.string().min(1).nullable(),
  sod_waiver: z.boolean(),
});

export const PrrClaims = z
  .strictObject({
    total_high_impact: z.number().int().min(0),
    affirmed: z.number().int().min(0),
    corrected: z.number().int().min(0),
    unknown: z.number().int().min(0),
    pct: z.number().min(0).max(100),
    claims_hash: Sha256Hex,
  })
  .refine((c) => c.affirmed + c.corrected + c.unknown <= c.total_high_impact, {
    message: 'affirmed + corrected + unknown exceeds the total',
    path: ['total_high_impact'],
  });

export const PrrAffirmed = z.strictObject({
  instructions: z.array(PrrAffirmedInstruction),
  claims: PrrClaims,
  intent: z.strictObject({ answers_hash: Sha256Hex, attested_by: PrincipalId }),
  operations: z.strictObject({ text_sha256: Sha256Hex, attested_by: PrincipalId }).nullable(),
  /** Full (M17): what card 3 decided, by hash and count. Absent below Full. */
  full: PrrAffirmedFull.optional(),
});

/** Observed at 0.4, never the factory's wishes. `null` where it could not be read (unknown). */
export const PrrControls = z.strictObject({
  effective_rules: z
    .strictObject({
      hash: Sha256Hex,
      required_checks: z.array(
        z.strictObject({
          name: z.string().min(1),
          integration_id: z.number().int().min(0).optional(),
        }),
      ),
      read_at: IsoDateTime,
    })
    .nullable(),
  attested: z.strictObject({
    bypass_has_no_factory_app: z.boolean(),
    app_scope_selected: z.boolean(),
    github_token_readonly: z.boolean(),
    at: IsoDateTime,
    by: PrincipalId,
  }),
  app_installation: z.strictObject({
    installation_id: z.number().int().min(0),
    repository_selection: z.enum(['all', 'selected']),
    permissions: z.record(z.string().min(1), z.enum(['read', 'write', 'admin'])),
  }),
  codeowners: z
    .strictObject({
      path: z.string().min(1),
      blob_sha: GitSha,
      errors: z.union([z.number().int().min(0), z.literal('unknown')]),
    })
    .nullable(),
  sensitive_paths_hash: Sha256Hex.nullable(),
  egress_request_ref: z.string().min(1).nullable(),
});

/** COUNTS ONLY: never a secret value or a fingerprint (OB §2.4, §5.3). */
export const PrrSecuritySummary = z.strictObject({
  history_scan: z.strictObject({
    status: z.enum(['ok', 'error']),
    refs_covered: z.enum(['all', 'default_only']),
    commits_scanned: z.number().int().min(0),
    truncated: z.boolean(),
    open: z.number().int().min(0),
    rotated: z.number().int().min(0),
    false_positive: z.number().int().min(0),
    /** A human accepted the finding as a test fixture (OB §5.2 B1): counted apart, never folded into another state. */
    accepted_test_fixture: z.number().int().min(0),
    rules_version: z.string().min(1),
  }),
});

export type PrrSecuritySummary = z.infer<typeof PrrSecuritySummary>;

export const SignerMode = z.enum(['solo', 'team']);
export type SignerMode = z.infer<typeof SignerMode>;

/** `role` is the role signed as; in SOLO the PRR still records which team-mode role would sign (TL, EM, FGB). */
export const PrrSigner = z.strictObject({
  principal: PrincipalId,
  role: z.string().min(1),
  mode: SignerMode,
  sod_waiver: z.boolean(),
});

/** Outside `record_hash`: it binds TO the record. `null` until an M4 decision exists. */
export const PrrM4 = z.strictObject({
  ledger_entry_id: LedgerEntryId,
  decision_hash: Sha256Hex,
});

export const PrrFreshness = z.strictObject({
  last_mechanical_check_at: IsoDateTime.nullable(),
  last_check_sha: GitSha.nullable(),
  stale_areas: z.array(AreaId),
});

// ---------------------------------------------------------------- PRR

export const PRR_SCHEMA_ID = 'prr/1';
/** `fresh_until` is `issued_at` plus this many days (OB §2.4). */
export const PRR_FRESH_DAYS = 90;
/** `review_by`: Light +3 months, Full +12 months (DED App. D §5). Census has none stated. */
export const PRR_REVIEW_MONTHS: Readonly<Partial<Record<Level, number>>> = { light: 3, full: 12 };

/** Fields outside `record_hash`. `record_hash` itself cannot hash itself, so it is excluded too. */
export const PRR_HASH_EXCLUDED = ['m4', 'status', 'freshness', 'record_hash'] as const;

/**
 * `record_hash` of a PRR (OB §2.4): sha256 of the canonical JSON of the record minus `m4`, `status`
 * and `freshness` (and minus `record_hash`, which holds the result). M4 binds to this hash, so a
 * status change or a mechanical freshness update leaves it as it was.
 */
export function prrRecordHash(prr: object): string {
  const excluded: readonly string[] = PRR_HASH_EXCLUDED;
  return hashCanonical(
    Object.fromEntries(Object.entries(prr).filter(([k]) => !excluded.includes(k))),
  );
}

export function prrRecordId(projectId: string, repoId: string): string {
  return `prr:${projectId}:${repoId}`;
}

/**
 * The `pins.governance_cap_map` of a record: the rule that sets the "earned" autonomy cap. No
 * governance earn rule exists yet (PLAN M5), so every record pins this one and its earned cap is
 * none; loosening past probation always needs a human (OB §2.3).
 */
export const PRR_GOVERNANCE_CAP_MAP = 'governance-caps/1';

const FORBIDDEN_KEY = /secret|fingerprint|hmac|password|private_key|api_key/i;

/** Key names that would carry a secret value or fingerprint, anywhere in the record. */
export function forbiddenKeys(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => forbiddenKeys(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) out.push(`${path}.${k}`);
      forbiddenKeys(v, `${path}.${k}`, out);
    }
  }
}

const rank = <T extends string>(order: readonly T[], v: T): number => order.indexOf(v);

const prrObject = z.strictObject({
  schema: z.literal(PRR_SCHEMA_ID),
  /** `prr:<project>:<repo_id>`. */
  record_id: z
    .string()
    .regex(/^prr:[a-z0-9][a-z0-9_-]*:[A-Za-z0-9_.-]+$/, 'prr:<project>:<repo_id>'),
  version: z.number().int().min(1),
  /** The `record_hash` of the version this one replaces. */
  supersedes: Sha256Hex.nullable(),
  status: ReadinessStatus,
  repo: PrrRepo,
  baseline_sha: GitSha,
  pins: PrrPins,
  level: PrrLevel,
  tier: PrrTier,
  pillars: z.array(PrrPillar).min(1),
  gating_profile: PrrGatingProfile,
  role_map: PrrRoleMap,
  /** The min of the pillar levels, never an average. */
  composite: RlLevel,
  autonomy: PrrAutonomy,
  /** SEC R2-8: a read-only Census may sign without B3; the docs role is not mintable when `none`. */
  writes: PrrWrites,
  affirmed: PrrAffirmed,
  controls: PrrControls,
  security_summary: PrrSecuritySummary,
  gaps: z.array(Gap),
  signer: PrrSigner,
  m4: PrrM4.nullable(),
  issued_at: IsoDateTime,
  fresh_until: IsoDateTime,
  /** `null` only where the level states none (Census). */
  review_by: IsoDateTime.nullable(),
  freshness: PrrFreshness,
  record_hash: Sha256Hex,
});

export const ProjectReadinessRecord = prrObject.superRefine((r, ctx) => {
  const bad = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

  // Identity of the record.
  const idParts = /^prr:([^:]+):(.+)$/.exec(r.record_id);
  if (idParts !== null && idParts[2] !== r.repo.repo_id) {
    bad(['record_id'], 'record_id names a different repo than repo.repo_id');
  }

  // Level: signed ≤ requested (OB §2.1). An open blocking gap blocks the level it names (OB §7).
  if (rank(LevelValues, r.level.signed) > rank(LevelValues, r.level.requested)) {
    bad(['level', 'signed'], 'the signed level cannot exceed the requested level');
  }
  r.gaps.forEach((g, i) => {
    if (
      g.severity === 'blocking' &&
      g.status === 'open' &&
      g.blocks_level !== null &&
      rank(LevelValues, r.level.signed) >= rank(LevelValues, g.blocks_level)
    ) {
      bad(['gaps', i], `an open blocking gap blocks ${g.blocks_level}; sign a lower level`);
    }
    if (g.repo_id !== r.repo.repo_id) bad(['gaps', i, 'repo_id'], 'gap belongs to another repo');
  });
  const gapIds = new Set(r.gaps.map((g) => g.gap_id));
  if (gapIds.size !== r.gaps.length) bad(['gaps'], 'one gap per gap_id');

  // Tier: the floor is raise-only. T2 locks two-person on and gets the gating floor and no waiver.
  if (rank(TierValues, r.tier.value) < rank(TierValues, r.tier.floor)) {
    bad(['tier', 'value'], 'the tier can only be raised above its floor');
  }
  if (r.tier.value === 'T2') {
    if (!(r.role_map.two_person.locked_on && r.role_map.two_person.enabled)) {
      bad(['role_map', 'two_person'], 'a T2 project has two-person locked on');
    }
    if (r.signer.sod_waiver) bad(['signer', 'sod_waiver'], 'sod_waiver is never stamped for T2');
  }
  for (const v of gatingFloorViolations(r.gating_profile, {
    tier: r.tier.value,
    deploys: r.gating_profile.project_deploys,
  })) {
    bad(['gating_profile'], v);
  }

  // Pillars and composite.
  const seen = new Set<string>();
  r.pillars.forEach((p, i) => {
    if (seen.has(p.pillar)) bad(['pillars', i, 'pillar'], 'one entry per pillar');
    seen.add(p.pillar);
    p.criteria.forEach((c, j) => {
      if (c.gap_id !== undefined && !gapIds.has(c.gap_id)) {
        bad(['pillars', i, 'criteria', j, 'gap_id'], 'gap_id is not in gaps');
      }
    });
  });
  if (r.composite !== Math.min(...r.pillars.map((p) => p.level))) {
    bad(['composite'], 'composite is the min of the pillar levels');
  }

  // Autonomy: effective is at most every cap (caps only tighten, OB §2.3).
  const a = r.autonomy;
  const caps = [a.tier_cap, a.level_cap, a.readiness_cap, a.posture_cap].filter(
    (c): c is Autonomy => c !== null,
  );
  for (const c of caps) {
    if (rank(AutonomyValues, a.effective) > rank(AutonomyValues, c)) {
      bad(['autonomy', 'effective'], `effective autonomy exceeds the cap ${c}`);
    }
  }
  if (
    a.probation_until !== null &&
    Date.parse(a.probation_until) > Date.parse(r.issued_at) &&
    rank(AutonomyValues, a.effective) > rank(AutonomyValues, 'A1')
  ) {
    bad(['autonomy', 'effective'], 'probation caps autonomy at A1');
  }

  // Only an M4 decision makes a version active, so every status past proposed has one.
  if (r.status !== 'proposed' && r.m4 === null) {
    bad(['m4'], `status ${r.status} needs the M4 decision it was made by`);
  }

  // Freshness windows.
  const issued = Date.parse(r.issued_at);
  const fresh = Date.parse(r.fresh_until);
  if (!(fresh > issued) || daysBetween(r.issued_at, r.fresh_until) > PRR_FRESH_DAYS) {
    bad(['fresh_until'], `fresh_until is after issued_at and at most ${PRR_FRESH_DAYS} days later`);
  }
  const months = PRR_REVIEW_MONTHS[r.level.signed];
  if (months !== undefined) {
    if (r.review_by === null) bad(['review_by'], `review_by is required at ${r.level.signed}`);
    else if (
      !(Date.parse(r.review_by) > issued) ||
      Date.parse(r.review_by) > addMonthsUtc(r.issued_at, months)
    ) {
      bad(['review_by'], `review_by is after issued_at and at most ${months} months later`);
    }
  }

  // Never a secret value or fingerprint anywhere in the record.
  const hits: string[] = [];
  forbiddenKeys(r, '$', hits);
  for (const h of hits) bad([], `field ${h} would carry a secret or fingerprint`);

  // The hash binds the content.
  if (r.record_hash !== prrRecordHash(r)) {
    bad(['record_hash'], 'record_hash does not match the record');
  }
});
export type ProjectReadinessRecord = z.infer<typeof ProjectReadinessRecord>;

/** A PRR without its hash: what a builder assembles before sealing. */
export type PrrBody = Omit<ProjectReadinessRecord, 'record_hash'>;

/** Adds the `record_hash` of `body`. */
export function sealPrr(body: PrrBody): ProjectReadinessRecord {
  return { ...body, record_hash: prrRecordHash(body) };
}
