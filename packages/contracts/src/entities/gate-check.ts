import { canonicalJson, deterministicId, sha256Hex } from '@aisdlc/kernel';
import { z } from 'zod';
import { GateStatus } from '../states/gate-instance.js';
import { Lane } from '../values.js';
import type { GithubPermissions } from './codehost.js';
import { RepoFullName } from './codehost.js';
import { GitSha, IsoDateTime, PrincipalId, ProjectId, Sha256Hex, WorkItemId } from './ids.js';

// gate-check (PLAN M14.5; ADR-0003 §1 Integration plane "gate-check"; FL 8.2 "gate-check: PR head SHA == Evidence Pack
// SHA", X4; onboarding-roadmap §6.6, DEC-10 (refined 2026-11-11), DEC-13(a)). One vocabulary for the service, its
// narrow App on the code host (the port in `@aisdlc/ports`, the fake and the adapter), core's X4 loop and the portal.
//
// gate-check writes ONE thing on the code host: the check run `aisdlc/gate` on a pull request's head, through its OWN
// App (`checks:write`, never the Push Broker's). It never merges, approves or changes a rule: a person merges.

/** The one check run gate-check writes; branch protection requires it, pinned to gate-check's App id. */
export const GATE_CHECK_NAME = 'aisdlc/gate';

/**
 * What gate-check's App asks for (its whole installation token): write the check run, read the pull requests and their
 * commits, the metadata every App has. Nothing else: no contents write, no pull-request write, no statuses (a status of
 * the same name could stand in for a required check, B4b), no administration.
 */
export const GATE_CHECK_APP_PERMISSIONS: GithubPermissions = {
  checks: 'write',
  pull_requests: 'read',
  metadata: 'read',
};

// ---------------------------------------------------------------- profiles and verdicts

/**
 * Which rule a pull request is held to:
 *   agent      opened by the Push Broker and known to core (`core.pull_request`): the passing signed Evidence Pack of
 *              exactly the PR head, and, when the item's route has G3 (its lane in its PINNED catalogue under its pinned
 *              gating profile and tier, the engine's own `presentGates`), G3 decided `approve` in the ledger. L8 (DEC-10(a):
 *              the human's change pushed by the factory as an `agent/*` PR) is this profile: its route has no G3
 *   s0         the repo is still onboarding (no level yet): the factory's evidence does not apply; never a pass
 *              (DEC-13(i): an S0 pack PR waits for the X2 path)
 *   non_agent  any other PR (a person's): never a pass; the laundering check runs, a person reviews, and only a named
 *              bypass person may merge it (recorded, X4)
 */
export const GateCheckProfile = z.enum(['agent', 's0', 'non_agent']);
export type GateCheckProfile = z.infer<typeof GateCheckProfile>;

/**
 * The check run's conclusion. `pending` is an `in_progress` check run (a dependency did not answer: unknown is unmet,
 * so never `success`). `neutral` and `skipped` are never written: GitHub counts both as passing a required check.
 */
export const GateCheckOutcome = z.enum(['success', 'failure', 'action_required', 'pending']);
export type GateCheckOutcome = z.infer<typeof GateCheckOutcome>;

export const GateCheckReason = z.enum([
  /** agent profile: pack for the head, signature good, G3 approved. */
  'passed',
  /** agent profile, a route with no G3 (L8, a lane or profile without it): pack for the head, signature good. */
  'passed_no_g3',
  /** No pack for this head (S7 has not signed one yet, or never will). */
  'no_pack',
  /** The pack for this head is signed but not passing (rework, a D2 handoff). */
  'pack_not_passing',
  /** The PR head moved past the head the pack was signed for (a new push: the old pass no longer applies). */
  'head_moved',
  /** The pack's bytes do not verify: bad signature, wrong key, not canonical, wrong hash, not this repo, PR or Unit. */
  'pack_invalid',
  'g3_missing',
  'g3_pending',
  'g3_not_approved',
  /** A newer G3 than the one the pack carries (the plan changed after the evidence). */
  'g3_changed',
  /** Authored by the Push Broker but not a pull request core recorded (fail closed). */
  'unknown_agent_pr',
  /** s0 profile. */
  's0_onboarding',
  /** non_agent profile: not factory work. */
  'not_factory_work',
  /** Laundering (DEC-13(a)): a non-agent PR on a factory `agent/*` branch. */
  'laundering_agent_branch',
  /** Laundering: a non-agent PR whose head is, or whose commits contain, a head the Push Broker wrote. */
  'laundering_agent_head',
  /** Laundering: a non-agent PR that cites an Evidence Pack (its id or object key) in its title or body. */
  'laundering_pack_cited',
  /** Laundering: a non-agent PR whose commits carry the factory's commit trailers. */
  'laundering_trailer',
  /** A dependency (the record, the object store, the code host's commit list) did not answer: pending. */
  'dependency_unavailable',
]);
export type GateCheckReason = z.infer<typeof GateCheckReason>;

const Text = (max: number) => z.string().min(1).max(max);

/** A pull request's author as the host names it (`type` Bot for an App). */
export const GateCheckAuthor = z.strictObject({
  login: Text(100),
  type: z.enum(['User', 'Bot', 'Organization']),
});
export type GateCheckAuthor = z.infer<typeof GateCheckAuthor>;

/**
 * One verdict for one PR at one head: what gate-check decided, from which facts (ids and hashes, never repo text).
 * Its hash is the check run's `external_id`, so the same verdict is written once.
 */
export const GateCheckVerdict = z.strictObject({
  repo: RepoFullName,
  pr_number: z.number().int().min(1),
  head_sha: GitSha,
  head_ref: Text(255),
  author: GateCheckAuthor,
  project_id: ProjectId,
  profile: GateCheckProfile,
  outcome: GateCheckOutcome,
  reason: GateCheckReason,
  /** One line for the check run's title; fixed text and ids only. */
  detail: Text(300),
  item_id: WorkItemId.nullable(),
  unit_key: z.string().min(1).max(128).nullable(),
  /** The signed pack the verdict rests on (agent profile). */
  pack_sha256: Sha256Hex.nullable(),
  /** The pack's lane (signed). */
  lane: Lane.nullable(),
  g3: z
    .strictObject({
      gate_instance_id: z.string().min(1).max(64),
      status: GateStatus,
      outcome: z.string().min(1).max(32).nullable(),
    })
    .nullable(),
});
export type GateCheckVerdict = z.infer<typeof GateCheckVerdict>;

export const gateCheckVerdictHash = (v: GateCheckVerdict): string =>
  sha256Hex(canonicalJson(v as never));

/** GitHub's check run fields for a verdict: `pending` is in progress, everything else completed. */
export function checkRunOf(v: GateCheckVerdict): {
  status: 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'action_required' | null;
} {
  return v.outcome === 'pending'
    ? { status: 'in_progress', conclusion: null }
    : { status: 'completed', conclusion: v.outcome };
}

// ---------------------------------------------------------------- bypass (DEC-10 refined)

/** The config key of the per-repo bypass list (factory layer, M1-gated). Empty by default: nobody bypasses. */
export const MERGE_BYPASS_CONFIG_KEY = 'codehost.merge_bypass';

/**
 * A GitHub user login: letters, digits and single hyphens, at most 39, not starting or ending with a hyphen. An App
 * (`name[bot]`, `app/name`) is not a login of this shape, so no App can ever be on the list (DEC-10: the list never
 * holds an App).
 */
export const GitHubUserLogin = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/, 'a GitHub user login (no App, no bot)');
export type GitHubUserLogin = z.infer<typeof GitHubUserLogin>;

/** A named person who may merge without `aisdlc/gate` passing: their GitHub login and their factory principal. */
export const BypassPerson = z.strictObject({
  login: GitHubUserLogin,
  principal_id: PrincipalId,
});
export type BypassPerson = z.infer<typeof BypassPerson>;

/** `{ "owner/name": [person, ...] }`: per repo, at most 10 people; a repo not named has nobody. */
export const MergeBypassConfig = z
  .record(RepoFullName, z.array(BypassPerson).max(10))
  .refine(
    (m) =>
      Object.values(m).every(
        (list) => new Set(list.map((p) => p.login.toLowerCase())).size === list.length,
      ),
    { message: 'a login appears twice in one repo list' },
  )
  .refine(
    (m) => new Set(Object.keys(m).map((r) => r.toLowerCase())).size === Object.keys(m).length,
    { message: 'a repo appears twice (repo names compare without case)' },
  );
export type MergeBypassConfig = z.infer<typeof MergeBypassConfig>;

/** The people on a repo's list (repo names compare without case). */
export function bypassListFor(cfg: MergeBypassConfig, repo: string): readonly BypassPerson[] {
  const k = repo.toLowerCase();
  for (const [r, list] of Object.entries(cfg)) if (r.toLowerCase() === k) return list;
  return [];
}

// ---------------------------------------------------------------- merges gate-check observed

/**
 * How a merge happened:
 *   gated         `aisdlc/gate` (gate-check's own App) was `success` on the merged head, and gate-check's record says so
 *   bypass        it was not, and the person who merged is on the repo's bypass list: recorded, X4 post-hoc review
 *   unauthorised  it was not, and the merger is not on the list (protect-main was not effective): recorded, X4 review
 *                 flagged as a security finding
 *   pre_watch     it was merged before gate-check started watching the repo (`gatecheck.repo_watched`): recorded,
 *                 never classed and never reviewed (gate-check could not have checked it)
 */
export const MergeClass = z.enum(['gated', 'bypass', 'unauthorised', 'pre_watch']);
export type MergeClass = z.infer<typeof MergeClass>;

export const MergeObservedPayload = z.strictObject({
  merge_id: z.uuid(),
  repo: RepoFullName,
  project_id: ProjectId,
  pr_number: z.number().int().min(1),
  head_sha: GitSha,
  head_ref: Text(255),
  merge_commit_sha: GitSha.nullable(),
  merged_by: Text(100).nullable(),
  merged_at: IsoDateTime.nullable(),
  author: GateCheckAuthor,
  class: MergeClass,
  /** The list entry that allowed it (`bypass` only). */
  bypass_person: BypassPerson.nullable(),
  /** What `aisdlc/gate` said on the head: gate-check's last verdict, and what the host showed for its App. */
  last_verdict: z
    .strictObject({ outcome: GateCheckOutcome, reason: GateCheckReason, profile: GateCheckProfile })
    .nullable(),
  host_check: z.enum(['success', 'not_success', 'absent']),
  item_id: WorkItemId.nullable(),
});
export type MergeObservedPayload = z.infer<typeof MergeObservedPayload>;

/** The merge's id: one per repo, PR and merged head (also the X4 gate's subject id). */
export const mergeSubjectId = (repo: string, prNumber: number, headSha: string): string =>
  deterministicId<'Merge'>(`aisdlc.merge:${repo.toLowerCase()}#${prNumber}@${headSha}`);

// ---------------------------------------------------------------- record

export const GATECHECK_STREAM_PREFIX = 'gatecheck:';
/** One stream per pull request: `gatecheck:<owner/name, lower case>#<number>`. */
export const gateCheckStream = (repo: string, prNumber: number): string =>
  `${GATECHECK_STREAM_PREFIX}${repo.toLowerCase()}#${prNumber}`;
/** The repo's own stream (its watch start): `gatecheck:<owner/name, lower case>`. */
export const gateCheckRepoStream = (repo: string): string =>
  `${GATECHECK_STREAM_PREFIX}${repo.toLowerCase()}`;

export const GATECHECK_EVENT = {
  /** A verdict that differs from the last one for the PR (and the check run written for it, when it was). */
  verdict_recorded: 'gatecheck.verdict_recorded',
  merge_gated: 'gatecheck.merge_gated',
  bypass_merge: 'gatecheck.bypass_merge',
  unauthorised_merge: 'gatecheck.unauthorised_merge',
  pre_watch_merge: 'gatecheck.pre_watch_merge',
  /** The first time gate-check saw the repo: merges before it are `pre_watch`. Written once per repo. */
  repo_watched: 'gatecheck.repo_watched',
} as const;
export type GateCheckEventType = (typeof GATECHECK_EVENT)[keyof typeof GATECHECK_EVENT];

/** The merge event of each class. */
export const MERGE_EVENT_OF: Readonly<Record<MergeClass, GateCheckEventType>> = {
  gated: GATECHECK_EVENT.merge_gated,
  bypass: GATECHECK_EVENT.bypass_merge,
  unauthorised: GATECHECK_EVENT.unauthorised_merge,
  pre_watch: GATECHECK_EVENT.pre_watch_merge,
};

/** `gatecheck.repo_watched`: when gate-check started watching a repo, and its default branch's head then. */
export const RepoWatchedPayload = z.strictObject({
  repo: RepoFullName,
  project_id: ProjectId,
  watched_at: IsoDateTime,
  default_branch: Text(255),
  head_sha: GitSha,
});
export type RepoWatchedPayload = z.infer<typeof RepoWatchedPayload>;

export const VerdictRecordedPayload = z.strictObject({
  verdict: GateCheckVerdict,
  verdict_sha256: Sha256Hex,
  /**
   * The verdict written as the check run on this head. A check run belongs to a commit, so when several open PRs share
   * a head the strictest of their verdicts is the one written (a PR that borrows an agent head never inherits its pass).
   */
  check_verdict_sha256: Sha256Hex,
  /** The check run the host gave back (`null`: it could not be written; the verdict is recorded all the same). */
  check_run_id: z.number().int().min(1).nullable(),
  observed_at: IsoDateTime,
});
export type VerdictRecordedPayload = z.infer<typeof VerdictRecordedPayload>;
