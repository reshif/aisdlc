import {
  FULL_BASELINE_SCHEMA_ID,
  FULL_INTENT_QUESTIONS,
  FULL_QUESTION_SET,
  FullBaseline,
  MAX_EXAM_QUESTIONS,
  MAX_GOLDEN_CANDIDATES,
  MAX_SPEC_SEEDS,
  ORACLE_LOCK_MAX_TESTS,
  SPEC_SEED_MAX_CHARS,
  fullBaselineHash,
  type CodeFileNode,
  type CodeGraph,
  type DetectorEvidence,
  type ExamQuestion,
  type ExclusionManifest,
  type Fact,
  type GoldenTaskCandidate,
  type HarvestExclusion,
  type SpecSeed,
  type SystemMap,
  type SystemMapArea,
} from '@aisdlc/contracts';
import { err, hashCanonical, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import { scanText } from '@aisdlc/secrets-rules';
import { lintText } from '@aisdlc/text-lint';
import { DEFAULT_PROTECTED_GLOBS, DEFAULT_SENSITIVE_GLOBS, matchesAny } from '@aisdlc/tripwires';

// The Full baseline, step 0.3 (PLAN M17; OB §6.2 row 0.3; FF1; DEC-15(a)): built from the code graph
// knowledge serves at the census head and the census detector facts. Pure and deterministic: the same
// inputs give the same baseline and the same `baseline_hash`. Every text it makes (a seed, an exam
// answer) is built from paths, identifiers and counts, and is linted and secret-scanned before it is
// kept: it may reach an agent as data. The harvest of golden-task candidates runs only after the
// exclusion manifest is built, and never takes a protected, sensitive, generated or vendored file.

export interface FullBaselineInput {
  readonly s0_id: string;
  readonly repo: string;
  readonly census_hash: string;
  readonly baseline_sha: string;
  readonly graph: CodeGraph;
  readonly facts: readonly Fact[];
}

export type FullRefusal = {
  readonly code: 'invalid_input' | 'refused' | 'conflict';
  readonly message: string;
};

/** Generated and vendored paths: never harvested. */
export const GENERATED_GLOBS: readonly string[] = [
  '**/vendor/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/generated/**',
  '**/__generated__/**',
  '**/*.min.js',
];

const RULES: ReadonlyArray<{ reason: HarvestExclusion; globs: readonly string[] }> = [
  { reason: 'protected_path', globs: DEFAULT_PROTECTED_GLOBS },
  { reason: 'sensitive_path', globs: DEFAULT_SENSITIVE_GLOBS },
  { reason: 'generated_or_vendored', globs: GENERATED_GLOBS },
];

const byStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(byStr);
const ev = (f: CodeFileNode, line = 1): DetectorEvidence => ({ path: f.path, blob: f.blob, line });

/** Text that may reach an agent as data: no secret, no blocking lint finding. */
export const cleanText = (text: string): boolean =>
  scanText(text).length === 0 && !lintText(text).some((f) => f.severity === 'blocking');

// ---------------------------------------------------------------- the system map

const MANIFEST =
  /(^|\/)(package\.json|pyproject\.toml|setup\.py|setup\.cfg|go\.mod|Cargo\.toml|pom\.xml|build\.gradle)$/;
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function systemMapOf(graph: CodeGraph): Result<SystemMap, FullRefusal> {
  if (graph.files.length === 0) {
    return err({ code: 'refused', message: 'the code graph holds no file: nothing to map' });
  }
  const node = new Map(graph.files.map((f) => [f.path, f]));
  const crossing = new Map<string, number>();
  for (const e of graph.edges) {
    const a = node.get(e.from)?.area;
    const b = node.get(e.to)?.area;
    if (a === undefined || b === undefined || a === b) continue;
    const k = `${a}\0${b}`;
    crossing.set(k, (crossing.get(k) ?? 0) + 1);
  }
  const edges = [...crossing.entries()]
    .map(([k, imports]) => {
      const [from, to] = k.split('\0') as [string, string];
      return { from, to, imports };
    })
    .sort((x, y) => byStr(x.from, y.from) || byStr(x.to, y.to));
  const areaNames = uniqSorted(graph.files.map((f) => f.area));
  const areas: SystemMapArea[] = areaNames.map((area) => {
    const files = graph.files.filter((f) => f.area === area);
    const manifest =
      files.find((f) => MANIFEST.test(f.path) && dirOf(f.path) === (area === '.' ? '' : area))
        ?.path ?? null;
    return {
      area,
      manifest,
      files: files.length,
      source_files: files.filter((f) => f.role === 'source').length,
      test_files: files.filter((f) => f.role === 'test').length,
      languages: uniqSorted(files.map((f) => f.language).filter((l) => l !== 'other')) as never,
      depends_on: edges.filter((e) => e.from === area).map((e) => e.to),
      used_by: edges.filter((e) => e.to === area).map((e) => e.from),
    };
  });
  const body = { graph_hash: graph.graph_hash, areas, edges };
  return ok({ ...body, map_hash: hashCanonical(body) as never });
}

// ---------------------------------------------------------------- seeds

const seedPath = (area: string): string =>
  `specs/${area === '.' ? 'repository' : area.replaceAll('/', '-')}.md`;

const list = (xs: readonly string[], none: string, max = 20): string =>
  xs.length === 0
    ? none
    : `${xs.slice(0, max).join(', ')}${xs.length > max ? ` and ${xs.length - max} more` : ''}`;

function seedOf(a: SystemMapArea, graph: CodeGraph, sha: string): SpecSeed {
  const files = graph.files.filter((f) => f.area === a.area);
  const sources = files.filter((f) => f.role === 'source');
  const tests = files.filter((f) => f.role === 'test');
  const names = uniqSorted(sources.flatMap((f) => f.exports.filter((n) => n !== 'default')));
  const text = [
    `# ${a.area === '.' ? 'The repository' : a.area} (observed)`,
    '',
    `Status: observed. This seed says what the code at ${sha.slice(0, 12)} does, not what it is meant to do. Affirm it or correct it on card 3.`,
    '',
    `- Files: ${a.files} (${a.source_files} source, ${a.test_files} test); languages: ${list(a.languages, 'none detected')}.`,
    `- Manifest: ${a.manifest ?? 'none'}.`,
    `- Depends on, inside the repository: ${list(a.depends_on, 'nothing')}.`,
    `- Used by: ${list(a.used_by, 'nothing inside the repository')}.`,
    `- Public names: ${list(names, 'none found')}.`,
    `- Tests: ${list(
      tests.map((t) => t.path),
      'none found',
      10,
    )}.`,
    '',
  ]
    .join('\n')
    .slice(0, SPEC_SEED_MAX_CHARS);
  const evidence = (sources.length > 0 ? sources : files).slice(0, 20).map((f) => ev(f));
  return {
    seed_id: `seed-${sha256Hex(`seed\n${a.area}`).slice(0, 16)}`,
    area: a.area,
    path: seedPath(a.area),
    status: 'observed',
    text,
    text_sha256: sha256Hex(text) as never,
    evidence,
  };
}

// ---------------------------------------------------------------- the exam

function examOf(map: SystemMap, graph: CodeGraph, facts: readonly Fact[]): ExamQuestion[] {
  const out: Array<Omit<ExamQuestion, 'question_id'>> = [];
  const node = new Map(graph.files.map((f) => [f.path, f]));
  const test = facts.find(
    (f): f is Extract<Fact, { kind: 'task_command' }> =>
      f.kind === 'task_command' &&
      f.name === 'test' &&
      f.state === 'found' &&
      f.invocation !== null,
  );
  if (test?.invocation) {
    out.push({
      text: 'How are the tests of the repository run?',
      answer: `With \`${test.invocation}\`${test.source ? ` (from ${test.source})` : ''}.`,
      evidence: test.evidence.slice(0, 20),
    });
  }
  out.push({
    text: 'Which parts (areas) does the repository have?',
    answer: `${map.areas.length}: ${list(
      map.areas.map((a) => `${a.area} (${a.files} files)`),
      'none',
    )}.`,
    evidence: [],
  });
  const ranked = [...map.areas].sort((x, y) => y.files - x.files || byStr(x.area, y.area));
  for (const a of ranked) {
    const crossing = graph.edges.filter(
      (e) => node.get(e.from)?.area === a.area && node.get(e.to)?.area !== a.area,
    );
    out.push({
      text: `What does ${a.area === '.' ? 'the repository root area' : a.area} depend on inside the repository?`,
      answer:
        a.depends_on.length === 0 ? 'Nothing inside the repository.' : `${list(a.depends_on, '')}.`,
      evidence: crossing.slice(0, 5).flatMap((e) => {
        const f = node.get(e.from);
        return f ? [ev(f, e.line)] : [];
      }),
    });
    const tests = graph.files.filter((f) => f.area === a.area && f.role === 'test');
    out.push({
      text: `Which tests exercise ${a.area === '.' ? 'the repository root area' : a.area}?`,
      answer:
        tests.length === 0
          ? 'None found in the area.'
          : `${tests.length}: ${list(
              tests.map((t) => t.path),
              '',
              5,
            )}.`,
      evidence: tests.slice(0, 5).map((t) => ev(t)),
    });
  }
  return out
    .filter((q) => cleanText(q.text) && cleanText(q.answer))
    .slice(0, MAX_EXAM_QUESTIONS)
    .map((q, i) => ({
      question_id: `exam-${String(i + 1).padStart(2, '0')}`,
      ...q,
      answer: q.answer.slice(0, 600),
    }));
}

// ---------------------------------------------------------------- exclusion, harvest, oracle lock

export function exclusionOf(graph: CodeGraph): ExclusionManifest {
  const excluded: Array<{ path: string; reason: HarvestExclusion }> = [];
  for (const f of [...graph.files].sort((a, b) => byStr(a.path, b.path))) {
    const r = RULES.find((x) => matchesAny(f.path, x.globs));
    if (r) excluded.push({ path: f.path, reason: r.reason });
  }
  const body = {
    rules: RULES.map((r) => ({ reason: r.reason, globs: [...r.globs] })),
    excluded: excluded.slice(0, 500),
    excluded_count: excluded.length,
    not_indexed: graph.skipped_index,
  };
  return { ...body, manifest_hash: hashCanonical(body) as never };
}

function harvest(graph: CodeGraph, excluded: ReadonlySet<string>): GoldenTaskCandidate[] {
  const node = new Map(graph.files.map((f) => [f.path, f]));
  const out: GoldenTaskCandidate[] = [];
  const tests = graph.files
    .filter((f) => f.role === 'test' && !excluded.has(f.path))
    .sort((a, b) => byStr(a.area, b.area) || byStr(a.path, b.path));
  for (const t of tests) {
    const subjects = uniqSorted(graph.edges.filter((e) => e.from === t.path).map((e) => e.to))
      .map((p) => node.get(p))
      .filter(
        (f): f is CodeFileNode => f !== undefined && f.role === 'source' && !excluded.has(f.path),
      )
      .slice(0, 5);
    if (subjects.length === 0) continue;
    out.push({
      candidate_id: `gt-${sha256Hex(`golden\n${t.path}`).slice(0, 16)}`,
      area: t.area,
      test: { path: t.path, blob: t.blob },
      subjects: subjects.map((s) => ({ path: s.path, blob: s.blob })),
    });
    if (out.length >= MAX_GOLDEN_CANDIDATES) break;
  }
  return out;
}

// ---------------------------------------------------------------- the baseline

export function buildFullBaseline(i: FullBaselineInput): Result<FullBaseline, FullRefusal> {
  if (i.graph.commit_sha !== i.baseline_sha) {
    return err({ code: 'conflict', message: 'the code graph is not at the census head' });
  }
  const map = systemMapOf(i.graph);
  if (!map.ok) return map;
  const made = map.value.areas.map((a) => seedOf(a, i.graph, i.baseline_sha));
  const seeds = made.filter((s) => cleanText(s.text)).slice(0, MAX_SPEC_SEEDS);
  const exclusion = exclusionOf(i.graph);
  const isExcluded = new Set(
    i.graph.files.filter((f) => RULES.some((r) => matchesAny(f.path, r.globs))).map((f) => f.path),
  );
  const lockable = i.graph.files
    .filter((f) => f.role === 'test' && !isExcluded.has(f.path))
    .map((f) => ({ path: f.path, blob: f.blob }));
  const tests = lockable.slice(0, ORACLE_LOCK_MAX_TESTS);
  const body = {
    schema: FULL_BASELINE_SCHEMA_ID,
    s0_id: i.s0_id,
    repo: i.repo,
    census_hash: i.census_hash,
    baseline_sha: i.baseline_sha,
    graph: {
      graph_hash: i.graph.graph_hash,
      files: i.graph.files.length,
      edges: i.graph.edges.length,
      external_imports: i.graph.external_imports,
      skipped_index: i.graph.skipped_index,
      truncated: i.graph.truncated,
    },
    system_map: map.value,
    question_set: FULL_QUESTION_SET,
    intent_questions: [...FULL_INTENT_QUESTIONS],
    exam: examOf(map.value, i.graph, i.facts),
    seeds,
    seeds_dropped: made.length - seeds.length,
    exclusion,
    golden_candidates: harvest(i.graph, isExcluded),
    oracle_lock: {
      tests,
      truncated: lockable.length > tests.length,
      lock_hash: hashCanonical(tests) as never,
    },
  };
  return ok(FullBaseline.parse({ ...body, baseline_hash: fullBaselineHash(body) }));
}

/** FF1 (OB §3.2): full codekb, system-map edges, `specs/` seeds. Unknown and partial are unmet. */
export function ff1Of(b: FullBaseline | null): {
  state: 'met' | 'unmet' | 'unknown';
  reasons: string[];
} {
  if (b === null) return { state: 'unknown', reasons: ['baseline_not_built'] };
  const reasons: string[] = [];
  if (b.graph.files === 0) reasons.push('code_graph_empty');
  if (b.graph.truncated) reasons.push('code_graph_truncated');
  const seeded = new Set(b.seeds.map((s) => s.area));
  for (const a of b.system_map.areas) if (!seeded.has(a.area)) reasons.push(`no_seed:${a.area}`);
  return { state: reasons.length === 0 ? 'met' : 'unmet', reasons };
}
