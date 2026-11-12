import {
  ProjectKnowledgeView,
  S0_EVENT,
  S0FullProposedPayload,
  type CardPayloadItem,
  type FullBaseline,
  type KnowledgeRepoView,
  type Level,
} from '@aisdlc/contracts';
import { governingPrr } from '@aisdlc/onboarding/fold';
import type pg from 'pg';
import { loadS0, s0Cards, type LoadedS0 } from './cards/read.js';
import { appliedCards } from './cards/sync.js';
import { readPrrState } from './prr-store.js';
import { catchUp } from './queries.js';

// The Knowledge screen outside card 3 (PLAN M17; contracts `portal-knowledge.ts`): what the factory knows about each
// repository of a project, read back from the RECORD only: the newest Full baseline recorded for the repo (card 3's
// `s0.full_proposed`) and card 3's decision on it (the seeds' status and text, the golden verdicts), with each area's
// level from the governing readiness record (DEC-25). Core answers at D2; the bff checks `project.view` and V2 and
// cuts it to the person's data class (`cutKnowledgeView`). A repository with no Full baseline answers its areas empty.

interface Baseline {
  readonly loaded: LoadedS0;
  readonly baseline: FullBaseline;
  readonly occurrence: number;
  readonly at: string;
}

function newestBaseline(loaded: LoadedS0): Baseline | null {
  let hit: Baseline | null = null;
  for (const e of loaded.events) {
    if (e.type !== S0_EVENT.full_proposed) continue;
    const p = S0FullProposedPayload.parse(e.payload);
    if (!hit || p.occurrence >= hit.occurrence) {
      hit = { loaded, baseline: p.baseline, occurrence: p.occurrence, at: e.occurred_at };
    }
  }
  return hit;
}

/** Card 3's approved and applied payload for this raising, or `null`. */
async function decidedC3(pool: pg.Pool, b: Baseline): Promise<readonly CardPayloadItem[] | null> {
  const cards = await s0Cards(pool, b.loaded.s0.record.s0_id);
  const applied = appliedCards(b.loaded);
  const c3 = cards.find(
    (c) =>
      c.kind === 'C3' &&
      c.occurrence === b.occurrence &&
      c.state.status === 'decided' &&
      c.state.steps[0]?.decision === 'approve' &&
      applied.has(c.card_id),
  );
  return c3 ? (c3.state.payload?.payload ?? []) : null;
}

export async function projectKnowledge(
  pool: pg.Pool,
  project: string,
): Promise<ProjectKnowledgeView | null> {
  await catchUp(pool);
  const known = await pool.query('SELECT 1 FROM core.project WHERE project_id = $1', [project]);
  if (known.rowCount === 0) return null;
  const repos = await pool.query<{ repo_ref: string; repo_id: string; repo_key: string }>(
    'SELECT repo_ref, repo_id, repo_key FROM core.repo WHERE project_id = $1 ORDER BY repo_ref',
    [project],
  );
  const out: KnowledgeRepoView[] = [];
  for (const r of repos.rows) {
    const s0s = await pool.query<{ s0_id: string }>(
      `SELECT s0_id FROM core.s0_record WHERE repo_key = $1 AND project_id = $2
        ORDER BY created_at DESC, s0_id DESC`,
      [r.repo_key, project],
    );
    let b: Baseline | null = null;
    for (const s of s0s.rows) {
      const loaded = await loadS0(pool, s.s0_id);
      b = loaded ? newestBaseline(loaded) : null;
      if (b) break;
    }
    const gov = governingPrr(await readPrrState(pool, project, r.repo_id));
    const levels: Readonly<Record<string, Level>> = gov?.prr.level.by_area ?? {};
    if (!b) {
      out.push({
        repo: r.repo_ref as never,
        s0_id: null,
        baseline: null,
        index: null,
        areas: [],
        code_graph: null,
        seeds: [],
        golden: [],
      });
      continue;
    }
    const x = b.baseline;
    const payload = await decidedC3(pool, b);
    const verdicts = new Map(
      (payload ?? []).flatMap((p) => (p.kind === 'seed_verdict' ? [[p.seed_id, p] as const] : [])),
    );
    const golden = (payload ?? []).find((p) => p.kind === 'golden_selection');
    const accepted = new Set(golden?.kind === 'golden_selection' ? golden.accepted : []);
    const rejected = new Set(golden?.kind === 'golden_selection' ? golden.rejected : []);
    out.push({
      repo: r.repo_ref as never,
      s0_id: b.loaded.s0.record.s0_id as never,
      baseline: {
        baseline_hash: x.baseline_hash,
        baseline_sha: x.baseline_sha,
        census_hash: x.census_hash,
        recorded_at: b.at,
        decided: payload !== null,
      },
      index: {
        files: x.graph.files,
        not_indexed: x.exclusion.not_indexed,
        excluded_count: x.exclusion.excluded_count,
        excluded: x.exclusion.excluded.map((e) => ({ path: e.path, reason: e.reason })),
      },
      areas: x.system_map.areas.map((a) => ({
        area: a.area,
        manifest: a.manifest,
        files: a.files,
        source_files: a.source_files,
        test_files: a.test_files,
        languages: a.languages,
        depends_on: a.depends_on,
        used_by: a.used_by,
        level: levels[a.area] ?? (a.area === '.' ? (levels['.'] ?? null) : null),
      })),
      code_graph: {
        graph_hash: x.graph.graph_hash,
        map_hash: x.system_map.map_hash,
        files: x.graph.files,
        edges: x.graph.edges,
        external_imports: x.graph.external_imports,
        truncated: x.graph.truncated,
        area_edges: x.system_map.edges,
      },
      seeds: x.seeds.map((s) => {
        const v = verdicts.get(s.seed_id);
        const text = v?.verdict === 'correct' && v.correction !== undefined ? v.correction : s.text;
        return {
          seed_id: s.seed_id,
          area: s.area,
          path: s.path,
          status: v?.status ?? 'observed',
          verdict: v?.verdict ?? null,
          text,
          text_sha256: v?.text_sha256 ?? s.text_sha256,
          withheld: false,
        };
      }),
      golden: x.golden_candidates.map((g) => ({
        candidate_id: g.candidate_id,
        area: g.area,
        test: g.test.path,
        subjects: g.subjects.map((t) => t.path),
        verdict: accepted.has(g.candidate_id)
          ? 'accept'
          : rejected.has(g.candidate_id)
            ? 'reject'
            : null,
      })),
    });
  }
  return ProjectKnowledgeView.parse({ project_id: project, repos: out, data_class: 'D2' });
}
