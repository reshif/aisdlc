import { z } from 'zod';
import { hashCanonical } from '@aisdlc/kernel';
import {
  AGENTS_ROOT_MAX_LINES,
  DetectorEvidence,
  LINT_RULES,
  LintRuleId,
  LintSeverity,
} from './detectors.js';
import { RepoFullName } from './codehost.js';
import { AreaId, GitSha, PrincipalId, S0RecordId, Sha256Hex } from './ids.js';
import { ClaimVerdict } from './onboarding.js';

// Card 2, the Light step 0.2 (PLAN M16; OB §3.4, §4, §6.2 row 0.2; DEC-11 as refined 2026-11-11,
// DEC-12(a), DEC-15(d)). The factory proposes, from the census and its detector facts: at most 50
// high-impact claims, each with evidence; the intent and practices questions; and, per instruction
// file (AGENTS.md, CLAUDE.md), a review of every section against the FACTORY TEMPLATE plus a
// proposed text made of the accepted sections (and drafted ones for what the template requires and
// the file lacks). Factory rules always win: a repo file can only add repo detail inside them. The
// proposal is recorded first (record-first, DEC-12(a)), secret-scanned before it is stored, and the
// card binds to its hash. Affirmed text becomes fenced Guidance, never Control (DEC-11(a)).

// ---------------------------------------------------------------- The factory template (config)

/** The config key of the factory template (factory layer only, M1-gated). */
export const INSTRUCTION_TEMPLATE_CONFIG_KEY = 'onboarding.instruction_template';
export const INSTRUCTION_TEMPLATE_SCHEMA_ID = 'instruction-template/1';

/**
 * What a section of an instruction file may be (OB §3.4 outline). `overview` is the title and the
 * lines before the first `##`. These are TAKEN: build and test commands, coding standards,
 * architecture notes, conventions (DEC-11 refined).
 */
export const InstructionSectionKind = z.enum([
  'overview',
  'commands',
  'layout',
  'conventions',
  'boundaries',
  'tests',
  'changes',
  'knowledge',
  'gotchas',
  'owners',
]);
export type InstructionSectionKind = z.infer<typeof InstructionSectionKind>;

/**
 * Why a section is NEVER taken (DEC-11 refined: tools, permissions, network, rule-overrides,
 * secrets), plus factory state (tier, lane, gate, budget, autonomy: OB §3.4 "must not contain")
 * and a section the template has no place for.
 */
export const InstructionRejectReason = z.enum([
  'tools',
  'permissions',
  'network',
  'rule_override',
  'factory_state',
  'secrets',
  'not_in_template',
]);
export type InstructionRejectReason = z.infer<typeof InstructionRejectReason>;

/** A lowercase word of a heading (`commands`, `build`). */
const Keyword = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, 'a lowercase word')
  .max(40);
/** A lowercase phrase looked for in a section body (plain text, never a regular expression). */
const Phrase = z
  .string()
  .min(3)
  .max(80)
  .refine((s) => s === s.toLowerCase(), 'lowercase');

// The lint's own severities (detectors.ts LINT_RULES), as a plain map: the template's refinement needs them.
const LINT_SEVERITY_OF: Readonly<Record<LintRuleId, LintSeverity>> = Object.fromEntries(
  Object.entries(LINT_RULES).map(([k, v]) => [k, v.severity]),
) as Record<LintRuleId, LintSeverity>;

export const InstructionTemplate = z
  .strictObject({
    schema: z.literal(INSTRUCTION_TEMPLATE_SCHEMA_ID),
    /** A heading that holds one of these words is a section of that kind. The first match wins. */
    accepted: z
      .array(z.strictObject({ kind: InstructionSectionKind, headings: z.array(Keyword).min(1) }))
      .min(1),
    /** What is never taken: by heading word or by a phrase in the body. Rejection wins over acceptance. */
    rejected: z.array(
      z.strictObject({
        reason: InstructionRejectReason.exclude(['not_in_template']),
        headings: z.array(Keyword),
        phrases: z.array(Phrase),
      }),
    ),
    /** Which reason a BLOCKING lint finding in a section rejects it for. Every blocking rule is mapped. */
    lint_rejects: z.partialRecord(LintRuleId, InstructionRejectReason.exclude(['not_in_template'])),
    /** Sections the factory drafts when the file has none (from the census facts). */
    required: z.array(InstructionSectionKind.extract(['commands', 'boundaries', 'knowledge'])),
    max_lines: z.number().int().min(10).max(AGENTS_ROOT_MAX_LINES),
  })
  .superRefine((t, ctx) => {
    for (const rule of LintRuleId.options) {
      if (LINT_SEVERITY_OF[rule] === 'blocking' && t.lint_rejects[rule] === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `the blocking lint rule ${rule} rejects a section for a reason`,
          path: ['lint_rejects', rule],
        });
      }
    }
    if (new Set(t.required).size !== t.required.length) {
      ctx.addIssue({ code: 'custom', message: 'a required kind twice', path: ['required'] });
    }
  });
export type InstructionTemplate = z.infer<typeof InstructionTemplate>;

/** The factory's default template. Changing it is an M1 config revision. */
export const DEFAULT_INSTRUCTION_TEMPLATE: InstructionTemplate = {
  schema: INSTRUCTION_TEMPLATE_SCHEMA_ID,
  accepted: [
    {
      kind: 'commands',
      headings: [
        'commands',
        'command',
        'build',
        'building',
        'running',
        'scripts',
        'setup',
        'usage',
      ],
    },
    { kind: 'tests', headings: ['tests', 'test', 'testing'] },
    {
      kind: 'layout',
      headings: ['layout', 'structure', 'architecture', 'overview', 'directories', 'packages'],
    },
    {
      kind: 'conventions',
      headings: ['conventions', 'convention', 'style', 'standards', 'practices', 'rules', 'coding'],
    },
    { kind: 'boundaries', headings: ['boundaries', 'boundary', 'sensitive', 'caution', 'careful'] },
    { kind: 'changes', headings: ['changes', 'commits', 'commit', 'branches', 'contributing'] },
    { kind: 'knowledge', headings: ['knowledge', 'docs', 'documentation', 'references', 'links'] },
    { kind: 'gotchas', headings: ['gotchas', 'pitfalls', 'troubleshooting', 'known', 'faq'] },
    { kind: 'owners', headings: ['owners', 'ownership', 'maintainers', 'contacts'] },
  ],
  rejected: [
    {
      reason: 'tools',
      headings: ['tools', 'tooling-access', 'mcp', 'plugins', 'hooks'],
      phrases: ['allowed tools', 'allowedtools', 'mcp server', 'mcpservers', 'tool access'],
    },
    {
      reason: 'permissions',
      headings: ['permissions', 'permission', 'access', 'privileges'],
      phrases: ['bypasspermissions', 'skip permissions', 'sudo ', 'run as root', 'admin rights'],
    },
    {
      reason: 'network',
      headings: ['network', 'networking', 'egress', 'internet'],
      phrases: [
        'network access',
        'internet access',
        'outbound',
        'egress',
        'curl http',
        'wget http',
      ],
    },
    {
      reason: 'rule_override',
      headings: ['overrides', 'override', 'exceptions'],
      phrases: [
        'ignore previous',
        'ignore all previous',
        'override the',
        'takes precedence',
        'supersedes',
        'instead of the factory',
        'regardless of',
      ],
    },
    {
      reason: 'secrets',
      headings: ['secrets', 'credentials', 'tokens', 'keys'],
      phrases: ['api key', 'password', 'private key', 'access token'],
    },
    {
      reason: 'factory_state',
      headings: ['autonomy', 'tier', 'lanes', 'gates', 'budget'],
      phrases: [],
    },
  ],
  lint_rejects: {
    'L-TIER': 'factory_state',
    'L-AUTONOMY': 'factory_state',
    'L-LANE': 'factory_state',
    'L-GATE': 'factory_state',
    'L-BUDGET': 'factory_state',
    'L-GRANT': 'permissions',
    'L-ADDRESS': 'rule_override',
    'L-DIRECTIVE': 'rule_override',
    'L-SECRET': 'secrets',
    'L-URL': 'network',
    'L-PIPE-SH': 'network',
  },
  required: ['commands', 'boundaries'],
  max_lines: AGENTS_ROOT_MAX_LINES,
};

export const instructionTemplateHash = (t: InstructionTemplate): string => hashCanonical(t);

// ---------------------------------------------------------------- The review of one file

/** The instruction files card 2 reviews (the root of the repo-wide area). */
export const InstructionPath = z.enum(['AGENTS.md', 'CLAUDE.md']);
export type InstructionPath = z.infer<typeof InstructionPath>;

export const InstructionSectionVerdict = z.enum(['accepted', 'rejected', 'drafted']);
export type InstructionSectionVerdict = z.infer<typeof InstructionSectionVerdict>;

export const InstructionSection = z
  .strictObject({
    index: z.number().int().min(0),
    /** The heading as written; `null` for the preamble, and for a section that holds a secret. */
    heading: z.string().max(200).nullable(),
    level: z.number().int().min(0).max(2),
    kind: InstructionSectionKind.nullable(),
    verdict: InstructionSectionVerdict,
    reasons: z.array(InstructionRejectReason),
    /** The blocking lint rules that fired in the section (the line is the evidence, never the text). */
    lint_rules: z.array(LintRuleId),
    /** 1-based, in the source file (in the proposed text for a drafted section). */
    line_start: z.number().int().min(1),
    line_end: z.number().int().min(1),
    text_sha256: Sha256Hex,
  })
  .refine((s) => (s.verdict === 'rejected') === s.reasons.length > 0, {
    message: 'a rejected section has its reasons, and only a rejected one',
    path: ['reasons'],
  });
export type InstructionSection = z.infer<typeof InstructionSection>;

export const InstructionLintFinding = z.strictObject({
  rule: LintRuleId,
  severity: LintSeverity,
  line: z.number().int().min(1),
});
export type InstructionLintFinding = z.infer<typeof InstructionLintFinding>;

/** Why there is no text a person could affirm. */
export const InstructionBlocked = z.enum([
  /** The text holds a secret (the shared ruleset): nothing is stored, and nothing overrides it. */
  'secret',
  /** The text has a blocking lint finding or a section the template rejects. */
  'not_clean',
  /** Nothing is left to affirm. */
  'empty',
]);
export type InstructionBlocked = z.infer<typeof InstructionBlocked>;

/**
 * What the factory (or a person, by an edit on the card) proposes as the affirmable text of one
 * file. `text` is what agents would receive as fenced Guidance; it is `null` when it is blocked by
 * a secret (a secret is never stored in the record).
 */
export const InstructionProposal = z
  .strictObject({
    text: z
      .string()
      .max(64 * 1024)
      .nullable(),
    text_sha256: Sha256Hex.nullable(),
    lines: z.number().int().min(0),
    lint: z.array(InstructionLintFinding),
    /** sha256 of the canonical JSON of `lint`. */
    lint_report_hash: Sha256Hex,
    /** Counts only: the rule, the value and the line stay out of the record. */
    secret_hits: z.number().int().min(0),
    blocked: InstructionBlocked.nullable(),
  })
  .refine((p) => (p.text === null) === (p.text_sha256 === null), {
    message: 'a text and its hash go together',
    path: ['text_sha256'],
  })
  .refine((p) => p.secret_hits === 0 || (p.text === null && p.blocked === 'secret'), {
    message: 'a text with a secret is never stored',
    path: ['text'],
  });
export type InstructionProposal = z.infer<typeof InstructionProposal>;

export const InstructionReview = z.strictObject({
  path: InstructionPath,
  area: AreaId,
  /** OB §4.1 item 1: `absent` or `data` (repo text is data until a person affirms it). */
  state: z.enum(['absent', 'data']),
  source_blob_sha: GitSha.nullable(),
  source_text_sha256: Sha256Hex.nullable(),
  template_hash: Sha256Hex,
  sections: z.array(InstructionSection),
  /** Required kinds the source has no accepted section for (the factory drafted them). */
  missing_required: z.array(InstructionSectionKind),
  proposed: InstructionProposal,
  /** `factory` for the proposal; the person's principal for an edit made on the card. */
  proposed_by: z.union([z.literal('factory'), PrincipalId]),
});
export type InstructionReview = z.infer<typeof InstructionReview>;

// ---------------------------------------------------------------- Claims and questions

/** OB §6.2 row 0.2: at most 50 high-impact claims. */
export const MAX_LIGHT_CLAIMS = 50;

export const LightClaimCategory = z.enum([
  'stack',
  'command',
  'dependencies',
  'ownership',
  'instructions',
  'presence',
  'deploy',
  'risk',
]);
export type LightClaimCategory = z.infer<typeof LightClaimCategory>;

/** A claim the static cartographer makes (DEC-15(d)). A claim without evidence is a fabrication. */
export const LightClaim = z.strictObject({
  claim_id: z.string().regex(/^cl-[0-9a-f]{16}$/),
  category: LightClaimCategory,
  text: z.string().min(1).max(300),
  evidence: z.array(DetectorEvidence).min(1).max(20),
});
export type LightClaim = z.infer<typeof LightClaim>;

export const LightQuestion = z.strictObject({
  question_id: z.string().regex(/^[a-z]{2,8}-\d{2}$/),
  text: z.string().min(1).max(300),
});
export type LightQuestion = z.infer<typeof LightQuestion>;

export const LIGHT_QUESTION_SET = 'light-questions/1';

/** The intent questions of card 2 (OB §6.2 row 0.2: about 15; ON10, RS-KN-5). Answered as text. */
export const INTENT_QUESTIONS: readonly LightQuestion[] = [
  ['What is this repository for, in one or two sentences?'],
  ['Who uses what it builds, and how many people depend on it?'],
  ['What must never break? Name the behaviours a change must keep.'],
  ['Which parts are the riskiest to change, and why?'],
  ['Which parts look wrong but are intentional?'],
  ['Which areas should agents not change at all (no-go zones)?'],
  ['What data does it handle, and is any of it personal or regulated?'],
  ['Where does it run, and what happens when a change is merged?'],
  ['Which external services does it talk to?'],
  ['What does a good change look like here (size, tests, docs)?'],
  ['Which kinds of work do you want the factory to take first?'],
  ['Which kinds of work must always stay with a person?'],
  ['How do you know a release went well?'],
  ['What is planned next that a change should not get in the way of?'],
  ['Anything else a newcomer should know before changing code here?'],
].map(([text], i) => ({
  question_id: `intent-${String(i + 1).padStart(2, '0')}`,
  text: text as string,
}));

/**
 * The practices interview (ON9, R-OPK-7). SOLO: once for the operator and reused across repos (the
 * reuse is a later task; until then it is asked on every card 2).
 */
export const PRACTICE_QUESTIONS: readonly LightQuestion[] = [
  ['How do you review a change before you merge it?'],
  ['Which checks must pass before a merge, locally and in CI?'],
  ['How are dependencies added and updated?'],
  ['How do you handle a failing or flaky test?'],
  ['How are secrets and credentials managed for this repository?'],
  ['How do you roll back a bad change?'],
].map(([text], i) => ({
  question_id: `prac-${String(i + 1).padStart(2, '0')}`,
  text: text as string,
}));

// ---------------------------------------------------------------- The proposal (record-first)

export const LIGHT_PROPOSAL_SCHEMA_ID = 'light-proposal/1';

export const LightProposal = z.strictObject({
  schema: z.literal(LIGHT_PROPOSAL_SCHEMA_ID),
  s0_id: S0RecordId,
  repo: RepoFullName,
  census_hash: Sha256Hex,
  baseline_sha: GitSha,
  template_hash: Sha256Hex,
  claims: z.array(LightClaim).max(MAX_LIGHT_CLAIMS),
  /** Claims the evidence validator dropped (evidence that is not in the facts: a fabrication). */
  claims_dropped: z.number().int().min(0),
  /** More claims than the cap were found; the lower-impact ones were left out. */
  claims_truncated: z.boolean(),
  question_set: z.literal(LIGHT_QUESTION_SET),
  intent_questions: z.array(LightQuestion),
  practice_questions: z.array(LightQuestion),
  instructions: z.array(InstructionReview),
  /** sha256 of the canonical JSON of this proposal minus this field. */
  proposal_hash: Sha256Hex,
});
export type LightProposal = z.infer<typeof LightProposal>;

export function lightProposalHash(p: object): string {
  return hashCanonical(
    Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'proposal_hash')),
  );
}

/**
 * The hash the D37 step-up is bound to when a person affirms instruction text (DEC-11(c-i)): the
 * affirmed files and their text hashes, sorted by path. One proof covers exactly that set.
 */
export function instructionsBoundHash(
  files: ReadonlyArray<{ readonly path: string; readonly text_sha256: string }>,
): string {
  return hashCanonical(
    [...files]
      .map((f) => ({ path: f.path, text_sha256: f.text_sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}

// ---------------------------------------------------------------- What a person sends

const Answer = z.string().trim().min(1).max(2000);

export const C2DecisionContent = z.strictObject({
  /** The proposal the person was shown; a decision on another one is refused. */
  proposal_hash: Sha256Hex,
  /** Every claim of the proposal, exactly once. */
  claims: z
    .array(
      z
        .strictObject({
          claim_id: z.string().min(1),
          verdict: ClaimVerdict,
          /** The correct statement, with `correct` only. Secret-scanned. */
          correction: z.string().trim().min(1).max(1000).optional(),
        })
        .refine((c) => (c.verdict === 'correct') === (c.correction !== undefined), {
          message: 'a correction goes with `correct`, and only with it',
          path: ['correction'],
        }),
    )
    .max(MAX_LIGHT_CLAIMS),
  /** Every intent question, answered as text (ON10). Secret-scanned. */
  intent_answers: z.array(z.strictObject({ question_id: z.string().min(1), answer: Answer })),
  /** The practices interview, attested (ON9). */
  practices: z.strictObject({
    attested: z.literal(true),
    answers: z.array(z.strictObject({ question_id: z.string().min(1), answer: Answer })),
  }),
  /** The instruction files affirmed, each at the text hash shown. AGENTS.md is required (LF5). */
  instructions: z
    .array(z.strictObject({ path: InstructionPath, text_sha256: Sha256Hex }))
    .min(1)
    .max(InstructionPath.options.length),
});
export type C2DecisionContent = z.infer<typeof C2DecisionContent>;

/** A person edits the proposed text on card 2 (OB §4.1 item 3). The person never pushes to the repo. */
export const C2InstructionEditRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  path: InstructionPath,
  text: z
    .string()
    .min(1)
    .max(64 * 1024),
  /** The text hash the edit starts from (what the person saw); another one is refused. */
  base_text_sha256: Sha256Hex.nullable(),
});
export type C2InstructionEditRequest = z.infer<typeof C2InstructionEditRequest>;

/** LF6: at least this share of the claims is affirmed or `unknown` (OB §3.2). */
export const LF6_MIN_AFFIRMED_OR_UNKNOWN = 0.9;
