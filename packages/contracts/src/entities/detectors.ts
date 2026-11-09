import { z } from 'zod';
import { Tier } from '../values.js';
import { CodeownersParseError } from './codehost.js';
import { CriterionId } from './criteria.js';
import { GitSha } from './ids.js';

// Detectors (PLAN M6.3, M6.4; OB §2.2, §3.4, §4.1, §5.2 B5/B6, §6.2 0.1): the deterministic facts
// the census reads from the head tree of the mirror, each with evidence {path, blob, line}. One
// vocabulary for `services/knowledge`, the census (M6.5) and the PRR. Nothing here carries a value
// from a repo file: facts name things (a script name, a path, a rule), they never quote text.

// ---------------------------------------------------------------- Registry

export const DetectorId = z.enum([
  'stack',
  'task_contract',
  'lockfiles',
  'codeowners',
  'tier_data_class',
  'tier_exposure',
  'tier_blast_radius',
  'inventory',
  'b5_workflows',
  'b6_apply_on_merge',
  'content_lint',
  'presence',
]);
export type DetectorId = z.infer<typeof DetectorId>;

export const DetectorInfo = z.strictObject({
  id: DetectorId,
  /** Bumped by hand when what the detector reports changes. The lint's embeds its rule set and allow-list. */
  version: z.string().min(1),
  /** The CRITERIA_V2 criteria the facts feed. */
  criteria: z.array(CriterionId),
});
export type DetectorInfo = z.infer<typeof DetectorInfo>;

/** Pinned in the PRR as `detector_set` (`PrrPins`). */
export const DetectorSetVersion = z.string().regex(/^detectors\/\d+:[0-9a-f]{12}$/);

// ---------------------------------------------------------------- Evidence

/** Where a fact was seen: the file in the head tree, its blob id (so the line is re-checkable), the 1-based line. */
export const DetectorEvidence = z.strictObject({
  path: z.string().min(1),
  blob: GitSha,
  line: z.number().int().min(1),
});
export type DetectorEvidence = z.infer<typeof DetectorEvidence>;

const evidence = z.array(DetectorEvidence);
const base = { detector: DetectorId, evidence };

// ---------------------------------------------------------------- Stack and the task contract

export const StackCategory = z.enum(['language', 'framework', 'package_manager', 'manifest']);
export type StackCategory = z.infer<typeof StackCategory>;

export const StackFact = z.strictObject({
  kind: z.literal('stack'),
  ...base,
  category: StackCategory,
  name: z.string().min(1),
});

/** OB §3.3: the language-agnostic core. `check` is the single "am I done?" command. */
export const TaskContractName = z.enum([
  'setup',
  'build',
  'test',
  'test-fast',
  'lint',
  'format-check',
  'typecheck',
  'check',
]);
export type TaskContractName = z.infer<typeof TaskContractName>;
export const TASK_CONTRACT_NAMES: readonly TaskContractName[] = TaskContractName.options;

/**
 * A task-contract name mapped onto the repo's own runner, or missing. `invocation` is how a person
 * would run it (`npm run test`, `make test`), never the script body. Nothing is ever run.
 */
export const TaskCommandFact = z.strictObject({
  kind: z.literal('task_command'),
  ...base,
  name: TaskContractName,
  state: z.enum(['found', 'missing']),
  runner: z.string().min(1).nullable(),
  invocation: z.string().min(1).nullable(),
  /** The file the mapping came from (`package.json#scripts`). */
  source: z.string().min(1).nullable(),
});

// ---------------------------------------------------------------- Lockfiles

export const LockfileFact = z.strictObject({
  kind: z.literal('lockfile'),
  ...base,
  manifest: z.string().min(1),
  ecosystem: z.string().min(1),
  state: z.enum(['present', 'absent']),
  lockfile: z.string().min(1).nullable(),
  /** `true` when the lockfile is the workspace root's, not the manifest's own directory's. */
  inherited: z.boolean(),
  /**
   * Whether a frozen install is possible: `feasible` (lockfile present and, where checkable, it
   * agrees with the manifest), `infeasible` (no lockfile, or it disagrees), `unknown` (present,
   * agreement not checked here: the probe decides).
   */
  frozen_install: z.enum(['feasible', 'infeasible', 'unknown']),
  reason: z.string().min(1),
});

// ---------------------------------------------------------------- CODEOWNERS

/** Paths the CODEOWNERS file must cover (OB §4.1 item 7, §6.6 / P-MUST-16): the factory's protected set. */
export const PROTECTED_PATH_PROBES: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/CODEOWNERS',
  '.github/workflows/ci.yml',
  '.factory/knowledge/index.yaml',
  '.claude/settings.json',
  '.mcp.json',
];

export const CodeownersFact = z.strictObject({
  kind: z.literal('codeowners'),
  ...base,
  state: z.enum(['absent', 'present']),
  path: z.string().min(1).nullable(),
  /** The other places a CODEOWNERS file exists; GitHub reads only the first of `.github/`, root, `docs/`. */
  shadowed: z.array(z.string()),
  rule_count: z.number().int().min(0),
  errors: z.array(CodeownersParseError),
  /** Owner keys (`user:alice`, `team:acme/core`, `email:a@b.c`). */
  owners: z.array(z.string()),
  protected_set: z.strictObject({
    covered: z.boolean(),
    uncovered: z.array(z.string()),
  }),
});

// ---------------------------------------------------------------- Tier floor (OB §2.2)

export const TierCriterion = z.enum([
  'data_class',
  'exposure',
  'blast_radius',
  'regulatory',
  'criticality',
]);
export type TierCriterion = z.infer<typeof TierCriterion>;

/** Detector-set criteria. `regulatory` and `criticality` are owner attestation only: never inferred. */
export const DetectedTierCriterion = TierCriterion.extract([
  'data_class',
  'exposure',
  'blast_radius',
]);
export const OWNER_ONLY_TIER_CRITERIA = ['regulatory', 'criticality'] as const;

export const AomRule = z.enum([
  'workflow_deploy',
  'workflow_environment',
  'terraform_apply',
  'kubectl_apply',
  'helm_upgrade',
  'serverless_deploy',
  'cdk_deploy',
  'pulumi_up',
  'cloud_cli_deploy',
  'deploy_action',
  'gitops_auto_sync',
  'ci_deploy_command',
  'platform_config',
]);
export type AomRule = z.infer<typeof AomRule>;

export const FixedTierSignalId = z.enum([
  'dc.pii',
  'dc.sensitive_pii',
  'ex.routing',
  'ex.open',
  'br.migration',
  'br.iac',
  'br.prod_inventory',
]);
/** `dc.*`, `ex.*`, `br.*` and the apply-on-merge family `aom.<rule>`. */
export const TierSignalId = z.union([
  FixedTierSignalId,
  z.string().regex(/^aom\.[a-z_]+$/, 'aom.<rule>'),
]);
export type TierSignalId = z.infer<typeof TierSignalId>;

export const TierSignalFact = z.strictObject({
  kind: z.literal('tier_signal'),
  ...base,
  signal: TierSignalId,
  criterion: DetectedTierCriterion,
  /** The floor this signal raises to. A signal never lowers. */
  floor: Tier.extract(['T1', 'T2']),
});

export const TierAssessment = z.strictObject({
  /** The detector floor: T0 when no signal fired, else the highest signal's. Raise-only afterwards. */
  floor: Tier,
  signals: z.array(z.string()),
  /** What the owner must still attest (card 1). Nothing is inferred and nothing defaults to a value. */
  attestation: z.strictObject({
    regulatory: z.literal('unattested'),
    criticality: z.literal('unattested'),
    /** Positive "no prod, no real data, no dependants"; required for T0 (R-SEC-T3, DEC-4). */
    t0_positive: z.enum(['unattested', 'not_applicable']),
  }),
  /** M7.4 reads this: M4 cannot sign until the owner attests. Always true at detection time. */
  blocks_m4_until_attested: z.boolean(),
  blocks_m4_reasons: z.array(
    z.enum(['t0_unattested', 'regulatory_unattested', 'criticality_unattested']),
  ),
});
export type TierAssessment = z.infer<typeof TierAssessment>;

// ---------------------------------------------------------------- Inventory (RS-AI-7, LF4)

export const InventoryKind = z.enum([
  'agents_md',
  'claude_md',
  'claude_dir',
  'mcp_json',
  'cursor',
  'copilot_instructions',
  'windsurf',
  'gemini',
  'aider',
  'continue',
  'git_hooks',
  'pre_commit_config',
  'devcontainer',
  'vscode_tasks',
  'direnv',
  /** npm lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`) run on every install. */
  'install_scripts',
]);
export type InventoryKind = z.infer<typeof InventoryKind>;

/** `absent` or `data`. Never `affirmed`: nothing in the inventory is guidance (OB §4.1). */
export const InventoryState = z.enum(['absent', 'data']);

export const InventoryFile = z.strictObject({
  path: z.string().min(1),
  blob: GitSha,
  bytes: z.number().int().min(0),
  /** Lines of a text file we read; `null` when it was not read. */
  lines: z.number().int().min(0).nullable(),
});

export const MAX_INVENTORY_FILES = 50;

export const InventoryFact = z.strictObject({
  kind: z.literal('instruction_file'),
  ...base,
  inventory: InventoryKind,
  state: InventoryState,
  file_count: z.number().int().min(0),
  /** At most `MAX_INVENTORY_FILES`; `file_count` is complete. */
  files: z.array(InventoryFile),
  /** Whether the config runs code on its own (hooks, lifecycle commands, `runOn: folderOpen`). */
  auto_run: z.enum(['yes', 'no', 'unknown', 'not_applicable']),
  /** Counts and flags only (`root_lines`, `max_chain_bytes`, `stub`). */
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

/** RS-AI-1: the whole AGENTS.md chain stays under 32 KiB (the Codex cut-off); the root ≤150 lines; nested ≤60. */
export const AGENTS_CHAIN_LIMIT_BYTES = 32 * 1024;
export const AGENTS_ROOT_MAX_LINES = 150;
export const AGENTS_NESTED_MAX_LINES = 60;

// ---------------------------------------------------------------- B5 and B6

export const WorkflowRule = z.enum([
  'pr_target_head_checkout',
  'workflow_run_head_checkout',
  'secrets_on_pr_trigger',
  'secrets_on_agent_trigger',
  'untrusted_context_in_run',
  'unpinned_action_with_secrets',
  'missing_permissions_on_writing_workflow',
]);
export type WorkflowRule = z.infer<typeof WorkflowRule>;

/** `red` is a B5 blocker; `amber` is a posture item (OB §5.2). */
export const WorkflowSeverity = z.enum(['red', 'amber']);
export const WORKFLOW_RULE_SEVERITY: Record<WorkflowRule, z.infer<typeof WorkflowSeverity>> = {
  pr_target_head_checkout: 'red',
  workflow_run_head_checkout: 'red',
  secrets_on_pr_trigger: 'red',
  secrets_on_agent_trigger: 'red',
  untrusted_context_in_run: 'red',
  unpinned_action_with_secrets: 'amber',
  missing_permissions_on_writing_workflow: 'amber',
};

export const WorkflowFindingFact = z.strictObject({
  kind: z.literal('workflow_finding'),
  ...base,
  rule: WorkflowRule,
  severity: WorkflowSeverity,
  path: z.string().min(1),
  job: z.string().min(1).nullable(),
});

export const ApplyOnMergeFact = z.strictObject({
  kind: z.literal('apply_on_merge'),
  ...base,
  rule: AomRule,
  /** `high`: a trigger on the default branch and a deploy step were both read. `medium`: a deploy command or platform config with no branch condition evaluated. */
  confidence: z.enum(['high', 'medium']),
  path: z.string().min(1),
});

// ---------------------------------------------------------------- Content lint (OB §3.4)

export const LintSeverity = z.enum(['blocking', 'advisory']);
export type LintSeverity = z.infer<typeof LintSeverity>;

/** The "must not contain" list of OB §3.4, one rule each. */
export const LINT_RULES = {
  'L-TIER': { severity: 'blocking', title: 'states a tier' },
  'L-AUTONOMY': { severity: 'blocking', title: 'states an autonomy level' },
  'L-LANE': { severity: 'blocking', title: 'states a lane' },
  'L-GATE': { severity: 'blocking', title: 'states a gate' },
  'L-BUDGET': { severity: 'blocking', title: 'states a budget' },
  'L-GRANT': { severity: 'blocking', title: 'grants a tool, permission, MCP server or egress' },
  'L-ADDRESS': { severity: 'blocking', title: 'is addressed to the factory or the AI' },
  'L-DIRECTIVE': {
    severity: 'blocking',
    title: 'tries to override instructions or skip safeguards',
  },
  'L-SECRET': { severity: 'blocking', title: 'holds a secret' },
  'L-URL': { severity: 'blocking', title: 'links outside the allow-list' },
  'L-PIPE-SH': { severity: 'blocking', title: 'pipes a download into a shell' },
  'L-PROSE': { severity: 'advisory', title: 'long architecture prose' },
  'L-FMT-LINES': { severity: 'advisory', title: 'longer than the template allows' },
  'L-FMT-FRONTMATTER': { severity: 'advisory', title: 'has front-matter (the template has none)' },
} as const satisfies Record<string, { severity: 'blocking' | 'advisory'; title: string }>;
export const LintRuleId = z.enum(
  Object.keys(LINT_RULES) as [keyof typeof LINT_RULES, ...(keyof typeof LINT_RULES)[]],
);
export type LintRuleId = z.infer<typeof LintRuleId>;

/**
 * A lint finding: the rule, its severity, and where. The line is the evidence; the text is not
 * quoted (a result must never carry repo text or a secret). `L-SECRET` findings are never listed
 * as facts, only counted (OB §5.3 item 4).
 */
export const LintFindingFact = z.strictObject({
  kind: z.literal('lint_finding'),
  ...base,
  rule: LintRuleId,
  severity: LintSeverity,
  path: z.string().min(1),
});

/**
 * What the head tree shows about files a repo is expected to have (PLAN M6.6; OB §3.3: README,
 * LICENSE, SECURITY.md, CI, tool configs, ...). One fact per item, always emitted: `absent` means
 * the detector looked and found nothing, which is different from the detector not running. `detail`
 * holds structural flags and counts only (`purpose`, `run`, `real_values`), never text of the file.
 */
export const PresenceItem = z.enum([
  'readme',
  'license',
  'security_policy',
  'contributing',
  'pr_template',
  'dependency_updates',
  'env_example',
  'repo_shape',
  'generated_paths',
  'quarantine_manifest',
  'skip_inventory',
  'decision_records',
  'runbooks',
  'ci_check',
  'formatter_config',
  'linter_config',
  'type_checker_config',
  'toolchain_pin',
  'coverage_config',
]);
export type PresenceItem = z.infer<typeof PresenceItem>;

export const PresenceFact = z.strictObject({
  kind: z.literal('presence'),
  ...base,
  item: PresenceItem,
  state: z.enum(['present', 'absent']),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const Fact = z.discriminatedUnion('kind', [
  StackFact,
  TaskCommandFact,
  LockfileFact,
  CodeownersFact,
  TierSignalFact,
  InventoryFact,
  WorkflowFindingFact,
  ApplyOnMergeFact,
  LintFindingFact,
  PresenceFact,
]);
export type Fact = z.infer<typeof Fact>;
export type FactKind = Fact['kind'];

// ---------------------------------------------------------------- The result

/** At most this many facts are listed; `fact_counts` always counts all of them. */
export const MAX_FACTS = 3000;

export const DetectorsError = z.strictObject({
  detector: DetectorId.nullable(),
  code: z.enum(['detector_failed', 'timeout', 'git_failed', 'unreadable_object', 'parse_failed']),
  message: z.string().min(1).max(500),
});

export type DetectorsError = z.infer<typeof DetectorsError>;

export const DetectorsResult = z.strictObject({
  detector_set_version: DetectorSetVersion,
  detectors: z.array(DetectorInfo),
  /** `error` when a detector failed or the time cap hit: its facts are absent, never "none found". */
  status: z.enum(['ok', 'error']),
  errors: z.array(DetectorsError),
  /** The branch the head belongs to, for apply-on-merge; `null` when it could not be told. */
  default_branch: z.string().min(1).nullable(),
  facts: z.array(Fact),
  fact_counts: z.record(z.string(), z.number().int().min(0)),
  facts_truncated: z.boolean(),
  tier: TierAssessment,
  /** `unknown` when a workflow could not be read or parsed: unknown counts as unmet. */
  b5: z.strictObject({
    status: z.enum(['met', 'blocked', 'unknown']),
    red: z.number().int().min(0),
    amber: z.number().int().min(0),
    workflows_unanalysed: z.number().int().min(0),
  }),
  b6: z.strictObject({
    detected: z.boolean(),
    high: z.number().int().min(0),
    medium: z.number().int().min(0),
  }),
  lint: z.strictObject({
    docs_linted: z.number().int().min(0),
    blocking: z.number().int().min(0),
    advisory: z.number().int().min(0),
    /** Counts per rule, `L-SECRET` included (counts only, no location). */
    by_rule: z.record(z.string(), z.number().int().min(0)),
  }),
});
export type DetectorsResult = z.infer<typeof DetectorsResult>;

/** Spellings of each name, normalised (lower case, `: _ .` become `-`). The exact name always wins. */
const TASK_NAME_ALIASES: Record<TaskContractName, readonly string[]> = {
  setup: ['setup', 'bootstrap', 'install-deps', 'deps', 'init'],
  build: ['build', 'compile'],
  test: ['test', 'tests', 'unit', 'test-unit', 'pytest'],
  'test-fast': [
    'test-fast',
    'fast-test',
    'test-quick',
    'quick-test',
    'tests-fast',
    'test-unit-fast',
  ],
  lint: ['lint', 'linter', 'eslint', 'lint-check', 'ruff', 'flake8', 'pylint'],
  'format-check': [
    'format-check',
    'check-format',
    'fmt-check',
    'check-fmt',
    'format-verify',
    'prettier-check',
    'black-check',
    'style-check',
  ],
  typecheck: ['typecheck', 'type-check', 'check-types', 'types', 'tsc', 'mypy', 'pyright'],
  check: ['check', 'ci', 'verify', 'validate', 'all'],
};

/** Normalised spelling of a runner entry (lower case; `: _ .` become `-`). */
export const normaliseTaskEntry = (s: string): string => s.toLowerCase().replace(/[:_.]/g, '-');

/** The task-contract name a runner entry stands for, or null. Exact normalised name first, then aliases. */
export function taskNameFor(entry: string): TaskContractName | null {
  const n = normaliseTaskEntry(entry);
  for (const t of TASK_CONTRACT_NAMES) if (n === t) return t;
  for (const t of TASK_CONTRACT_NAMES) if (TASK_NAME_ALIASES[t].includes(n)) return t;
  return null;
}
