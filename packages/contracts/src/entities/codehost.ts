import { z } from 'zod';
import { GitSha, IsoDateTime, PrincipalId, ProjectId } from './ids.js';
import { RepoOwnerType } from './projects.js';

// The code host (PLAN M5; DM §3.6 and §4 `CodeHostPort`; OB §5.5 and §6.5). One vocabulary for the
// port in `@aisdlc/ports`, the fake, the GitHub App adapter and the `codehost` service: the
// forbidden verbs and permissions, the token roles, what a read returns, the B4 blockers and the
// CODEOWNERS feed. Nothing here talks to a network.

// ---------------------------------------------------------------- What the factory never does

/**
 * Verbs the factory never performs on a code host (OB §5.5, D11: "the factory never merges").
 * No `CodeHostPort` method may express one: a test compares the port's method names with this
 * list, and a compile-time check does the same for the interface.
 */
export const CodeHostForbiddenVerb = z.enum([
  'merge',
  'enqueue',
  'approve',
  'auto_merge',
  'force',
  'delete',
  'dismiss',
  'admin',
]);
export type CodeHostForbiddenVerb = z.infer<typeof CodeHostForbiddenVerb>;
export const CODEHOST_FORBIDDEN_VERBS: readonly CodeHostForbiddenVerb[] =
  CodeHostForbiddenVerb.options;

// ---------------------------------------------------------------- App permissions

/** A GitHub App permission level, as the installation and token responses spell it. */
export const GithubPermissionLevel = z.enum(['read', 'write', 'admin']);
export type GithubPermissionLevel = z.infer<typeof GithubPermissionLevel>;

/** `{contents: 'read', metadata: 'read'}`. The same shape as `PrrControls.app_installation.permissions`. */
export const GithubPermissions = z.record(z.string().min(1), GithubPermissionLevel);
export type GithubPermissions = z.infer<typeof GithubPermissions>;

/**
 * Permissions the factory never requests, whatever the level (OB §6.5 "Never"): administration
 * (which also covers deploy keys and collaborators), workflows, secrets, environments, security
 * alerts, hooks, and `statuses` (a status with a matching name could satisfy a required check,
 * B4b). `actions` is forbidden at write level only; its read level is harmless.
 */
export const GITHUB_FORBIDDEN_PERMS: readonly string[] = [
  'administration',
  'workflows',
  'secrets',
  'dependabot_secrets',
  'environments',
  'security_events',
  'secret_scanning_alerts',
  'repository_advisories',
  'repository_hooks',
  'organization_hooks',
  'organization_administration',
  'organization_secrets',
  'statuses',
];
/** Forbidden only at `write` (and `admin`): the permission is otherwise read-only and harmless. */
export const GITHUB_FORBIDDEN_WRITE_PERMS: readonly string[] = ['actions'];

/**
 * The permissions of `perms` that are forbidden (sorted `name:level`). Any `admin` level is
 * forbidden, so is an unrecognised level (fail closed).
 */
export function forbiddenPermissionsIn(perms: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const [name, level] of Object.entries(perms)) {
    const known = level === 'read' || level === 'write' || level === 'admin';
    if (
      GITHUB_FORBIDDEN_PERMS.includes(name) ||
      (GITHUB_FORBIDDEN_WRITE_PERMS.includes(name) && level !== 'read') ||
      level === 'admin' ||
      !known
    ) {
      out.push(`${name}:${level}`);
    }
  }
  return out.sort();
}

/**
 * The token roles of OB §6.5. One App plays every role locally, so the installation grant is the
 * union and separation is token-level only: every role mints a token with an explicit subset.
 * `hub`: Census read and bundle. `posture`: effective rules, collaborators, installation. `docs`
 * and `tracker` write, and are not mintable by a read-only (Census) codehost.
 */
export const CodeHostRole = z.enum(['hub', 'posture', 'docs', 'tracker']);
export type CodeHostRole = z.infer<typeof CodeHostRole>;
export const CodeHostRoleValues: readonly CodeHostRole[] = CodeHostRole.options;

export const CODEHOST_ROLE_PERMISSIONS: Readonly<Record<CodeHostRole, GithubPermissions>> = {
  hub: { contents: 'read', metadata: 'read' },
  posture: { metadata: 'read' },
  docs: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  tracker: { issues: 'write', metadata: 'read' },
};

/** A role that only reads can be minted in Census mode. */
export const codeHostRoleIsReadOnly = (role: CodeHostRole): boolean =>
  Object.values(CODEHOST_ROLE_PERMISSIONS[role]).every((l) => l === 'read');

// ---------------------------------------------------------------- Reads: ok, unknown, unreadable

/**
 * Why a read is not `ok`. `unreadable` reasons are answers: the host refused, hides or does not
 * support the thing, or the factory refused to ask. `unknown` reasons are the absence of an
 * answer: a network failure, a timeout, a rate limit, a server error, a body that makes no sense,
 * a list cut short. Neither is ever "met" (PLAN principle 7).
 */
export const CodeHostReason = z.enum([
  // unreadable
  'unauthenticated',
  'forbidden',
  'not_found',
  'permission_not_granted',
  'refused',
  'repo_not_allowed',
  'not_a_file',
  'too_large',
  'not_implemented',
  /** A bundle was asked to end at a head that is no longer the default branch's head. */
  'head_moved',
  // unknown
  'network',
  'timeout',
  'rate_limited',
  'server_error',
  'malformed',
  'truncated',
  /** The registry of S0 repos (P-MUST-3) did not answer: nothing is allowed meanwhile. */
  'registry_unavailable',
]);
export type CodeHostReason = z.infer<typeof CodeHostReason>;

export const CodeHostReadState = z.enum(['ok', 'unknown', 'unreadable']);
export type CodeHostReadState = z.infer<typeof CodeHostReadState>;

/** A read that did not give a value. */
export const CodeHostNotOk = z.strictObject({
  state: z.enum(['unknown', 'unreadable']),
  reason: CodeHostReason,
  /** Never carries a credential, a token or key material. */
  message: z.string(),
  /** A write that was refused says why in one token (`PushRefusalCode`); reads leave it out. */
  code: z.string().min(1).max(40).optional(),
});
export type CodeHostNotOk = z.infer<typeof CodeHostNotOk>;

export type CodeHostRead<T> = { readonly state: 'ok'; readonly value: T } | CodeHostNotOk;

// ---------------------------------------------------------------- Repos and the installation

/** `owner/name`, as GitHub spells it (compared without case). */
export const RepoFullName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name')
  .refine((s) => s.split('/').every((p) => p !== '.' && p !== '..'), {
    message: 'owner and name cannot be "." or ".."',
  });
export type RepoFullName = z.infer<typeof RepoFullName>;

export const InstallationRepo = z.strictObject({
  full_name: RepoFullName,
  default_branch: z.string().min(1),
  private: z.boolean(),
  archived: z.boolean(),
  /** Who owns the repo (GitHub's `owner.type`); absent when the host does not say. Tier and PRR need it. */
  owner_type: RepoOwnerType.optional(),
});
export type InstallationRepo = z.infer<typeof InstallationRepo>;

export const InstallationInfo = z.strictObject({
  installation_id: z.number().int().min(0),
  account_login: z.string().min(1),
  repository_selection: z.enum(['all', 'selected']),
  permissions: GithubPermissions,
  /** `true` when GitHub says the installation is suspended. */
  suspended: z.boolean(),
});
export type InstallationInfo = z.infer<typeof InstallationInfo>;

/** A file at a commit (decoded as UTF-8). `blob_sha` is the git blob id. */
export const FileAtSha = z.strictObject({
  path: z.string().min(1),
  sha: GitSha,
  blob_sha: GitSha,
  size: z.number().int().min(0),
  content: z.string(),
});
export type FileAtSha = z.infer<typeof FileAtSha>;

// ---------------------------------------------------------------- Effective rules on a branch

/**
 * A required status check. `integration_id` is the App that must produce it; `null` means any
 * source can satisfy it, which is what B4b is about.
 */
export const RequiredCheck = z.strictObject({
  context: z.string().min(1),
  integration_id: z.number().int().min(0).nullable(),
});
export type RequiredCheck = z.infer<typeof RequiredCheck>;

export const PullRequestRule = z.strictObject({
  required_approving_review_count: z.number().int().min(0),
  require_code_owner_review: z.boolean(),
  require_last_push_approval: z.boolean(),
  dismiss_stale_reviews_on_push: z.boolean(),
  required_review_thread_resolution: z.boolean(),
});
export type PullRequestRule = z.infer<typeof PullRequestRule>;

/**
 * The rules in force on one branch, merged over every ruleset that applies (the strictest value
 * wins). Bypass actors are not here: GitHub does not show them without ruleset write (OB §6.5).
 */
export const BranchRules = z.strictObject({
  branch: z.string().min(1),
  /** `null`: no pull-request rule applies. */
  pull_request: PullRequestRule.nullable(),
  required_checks: z.array(RequiredCheck),
  strict_status_checks: z.boolean(),
  /** A `non_fast_forward` rule applies: force-pushes are blocked. */
  blocks_force_push: z.boolean(),
  /** A `deletion` rule applies: the branch cannot be deleted. */
  blocks_deletion: z.boolean(),
  requires_linear_history: z.boolean(),
  requires_signatures: z.boolean(),
  /** Rule types that apply and that this model does not interpret. */
  other_rule_types: z.array(z.string().min(1)),
});
export type BranchRules = z.infer<typeof BranchRules>;

export const Collaborator = z.strictObject({
  login: z.string().min(1),
  /** The GitHub role name (`admin`, `maintain`, `write`, `triage`, `read` or a custom role). */
  permission: z.string().min(1),
});
export type Collaborator = z.infer<typeof Collaborator>;

// ---------------------------------------------------------------- CODEOWNERS

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;

export const CodeownersFile = z.strictObject({
  path: z.string().min(1),
  sha: GitSha,
  blob_sha: GitSha,
  content: z.string(),
});
export type CodeownersFile = z.infer<typeof CodeownersFile>;

/** What GitHub reports for a CODEOWNERS file (`GET /repos/{r}/codeowners/errors`). */
export const CodeownersError = z.strictObject({
  line: z.number().int().min(1),
  column: z.number().int().min(0),
  kind: z.string().min(1),
  message: z.string(),
  path: z.string().min(1),
});
export type CodeownersError = z.infer<typeof CodeownersError>;

export const CodeownersOwner = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), login: z.string().min(1) }),
  z.strictObject({ kind: z.literal('team'), org: z.string().min(1), slug: z.string().min(1) }),
  z.strictObject({ kind: z.literal('email'), email: z.string().min(1) }),
]);
export type CodeownersOwner = z.infer<typeof CodeownersOwner>;

/** A line of CODEOWNERS the parser could not use (it is skipped, as GitHub skips it). */
export const CodeownersParseError = z.strictObject({
  line: z.number().int().min(1),
  message: z.string().min(1),
});
export type CodeownersParseError = z.infer<typeof CodeownersParseError>;

// ---------------------------------------------------------------- B4 (OB §5.2)

export const B4Id = z.enum(['B4a', 'B4b', 'B4c']);
export type B4Id = z.infer<typeof B4Id>;

/** `unknown` is a refusal to say "clear": for B4a and B4b it blocks. */
export const B4Status = z.enum(['clear', 'blocked', 'amber', 'unknown']);
export type B4Status = z.infer<typeof B4Status>;

export const B4Finding = z.strictObject({
  id: B4Id,
  status: B4Status,
  /** What the finding stops: M4 entirely (B4a, B4b) or only an amber remediation (B4c). */
  blocks: z.enum(['m4', 'remediation']),
  /** Whether this finding stops what it blocks now (`blocked` or `unknown`; B4c: `amber`). */
  active: z.boolean(),
  reasons: z.array(z.string().min(1)),
});
export type B4Finding = z.infer<typeof B4Finding>;

export const B4Report = z.strictObject({
  b4a: B4Finding,
  b4b: B4Finding,
  b4c: B4Finding,
  /** B4a or B4b is active: M4 may not be signed. */
  blocks_m4: z.boolean(),
  amber: z.boolean(),
});
export type B4Report = z.infer<typeof B4Report>;

// ---------------------------------------------------------------- CODEOWNERS feed (M5.2)

export const CodeownersSyncRepo = z.strictObject({
  repo: RepoFullName,
  /** A default-branch head the caller already read; absent: the codehost reads the head. */
  sha: GitSha.optional(),
});
export type CodeownersSyncRepo = z.infer<typeof CodeownersSyncRepo>;

export const CodeownersSyncRequest = z.strictObject({
  repos: z.array(CodeownersSyncRepo).min(1).max(50),
});
export type CodeownersSyncRequest = z.infer<typeof CodeownersSyncRequest>;

export const CodeownersSyncReport = z.strictObject({
  project_id: ProjectId,
  repos: z.array(
    z.strictObject({
      repo: RepoFullName,
      sha: GitSha,
      /** `null`: the repo has no CODEOWNERS file at that sha. */
      path: z.string().min(1).nullable(),
      blob_sha: GitSha.nullable(),
      parse_errors: z.array(CodeownersParseError),
      /** What GitHub itself reports; `null` when it could not be read (never blocks the sync). */
      github_errors: z.array(CodeownersError).nullable(),
    }),
  ),
  /** Logins mapped to principals, in login order. */
  mapped: z.array(z.strictObject({ login: z.string().min(1), principal_id: PrincipalId })),
  /** Logins with no `github_login` IdentityLink: reported, never invented. */
  unmapped_logins: z.array(z.string().min(1)),
  /** `@org/team` owners: unresolved until a team-membership source exists. */
  unresolved_teams: z.array(z.string().min(1)),
  /** E-mail owners: unresolved (GitHub does not say which account an address is). */
  unresolved_emails: z.array(z.string().min(1)),
  /** The members the project's g4 group holds after the sync. */
  members: z.array(PrincipalId),
  added: z.array(PrincipalId),
  removed: z.array(PrincipalId),
  synced_at: IsoDateTime,
});
export type CodeownersSyncReport = z.infer<typeof CodeownersSyncReport>;

/** The body of identity's "set the members of a project's g4 group from CODEOWNERS" command. */
export const SetCodeownerMembersRequest = z.strictObject({
  principals: z.array(PrincipalId).max(500),
  /** Where the owners were read (`owner/name@sha, ...`), for the removal reason. */
  source_ref: z.string().min(1).max(2000),
});
export type SetCodeownerMembersRequest = z.infer<typeof SetCodeownerMembersRequest>;

export const SetCodeownerMembersResult = z.strictObject({
  project_id: ProjectId,
  group_id: z.string().min(1),
  members: z.array(PrincipalId),
  added: z.array(PrincipalId),
  removed: z.array(PrincipalId),
});
export type SetCodeownerMembersResult = z.infer<typeof SetCodeownerMembersResult>;

// ---------------------------------------------------------------- Bundle (M5.3)

/** 256 MiB: the largest bundle the codehost produces (OB §6.5 "Bytes flow", SP-PROC-4). */
export const BUNDLE_DEFAULT_CAP_BYTES = 256 * 1024 * 1024;
/** 180 s: the time one bundle call may take, git included (OB §5.3 item 3). */
export const BUNDLE_DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Which refs a bundle covers. `all`: every branch and tag, plus `refs/pull/<n>/head` on a public repo
 * (OB §5.3 item 3). `default_only`: the default branch alone, recorded as such.
 */
export const BundleRefs = z.enum(['all', 'default_only']);
export type BundleRefs = z.infer<typeof BundleRefs>;

/**
 * Asks for a credential-free `git bundle` of a repo. `refs: 'all'` falls back to `default_only`
 * (and says so in the manifest) when all refs would exceed the size cap.
 */
export const BundleRequest = z.strictObject({
  repo: RepoFullName,
  /** The head the bundle must end at (`X-Base-Sha`). Absent: whatever the default branch is at. */
  base_sha: GitSha.optional(),
  refs: BundleRefs,
});
export type BundleRequest = z.infer<typeof BundleRequest>;

/** What a bundle holds and what it cost. Sent as the `X-Bundle-Manifest` header. */
export const BundleManifest = z.strictObject({
  repo: RepoFullName,
  /** The default branch's head: the bundle's `HEAD` and the value of `X-Base-Sha`. */
  head_sha: GitSha,
  /** What the bundle actually covers: recorded, never assumed from the request. */
  refs_covered: BundleRefs,
  /** Refs in the bundle, not counting `HEAD`. */
  ref_count: z.number().int().min(1),
  commit_count: z.number().int().min(1),
  bytes: z.number().int().min(1),
  duration_ms: z.number().int().min(0),
});
export type BundleManifest = z.infer<typeof BundleManifest>;

// ---------------------------------------------------------------- Registered repos (P-MUST-3)

/**
 * A repo that has an S0 record (or request) in a project. The code-host allow-list is the
 * installation's repos intersected with these (OB §6.5, P-MUST-3). The source is Projects (M7).
 */
export const RegisteredRepo = z.strictObject({
  project_id: ProjectId,
  repo: RepoFullName,
});
export type RegisteredRepo = z.infer<typeof RegisteredRepo>;
