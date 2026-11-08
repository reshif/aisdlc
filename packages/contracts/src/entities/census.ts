import { z } from 'zod';
import { hashCanonical } from '@aisdlc/kernel';
import { Level, LevelValues, Tier } from '../values.js';
import { BundleRefs, RepoFullName } from './codehost.js';
import { CatalogueRef } from './config.js';
import {
  CRITERIA_SET_ID,
  CriterionClass,
  CriterionId,
  CriterionPillar,
  FloorId,
} from './criteria.js';
import {
  DetectedTierCriterion,
  DetectorEvidence,
  DetectorId,
  DetectorSetVersion,
  InventoryKind,
  InventoryState,
  TierSignalId,
} from './detectors.js';
import { AreaId, GitSha, PrincipalId, RepoId, Sha256Hex } from './ids.js';
import { RepoOwnerType, RepoVisibility } from './projects.js';
import {
  Gap,
  GapId,
  PrrSecuritySummary,
  ReadinessPillar,
  SignerMode,
  forbiddenKeys,
} from './readiness.js';

// The Census record (PLAN M6.5; OB §2.1-§2.4, §3.1-§3.3, §5.1-§5.2, §6.2 row 0.1, §7; DM §3.2,
// §3.7). Everything step 0.1 produces, assembled by a PURE function from the job's result: the
// repo identity, the pins, the RiskCategory with its evidence, the posture and the blockers, every
// criterion of the catalogue evaluated at the requested level, the floors, the pillar pre-score,
// the probe state, the instruction/harness inventory summary and gap ledger v1. M7.4 (the PRR
// builder) reads this record. It holds no timestamp and no secret: the same inputs give the same
// bytes, and findings appear as COUNTS only.

export const CENSUS_SCHEMA_ID = 'census/1';

/**
 * Version of the assembly rules in this file's consumers (N/A rules, scoring rule, blocker rules).
 * Bumped by hand when what the assembly concludes from the same facts changes; pinned in the record.
 */
export const CENSUS_ASSEMBLY_VERSION = 'census-rules/1';

/** The Census judges one repo-wide area (OB §2.1: "The testbed signs one repo-wide area"). */
export const CENSUS_AREA = '.';

export const censusId = (repoId: string, baselineSha: string): string =>
  `census:${repoId}:${baselineSha}`;

// ---------------------------------------------------------------- Mapping and N/A rules

/**
 * The specs do not map the eleven criterion families (OB §3.3 "Pillar") onto the four readiness
 * pillars VRL/ERL/ORL/KRL (see `CriterionPillar`). This is the Census's choice, in one place:
 *   VRL  verification: can the agent check its own work (build/test, style, tests)
 *   ERL  environment: is the place the agent works safe and controlled (egress, security, change control)
 *   ORL  ownership and operations (identity and owner, operations, public-facing process)
 *   KRL  knowledge: what the agent is told and can read (instructions, knowledge)
 */
export const READINESS_PILLAR_OF_FAMILY: Readonly<Record<CriterionPillar, ReadinessPillar>> = {
  BT: 'VRL',
  ST: 'VRL',
  TH: 'VRL',
  EN: 'ERL',
  SEC: 'ERL',
  CC: 'ERL',
  ID: 'ORL',
  OP: 'ORL',
  PUB: 'ORL',
  AI: 'KRL',
  KN: 'KRL',
};

/**
 * The ONLY ways a criterion is N/A (OB §3.1: "N/A comes only from a written deterministic rule,
 * never from agent judgement"). Anything else is met, unmet or unknown.
 */
export const CENSUS_NA_RULES = {
  'NA-LEVEL': 'the catalogue shows "—" for this criterion at the requested level',
  'NA-PUBLIC-OR-USER-REPO':
    'RS-CC-5: the catalogue says N/A on public or user-owned repos, and the repo is one',
  'NA-NO-NESTED-AGENTS': 'RS-AI-6: it applies "if present", and no nested AGENTS.md exists',
  'NA-NO-MANIFEST': 'RS-BT-3: no package manifest was detected, so there is nothing to lock',
} as const;
export const CensusNaRule = z.enum(
  Object.keys(CENSUS_NA_RULES) as [
    keyof typeof CENSUS_NA_RULES,
    ...(keyof typeof CENSUS_NA_RULES)[],
  ],
);
export type CensusNaRule = z.infer<typeof CensusNaRule>;

// ---------------------------------------------------------------- Inputs the Census cannot read from a bundle

const PermissionLevel = z.enum(['read', 'write', 'admin']);

/**
 * What the assembly takes besides the job's result: facts that come from the code host (B4, CF1,
 * CF4) and from humans (card 1 and card 4). Every field is optional and an absent field is
 * UNKNOWN, which counts as unmet (fail closed). Nothing here is ever read from the repo.
 */
export const CensusAttestations = z.strictObject({
  /** The factory's repo id (DM leaves it open). Default: `<owner>.<name>`, lowercase. */
  repo_id: RepoId.optional(),
  /** Project mode; default `solo`. `team` raises RS-CC-1/2 (and RS-PUB-1/2 on public repos) to FLOOR. */
  mode: SignerMode.optional(),
  /** Read from the code host (RS-ID-4, CF4). */
  repo: z
    .strictObject({
      visibility: RepoVisibility,
      owner_type: RepoOwnerType,
      plan: z.string().min(1).nullable(),
    })
    .optional(),
  /** The App installation as the code host reports it (RS-ID-1, B4). */
  installation: z
    .strictObject({
      repository_selection: z.enum(['all', 'selected']),
      permissions: z.record(z.string().min(1), PermissionLevel),
    })
    .optional(),
  /** Required checks of the default branch; `null` is "could not be read". Needed by B4b. */
  required_checks: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        integration_id: z.number().int().min(0).optional(),
      }),
    )
    .nullable()
    .optional(),
  /** Observed at the reduced 0.4 (RS-CC-3, RS-CC-4); `bypass_attested` is the H attestation. */
  protect_main: z.boolean().optional(),
  app_push_agent_only: z.boolean().optional(),
  bypass_attested: z.boolean().optional(),
  /** Card 1: the owner confirmed (RS-ID-2). */
  owner_confirmed: z.strictObject({ by: PrincipalId }).optional(),
  /** Card 1: the tier as signed, and which attestations stand behind it (RS-ID-3, DEC-4). */
  tier: z
    .strictObject({
      signed: Tier,
      regulatory_attested: z.boolean(),
      criticality_attested: z.boolean(),
      t0_attested: z.boolean(),
    })
    .optional(),
  /** Card 4 at Light: `operations.md` attested (RS-OP-2, closes B6). */
  operations_attested: z.boolean().optional(),
  /** Card 4: egress needs declared (RS-EN-1). */
  egress_declared: z.boolean().optional(),
});
export type CensusAttestations = z.input<typeof CensusAttestations>;

// ---------------------------------------------------------------- Parts

/** Where a conclusion came from. Never a repo value, never a finding location. */
export const CensusEvidence = z.strictObject({
  source: z.enum(['intake', 'scan', 'detector', 'codehost', 'attestation']),
  /** A token: `fact:workflow_finding`, `scan:finding_counts`, `attestation:owner_confirmed`, `absent:agents_md`. */
  ref: z.string().min(1).max(120),
  path: z.string().min(1).optional(),
  blob: GitSha.optional(),
  line: z.number().int().min(1).optional(),
});
export type CensusEvidence = z.infer<typeof CensusEvidence>;

/** At most this many evidence items are listed per conclusion. */
export const MAX_CENSUS_EVIDENCE = 20;

export const CensusRepo = z.strictObject({
  full_name: RepoFullName,
  owner: z.string().min(1),
  name: z.string().min(1),
  repo_id: RepoId,
  /** `null`: not supplied by the code host (unknown). */
  visibility: RepoVisibility.nullable(),
  owner_type: RepoOwnerType.nullable(),
  plan: z.string().min(1).nullable(),
  /** The branch the head belongs to (from the mirror); `null` if it could not be told. */
  default_branch: z.string().min(1).nullable(),
  archetype: z.string().min(1).nullable(),
});
export type CensusRepo = z.infer<typeof CensusRepo>;

export const CensusPins = z.strictObject({
  catalogue: CatalogueRef,
  /** `CRITERIA_V2@<catalogue version>`. */
  criteria_set: z.string().regex(new RegExp(`^${CRITERIA_SET_ID}@\\S+$`)),
  /** `null`: the result was recorded before detectors existed. */
  detector_set_version: DetectorSetVersion.nullable(),
  /** The secret ruleset version the scan ran with. */
  rules_version: z.string().min(1),
  assembly: z.literal(CENSUS_ASSEMBLY_VERSION),
});
export type CensusPins = z.infer<typeof CensusPins>;

export const BlockerId = z.enum(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
export type BlockerId = z.infer<typeof BlockerId>;
export const BlockerIdValues: readonly BlockerId[] = BlockerId.options;
/** `unknown` counts as open for posture (fail closed). `not_evaluated`: not decided at Census (B3). */
export const BlockerStatus = z.enum(['met', 'blocked', 'unknown', 'not_evaluated']);
export type BlockerStatus = z.infer<typeof BlockerStatus>;

export const CensusBlocker = z.strictObject({
  id: BlockerId,
  status: BlockerStatus,
  /** Cause codes (`scan_error`, `cap_reached`, `B4a`, `pr_target_head_checkout`...). Never repo text. */
  reasons: z.array(z.string().min(1)),
  /** Carried to a higher level or shown on a card, but not a blocker now (`refs_default_only` at Census). */
  notes: z.array(z.string().min(1)),
  evidence: z.array(CensusEvidence),
});
export type CensusBlocker = z.infer<typeof CensusBlocker>;

export const PostureState = z.enum(['red', 'amber', 'green']);
export type PostureState = z.infer<typeof PostureState>;

export const AmberCode = z.enum(['b5_amber_workflow', 'no_lockfile', 'b4c_statuses_pinned']);
export type AmberCode = z.infer<typeof AmberCode>;

export const PostureReason = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('blocker'),
    blocker: BlockerId.extract(['B1', 'B2', 'B3', 'B4', 'B5']),
    status: z.enum(['blocked', 'unknown']),
    codes: z.array(z.string().min(1)),
    evidence: z.array(CensusEvidence),
  }),
  z.strictObject({
    kind: z.literal('amber'),
    code: AmberCode,
    count: z.number().int().min(1),
    evidence: z.array(CensusEvidence),
  }),
]);
export type PostureReason = z.infer<typeof PostureReason>;

export const CensusPosture = z.strictObject({
  /** Red: any B1-B5 open (blocked or unknown). Amber: a high-severity remediable item. Else green (OB §5.2). */
  state: PostureState,
  reasons: z.array(PostureReason),
  /** B7: only K-exec counts, so the probe is `pending` here. */
  b7: z.literal('probe_pending'),
});
export type CensusPosture = z.infer<typeof CensusPosture>;

export const CensusTierSignal = z.strictObject({
  signal: TierSignalId,
  criterion: DetectedTierCriterion,
  floor: Tier.extract(['T1', 'T2']),
  raised_by: DetectorId,
  evidence: z.array(DetectorEvidence),
});

export const RiskBlocksReason = z.enum([
  't0_unattested',
  'regulatory_unattested',
  'criticality_unattested',
  'detectors_incomplete',
]);

export const CensusRiskCategory = z
  .strictObject({
    /** The detector floor; raise-only afterwards (OB §2.2). */
    tier_floor: Tier,
    signals: z.array(CensusTierSignal),
    /** The detectors whose signals raised the floor, sorted. */
    raised_by: z.array(DetectorId),
    /** Owner attestation only; never inferred, never defaulted to a value. */
    regulatory: z.enum(['unattested', 'attested']),
    criticality: z.enum(['unattested', 'attested']),
    t0: z.enum(['unattested', 'attested', 'not_applicable']),
    /** `incomplete`: a detector failed or its facts were cut, so the floor is a lower bound. */
    floor_basis: z.enum(['complete', 'incomplete']),
    blocks_m4_until_attested: z.boolean(),
    blocks_m4_reasons: z.array(RiskBlocksReason),
  })
  .refine((r) => r.blocks_m4_until_attested === r.blocks_m4_reasons.length > 0, {
    message: 'blocks_m4_until_attested holds exactly when there are reasons',
    path: ['blocks_m4_until_attested'],
  });
export type CensusRiskCategory = z.infer<typeof CensusRiskCategory>;

export const CensusCriterionStatus = z.enum(['met', 'unmet', 'unknown', 'na']);
export type CensusCriterionStatus = z.infer<typeof CensusCriterionStatus>;
/** What the evidence shows, before the level decides what it means. */
export const CensusObserved = z.enum(['pass', 'fail', 'unknown']);
export type CensusObserved = z.infer<typeof CensusObserved>;

export const CensusCriterionResult = z.strictObject({
  id: CriterionId,
  /** The criterion family (OB §3.3 "Pillar"). */
  family: CriterionPillar,
  pillar: ReadinessPillar,
  /** The class at the requested level (team escalation applied); `null` where N/A by level. */
  class: CriterionClass.nullable(),
  escalated: z.boolean(),
  /** The class the pre-score uses: the requested level's, but Light's at Census. */
  scoring_class: CriterionClass.nullable(),
  status: CensusCriterionStatus,
  observed: CensusObserved,
  na_rule: CensusNaRule.nullable(),
  reasons: z.array(z.string().min(1)),
  evidence: z.array(CensusEvidence),
  gap_id: GapId.optional(),
});
export type CensusCriterionResult = z.infer<typeof CensusCriterionResult>;

export const FloorStatus = z.enum(['met', 'unmet', 'unknown', 'not_evaluated']);
export type FloorStatus = z.infer<typeof FloorStatus>;

export const CensusFloor = z.strictObject({
  id: FloorId,
  status: FloorStatus,
  criteria: z.array(CriterionId),
});
export type CensusFloor = z.infer<typeof CensusFloor>;

const RlLevel = z.number().int().min(0).max(4);

export const CensusPillar = z.strictObject({
  pillar: ReadinessPillar,
  level: RlLevel,
  by_area: z.record(AreaId, RlLevel),
  /** The criteria of this pillar, in catalogue order. */
  criteria: z.array(CriterionId),
  floors_open: z.number().int().min(0),
  measured: z.number().int().min(0),
  total: z.number().int().min(0),
  scored_pass: z.number().int().min(0),
  scored_total: z.number().int().min(0),
  all_pass: z.boolean(),
});
export type CensusPillar = z.infer<typeof CensusPillar>;

export const CensusPreScore = z.strictObject({
  /** The level whose classes the pre-score used (`light` at Census: the readiness a Light request would see). */
  basis_level: Level,
  pillars: z.array(CensusPillar),
  /** The min of the pillar levels, never an average. */
  composite: RlLevel,
});
export type CensusPreScore = z.infer<typeof CensusPreScore>;

export const CensusProbe = z.strictObject({
  state: z.literal('pending'),
  blocker: z.literal('B7'),
  /** Only a run in K-exec counts; nothing in the Census ran anything. */
  counts_only_in: z.literal('K-exec'),
});
export type CensusProbe = z.infer<typeof CensusProbe>;

export const CensusInventoryKind = z.strictObject({
  inventory: InventoryKind,
  state: InventoryState,
  file_count: z.number().int().min(0),
  auto_run: z.enum(['yes', 'no', 'unknown', 'not_applicable']),
});

export const CensusInventory = z.strictObject({
  /** `incomplete`: the inventory detector failed or was cut, so absent kinds are not "none". */
  status: z.enum(['complete', 'incomplete']),
  kinds: z.array(CensusInventoryKind),
  files_total: z.number().int().min(0),
  /** Kinds that run code on their own (`auto_run: yes`). */
  auto_run_kinds: z.array(InventoryKind),
  agents: z
    .strictObject({
      root_present: z.boolean().nullable(),
      root_lines: z.number().int().min(0).nullable(),
      chain_bytes: z.number().int().min(0).nullable(),
      nested: z.number().int().min(0).nullable(),
    })
    .nullable(),
});
export type CensusInventory = z.infer<typeof CensusInventory>;

export const CensusDetectorsSummary = z.strictObject({
  status: z.enum(['ok', 'error']),
  error_codes: z.array(z.string().min(1)),
  facts_truncated: z.boolean(),
  fact_counts: z.record(z.string(), z.number().int().min(0)),
  lint: z.strictObject({
    docs_linted: z.number().int().min(0),
    blocking: z.number().int().min(0),
    advisory: z.number().int().min(0),
  }),
});
export type CensusDetectorsSummary = z.infer<typeof CensusDetectorsSummary>;

// ---------------------------------------------------------------- The record

const censusObject = z.strictObject({
  schema: z.literal(CENSUS_SCHEMA_ID),
  /** `census:<repo_id>:<baseline_sha>`: also the record stream. */
  census_id: z.string().regex(/^census:[A-Za-z0-9_.-]+:[0-9a-f]{40}$/),
  repo: CensusRepo,
  /** The manifest's head: the commit every fact was read at. */
  baseline_sha: GitSha,
  requested_level: Level,
  pins: CensusPins,
  refs_covered: BundleRefs,
  /** Counts only; `accepted_test_fixture` has its own field (decided at M6.5). */
  security_summary: PrrSecuritySummary,
  risk_category: CensusRiskCategory,
  posture: CensusPosture,
  blockers: z.array(CensusBlocker),
  criteria: z.array(CensusCriterionResult),
  floors: z.array(CensusFloor),
  pre_score: CensusPreScore,
  probe: CensusProbe,
  inventory: CensusInventory,
  detectors: CensusDetectorsSummary.nullable(),
  coverage_counts: z.record(z.string(), z.number().int().min(0)),
  /** Gap ledger v1: one per unmet or unknown criterion, one repo-wide area. */
  gaps: z.array(Gap),
  /** sha256 of the canonical JSON of this record minus this field. */
  census_hash: Sha256Hex,
});

/** The hash of a Census (`census_hash`): the canonical JSON of the record minus the hash itself. */
export function censusHash(census: object): string {
  return hashCanonical(
    Object.fromEntries(Object.entries(census).filter(([k]) => k !== 'census_hash')),
  );
}

const rank = <T extends string>(order: readonly T[], v: T): number => order.indexOf(v);

export const CensusRecord = censusObject.superRefine((c, ctx) => {
  const bad = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  if (c.census_id !== censusId(c.repo.repo_id, c.baseline_sha)) {
    bad(['census_id'], 'census_id is census:<repo_id>:<baseline_sha>');
  }
  const ids = c.criteria.map((r) => r.id);
  if (new Set(ids).size !== ids.length) bad(['criteria'], 'one result per criterion');
  const gapIds = new Set(c.gaps.map((g) => g.gap_id));
  if (gapIds.size !== c.gaps.length) bad(['gaps'], 'one gap per gap_id');
  c.gaps.forEach((g, i) => {
    if (g.repo_id !== c.repo.repo_id) bad(['gaps', i, 'repo_id'], 'gap belongs to another repo');
    if (g.area !== CENSUS_AREA) bad(['gaps', i, 'area'], `the Census has one area, ${CENSUS_AREA}`);
    if (g.status !== 'open') bad(['gaps', i, 'status'], 'a new gap is open');
    if (g.severity === 'blocking' && g.blocks_level !== c.requested_level) {
      bad(['gaps', i, 'blocks_level'], 'a blocking gap blocks the requested level');
    }
  });
  c.criteria.forEach((r, i) => {
    if (r.gap_id !== undefined && !gapIds.has(r.gap_id)) {
      bad(['criteria', i, 'gap_id'], 'gap_id is not in gaps');
    }
    if ((r.status === 'na') !== (r.na_rule !== null)) {
      bad(['criteria', i, 'na_rule'], 'N/A comes with its rule, and only then');
    }
  });
  if (c.pre_score.composite !== Math.min(...c.pre_score.pillars.map((p) => p.level))) {
    bad(['pre_score', 'composite'], 'composite is the min of the pillar levels');
  }
  if (rank(LevelValues, c.pre_score.basis_level) < rank(LevelValues, c.requested_level)) {
    bad(['pre_score', 'basis_level'], 'the pre-score basis is at least the requested level');
  }
  const red = c.posture.reasons.some((r) => r.kind === 'blocker');
  const amber = c.posture.reasons.some((r) => r.kind === 'amber');
  if (c.posture.state !== (red ? 'red' : amber ? 'amber' : 'green')) {
    bad(
      ['posture', 'state'],
      'posture is red on any open B1-B5, else amber on an amber item, else green',
    );
  }
  const hits: string[] = [];
  forbiddenKeys(c, '$', hits);
  for (const h of hits) bad([], `field ${h} would carry a secret or fingerprint`);
  if (c.census_hash !== censusHash(c))
    bad(['census_hash'], 'census_hash does not match the record');
});
export type CensusRecord = z.infer<typeof CensusRecord>;

/** A Census without its hash: what the assembly builds before sealing. */
export type CensusBody = Omit<CensusRecord, 'census_hash'>;

export function sealCensus(body: CensusBody): CensusRecord {
  return { ...body, census_hash: censusHash(body) };
}

// ---------------------------------------------------------------- Event and HTTP shapes

/** `census.assembled` on stream `census:<repo_id>:<baseline_sha>`; the whole record rides on the event. */
export const CensusAssembledPayload = z.strictObject({
  job_id: z.string().min(1),
  repo: RepoFullName,
  census_hash: Sha256Hex,
  census: CensusRecord,
});
export type CensusAssembledPayload = z.infer<typeof CensusAssembledPayload>;

/** `GET /v1/repos/:owner/:name/census/latest`: the record and its gap ledger (counts-only security). */
export const CensusLatest = z.strictObject({
  census_id: z.string().min(1),
  census_hash: Sha256Hex,
  job_id: z.string().min(1),
  assembled_at: z.iso.datetime(),
  census: CensusRecord,
  /** The same list as `census.gaps`. */
  gaps: z.array(Gap),
});
export type CensusLatest = z.infer<typeof CensusLatest>;
