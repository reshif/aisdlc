import {
  CODER_POLICY,
  buildSourceError,
  specHashOf,
  taskContractOf,
  type BuildContextInputs,
  type BuildSourceError,
  type BuildSourcePort,
  type OracleFile,
  type TaskContract,
  type UnitPlan,
} from '@aisdlc/build';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { RepoFile } from '@aisdlc/ports';
import type pg from 'pg';
import { listGrants } from '../admission/read.js';
import { latestArtefact } from '../planning/store.js';
import { listUnits } from '../planning/units.js';
import { readItem } from '../work-items.js';

// The real `BuildSourcePort` of core (PLAN M13.3): the Unit's plan out of the artefacts S5 stored (the Unit split,
// the task plan, the verification binding) and the oracle specs G2 approved, the repo at the plan's base commit through a
// files port (the code host's bundle), the task contract from the same names the census detectors map. The oracle TEST FILES
// are not here yet: writing them from the approved specs is the test agent's job at 6.3 (A6), a later task; with none
// bound, 6.3 finds every approved oracle missing and raises G3o, never a silent pass.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What a Unit of each size is estimated to take (ET2's "2x time"). */
const ESTIMATE_MS: Record<string, number> = { S: 3_600_000, M: 2 * 3_600_000, L: 4 * 3_600_000 };

export interface RepoFilesPort {
  files(repo: string, sha: string): Promise<Result<RepoFile[], BuildSourceError>>;
}

export class CoreBuildSource implements BuildSourcePort {
  constructor(
    private readonly d: {
      readonly pool: pg.Pool;
      readonly repo: RepoFilesPort;
      /** Where oracle files come from, once something writes them (default: none). */
      readonly oracles?: BuildSourcePort['oracleFiles'];
    },
  ) {}

  files(repo: string, sha: string) {
    return this.d.repo.files(repo, sha);
  }

  async unitPlan(req: {
    item_id: string;
    repo: string;
    lane: string;
  }): Promise<Result<UnitPlan, BuildSourceError>> {
    const item = await readItem(this.d.pool, req.item_id);
    if (!item) return err(buildSourceError('not_found', 'no such item'));
    const base = item.state.plan_base_sha;
    // the Unit whose grant is live (or the first one): an item with no plan has the one implicit Unit `main`
    const units = await listUnits(this.d.pool, req.item_id);
    const grants = await listGrants(this.d.pool, req.item_id);
    const live =
      grants.find((g) => g.status === 'active') ?? grants.find((g) => g.status === 'waiting');
    const unit = units.find((u) => u.unit_id === live?.unit_id) ?? units[0];
    if (!unit) return err(buildSourceError('not_found', 'the item has no Unit'));
    const split = await latestArtefact(this.d.pool, req.item_id, 'unit_split');
    const plan = await latestArtefact(this.d.pool, req.item_id, 'plan');
    const binding = await latestArtefact(this.d.pool, req.item_id, 'verification_binding');
    const specs = await latestArtefact(this.d.pool, req.item_id, 'oracle_specs');
    const sha = base ?? unit.base_sha;
    if (!sha) return err(buildSourceError('invalid', 'the plan names no base commit'));
    const planned = list(isObj(plan?.content) ? plan?.content['units'] : undefined).find(
      (u) => u['unit_key'] === unit.unit_key,
    );
    const tasks = list(planned?.['tasks']).map((t) => ({
      task_id: str(t['task_id']),
      title: str(t['description']).slice(0, 120),
      instructions: `${str(t['description'])}\nVerify: ${str(t['verification'])}`,
    }));
    const ids = new Set(
      list(isObj(binding?.content) ? binding?.content['bindings'] : undefined)
        .filter((b) => b['unit_key'] === unit.unit_key)
        .flatMap((b) =>
          Array.isArray(b['oracle_ids']) ? (b['oracle_ids'] as unknown[]).map(String) : [],
        ),
    );
    const oracles = list(isObj(specs?.content) ? specs?.content['oracles'] : undefined)
      .filter((o) => ids.has(str(o['oracle_id'])))
      .map((o) => ({
        oracle_id: str(o['oracle_id']),
        requirement_id: str(o['requirement_id']),
        spec_sha256: specHashOf({
          oracle_id: str(o['oracle_id']),
          requirement_id: str(o['requirement_id']),
          description: str(o['description']),
          expected_failure: str(o['expected_failure']),
        }),
      }));
    const scopes = unit.paths.flatMap((p) => [p, `${p.replace(/\/$/, '')}/**`]);
    void split;
    return ok({
      base_sha: sha,
      unit_key: unit.unit_key,
      title: unit.title,
      scope_globs: scopes,
      tasks:
        tasks.length > 0 ? tasks : [{ task_id: 'T1', title: unit.title, instructions: unit.title }],
      oracles,
      estimate_ms: ESTIMATE_MS[unit.size] ?? ESTIMATE_MS['M'] ?? 7_200_000,
    });
  }

  async oracleFiles(req: {
    item_id: string;
    repo: string;
    unit_key: string;
  }): Promise<Result<OracleFile[], BuildSourceError>> {
    return this.d.oracles ? this.d.oracles(req) : ok([]);
  }

  contract(_repo: string, _sha: string, files: readonly RepoFile[]): TaskContract {
    return taskContractOf(files);
  }

  async context(): Promise<Result<BuildContextInputs, BuildSourceError>> {
    return ok({ policy: [{ text: CODER_POLICY }], intent: null });
  }
}
