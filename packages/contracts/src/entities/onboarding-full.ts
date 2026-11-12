import { z } from 'zod';
import { hashCanonical } from '@aisdlc/kernel';
import { RepoFullName } from './codehost.js';
import { DetectorEvidence } from './detectors.js';
import { AreaId, GitSha, PrincipalId, S0RecordId, Sha256Hex } from './ids.js';
import { PrrServiceEnvs, ServiceEnvDeclaration } from './service-env.js';

// Full onboarding, step 0.3 (PLAN M17; OB §3.2 FF1, §6.2 row 0.3; DEC-15(a), DEC-25). The factory
// builds the Full baseline from the census head: the code graph (files, their area and role, the
// imports between them: the "full codekb"), the system map (areas and the edges between them), one
// living-spec seed per area (`observed` until a person affirms it `intended`), the exam (questions
// the factory answers from the map, graded by a person: MEASURED, never a gate), the golden-task
// candidates (harvested after the exclusion manifest) and the oracle-lock proposal. The baseline is
// recorded first (record-first, DEC-12(a)), secret-scanned before it is stored, and card 3 binds to
// its hash. Everything here is paths, blob ids, counts and identifiers: never file content.
//
// A repository reaches Full only as a LEVEL-UP after a Light onboarding, never straight to Full (the user's
// decision, PLAN §7a, 2026-11-12): card 3 is the Full step of a level-up request (M16's level-up builds it).

// ---------------------------------------------------------------- The code graph (knowledge)

export const CODE_GRAPH_SCHEMA_ID = 'code-graph/1';
/** Caps of one graph (the index itself is capped at 2,000 files). */
export const CODE_GRAPH_MAX_FILES = 2_000;
export const CODE_GRAPH_MAX_EDGES = 20_000;
export const CODE_GRAPH_MAX_EXPORTS = 50;

export const CodeLanguage = z.enum(['typescript', 'javascript', 'python', 'other']);
export type CodeLanguage = z.infer<typeof CodeLanguage>;

/** What a file is to the map: code, a test, a manifest or config, a document, or something else. */
export const CodeFileRole = z.enum(['source', 'test', 'config', 'doc', 'other']);
export type CodeFileRole = z.infer<typeof CodeFileRole>;

/** An exported name: an identifier only (a name cannot carry an instruction or a value). */
export const CodeIdentifier = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/);

export const CodeFileNode = z.strictObject({
  path: z.string().min(1).max(512),
  blob: GitSha,
  language: CodeLanguage,
  role: CodeFileRole,
  /** The monorepo part the file belongs to: the nearest directory with a manifest, else `.` (DEC-25). */
  area: AreaId,
  lines: z.number().int().min(0),
  exports: z.array(CodeIdentifier).max(CODE_GRAPH_MAX_EXPORTS),
});
export type CodeFileNode = z.infer<typeof CodeFileNode>;

/** One import resolved to a file of the repo (`line` is the import's line in `from`). */
export const CodeEdge = z.strictObject({
  from: z.string().min(1).max(512),
  to: z.string().min(1).max(512),
  line: z.number().int().min(1),
});
export type CodeEdge = z.infer<typeof CodeEdge>;

export const CodeGraph = z
  .strictObject({
    schema: z.literal(CODE_GRAPH_SCHEMA_ID),
    repo: RepoFullName,
    commit_sha: GitSha,
    files: z.array(CodeFileNode).max(CODE_GRAPH_MAX_FILES),
    edges: z.array(CodeEdge).max(CODE_GRAPH_MAX_EDGES),
    /** Imports that name no file of the repo (a package, the standard library): counted, never listed. */
    external_imports: z.number().int().min(0),
    /** Files the search index left out (too big, binary, a secret): the graph does not see them. */
    skipped_index: z.number().int().min(0),
    /** A cap was reached: the graph is partial. */
    truncated: z.boolean(),
    /** sha256 of the canonical JSON of the graph minus this field. */
    graph_hash: Sha256Hex,
  })
  .superRefine((g, ctx) => {
    const paths = new Set(g.files.map((f) => f.path));
    if (paths.size !== g.files.length) {
      ctx.addIssue({ code: 'custom', message: 'one node per path', path: ['files'] });
    }
    g.edges.forEach((e, i) => {
      if (!paths.has(e.from) || !paths.has(e.to)) {
        ctx.addIssue({
          code: 'custom',
          message: 'an edge names a file not in the graph',
          path: ['edges', i],
        });
      }
    });
  });
export type CodeGraph = z.infer<typeof CodeGraph>;

export const codeGraphHash = (g: object): string =>
  hashCanonical(Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'graph_hash')));

// ---------------------------------------------------------------- The system map

export const SystemMapArea = z.strictObject({
  area: AreaId,
  /** The manifest that makes it an area (`null` for the repo-wide area `.` without one). */
  manifest: z.string().min(1).max(512).nullable(),
  files: z.number().int().min(0),
  source_files: z.number().int().min(0),
  test_files: z.number().int().min(0),
  languages: z.array(CodeLanguage),
  depends_on: z.array(AreaId),
  used_by: z.array(AreaId),
});
export type SystemMapArea = z.infer<typeof SystemMapArea>;

export const SystemMapEdge = z.strictObject({
  from: AreaId,
  to: AreaId,
  /** How many file imports cross from one area into the other. */
  imports: z.number().int().min(1),
});
export type SystemMapEdge = z.infer<typeof SystemMapEdge>;

export const SystemMap = z.strictObject({
  graph_hash: Sha256Hex,
  areas: z.array(SystemMapArea).min(1),
  edges: z.array(SystemMapEdge),
  /** sha256 of the canonical JSON of `{graph_hash, areas, edges}`. */
  map_hash: Sha256Hex,
});
export type SystemMap = z.infer<typeof SystemMap>;

// ---------------------------------------------------------------- Seeds, exam, golden tasks, oracle lock

/** A living-spec seed is `observed` (what the code does) until a person affirms it `intended`. */
export const SeedStatus = z.enum(['observed', 'intended']);
export type SeedStatus = z.infer<typeof SeedStatus>;

export const MAX_SPEC_SEEDS = 30;
export const SPEC_SEED_MAX_CHARS = 4_000;

export const SpecSeed = z.strictObject({
  seed_id: z.string().regex(/^seed-[0-9a-f]{16}$/),
  area: AreaId,
  /** Where the seed would live in the repo once the pack is projected (`specs/<area>.md`). */
  path: z.string().min(1).max(300),
  status: z.literal('observed'),
  text: z.string().min(1).max(SPEC_SEED_MAX_CHARS),
  text_sha256: Sha256Hex,
  evidence: z.array(DetectorEvidence).min(1).max(20),
});
export type SpecSeed = z.infer<typeof SpecSeed>;

export const MAX_EXAM_QUESTIONS = 20;

/** A question the factory answers from its own map; a person grades the answer (measured, not a gate). */
export const ExamQuestion = z.strictObject({
  question_id: z.string().regex(/^exam-\d{2}$/),
  text: z.string().min(1).max(300),
  answer: z.string().min(1).max(600),
  evidence: z.array(DetectorEvidence).max(20),
});
export type ExamQuestion = z.infer<typeof ExamQuestion>;

export const ExamGrade = z.enum(['correct', 'incorrect', 'unsure']);
export type ExamGrade = z.infer<typeof ExamGrade>;

/** Why a path is left out of the golden harvest (the exclusion manifest is built before the harvest). */
export const HarvestExclusion = z.enum([
  'protected_path',
  'sensitive_path',
  'generated_or_vendored',
]);
export type HarvestExclusion = z.infer<typeof HarvestExclusion>;

export const ExclusionManifest = z.strictObject({
  rules: z.array(z.strictObject({ reason: HarvestExclusion, globs: z.array(z.string().min(1)) })),
  excluded: z
    .array(z.strictObject({ path: z.string().min(1).max(512), reason: HarvestExclusion }))
    .max(500),
  excluded_count: z.number().int().min(0),
  /** Files the index never held (a secret, too big, binary): never harvested, never named. */
  not_indexed: z.number().int().min(0),
  manifest_hash: Sha256Hex,
});
export type ExclusionManifest = z.infer<typeof ExclusionManifest>;

export const MAX_GOLDEN_CANDIDATES = 20;

const FileRef = z.strictObject({ path: z.string().min(1).max(512), blob: GitSha });

/** A golden-task candidate: an existing test whose subject code the factory could be asked to rebuild. */
export const GoldenTaskCandidate = z.strictObject({
  candidate_id: z.string().regex(/^gt-[0-9a-f]{16}$/),
  area: AreaId,
  test: FileRef,
  subjects: z.array(FileRef).min(1).max(5),
});
export type GoldenTaskCandidate = z.infer<typeof GoldenTaskCandidate>;

export const GoldenVerdict = z.enum(['accept', 'reject']);
export type GoldenVerdict = z.infer<typeof GoldenVerdict>;

export const ORACLE_LOCK_MAX_TESTS = 500;

/** The tests the factory proposes to lock as oracles; pushed through the X2 path later (M17), never here. */
export const OracleLockProposal = z.strictObject({
  tests: z.array(FileRef).max(ORACLE_LOCK_MAX_TESTS),
  truncated: z.boolean(),
  lock_hash: Sha256Hex,
});
export type OracleLockProposal = z.infer<typeof OracleLockProposal>;

// ---------------------------------------------------------------- The intent interview (~25)

export const FullQuestion = z.strictObject({
  question_id: z.string().regex(/^[a-z]{2,8}-\d{2}$/),
  text: z.string().min(1).max(300),
});
export type FullQuestion = z.infer<typeof FullQuestion>;

export const FULL_QUESTION_SET = 'full-questions/1';

/** Card 3's longer intent interview (OB §6.2 row 0.3: about 25). Answered as text, secret-scanned. */
export const FULL_INTENT_QUESTIONS: readonly FullQuestion[] = [
  ['For each part of the repository, what is it for, in a sentence?'],
  ['Which behaviours are contractual: callers outside this repository rely on them?'],
  ['Which invariants must every change keep (data, ordering, idempotence, security)?'],
  ['Which parts are expected to change most in the next months?'],
  ['Which parts are frozen or being retired?'],
  ['Which public interfaces (APIs, CLIs, schemas, events) does the repository offer?'],
  ['Which of them are versioned, and how is a breaking change handled?'],
  ['What are the performance or latency expectations, and where are they measured?'],
  ['What are the availability expectations, and who is woken up when it breaks?'],
  ['Which data does each part store, and for how long?'],
  ['Which data is personal, regulated or customer-owned, and where does it flow?'],
  ['Which external systems does each part depend on, and what happens when one is down?'],
  ['How is the system configured per environment (local, staging, production)?'],
  ['Is staging separated from production (accounts, data, credentials)?'],
  ['How are database or schema migrations written, reviewed and rolled back?'],
  ['Which tests are the real safety net, and which are known to be weak?'],
  ['Which areas have no tests on purpose, and why?'],
  ['Where do the specifications live today (documents, tickets, nowhere)?'],
  ['Which past incidents should a change here never repeat?'],
  ['Which conventions are enforced by tools, and which only by review?'],
  ['Which dependencies are pinned on purpose, and which may be upgraded freely?'],
  ['Which kinds of feature work do you want the factory to take at Full?'],
  ['Which decisions must always come back to a person, whatever the lane?'],
  ['How should a feature be split into reviewable changes here?'],
  ['Anything else the factory must know before it builds features here?'],
].map(([text], i) => ({
  question_id: `full-${String(i + 1).padStart(2, '0')}`,
  text: text as string,
}));

// ---------------------------------------------------------------- The baseline (record-first)

export const FULL_BASELINE_SCHEMA_ID = 'full-baseline/1';

export const FullBaseline = z.strictObject({
  schema: z.literal(FULL_BASELINE_SCHEMA_ID),
  s0_id: S0RecordId,
  repo: RepoFullName,
  census_hash: Sha256Hex,
  baseline_sha: GitSha,
  /** The code graph by hash and size (the graph itself is knowledge's, at this commit). */
  graph: z.strictObject({
    graph_hash: Sha256Hex,
    files: z.number().int().min(0),
    edges: z.number().int().min(0),
    external_imports: z.number().int().min(0),
    skipped_index: z.number().int().min(0),
    truncated: z.boolean(),
  }),
  system_map: SystemMap,
  question_set: z.literal(FULL_QUESTION_SET),
  intent_questions: z.array(FullQuestion),
  exam: z.array(ExamQuestion).max(MAX_EXAM_QUESTIONS),
  seeds: z.array(SpecSeed).max(MAX_SPEC_SEEDS),
  /** Seeds the lint or the secret scan left out (they could reach an agent as data). */
  seeds_dropped: z.number().int().min(0),
  exclusion: ExclusionManifest,
  golden_candidates: z.array(GoldenTaskCandidate).max(MAX_GOLDEN_CANDIDATES),
  oracle_lock: OracleLockProposal,
  /** sha256 of the canonical JSON of this baseline minus this field. */
  baseline_hash: Sha256Hex,
});
export type FullBaseline = z.infer<typeof FullBaseline>;

export const fullBaselineHash = (b: object): string =>
  hashCanonical(Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'baseline_hash')));

// ---------------------------------------------------------------- What a person sends (card 3)

const Answer = z.string().trim().min(1).max(2000);

export const SeedVerdict = z.enum(['affirm', 'correct', 'keep_observed']);
export type SeedVerdict = z.infer<typeof SeedVerdict>;

export const C3DecisionContent = z.strictObject({
  /** The baseline the person was shown; a decision on another one is refused. */
  baseline_hash: Sha256Hex,
  /** Every interview question, answered as text. Secret-scanned. */
  intent_answers: z.array(z.strictObject({ question_id: z.string().min(1), answer: Answer })),
  /** Every exam answer graded (measured, not a gate: `unsure` is a grade). */
  exam: z
    .array(z.strictObject({ question_id: z.string().min(1), grade: ExamGrade }))
    .max(MAX_EXAM_QUESTIONS),
  /** Every seed, exactly once: affirmed as written, corrected (the person's text), or kept `observed`. */
  seeds: z
    .array(
      z
        .strictObject({
          seed_id: z.string().min(1),
          verdict: SeedVerdict,
          correction: z.string().trim().min(1).max(SPEC_SEED_MAX_CHARS).optional(),
        })
        .refine((s) => (s.verdict === 'correct') === (s.correction !== undefined), {
          message: 'a correction goes with `correct`, and only with it',
          path: ['correction'],
        }),
    )
    .max(MAX_SPEC_SEEDS),
  /** Every golden-task candidate, accepted or rejected. */
  golden: z
    .array(z.strictObject({ candidate_id: z.string().min(1), verdict: GoldenVerdict }))
    .max(MAX_GOLDEN_CANDIDATES),
  /** FF2 (L5 only): the services, their environments and the staging-separation attestation. Optional. */
  service_envs: ServiceEnvDeclaration.optional(),
});
export type C3DecisionContent = z.infer<typeof C3DecisionContent>;

/** What a decided card 3 puts in the PRR (`affirmed.full`, OB §2.4). Hashes and counts only. */
export const PrrAffirmedFull = z.strictObject({
  baseline_hash: Sha256Hex,
  graph_hash: Sha256Hex,
  map_hash: Sha256Hex,
  areas: z.array(AreaId).min(1),
  intent: z.strictObject({ answers_hash: Sha256Hex, attested_by: PrincipalId }),
  seeds: z.strictObject({
    total: z.number().int().min(0),
    intended: z.number().int().min(0),
    observed: z.number().int().min(0),
    seeds_hash: Sha256Hex,
  }),
  /** Measured, not a gate (DEC-15(a)): `null` when nothing was graded correct or incorrect. */
  exam: z.strictObject({
    questions: z.number().int().min(0),
    correct: z.number().int().min(0),
    incorrect: z.number().int().min(0),
    unsure: z.number().int().min(0),
    score_pct: z.number().min(0).max(100).nullable(),
    exam_hash: Sha256Hex,
  }),
  golden: z.strictObject({ accepted: z.number().int().min(0), golden_hash: Sha256Hex }),
  oracle_lock_hash: Sha256Hex,
  /** FF2 and the ServiceEnvs card 3 declared (absent: none declared, FF2 unmet). */
  service_envs: PrrServiceEnvs.optional(),
});
export type PrrAffirmedFull = z.infer<typeof PrrAffirmedFull>;
