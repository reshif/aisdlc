import { z } from 'zod';
import { DataClass, Level } from '../values.js';
import { RepoFullName } from './codehost.js';
import { AreaId, GitSha, IsoDateTime, S0RecordId, Sha256Hex } from './ids.js';
import {
  CodeLanguage,
  GoldenVerdict,
  HarvestExclusion,
  SeedStatus,
  SeedVerdict,
  SystemMapEdge,
} from './onboarding-full.js';
import { reachesClass } from './portal-verify.js';

// The Knowledge screen outside card 3 (PLAN M17): what the factory knows about a project's repositories, from the
// RECORD: the Full baseline card 3 was shown (`s0.full_proposed`) and what card 3 decided (the seeds' status, the
// golden-task verdicts). Per repository: the repo index (the system map's areas with their files, the exclusion
// manifest and what the index never held), the system map and the code graph (its size and the import edges between
// areas; the per-file graph stays knowledge's, at that commit), the living-spec seeds and the golden-task candidates.
//
// Read under `project.view` at view level V2 (it is content of the work) and cut to the person's data class on the
// server (`cutKnowledgeView`): below D1 the paths and the seed text are withheld, and only areas and counts remain.

export const KnowledgeAreaView = z.strictObject({
  area: AreaId,
  manifest: z.string().nullable(),
  files: z.number().int().min(0),
  source_files: z.number().int().min(0),
  test_files: z.number().int().min(0),
  languages: z.array(CodeLanguage),
  depends_on: z.array(AreaId),
  used_by: z.array(AreaId),
  /** The level the governing readiness record gives the area (DEC-25), `null` without one. */
  level: Level.nullable(),
});
export type KnowledgeAreaView = z.infer<typeof KnowledgeAreaView>;

export const KnowledgeSeedView = z.strictObject({
  seed_id: z.string().min(1),
  area: AreaId,
  /** `null` below D1. */
  path: z.string().nullable(),
  status: SeedStatus,
  /** What card 3 decided (`null`: card 3 is not decided yet). */
  verdict: SeedVerdict.nullable(),
  /** The text now held (the correction when one was given); `null` below D1. */
  text: z.string().nullable(),
  text_sha256: Sha256Hex,
  withheld: z.boolean(),
});
export type KnowledgeSeedView = z.infer<typeof KnowledgeSeedView>;

export const KnowledgeGoldenView = z.strictObject({
  candidate_id: z.string().min(1),
  area: AreaId,
  /** `null` below D1. */
  test: z.string().nullable(),
  subjects: z.array(z.string()),
  verdict: GoldenVerdict.nullable(),
});
export type KnowledgeGoldenView = z.infer<typeof KnowledgeGoldenView>;

export const KnowledgeRepoView = z.strictObject({
  repo: RepoFullName,
  /** The S0 record whose Full baseline this is (`null`: no Full baseline recorded yet). */
  s0_id: S0RecordId.nullable(),
  baseline: z
    .strictObject({
      baseline_hash: Sha256Hex,
      baseline_sha: GitSha,
      census_hash: Sha256Hex,
      recorded_at: IsoDateTime,
      /** Card 3 decided it (approved and applied). */
      decided: z.boolean(),
    })
    .nullable(),
  index: z
    .strictObject({
      files: z.number().int().min(0),
      not_indexed: z.number().int().min(0),
      excluded_count: z.number().int().min(0),
      /** `[]` below D1. */
      excluded: z.array(z.strictObject({ path: z.string(), reason: HarvestExclusion })),
    })
    .nullable(),
  areas: z.array(KnowledgeAreaView),
  code_graph: z
    .strictObject({
      graph_hash: Sha256Hex,
      map_hash: Sha256Hex,
      files: z.number().int().min(0),
      edges: z.number().int().min(0),
      external_imports: z.number().int().min(0),
      truncated: z.boolean(),
      area_edges: z.array(SystemMapEdge),
    })
    .nullable(),
  seeds: z.array(KnowledgeSeedView),
  golden: z.array(KnowledgeGoldenView),
});
export type KnowledgeRepoView = z.infer<typeof KnowledgeRepoView>;

export const ProjectKnowledgeView = z.strictObject({
  project_id: z.string().min(1),
  repos: z.array(KnowledgeRepoView),
  /** The class the view was cut to (core answers at D2; the bff cuts it to the person's). */
  data_class: DataClass,
});
export type ProjectKnowledgeView = z.infer<typeof ProjectKnowledgeView>;

/** The Knowledge view cut to a data class: paths and seed text need D1; areas and counts are D0. */
export function cutKnowledgeView(v: ProjectKnowledgeView, dc: DataClass): ProjectKnowledgeView {
  if (reachesClass(dc, 'D1')) return { ...v, data_class: dc };
  return {
    ...v,
    data_class: dc,
    repos: v.repos.map((r) => ({
      ...r,
      index: r.index === null ? null : { ...r.index, excluded: [] },
      seeds: r.seeds.map((s) => ({ ...s, path: null, text: null, withheld: true })),
      golden: r.golden.map((g) => ({ ...g, test: null, subjects: [] })),
    })),
  };
}
