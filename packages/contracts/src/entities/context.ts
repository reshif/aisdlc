import { z } from 'zod';
import { LintRuleId } from './detectors.js';
import { GitSha, Sha256Hex } from './ids.js';

// The context an agent is built (PLAN M11.4; OB §3.4 precedence, §4.1 items 6 to 9; FL FIX 15). The
// builder is `@aisdlc/agents` `buildContext`; the vocabulary is here once.

/**
 * OB §3.4: 1 factory policy and constitution; 2 the intent block a human accepted at G1; 3 affirmed
 * instruction text (DEC-11(a): fenced Guidance, never Control); 4 affirmed claims; 5 fresh pack docs;
 * 6 inferred, stale or unmerged-draft docs (tagged); 7 all other repo text, as data only.
 */
export const ContextLevel = z.number().int().min(1).max(7);
export type ContextLevel = z.infer<typeof ContextLevel>;

/** `control`: levels 1 and 2, the factory's own. `guidance`: level 3. `data`: everything a repo wrote or a human affirmed about one. */
export const ContextPieceKind = z.enum(['control', 'guidance', 'data']);
export type ContextPieceKind = z.infer<typeof ContextPieceKind>;

export const ContextTag = z.enum([
  'affirmed',
  'fresh',
  'inferred',
  'stale',
  'unmerged_draft',
  'overridden',
  'truncated',
  'lint_flagged',
]);
export type ContextTag = z.infer<typeof ContextTag>;

/** The provenance header of a piece. `repo`, `area`, `path` and `commit_sha` are `null` for a piece that is not from a repo. */
export const ContextProvenance = z.strictObject({
  source: z.enum(['factory', 'record', 'repo']),
  repo: z.string().nullable(),
  area: z.string().nullable(),
  path: z.string().nullable(),
  commit_sha: GitSha.nullable(),
  text_sha256: Sha256Hex,
  /** The record entry that affirmed it (levels 3 and 4). */
  affirmation_ref: z.string().nullable(),
});
export type ContextProvenance = z.infer<typeof ContextProvenance>;

export const KnowledgeDefectKind = z.enum([
  /** A lower level says something a higher level decides (a lane, a gate, tools...) or contradicts it on the same subject. */
  'level_conflict',
  /** Repo text carries a directive the lint flags: it was kept as data and ignored. */
  'directive_in_repo_text',
  /** Affirmed text whose bytes do not hash to the affirmed `text_sha256`: it was not served. */
  'provenance_mismatch',
  /** Repo text from a commit that is not the merged default-branch head: it was not served. */
  'unmerged_excluded',
  /** Levels 1 and 2 alone exceed the budget: they were served in full, nothing else was. */
  'required_over_budget',
]);
export type KnowledgeDefectKind = z.infer<typeof KnowledgeDefectKind>;

/** Logged, never quoted: a defect names the level, the path and the rules, not the text. */
export const KnowledgeDefect = z.strictObject({
  kind: KnowledgeDefectKind,
  level: ContextLevel,
  path: z.string().nullable(),
  rules: z.array(LintRuleId),
  detail: z.string().max(300),
});
export type KnowledgeDefect = z.infer<typeof KnowledgeDefect>;
