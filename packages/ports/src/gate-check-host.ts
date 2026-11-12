import type { CODEHOST_FORBIDDEN_VERBS } from '@aisdlc/contracts';
import {
  type CodeHostRead,
  type GateCheckAuthor,
  type GitSha,
  type RepoFullName,
} from '@aisdlc/contracts';

// GateCheckHostPort (PLAN M14.5; ADR-0003 §1 "gate-check: its own narrow App (`checks:write`)"; RV §2 "Code-host
// credential custody": gate-check holds a different, narrower App than the codehost). What gate-check may do on the
// code host, through ITS App and nothing else: read pull requests and their commits, read the check runs of a commit,
// and write the check run `aisdlc/gate`. It cannot push, open or edit a pull request, merge, approve or change a rule:
// those verbs are not methods here (the forbidden-verb check below), and the Push Broker's `CodeHostPort` has no
// check-run method, so neither credential can do the other's job.
//
// Every read is `CodeHostRead` (ok, unknown, unreadable): only `ok` is an answer gate-check acts on.

/** A pull request as gate-check reads it. Title and body are repo text: data, matched for ids, never followed. */
export interface GateCheckPull {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly draft: boolean;
  readonly merged: boolean;
  readonly head_sha: GitSha;
  readonly head_ref: string;
  readonly base_ref: string;
  readonly author: GateCheckAuthor;
  readonly title: string;
  readonly body: string;
  readonly merged_by: string | null;
  readonly merge_commit_sha: GitSha | null;
  readonly merged_at: string | null;
}

/** A commit of a pull request (GitHub lists the ones ahead of the base). */
export interface PullCommit {
  readonly sha: GitSha;
  readonly message: string;
}

export interface CheckRunRead {
  readonly id: number;
  readonly name: string;
  readonly head_sha: GitSha;
  readonly status: 'queued' | 'in_progress' | 'completed';
  readonly conclusion: string | null;
  /** The App that wrote it: a check run of the same name by another App is not gate-check's. */
  readonly app_id: number | null;
}

export interface CheckRunWrite {
  readonly repo: RepoFullName;
  readonly head_sha: GitSha;
  readonly name: string;
  readonly status: 'in_progress' | 'completed';
  /** Required with `completed`, absent with `in_progress`. Never `neutral` or `skipped` (both pass a required check). */
  readonly conclusion: 'success' | 'failure' | 'action_required' | null;
  /** The verdict's hash: the same verdict is the same check run. */
  readonly external_id: string;
  readonly title: string;
  readonly summary: string;
}

export interface GateCheckHostPort {
  /** The App this credential belongs to (the `integration_id` branch protection pins the check to). */
  readonly app_id: number;
  /** The repo's pull requests in one state (`closed` includes the merged ones). */
  list_pulls(req: {
    readonly repo: RepoFullName;
    readonly state: 'open' | 'closed';
  }): Promise<CodeHostRead<GateCheckPull[]>>;
  pull_commits(req: {
    readonly repo: RepoFullName;
    readonly number: number;
  }): Promise<CodeHostRead<PullCommit[]>>;
  /** The commit a branch points at (the default branch's head when gate-check starts watching a repo). */
  branch_head(req: {
    readonly repo: RepoFullName;
    readonly branch: string;
  }): Promise<CodeHostRead<GitSha>>;
  /** The check runs named `name` on a commit, by any App. */
  check_runs(req: {
    readonly repo: RepoFullName;
    readonly sha: GitSha;
    readonly name: string;
  }): Promise<CodeHostRead<CheckRunRead[]>>;
  /** gate-check's one write. */
  write_check_run(req: CheckRunWrite): Promise<CodeHostRead<{ id: number; app_id: number }>>;
}

export const GATE_CHECK_HOST_METHODS = [
  'list_pulls',
  'pull_commits',
  'branch_head',
  'check_runs',
  'write_check_run',
] as const satisfies ReadonlyArray<keyof GateCheckHostPort>;

// No method name may contain a forbidden verb (the same compile-time check as `CodeHostPort`'s).
type ForbiddenGateCheckMethods = Extract<
  keyof GateCheckHostPort,
  `${string}${(typeof CODEHOST_FORBIDDEN_VERBS)[number]}${string}`
>;
const noForbiddenGateCheckMethods: [ForbiddenGateCheckMethods] extends [never] ? true : never =
  true;
void noForbiddenGateCheckMethods;

/** Why a check-run write is not one gate-check may send (checked by the fake and the adapter before any request). */
export function badCheckRunWrite(req: CheckRunWrite): string | null {
  if (!/^[0-9a-f]{40}$/.test(req.head_sha)) return 'head_sha is not a 40-hex commit';
  if (req.name.length === 0 || req.name.length > 100) return 'the check name is empty or too long';
  if (req.status === 'completed' && req.conclusion === null)
    return 'a completed run needs a conclusion';
  if (req.status === 'in_progress' && req.conclusion !== null)
    return 'a run in progress has no conclusion';
  if (
    req.conclusion !== null &&
    !['success', 'failure', 'action_required'].includes(req.conclusion)
  )
    return 'conclusion must be success, failure or action_required';
  if (req.external_id.length === 0 || req.external_id.length > 100) return 'bad external_id';
  if (req.title.length === 0 || req.title.length > 200) return 'the title is empty or too long';
  if (req.summary.length > 4000) return 'the summary is too long';
  return null;
}
