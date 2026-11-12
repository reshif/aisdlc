import { z } from 'zod';
import { RepoFullName } from './codehost.js';
import { GateInstanceId, GitSha, IsoDateTime, Sha256Hex, WorkItemId } from './ids.js';
import { UnitKey } from './planning.js';

// 8.2 merge observed (PLAN M15.2; FL S8 8.2 "HUMAN merges on GitHub ... factory reconciles", F10 B15 split). A person
// merges an agent pull request on the code host; the factory never does. The code host's poll records what it saw of
// the agent PRs (`agent_pulls`, an inbound fact per repo) and core reconciles each PR against its item, record first:
//
//   completed        merged, and the merged head is exactly the head the approved G4 and the passing Evidence Pack
//                    bind: the item leaves 8.2 (S8b where the project releases, else S9)
//   post_hoc_review  merged, but with no approved G4 for that head (merged before G4, a head pushed after the
//                    approval, the item not at 8.2): never a completion; X4 post-hoc review (one per merge, shared
//                    with gate-check's bypass and unauthorised merges)
//   rebased          B15a: still open at 8.2, the base moved and the PR head is a new commit on it with no conflict
//                    (a clean rebase): S7 runs again on the rebased head, which needs its own pack and its own G4
//   conflict         B15b: still open at 8.2 and the host reports a merge conflict: back to S6 to resolve it
//
// An unreadable merge state (no answer, no merge commit, no head) is no completion: nothing is recorded for it.

/**
 * Whether a PR can be merged onto its base as it is, as the code host reports it (GitHub's `mergeable_state`):
 *   current   nothing about the base stops it (`clean`, `blocked`, `unstable`, `has_hooks`, `draft`)
 *   behind    the base moved and the branch is out of date, with no conflict (`behind`)
 *   conflict  the branch conflicts with the base (`dirty`)
 *   unknown   not computed yet, or anything else: never acted on
 */
export const PrMergeability = z.enum(['current', 'behind', 'conflict', 'unknown']);
export type PrMergeability = z.infer<typeof PrMergeability>;

/** GitHub's `mergeable_state` in the factory's words. Anything not listed is `unknown`. */
export function mergeabilityOf(state: string | null | undefined): PrMergeability {
  switch (state) {
    case 'clean':
    case 'blocked':
    case 'unstable':
    case 'has_hooks':
    case 'draft':
      return 'current';
    case 'behind':
      return 'behind';
    case 'dirty':
      return 'conflict';
    default:
      return 'unknown';
  }
}

/** One agent PR as the poll saw it. Merge fields are `null` until the host says it merged. */
export const AgentPull = z.strictObject({
  number: z.number().int().min(1),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  head_sha: GitSha,
  base_ref: z.string().min(1).max(255),
  /** The base branch's commit as the host reports it now; `null` when it did not say. */
  base_sha: GitSha.nullable(),
  mergeable: PrMergeability,
  merge_commit_sha: GitSha.nullable(),
  merged_at: IsoDateTime.nullable(),
  merged_by: z.string().min(1).max(100).nullable(),
});
export type AgentPull = z.infer<typeof AgentPull>;

/** The value of an `agent_pulls` inbound fact: the repo's watched agent PRs, by number. */
export const AgentPullsFact = z.strictObject({
  pulls: z.array(AgentPull).max(500),
});
export type AgentPullsFact = z.infer<typeof AgentPullsFact>;

export const MergeReconcileOutcome = z.enum([
  'completed',
  'post_hoc_review',
  'rebased',
  'conflict',
]);
export type MergeReconcileOutcome = z.infer<typeof MergeReconcileOutcome>;

/** Why a merge is not a normal completion (or what made it one). */
export const MergeReconcileReason = z.enum([
  /** the merged head is the approved one, the pack binds it */
  'approved_head',
  /** no approved G4 for the item (merged before G4, or G4 was not approved) */
  'no_approved_g4',
  /** an approved G4, but for another head: the merged content is not what was approved */
  'head_not_approved',
  /** the approved head has no passing Evidence Pack that the approval bound */
  'pack_not_bound',
  /** the item was not waiting for the merge (8.2) and never will be: ended, or elsewhere */
  'item_not_at_8_2',
  /** B15a */
  'base_moved_clean_rebase',
  /** B15b */
  'merge_conflict',
]);
export type MergeReconcileReason = z.infer<typeof MergeReconcileReason>;

export const MERGE_STREAM_PREFIX = 'merge:';
/** One stream per item: `merge:<item>`. */
export const mergeStream = (itemId: string): string => `${MERGE_STREAM_PREFIX}${itemId}`;

export const MERGE_EVENT = {
  /** What core concluded about one agent PR it saw merged, rebased or in conflict. Once per key. */
  reconciled: 'merge.reconciled',
} as const;

/** The key a reconciliation is recorded under: repo, PR and the commit it is about (merge commit, or new head). */
export const mergeReconcileKey = (
  repo: string,
  prNumber: number,
  sha: string,
  outcome: MergeReconcileOutcome,
): string => `${repo.toLowerCase()}#${prNumber}@${sha}:${outcome}`;

export const MergeReconciledPayload = z.strictObject({
  key: z.string().min(1).max(400),
  item_id: WorkItemId,
  repo: RepoFullName,
  pr_number: z.number().int().min(1),
  unit_key: UnitKey,
  outcome: MergeReconcileOutcome,
  reason: MergeReconcileReason,
  /** The PR head the host reported (the merged head, or the rebased one). */
  head_sha: GitSha,
  base_sha: GitSha.nullable(),
  merge_commit_sha: GitSha.nullable(),
  merged_at: IsoDateTime.nullable(),
  merged_by: z.string().min(1).max(100).nullable(),
  /** What the item's newest G4 approved for this PR, if it approved anything. */
  approved: z
    .strictObject({
      gate_instance_id: GateInstanceId,
      head_sha: GitSha,
      pack_sha256: Sha256Hex,
    })
    .nullable(),
  /** B15a rounds already taken and the pinned catalogue's limit (`b15a_times`); `null` for the other outcomes. */
  b15a: z
    .strictObject({ taken: z.number().int().min(0), limit: z.number().int().min(0).nullable() })
    .nullable(),
});
export type MergeReconciledPayload = z.infer<typeof MergeReconciledPayload>;
