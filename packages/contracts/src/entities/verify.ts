import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import { z } from 'zod';
import { GateId, TriggerId } from '../flow.js';
import { Lane, type StepId } from '../values.js';
import { AgentBinding } from './agent-definitions.js';
import { RepoFullName } from './codehost.js';
import { GitSha, ProjectId, Sha256Hex, WorkItemId } from './ids.js';
import { Constitution } from './planning.js';
import { SandboxClass, SandboxGrantRef } from './sandbox.js';

// S7 Verify (PLAN M14.3; FL S7, X2, Q1; ADR-0003 §1 `verify`): the vocabulary of the checks 7.1 to 7.5, their findings
// and their results. One definition for the pure checks (`packages/verify`), the verify service (`services/verify`),
// core's stage port and, later, the 7.6 Evidence Pack (M14.4), which binds each result by its hash.
//
// A result is content-addressed: `verifyResultHash` is the sha256 of its canonical JSON, and a result holds no clock
// and no secret, so the same inputs give the same hash. The verdict is three-valued and fails closed: `unknown` (a kit
// gave no answer: a void session, a refused session, an invalid reviewer answer) is UNMET, exactly like `failed`.

// ---------------------------------------------------------------- steps and checks

/** The steps the verify service runs (7.6 assembles and signs the pack: M14.4). */
export const VERIFY_STEPS = [
  '7.1',
  '7.2',
  '7.3',
  '7.4',
  '7.5',
] as const satisfies readonly StepId[];
export const VerifyStep = z.enum(VERIFY_STEPS);
export type VerifyStep = z.infer<typeof VerifyStep>;

export const VerifyCheckId = z.enum([
  'deterministic',
  'test_integrity',
  'spec_conformance',
  'secrets_dependencies',
  'constitution',
]);
export type VerifyCheckId = z.infer<typeof VerifyCheckId>;

/** The one check each step runs. */
export const VERIFY_CHECK_OF_STEP: Readonly<Record<VerifyStep, VerifyCheckId>> = {
  '7.1': 'deterministic',
  '7.2': 'test_integrity',
  '7.3': 'spec_conformance',
  '7.4': 'secrets_dependencies',
  '7.5': 'constitution',
};

/** `unknown` is unmet: nothing downstream may read it as a pass. */
export const CheckVerdict = z.enum(['passed', 'failed', 'unknown']);
export type CheckVerdict = z.infer<typeof CheckVerdict>;

export const FindingSeverity = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

/**
 * What a check found. Grouped by the step that reports it; `kit_error` (a kit gave no verdict) can come from any.
 *
 *   7.1  command_failed, command_void, no_test_command
 *   7.2  locked_test_edit (ET10), stub_test (ET10), stub_probe_passed (ET10), stub_probe_skipped, mutation_survived,
 *        mutation_score_low, mutation_none, holdout_failed, holdout_none, locked_test_stale (E6, B12: M14.4)
 *   7.3  oracle_missing, oracle_unbound, spec_mismatch, no_marker, duplicate_oracle, oracle_failing, conformance_review
 *   7.4  secret_new, dependency_new, dependency_unapproved, protected_path (X2)
 *   7.5  constitution_violation (E2), constitution_review (E2 when high)
 */
export const FindingKind = z.enum([
  'command_failed',
  'command_void',
  'no_test_command',
  'locked_test_edit',
  'stub_test',
  'stub_probe_passed',
  'stub_probe_skipped',
  'mutation_survived',
  'mutation_score_low',
  'mutation_none',
  'holdout_failed',
  'holdout_none',
  'locked_test_stale',
  'oracle_missing',
  'oracle_unbound',
  'spec_mismatch',
  'no_marker',
  'duplicate_oracle',
  'oracle_failing',
  'conformance_review',
  'secret_new',
  'dependency_new',
  'dependency_unapproved',
  'protected_path',
  'constitution_violation',
  'constitution_review',
  'kit_error',
]);
export type FindingKind = z.infer<typeof FindingKind>;

/** Misbehaviour (ET10, FL Q1 "locked-test edit · stub passes"): never a finding to repair, always a quarantine. */
export const QUARANTINE_FINDINGS: readonly FindingKind[] = [
  'locked_test_edit',
  'stub_test',
  'stub_probe_passed',
];

const Text = (max: number) => z.string().min(1).max(max);
const RepoPath = z.string().min(1).max(1024);

/**
 * One finding. It never holds repo text beyond a path and a short rule name, and never a secret's value: a secret is
 * named by its rule id and line, and its `fingerprint` is a hash of the rule and the value's hash.
 */
export const VerifyFinding = z.strictObject({
  kind: FindingKind,
  severity: FindingSeverity,
  rule_id: Text(64).nullable(),
  path: RepoPath.nullable(),
  line: z.number().int().min(1).nullable(),
  message: Text(500),
  /** Stable across runs: what "new against the base" compares (7.4), and how 7.6 de-duplicates. */
  fingerprint: Sha256Hex,
});
export type VerifyFinding = z.infer<typeof VerifyFinding>;

/** One kit (a sandbox session, or the reviewer's model call) the check ran. `answered`: it gave a verdict. */
export const VerifyKitRun = z.strictObject({
  kit: Text(64),
  /** `null` for an in-process kit (the secret and dependency scans, the reviewer's one call). */
  class: SandboxClass.nullable(),
  session_id: z.string().max(64).nullable(),
  status: z.enum(['answered', 'void', 'refused', 'error']),
  exit_code: z.number().int().nullable(),
  detail: z.string().max(200).nullable(),
});
export type VerifyKitRun = z.infer<typeof VerifyKitRun>;

/** What a check raised through core: a gate (X2 at 7.4, E2 at 7.5, E6 at 7.2 for B12) or ET10 (Q1, at 7.2). */
export const VerifyRaise = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('gate'),
    gate: GateId.extract(['X2', 'E2', 'E6']),
    reason_code: Text(64),
  }),
  z.strictObject({
    kind: z.literal('trigger'),
    trigger: TriggerId.extract(['ET10']),
    reason_code: Text(64),
  }),
]);
export type VerifyRaise = z.infer<typeof VerifyRaise>;

/** A mutation kit's score (7.2): mutants of the Unit's changed source lines the repo's tests killed. */
export const MutationScore = z.strictObject({
  total: z.number().int().min(0),
  killed: z.number().int().min(0),
  survived: z.number().int().min(0),
  unknown: z.number().int().min(0),
  min_score: z.number().min(0).max(1),
});
export type MutationScore = z.infer<typeof MutationScore>;

export const VERIFY_RESULT_SCHEMA = 'verify-check-result/1';

/** The result of one check over one Unit head. Content-addressed by `verifyResultHash`. */
export const VerifyCheckResult = z.strictObject({
  schema: z.literal(VERIFY_RESULT_SCHEMA),
  item_id: WorkItemId,
  unit_key: Text(128),
  step: VerifyStep,
  check: VerifyCheckId,
  repo: RepoFullName,
  lane: Lane,
  /** The merged commit the plan was made against: "new" findings are new against THIS. */
  base_sha: GitSha,
  /** The Unit head that was verified: what the Evidence Pack binds. */
  head_sha: GitSha,
  /** The sha256 of the canonical inputs (locks, oracles, constitution, approvals): no secret, no clock. */
  inputs_sha256: Sha256Hex,
  verdict: CheckVerdict,
  findings: z.array(VerifyFinding).max(500),
  kits: z.array(VerifyKitRun).max(64),
  raised: VerifyRaise.nullable(),
  mutation: MutationScore.nullable(),
  /** The shared secret ruleset's version (7.4), so a later ruleset is never mistaken for this one. */
  rules_version: z.string().max(64).nullable(),
});
export type VerifyCheckResult = z.infer<typeof VerifyCheckResult>;

/** The content address of a result: the sha256 of its canonical JSON. */
export const verifyResultHash = (r: VerifyCheckResult): string =>
  sha256Hex(canonicalJson(r as never));

// ---------------------------------------------------------------- what core asks

/** An oracle G2 approved and 5.4 bound to the Unit (its marker carries `spec_sha256`). */
export const VerifyOracle = z.strictObject({
  oracle_id: Text(64),
  requirement_id: Text(128),
  spec_sha256: Sha256Hex,
});
export type VerifyOracle = z.infer<typeof VerifyOracle>;

/** An earlier artefact a reviewer reads, as data (already secret-scanned when it was stored). */
export const VerifyArtefact = z.strictObject({
  type: Text(64),
  sha256: Sha256Hex,
  text: z.string().max(200_000),
});
export type VerifyArtefact = z.infer<typeof VerifyArtefact>;

/** `aisk_` and 48 hex: the gateway virtual key's secret (never recorded, never in a result). */
const GatewayKey = z.string().regex(/^aisk_[0-9a-f]{48}$/);

/**
 * `POST /v1/checks` (docs/specs/verify-api.md): one step's check over one Unit head. Ids, hashes and approvals; the
 * repo itself is read at the two commits through the code host, never sent. `review` is the D+A half of 7.3 and 7.5:
 * the agent bound to the command and its key, lent for the length of this call only.
 */
export const VerifyRunRequest = z.strictObject({
  command_key: z.string().min(1).max(512),
  item_id: WorkItemId,
  project_id: ProjectId,
  unit_key: Text(128),
  step: VerifyStep,
  attempt: z.number().int().min(1),
  repo: RepoFullName,
  lane: Lane,
  base_sha: GitSha,
  head_sha: GitSha,
  /** The locked oracle tests: path -> the sha256 they were locked with (6.3, or after E6 and G3o). */
  locks: z.record(RepoPath, Sha256Hex),
  oracles: z.array(VerifyOracle).max(200),
  /** L0: the oracle is the reproduction test, not approved specs. */
  repro: z.boolean(),
  /** Gates already approved for this item at this step. */
  approved_gates: z.array(GateId),
  /** The head is what the Push Broker wrote under an X2 approved at 6.6 for exactly that patch. */
  x2_covered: z.boolean(),
  /** A new dependency was approved for this Unit (X3 at 6.4). */
  x3_approved: z.boolean(),
  /** Egress hosts the approved design names with an approval reference (7.5). */
  approved_hosts: z.array(z.string().min(1).max(253)).max(100),
  constitution: Constitution,
  /** The live admission grant every sandbox session names (the sandbox-controller starts nothing else). */
  grant: SandboxGrantRef.nullable(),
  review: z
    .strictObject({
      agent: AgentBinding,
      gateway_key: GatewayKey,
      artefacts: z.array(VerifyArtefact).max(20),
    })
    .nullable(),
});
export type VerifyRunRequest = z.infer<typeof VerifyRunRequest>;

/** What `POST /v1/checks` answers: the stored result and its hash. The stage outcome is a pure function of it. */
export const VerifyRunResponse = z.strictObject({
  result_sha256: Sha256Hex,
  result: VerifyCheckResult,
  /** `true` when the command key had a result already: nothing ran again. */
  duplicate: z.boolean(),
});
export type VerifyRunResponse = z.infer<typeof VerifyRunResponse>;

// ---------------------------------------------------------------- what verify records

export const VERIFY_EVENT = { check_recorded: 'verify.check_recorded' } as const;
export type VerifyEventType = (typeof VERIFY_EVENT)[keyof typeof VERIFY_EVENT];
export const VERIFY_STREAM_PREFIXES = ['verify:'] as const;
export const verifyStream = (itemId: string): string => `verify:${itemId}`;

export const VerifyCheckRecordedPayload = z.strictObject({
  command_key: z.string().min(1).max(512),
  result_sha256: Sha256Hex,
  result: VerifyCheckResult,
});
export type VerifyCheckRecordedPayload = z.infer<typeof VerifyCheckRecordedPayload>;

// ---------------------------------------------------------------- what a failure asks for (M14.4: 7.6, B9 to B12, D2)

/**
 * What a failing finding asks of the factory (FL S7: B9 "repairable finding", B10 "spec ambiguous", B11 "approach
 * wrong", B12 "locked test must change", D2 "hard-fail class"). It is DERIVED, never stored: a pure function of the
 * finding's kind (and, for A5's review findings, its rule id), so a result's hash does not change with the table and
 * every reader (core's 7.2, 7.3 and 7.6, the Evidence Pack, the portal) classifies a finding the same way.
 *
 *   repairable          the coder can fix it in 6.4 (B9 at 7.6)
 *   spec_ambiguous      the approved spec does not say: G2's portion again (B10 at 7.3)
 *   approach_wrong      the plan's approach does not work: G3 again (B11 at 7.6)
 *   locked_test_change  a locked oracle no longer matches the approved spec: E6 then G3o (B12 at 7.2)
 *   hard_fail           a person must look: D2 at once (a new secret pushed, a protected path without X2, a
 *                       constitution violation not approved, a command that cannot run, a kit with no answer)
 *   quarantine          misbehaviour: Q1 (ET10), never a repair
 */
export const RepairClass = z.enum([
  'repairable',
  'spec_ambiguous',
  'approach_wrong',
  'locked_test_change',
  'hard_fail',
  'quarantine',
]);
export type RepairClass = z.infer<typeof RepairClass>;

/** The class of a failing finding by its kind (A5's review findings may be narrowed by rule id: `REVIEW_RULE_CLASS`). */
export const REPAIR_CLASS_OF_FINDING: Readonly<Record<FindingKind, RepairClass>> = {
  command_failed: 'repairable',
  command_void: 'hard_fail',
  no_test_command: 'hard_fail',
  locked_test_edit: 'quarantine',
  stub_test: 'quarantine',
  stub_probe_passed: 'quarantine',
  stub_probe_skipped: 'repairable',
  mutation_survived: 'repairable',
  mutation_score_low: 'repairable',
  mutation_none: 'repairable',
  holdout_failed: 'repairable',
  holdout_none: 'repairable',
  locked_test_stale: 'locked_test_change',
  oracle_missing: 'repairable',
  oracle_unbound: 'repairable',
  spec_mismatch: 'repairable',
  no_marker: 'repairable',
  duplicate_oracle: 'repairable',
  oracle_failing: 'repairable',
  conformance_review: 'repairable',
  secret_new: 'hard_fail',
  dependency_new: 'repairable',
  dependency_unapproved: 'repairable',
  protected_path: 'hard_fail',
  constitution_violation: 'hard_fail',
  constitution_review: 'repairable',
  kit_error: 'hard_fail',
};

/**
 * The rule ids of an A5 review finding that narrow its class (the reviewer names the rule, the factory decides what
 * it means). `spec_ambiguous` only counts at 7.3 (B10 starts there); `approach_wrong` at 7.3 and 7.5 (B11 is taken at
 * 7.6). Both send the item back to people (G2, G3): a rule id can never make a finding pass or skip a gate.
 */
export const REVIEW_RULE_CLASS: Readonly<
  Record<string, { readonly class: RepairClass; readonly steps: readonly VerifyStep[] }>
> = {
  spec_ambiguous: { class: 'spec_ambiguous', steps: ['7.3'] },
  approach_wrong: { class: 'approach_wrong', steps: ['7.3', '7.5'] },
};

const REVIEW_KINDS: readonly FindingKind[] = ['conformance_review', 'constitution_review'];

/** The class of one finding reported at `step`. */
export function repairClassOf(
  f: Pick<VerifyFinding, 'kind' | 'rule_id'>,
  step: VerifyStep,
): RepairClass {
  if (REVIEW_KINDS.includes(f.kind) && f.rule_id !== null) {
    const r = REVIEW_RULE_CLASS[f.rule_id];
    if (r !== undefined && r.steps.includes(step)) return r.class;
  }
  return REPAIR_CLASS_OF_FINDING[f.kind];
}
