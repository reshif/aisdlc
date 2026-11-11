import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  CODEHOST_FORBIDDEN_VERBS,
  CODEOWNERS_PATHS,
  type BranchRules,
  type BundleManifest,
  type BundleRequest,
  type ApplyPatchRequest,
  type AppliedPatch,
  type CodeHostNotOk,
  type CodeHostRead,
  type CodeHostReason,
  type CodeownersError,
  type CodeownersFile,
  type Collaborator,
  type FileAtSha,
  type GitSha,
  type InstallationInfo,
  type InstallationRepo,
  type RepoFullName,
  type RequiredCheck,
} from '@aisdlc/contracts';
import { z } from 'zod';

// CodeHostPort (PLAN M5.1; DM §4 and §8 gap 7: one port for the code host). The domain talks to
// GitHub only through this interface. It has reads (`bundle` reads git objects), and one write (`apply_patch`) that the factory may need later; it has NO method able to merge, enqueue,
// approve, auto-merge, force-push, delete, dismiss a review or administer anything: those verbs are
// `CODEHOST_FORBIDDEN_VERBS`, and `codehost-port.test.ts` and the type check below keep every
// method name clear of them.
//
// Every read returns `CodeHostRead<T>`: `ok`, or `unknown` (no answer: network, 5xx, rate limit,
// garbled body, a list cut short) or `unreadable` (an answer: refused, hidden, not supported). Both
// are fail-closed: use `holds` so that only `ok` can ever be "met".

// ---------------------------------------------------------------- Results

export const readOk = <T>(value: T): CodeHostRead<T> => ({ state: 'ok', value });
export const readUnknown = (reason: CodeHostReason, message: string): CodeHostNotOk => ({
  state: 'unknown',
  reason,
  message,
});
export const readUnreadable = (reason: CodeHostReason, message: string): CodeHostNotOk => ({
  state: 'unreadable',
  reason,
  message,
});
export const isOk = <T>(r: CodeHostRead<T>): r is { readonly state: 'ok'; readonly value: T } =>
  r.state === 'ok';

/** A condition is met only by an `ok` read whose value satisfies it; `unknown` and `unreadable` are never met. */
export const holds = <T>(r: CodeHostRead<T>, pred: (v: T) => boolean): boolean =>
  r.state === 'ok' && pred(r.value);

/** Maps the value of an `ok` read; a read that is not `ok` passes through unchanged. */
export function mapRead<T, U>(r: CodeHostRead<T>, f: (v: T) => U): CodeHostRead<U> {
  return r.state === 'ok' ? readOk(f(r.value)) : r;
}

// ---------------------------------------------------------------- Requests

export interface RepoRequest {
  readonly repo: RepoFullName;
}
export interface ReadAtShaRequest extends RepoRequest {
  readonly sha: GitSha;
  /** Repo-relative, no leading slash, no `..`. */
  readonly path: string;
}
export interface BranchRequest extends RepoRequest {
  readonly branch: string;
}
export interface CodeownersRequest extends RepoRequest {
  readonly sha: GitSha;
}
export interface CodeownersErrorsRequest extends RepoRequest {
  /** A commit or branch; absent: the default branch. */
  readonly ref?: string;
}

/**
 * A credential-free `git bundle` and what it holds (`BundleRequest` and `BundleManifest` are
 * contracts). The bytes are a stream, read once: the codehost removes its work directory before it
 * returns, so there is nothing on disk to clean up and nothing for a caller to leak but the stream
 * itself. `dispose` destroys the stream (idempotent); reading it to the end or destroying it also
 * releases it.
 */
export interface BundleResult {
  readonly manifest: BundleManifest;
  readonly stream: Readable;
  dispose(): void;
}

/**
 * M13.6, the Push Broker's one write (`ApplyPatchRequest` and `AppliedPatch` are contracts): one Unit's patch as ONE
 * commit on `agent/<item>/<unit>` and a Draft PR from it. Refused (`unreadable/refused` with a `code`) before any
 * request: a ref outside `agent/**`, a stale lease epoch, a secret in the patch, a protected path with no X2 bound to
 * exactly this patch, a path trick, a spike. A branch that moved is not fast-forwarded: it is refused.
 */
export type { ApplyPatchRequest, AppliedPatch } from '@aisdlc/contracts';

/** M13.6. Read-only facts about a pull request; the factory never acts on it. */
export interface PrStatusRequest extends RepoRequest {
  readonly number: number;
}
export interface PrStatus {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly head_sha: GitSha;
  readonly draft: boolean;
  /** `false`: the check runs were not read (no token of the Push Broker can), so `checks` is empty and says nothing. */
  readonly checks_read: boolean;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly conclusion: string | null;
    readonly integration_id: number | null;
  }>;
}

// ---------------------------------------------------------------- The port

export interface CodeHostPort {
  /** The repositories the installation can reach. */
  list_repos(): Promise<CodeHostRead<InstallationRepo[]>>;
  /** The installation: id, repository selection and the permissions it holds. */
  installation(): Promise<CodeHostRead<InstallationInfo>>;
  /** A file at a commit. `ok(null)`: the repo is readable and has no such file there. */
  read_at_sha(req: ReadAtShaRequest): Promise<CodeHostRead<FileAtSha | null>>;
  /** The commit a branch points at. */
  branch_head(req: BranchRequest): Promise<CodeHostRead<GitSha>>;
  /** The rules in force on a branch (merged over every ruleset). */
  rules_for_branch(req: BranchRequest): Promise<CodeHostRead<BranchRules>>;
  /** The CODEOWNERS file at a commit (`.github/`, root, `docs/`: the first that exists). */
  codeowners(req: CodeownersRequest): Promise<CodeHostRead<CodeownersFile | null>>;
  /** What GitHub reports as wrong with the CODEOWNERS file. */
  codeowners_errors(req: CodeownersErrorsRequest): Promise<CodeHostRead<CodeownersError[]>>;
  /** Who can access the repo, and with which role. */
  collaborators(req: RepoRequest): Promise<CodeHostRead<Collaborator[]>>;
  /** A credential-free `git bundle` of the repo, at the default branch's head. */
  bundle(req: BundleRequest): Promise<CodeHostRead<BundleResult>>;
  /** The Push Broker's one write (M13.6). */
  apply_patch(req: ApplyPatchRequest): Promise<CodeHostRead<AppliedPatch>>;
  /** Facts about a pull request, read only (M13.6). */
  pr_status(req: PrStatusRequest): Promise<CodeHostRead<PrStatus>>;
}

/** Every method of the port, once. The contract suite and the verb test read this list. */
export const CODEHOST_PORT_METHODS = [
  'list_repos',
  'installation',
  'read_at_sha',
  'branch_head',
  'rules_for_branch',
  'codeowners',
  'codeowners_errors',
  'collaborators',
  'bundle',
  'apply_patch',
  'pr_status',
] as const satisfies ReadonlyArray<keyof CodeHostPort>;

// No method name may contain a forbidden verb. This is checked by the compiler (a violation makes
// `ForbiddenMethodNames` non-`never`, so the assignment below stops compiling) and by a test.
type ForbiddenMethodNames = Extract<
  keyof CodeHostPort,
  `${string}${(typeof CODEHOST_FORBIDDEN_VERBS)[number]}${string}`
>;
const noForbiddenMethods: [ForbiddenMethodNames] extends [never] ? true : never = true;
void noForbiddenMethods;

/** Names in `names` that contain a forbidden verb (for tests of any implementation). */
export const forbiddenVerbMethods = (names: readonly string[]): string[] =>
  names.filter((n) => CODEHOST_FORBIDDEN_VERBS.some((v) => n.toLowerCase().includes(v)));

// ---------------------------------------------------------------- Shared pure helpers

/** `git hash-object` of a blob: sha1 of `blob <bytes>\0<content>`. */
export const gitBlobSha = (content: string): GitSha =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');

/** Repo names compare without case (GitHub). */
export const repoKey = (repo: string): string => repo.toLowerCase();

/** Why a repo-relative path is not acceptable, or `null`. No traversal, no absolute path, no NUL. */
export function badRepoPath(path: string): string | null {
  if (path === '' || path.length > 4096) return 'path is empty or too long';
  if (path.startsWith('/') || path.includes('\0') || path.includes('\\'))
    return 'path is not relative';
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return 'path has an empty, "." or ".." segment';
  }
  return null;
}

/** The first CODEOWNERS location that holds a file, read through `read` (GitHub's own order). */
export async function findCodeowners(
  read: (path: string) => Promise<CodeHostRead<FileAtSha | null>>,
): Promise<CodeHostRead<CodeownersFile | null>> {
  for (const path of CODEOWNERS_PATHS) {
    const r = await read(path);
    // A location that cannot be read is not "absent": a later location must not stand in for it.
    if (r.state !== 'ok') return r;
    if (r.value !== null) {
      return readOk({
        path: r.value.path,
        sha: r.value.sha,
        blob_sha: r.value.blob_sha,
        content: r.value.content,
      });
    }
  }
  return readOk(null);
}

// ---------------------------------------------------------------- Effective branch rules

const RawRule = z.looseObject({ type: z.string().min(1) });
const PullRequestParams = z.looseObject({
  required_approving_review_count: z.number().int().min(0),
  dismiss_stale_reviews_on_push: z.boolean(),
  require_code_owner_review: z.boolean(),
  require_last_push_approval: z.boolean(),
  required_review_thread_resolution: z.boolean(),
});
const ChecksParams = z.looseObject({
  strict_required_status_checks_policy: z.boolean().optional(),
  required_status_checks: z.array(
    z.looseObject({
      context: z.string().min(1),
      integration_id: z.number().int().min(0).nullish(),
    }),
  ),
});

/**
 * The effective rules of a branch from what `GET /repos/{r}/rules/branches/{b}` returns (an array
 * of rule objects, one per applying rule, across rulesets). Several rulesets can apply: the
 * strictest value wins (highest review count, any `true`), required checks are united, and a check
 * required once without `integration_id` stays unpinned. A rule of a known type with malformed
 * parameters is `unknown/malformed`, never "no rule".
 */
export function effectiveBranchRules(branch: string, raw: unknown): CodeHostRead<BranchRules> {
  const list = z.array(RawRule).safeParse(raw);
  if (!list.success) return readUnknown('malformed', 'rules are not a list of rules');
  let pull = null as BranchRules['pull_request'];
  const checks = new Map<string, RequiredCheck>();
  let strict = false;
  let force = false;
  let del = false;
  let linear = false;
  let signed = false;
  const other = new Set<string>();
  for (const rule of list.data) {
    switch (rule.type) {
      case 'pull_request': {
        const p = PullRequestParams.safeParse(rule['parameters']);
        if (!p.success)
          return readUnknown('malformed', 'pull_request rule has no usable parameters');
        pull = {
          required_approving_review_count: Math.max(
            pull?.required_approving_review_count ?? 0,
            p.data.required_approving_review_count,
          ),
          require_code_owner_review:
            (pull?.require_code_owner_review ?? false) || p.data.require_code_owner_review,
          require_last_push_approval:
            (pull?.require_last_push_approval ?? false) || p.data.require_last_push_approval,
          dismiss_stale_reviews_on_push:
            (pull?.dismiss_stale_reviews_on_push ?? false) || p.data.dismiss_stale_reviews_on_push,
          required_review_thread_resolution:
            (pull?.required_review_thread_resolution ?? false) ||
            p.data.required_review_thread_resolution,
        };
        break;
      }
      case 'required_status_checks': {
        const p = ChecksParams.safeParse(rule['parameters']);
        if (!p.success) {
          return readUnknown('malformed', 'required_status_checks rule has no usable parameters');
        }
        strict ||= p.data.strict_required_status_checks_policy === true;
        for (const c of p.data.required_status_checks) {
          const integration_id = c.integration_id ?? null;
          checks.set(`${c.context}\0${integration_id ?? ''}`, {
            context: c.context,
            integration_id,
          });
        }
        break;
      }
      case 'non_fast_forward':
        force = true;
        break;
      case 'deletion':
        del = true;
        break;
      case 'required_linear_history':
        linear = true;
        break;
      case 'required_signatures':
        signed = true;
        break;
      default:
        other.add(rule.type);
    }
  }
  return readOk({
    branch,
    pull_request: pull,
    required_checks: [...checks.values()].sort(
      (a, b) =>
        a.context.localeCompare(b.context) || (a.integration_id ?? -1) - (b.integration_id ?? -1),
    ),
    strict_status_checks: strict,
    blocks_force_push: force,
    blocks_deletion: del,
    requires_linear_history: linear,
    requires_signatures: signed,
    other_rule_types: [...other].sort(),
  });
}
