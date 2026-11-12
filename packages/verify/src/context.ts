import type { TaskContract } from '@aisdlc/build';
import type { VerifyRunRequest } from '@aisdlc/contracts';
import type { KitContext } from './kits.js';
import type { HoldoutPort, ReviewerPort } from './ports.js';
import type { Tree } from './tree.js';

// What one check is handed (PLAN M14.3): the request, the two trees, the task contract, the kit context and the ports.

export interface VerifyPolicy {
  /** Mutants per Unit (each is one O session). */
  readonly max_mutants: number;
  /** The share of mutants the tests must kill. */
  readonly min_mutation_score: number;
}

/**
 * The defaults of this build. The catalogue names no number for mutation (FL 7.2 "mutation · holdout"), so like the
 * diff budget of the tripwires these are a build default, a tunable for a later M1-gated config, never a catalogue
 * edit. A few mutants, because each one is a full test run.
 */
export const DEFAULT_VERIFY_POLICY: VerifyPolicy = { max_mutants: 6, min_mutation_score: 0.5 };

export interface CheckContext {
  readonly req: VerifyRunRequest;
  readonly base: Tree;
  readonly head: Tree;
  /** The repo's commands, read from the BASE commit's names (a change of the head's manifest cannot rename them). */
  readonly contract: TaskContract;
  readonly kit: KitContext;
  readonly holdouts: HoldoutPort;
  readonly reviewer: ReviewerPort;
  readonly prompt: (ref: string) => string;
  readonly policy: VerifyPolicy;
}
