import type { ContextRequest } from '@aisdlc/agents';
import type { TaskContractName } from '@aisdlc/contracts';
import { taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import type { RepoFile } from '@aisdlc/ports';

// What S6 needs to know that is not in a sandbox (PLAN M13.3, M13.4), behind one port with a deterministic fake:
// the repo at the Unit's base commit (the knowledge bundle), the Unit's plan (its tasks, scope and the oracle specs
// G2 approved and 5.4 bound to it), the oracle test files bound to it, the repo's task contract (the census
// detectors' `task_command` facts: how `test` and `check` run) and the affirmed context for the coder.
// The real adapters live where the data is (core: the artefacts; the code host: the bundle).

export const BuildSourceError = taggedError('BuildSourceError');
export type BuildSourceError = TaggedError<
  'BuildSourceError',
  { code: 'unavailable' | 'not_found' | 'invalid'; message: string }
>;
export const buildSourceError = (
  code: BuildSourceError['code'],
  message: string,
): BuildSourceError => BuildSourceError({ code, message });

export interface BuildTask {
  readonly task_id: string;
  readonly title: string;
  readonly instructions: string;
}

/** An oracle spec G2 approved, bound to the Unit at 5.4. `spec_sha256` is the hash of the approved spec entry. */
export interface ApprovedOracle {
  readonly oracle_id: string;
  readonly requirement_id: string;
  readonly spec_sha256: string;
}

export interface UnitPlan {
  /** The merged commit the plan was made against (G3 binds it): the repo copy is of THIS commit. */
  readonly base_sha: string;
  readonly unit_key: string;
  readonly title: string;
  /** The Unit's scope: CODEOWNERS-style globs. Empty: the whole repo. */
  readonly scope_globs: readonly string[];
  readonly tasks: readonly BuildTask[];
  readonly oracles: readonly ApprovedOracle[];
  /** What a Unit of this size is estimated to take (ET2's "2x time"). */
  readonly estimate_ms: number;
}

/** A test file bound to the Unit as an oracle (written from the approved spec). It declares which spec it implements, by marker. */
export interface OracleFile {
  readonly path: string;
  readonly content: string;
}

/** How the repo runs its tests (the census `task_command` facts, as argv). `null`: the repo has no such task. */
export type TaskContract = Readonly<Partial<Record<TaskContractName, readonly string[] | null>>>;

export type BuildContextInputs = Omit<ContextRequest, 'agent_id' | 'purpose' | 'merged_sha'>;

export interface BuildSourcePort {
  files(repo: string, sha: string): Promise<Result<RepoFile[], BuildSourceError>>;
  unitPlan(req: {
    item_id: string;
    repo: string;
    lane: string;
  }): Promise<Result<UnitPlan, BuildSourceError>>;
  oracleFiles(req: {
    item_id: string;
    repo: string;
    unit_key: string;
  }): Promise<Result<OracleFile[], BuildSourceError>>;
  contract(repo: string, sha: string, files: readonly RepoFile[]): TaskContract;
  context(req: {
    item_id: string;
    repo: string;
    base_sha: string;
  }): Promise<Result<BuildContextInputs, BuildSourceError>>;
}
