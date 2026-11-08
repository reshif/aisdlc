import { z } from 'zod';
import { defineMachine, type TransitionTable } from '../states/machine.js';
import { BundleManifest, BundleRefs, RepoFullName } from './codehost.js';
import { DetectorsResult } from './detectors.js';
import { GitSha, IsoDateTime, PrincipalId, Sha256Hex, uuidId } from './ids.js';
import { PrrSecuritySummary } from './readiness.js';

// Knowledge (PLAN M6.1, M6.2; OB §5.3, §6.5 "Bytes flow", DEC-5): bundle intake into a hardened
// bare mirror, coverage items, the secret scan's coverage, and the human-only finding states.
// One vocabulary for `services/knowledge`, the census (M6.5) and the portal. The knowledge
// container holds no code-host credential and no HMAC key (DEC-5 condition 1).

// ---------------------------------------------------------------- Ids, streams, events

export const KnowledgeJobId = uuidId<'KnowledgeJob'>();
export type KnowledgeJobId = z.infer<typeof KnowledgeJobId>;
export const FindingId = uuidId<'SecurityFinding'>();
export type FindingId = z.infer<typeof FindingId>;

export const kjobStream = (id: string): string => `kjob:${id}`;
export const findingStream = (id: string): string => `finding:${id}`;

export const KNOWLEDGE_EVENT = {
  job_queued: 'kjob.queued',
  job_started: 'kjob.started',
  job_done: 'kjob.done',
  job_error: 'kjob.error',
  finding_detected: 'finding.detected',
  finding_state_changed: 'finding.state_changed',
} as const;

// ---------------------------------------------------------------- Caps (DEC-5 condition 2)

/** Defaults of the caps; each is configurable per deployment, and a cap that bites is recorded. */
export const KNOWLEDGE_DEFAULTS = {
  /** Commits walked by the secret scan (OB §11 row 2: raised from 5000, recorded, never silent). */
  commit_cap: 50_000,
  /** Largest blob read and scanned; a bigger one is a `file_over_cap` coverage item. */
  max_file_bytes: 5 * 1024 * 1024,
  /** One job, intake and scan together. */
  job_timeout_ms: 600_000,
} as const;

// ---------------------------------------------------------------- Job

export const KnowledgeJobKind = z.enum(['census_intake']);
export type KnowledgeJobKind = z.infer<typeof KnowledgeJobKind>;

/** `queued -> running -> done | error`; a queued job that cannot start (restart) is `error` too. */
export const KnowledgeJobState = z.enum(['queued', 'running', 'done', 'error']);
export type KnowledgeJobState = z.infer<typeof KnowledgeJobState>;
export const KNOWLEDGE_JOB_TRANSITIONS: TransitionTable<KnowledgeJobState> = {
  queued: ['running', 'error'],
  running: ['done', 'error'],
  done: [],
  error: [],
};
export const KnowledgeJobMachine = defineMachine('KnowledgeJob', KNOWLEDGE_JOB_TRANSITIONS);

export const StartCensusIntakeRequest = z.strictObject({
  repo: RepoFullName,
  /** Default `all`. */
  refs: BundleRefs.optional(),
  /** The head the bundle must end at. Absent: the default branch's head when the bundle is made. */
  base_sha: GitSha.optional(),
});
export type StartCensusIntakeRequest = z.infer<typeof StartCensusIntakeRequest>;

// ---------------------------------------------------------------- Coverage

/**
 * What the intake or the scan did not look at, and why (DEC-5 condition 2: never silently
 * skipped). `lfs_pointer` and `submodule` are listed as unscanned.
 */
export const CoverageKind = z.enum([
  'file_over_cap',
  'lfs_pointer',
  'submodule',
  'unreadable_object',
  'commit_cap',
  'time_cap',
  'list_truncated',
  /** A detector could not parse a file (broken YAML, JSON, TOML): its facts are missing, not "none". */
  'unparseable_file',
  /** A file is over a parser limit (size, alias count): not parsed. */
  'parse_limit',
  /** A detector stopped at its file-count cap: its heuristic saw only part of the tree. */
  'detector_cap',
]);
export type CoverageKind = z.infer<typeof CoverageKind>;

export const CoverageItem = z.strictObject({
  kind: CoverageKind,
  /** The path in the tree (head tree or the first path the object was seen at), if there is one. */
  path: z.string().min(1).nullable(),
  /** The git object id, if there is one. */
  object: GitSha.nullable(),
  reason: z.string().min(1).max(500),
});
export type CoverageItem = z.infer<typeof CoverageItem>;

/** At most this many items are listed; `coverage_counts` always counts all of them. */
export const MAX_COVERAGE_ITEMS = 5000;

export const RefEntry = z.strictObject({ name: z.string().min(1), sha: GitSha });
export type RefEntry = z.infer<typeof RefEntry>;

/** OB §5.3 item 1: refs, commit count, cap reached, LFS unscanned, submodules listed. */
export const ScanCoverage = z.strictObject({
  /** From the codehost's manifest: what the bundle covers, never assumed from the request. */
  refs_covered: BundleRefs,
  ref_count: z.number().int().min(0),
  commits_scanned: z.number().int().min(0),
  blobs_scanned: z.number().int().min(0),
  truncated: z.boolean(),
  cap_reached: z.boolean(),
  lfs_unscanned: z.number().int().min(0),
  submodules_listed: z.number().int().min(0),
  rules_version: z.string().min(1),
});
export type ScanCoverage = z.infer<typeof ScanCoverage>;

export const ScanStatus = z.enum(['ok', 'error']);
export type ScanStatus = z.infer<typeof ScanStatus>;

export const ScanError = z.strictObject({
  /** Why the scan could not complete. Never a value from the repo. */
  code: z.enum([
    'git_failed',
    'parse_failed',
    'unreadable_object',
    'timeout',
    'fingerprint_unavailable',
    'store_failed',
  ]),
  message: z.string().min(1).max(500),
});
export type ScanError = z.infer<typeof ScanError>;

// ---------------------------------------------------------------- Findings (Security-only)

/** `open -> rotated | false_positive | accepted_test_fixture`, set only by a human (OB §5.3 items 6, 11). */
export const FindingState = z.enum(['open', 'rotated', 'false_positive', 'accepted_test_fixture']);
export type FindingState = z.infer<typeof FindingState>;
export const FINDING_TRANSITIONS: TransitionTable<FindingState> = {
  open: ['rotated', 'false_positive', 'accepted_test_fixture'],
  rotated: [],
  false_positive: [],
  accepted_test_fixture: [],
};
export const FindingMachine = defineMachine('Finding', FINDING_TRANSITIONS);

export const FindingCounts = z.strictObject({
  open: z.number().int().min(0),
  rotated: z.number().int().min(0),
  false_positive: z.number().int().min(0),
  accepted_test_fixture: z.number().int().min(0),
});
export type FindingCounts = z.infer<typeof FindingCounts>;

export const FindingLocation = z.strictObject({
  blob_id: GitSha,
  /** Every path the blob was seen at in the scan (a few at most). */
  paths: z.array(z.string().min(1)),
  line: z.number().int().min(1),
  /** The oldest commit (in scan order) that introduced the blob; `null` if only a tag or ref holds it. */
  first_commit: GitSha.nullable(),
});
export type FindingLocation = z.infer<typeof FindingLocation>;

/**
 * A finding as the Security-only store holds it. It carries the HMAC fingerprint and never the
 * value. Findings are written to the `security_findings` schema and read only with the `security`
 * scope; they never reach the knowledge index, a pack, a job result or the PRR.
 */
export const SecurityFinding = z.strictObject({
  finding_id: FindingId,
  repo: RepoFullName,
  rule_id: z.string().min(1),
  fingerprint: Sha256Hex,
  state: FindingState,
  first_job_id: KnowledgeJobId,
  first_commit: GitSha.nullable(),
  locations: z.array(FindingLocation),
  state_changed_by: PrincipalId.nullable(),
  state_changed_at: IsoDateTime.nullable(),
  state_reason: z.string().nullable(),
  detected_at: IsoDateTime,
});
export type SecurityFinding = z.infer<typeof SecurityFinding>;

/** The human's request. The principal is bound by the caller (the bff); a service principal is refused. */
export const SetFindingStateRequest = z.strictObject({
  state: FindingState.exclude(['open']),
  principal_id: PrincipalId,
  /** Free text from the human. It stays in the Security store; the record holds its hash. */
  reason: z.string().min(1).max(2000),
});
export type SetFindingStateRequest = z.infer<typeof SetFindingStateRequest>;

// ---------------------------------------------------------------- Job output

export const IntakeResult = z.strictObject({
  repo: RepoFullName,
  /** The head the bundle was verified to end at (`X-Base-Sha`). */
  base_sha: GitSha,
  manifest: BundleManifest,
  bundle_sha256: Sha256Hex,
  bundle_bytes: z.number().int().min(1),
  /** Refs found in the mirror (what the scan walked from). */
  refs: z.array(RefEntry),
  head_tree: z.strictObject({
    files: z.number().int().min(0),
    bytes: z.number().int().min(0),
  }),
  coverage_items: z.array(CoverageItem),
  /** Counts of every coverage item, listed or not. */
  coverage_counts: z.partialRecord(CoverageKind, z.number().int().min(0)),
  scan_status: ScanStatus,
  scan_error: ScanError.nullable(),
  scan_coverage: ScanCoverage,
  /** COUNTS ONLY, in the PRR's own shape. No value, no fingerprint, no path, no rule. */
  security_summary: PrrSecuritySummary,
  /** The same counts, with the fourth state the PRR shape has no slot for. */
  finding_counts: FindingCounts,
  /** The detectors (M6.3) and the content lint (M6.4); `null` only in results recorded before they existed. */
  detectors: DetectorsResult.nullable().default(null),
});
export type IntakeResult = z.infer<typeof IntakeResult>;

export const KnowledgeJob = z.strictObject({
  job_id: KnowledgeJobId,
  kind: KnowledgeJobKind,
  repo: RepoFullName,
  state: KnowledgeJobState,
  refs_requested: BundleRefs,
  base_sha_requested: GitSha.nullable(),
  created_at: IsoDateTime,
  started_at: IsoDateTime.nullable(),
  finished_at: IsoDateTime.nullable(),
  /** Why the job is `error` (intake failures: refused bundle, cap, timeout). Never a repo value. */
  error: z.string().nullable(),
  result: IntakeResult.nullable(),
  /** sha256 of the canonical JSON of `result` (outputs are content-hashed, OB §5.3 item 10). */
  result_sha256: Sha256Hex.nullable(),
});
export type KnowledgeJob = z.infer<typeof KnowledgeJob>;

// ---------------------------------------------------------------- Event payloads (no values, no fingerprints)

export const KjobQueuedPayload = z.strictObject({
  job_id: KnowledgeJobId,
  kind: KnowledgeJobKind,
  repo: RepoFullName,
  refs_requested: BundleRefs,
  base_sha_requested: GitSha.nullable(),
});
export const KjobStartedPayload = z.strictObject({ job_id: KnowledgeJobId });
/** The whole result rides on the event, so the job read model is a pure fold of the record. */
export const KjobDonePayload = z.strictObject({
  job_id: KnowledgeJobId,
  result: IntakeResult,
  result_sha256: Sha256Hex,
});
export const KjobErrorPayload = z.strictObject({
  job_id: KnowledgeJobId,
  error: z.string().min(1).max(500),
});
export const FindingDetectedPayload = z.strictObject({
  finding_id: FindingId,
  job_id: KnowledgeJobId,
  repo: RepoFullName,
  rule_id: z.string().min(1),
});
export const FindingStateChangedPayload = z.strictObject({
  finding_id: FindingId,
  repo: RepoFullName,
  from: FindingState,
  to: FindingState,
  principal_id: PrincipalId,
  /** sha256 of the human's reason; the text itself stays in the Security store. */
  reason_sha256: Sha256Hex,
});

// ---------------------------------------------------------------- B1 / B2 (OB §5.2)

/**
 * Why a scan blocks B2 (OB §5.2): errored, hit the commit cap, a ref class unscanned. Empty means
 * B2 is met. Fail closed: `default_only` is a reason too (the census may show it as an
 * owner-accepted gap on the synthetic and public testbed; that decision is not made here).
 */
export function b2Reasons(s: {
  readonly scan_status: ScanStatus;
  readonly scan_coverage: Pick<ScanCoverage, 'truncated' | 'cap_reached' | 'refs_covered'>;
}): string[] {
  const out: string[] = [];
  if (s.scan_status !== 'ok') out.push('scan_error');
  if (s.scan_coverage.cap_reached) out.push('cap_reached');
  if (s.scan_coverage.truncated) out.push('truncated');
  if (s.scan_coverage.refs_covered !== 'all') out.push('refs_default_only');
  return out;
}

/** B1: any finding not `rotated`, `false_positive` or `accepted_test_fixture`. */
export const b1Blocked = (c: Pick<FindingCounts, 'open'>): boolean => c.open > 0;
