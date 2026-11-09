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
  /** The approved spec's own words (M13.6: what A6 writes the test from). Data: quoted, never instructions. */
  readonly description?: string;
  readonly expected_failure?: string;
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
  /** The Unit's lease epoch as the live grant holds it (M13.6: the writer's epoch the Push Broker checks). */
  readonly lease_epoch?: number;
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
  /**
   * M13.6: keeps the oracle test files A6 wrote at 6.3, so that `oracleFiles` returns THESE on every later call (the
   * spec check and the lock then always see the same bytes; a redo of 6.3 does not author them again). Absent: the
   * authored files live in the session only.
   */
  saveOracleFiles?(req: {
    item_id: string;
    repo: string;
    unit_key: string;
    command_key: string;
    files: readonly OracleFile[];
  }): Promise<Result<void, BuildSourceError>>;
  /**
   * M13.6: stores a content-addressed artefact of S6 in the record (the patch an X2 decides at 6.6, the L7 spike report)
   * and answers its sha256. Absent: the artefact is kept in the session store only.
   */
  recordArtefact?(req: {
    item_id: string;
    step: '6.5' | '6.6';
    type: 'patch' | 'spike_report';
    command_key: string;
    content: unknown;
  }): Promise<Result<{ sha256: string }, BuildSourceError>>;
  contract(repo: string, sha: string, files: readonly RepoFile[]): TaskContract;
  context(req: {
    item_id: string;
    repo: string;
    base_sha: string;
  }): Promise<Result<BuildContextInputs, BuildSourceError>>;
}
