import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import { z } from 'zod';
import { GitSha, IsoDateTime, Sha256Hex, WorkItemId } from './ids.js';
import { PullRequestState, RepoFullName } from './codehost.js';
import { UnitKey } from './planning.js';

// The Push Broker's vocabulary (PLAN M13.6; DM §3.6 Branch, Commit, PullRequest, PushReceipt; OB §5.5, §6.5 and §6.6;
// onboarding-roadmap §11 rows 20 to 23). One definition for the port, the fake, the GitHub adapter, the codehost's
// route, core's record and the S6 coding port. Nothing here talks to a network.
//
// The only writer to GitHub is the Push Broker (`services/codehost`). It writes ONE kind of thing: a commit chain on
// the branch `agent/<item>/<unit>` and a DRAFT pull request from it. It has no way to merge, approve, request a
// review, change a ruleset or a workflow, force-push or delete: the verbs do not exist as methods or as allow-list rows.

// ---------------------------------------------------------------- Branch

/** The only ref prefix the broker writes (DM §3.6 Branch: `writable` is the agent prefix only). */
export const PUSH_BRANCH_PREFIX = 'agent/';

/**
 * `agent/<item uuid>/<unit key>`, nothing else. Checked as a whole (the item is a UUID, the unit a slug) and then by
 * git's own ref rules, so `agent/../main`, `agent/x/y.lock`, `agent/x//y` and `agent/x/y..z` are all refused.
 */
export function badPushBranch(branch: string, item_id?: string, unit_key?: string): string | null {
  const m = /^agent\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([^/]+)$/.exec(
    branch,
  );
  if (!m) return 'the branch is not agent/<item>/<unit>';
  const unit = m[2] as string;
  if (!UnitKey.safeParse(unit).success) return 'the unit part of the branch is not a unit key';
  if (unit.includes('..') || unit.endsWith('.') || unit.endsWith('.lock')) {
    return 'the unit part of the branch is not a valid git ref name';
  }
  if (item_id !== undefined && m[1] !== item_id) return 'the branch names another item';
  if (unit_key !== undefined && unit !== unit_key) return 'the branch names another unit';
  return null;
}

// ---------------------------------------------------------------- Protected paths (OB §6.6, SP-FID-3)

/**
 * Paths the Push Broker refuses unless an X2 decision is bound to exactly the patch that touches them
 * (OB §11 row 20): the instruction files an agent could use to widen its own power, CODEOWNERS (who may approve)
 * and the factory's own directories. Compared without case and after normalisation, so `agents.MD` and
 * `.Claude/x` are caught on a case-insensitive file system.
 */
export const PUSH_PROTECTED_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  '.mcp.json',
  '.factory/**',
  '.claude/**',
] as const;

const lower = (p: string): string => p.normalize('NFC').toLowerCase();

/** The protected-path rule `path` falls under, or `null`. Nested instruction files (`pkg/AGENTS.md`) count. */
export function protectedPushPath(path: string): string | null {
  const p = lower(path);
  const segs = p.split('/');
  const name = segs[segs.length - 1] as string;
  if (name === 'agents.md') return 'AGENTS.md';
  if (name === 'claude.md') return 'CLAUDE.md';
  if (name === '.mcp.json') return '.mcp.json';
  if (p === 'codeowners' || p === '.github/codeowners' || p === 'docs/codeowners')
    return 'CODEOWNERS';
  if (segs[0] === '.factory') return '.factory/**';
  if (segs[0] === '.claude') return '.claude/**';
  return null;
}

/** Workflow files: GitHub itself needs the `workflows` permission for them, which the factory never requests. Never writable. */
export const isWorkflowPath = (path: string): boolean =>
  lower(path).startsWith('.github/workflows/');

/** Why a patch path is not acceptable at all (no X2 can make it so), or `null`. */
export function badPatchPath(path: string): string | null {
  if (path === '' || path.length > 1024) return 'the path is empty or too long';
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return 'the path is not a plain relative path';
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'the path has a control character';
  const segs = path.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    return 'the path has an empty, "." or ".." segment';
  }
  if (segs.some((s) => lower(s) === '.git' || /^\.git\s*$/i.test(s) || /^git~\d$/i.test(s))) {
    return 'the path is inside .git';
  }
  if (segs.some((s) => /[\s.]$/.test(s))) return 'a path segment ends in a dot or a space';
  return null;
}

// ---------------------------------------------------------------- The patch

/** `100644` and `100755` only: a symlink (`120000`) or a submodule (`160000`) is not a file the factory writes. */
export const PatchFile = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('put'),
    path: z.string().min(1).max(1024),
    mode: z.enum(['100644', '100755']),
    /** The file's bytes, base64. */
    content_b64: z.string().max(40_000_000),
  }),
  z.strictObject({ op: z.literal('delete'), path: z.string().min(1).max(1024) }),
]);
export type PatchFile = z.infer<typeof PatchFile>;

export const PATCH_SCHEMA = 'patch/1';
export const PATCH_MAX_FILES = 2000;

/** What a Unit's session changed, against its base commit: the unit of approval (X2) and the unit of hashing. */
export const PatchSet = z.strictObject({
  schema: z.literal(PATCH_SCHEMA),
  files: z.array(PatchFile).min(1).max(PATCH_MAX_FILES),
});
export type PatchSet = z.infer<typeof PatchSet>;

/** A patch with its files sorted by path, so the same change is the same bytes and the same hash. */
export const patchSetOf = (files: readonly PatchFile[]): PatchSet => ({
  schema: PATCH_SCHEMA,
  files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
});

/** The patch hash an X2 decision is bound to: sha256 of the canonical JSON of the patch set. */
export const patchHashOf = (patch: PatchSet): string => sha256Hex(canonicalJson(patch as never));

// ---------------------------------------------------------------- Evidence the PR body is built from

/** Facts, never prose from the repo: the body is rendered from these and every text in them is made inert. */
export const PushEvidence = z.strictObject({
  title: z.string().min(1).max(200),
  lane: z.string().min(1).max(8),
  base_sha: GitSha,
  oracles: z
    .array(z.strictObject({ oracle_id: z.string().min(1).max(64), spec_sha256: Sha256Hex }))
    .max(200),
  files_changed: z.number().int().min(0),
  lines_changed: z.number().int().min(0),
  checks: z
    .array(
      z.strictObject({ name: z.string().min(1).max(64), result: z.enum(['passed', 'failed']) }),
    )
    .max(50),
  /** Hashes only: the session, the plan, the evidence the story rests on. */
  refs: z.record(z.string().min(1).max(32), z.string().min(1).max(128)).default({}),
});
export type PushEvidence = z.infer<typeof PushEvidence>;

// ---------------------------------------------------------------- The request and what comes back

/**
 * `apply_patch`: one Unit's patch, as one commit on its branch and a draft PR. `lease_epoch` is the epoch the writer
 * was given at admission: the broker asks the Unit's owner (core) for the current one and refuses a stale writer.
 * `expected_head` is the head the writer last pushed (`null`: a new branch): a branch that has moved is not a
 * fast-forward and is refused, never forced.
 */
export const ApplyPatchRequest = z.strictObject({
  repo: RepoFullName,
  item_id: WorkItemId,
  unit_key: UnitKey,
  lane: z.string().min(1).max(8),
  lease_epoch: z.number().int().min(1),
  branch: z.string().min(1).max(255),
  base_sha: GitSha,
  expected_head: GitSha.nullable(),
  patch: PatchSet,
  /** The commit's subject line. The trailers (item, unit, epoch, patch hash) are added by the broker. */
  message: z.string().min(1).max(200),
  evidence: PushEvidence,
});
export type ApplyPatchRequest = z.infer<typeof ApplyPatchRequest>;

/** DM §3.6 `PushReceipt.status`, with `refused` for every other reason (the code says which). */
export const PushReceiptStatus = z.enum(['applied', 'refused_stale_epoch', 'no_lease', 'refused']);
export type PushReceiptStatus = z.infer<typeof PushReceiptStatus>;

export const PushRefusalCode = z.enum([
  'branch_not_allowed',
  'bad_patch',
  'bad_path',
  'secret_in_patch',
  'protected_path',
  'workflow_path',
  'stale_epoch',
  'no_lease',
  'spike_lane',
  'non_fast_forward',
  'base_unknown',
  'guards_unavailable',
  'repo_not_allowed',
  /** M16 (OB §8, DEC-21): the repo's readiness record is suspended for drift; only an L8 (human-led) push goes on. */
  'prr_suspended',
  /** Any other refusal (the allow-list, a host rule): the message says which. */
  'refused',
]);
export type PushRefusalCode = z.infer<typeof PushRefusalCode>;

export const PullRequestRef = z.strictObject({
  number: z.number().int().min(1),
  draft: z.boolean(),
  state: z.enum(['open', 'closed']),
  head_sha: GitSha,
  head_ref: z.string().min(1).max(255),
  base_ref: z.string().min(1).max(255),
  html_url: z.string().max(500).nullable(),
});
export type PullRequestRef = z.infer<typeof PullRequestRef>;

export const AppliedPatch = z.strictObject({
  branch: z.string().min(1),
  commit_sha: GitSha,
  parent_sha: GitSha,
  tree_sha: GitSha,
  /** The branch did not exist before this push. */
  created: z.boolean(),
  patch_hash: Sha256Hex,
  pr: PullRequestRef,
});
export type AppliedPatch = z.infer<typeof AppliedPatch>;

/**
 * DM §3.6 PushReceipt: what the Push Broker did, recorded by core as a record event AND a ledger entry. A refusal is
 * a receipt too (status `refused`, with its code): the ledger shows what was tried as well as what was written.
 */
export const PushReceipt = z.strictObject({
  receipt_id: z.string().min(1).max(128),
  item_id: WorkItemId,
  unit_key: UnitKey,
  repo: RepoFullName,
  branch: z.string().min(1),
  lease_epoch: z.number().int().min(1),
  patch_hash: Sha256Hex,
  status: PushReceiptStatus,
  /** Why it was refused; `null` for `applied`. */
  code: PushRefusalCode.nullable(),
  base_sha: GitSha,
  head_sha: GitSha.nullable(),
  pr_number: z.number().int().min(1).nullable(),
  files: z.number().int().min(0),
  at: IsoDateTime,
});
export type PushReceipt = z.infer<typeof PushReceipt>;

/** DM §3.6 PullRequest as core reads it (`core.pull_request`, rebuilt from the receipts). */
export const PullRequest = z.strictObject({
  pr_ref: z.string().min(1).max(64),
  repo: RepoFullName,
  number: z.number().int().min(1),
  item_id: WorkItemId,
  unit_key: UnitKey,
  head_ref: z.string().min(1),
  head_sha: GitSha,
  state: PullRequestState,
  draft: z.boolean(),
});
export type PullRequest = z.infer<typeof PullRequest>;

// ---------------------------------------------------------------- Record

export const pushStream = (itemId: string): string => `push:${itemId}`;
export const PUSH_STREAM_PREFIX = 'push:';

export const PUSH_EVENT = {
  /** Recorded BEFORE the broker is called (DEC-12(a): the record first, the host is its projection). */
  intended: 'push.intended',
  receipt_recorded: 'push.receipt_recorded',
} as const;

export const PushIntendedPayload = z.strictObject({
  item_id: WorkItemId,
  unit_key: UnitKey,
  repo: RepoFullName,
  branch: z.string().min(1),
  lease_epoch: z.number().int().min(1),
  base_sha: GitSha,
  patch_hash: Sha256Hex,
  files: z.number().int().min(0),
  command_key: z.string().min(1),
  /**
   * The paths the patch touches (M15.1): what G4 reads as the changed paths of the head this patch became. The patch
   * is the Unit's whole diff against the base, so its paths are the PR's. Absent in events older than M15.1: G4 then
   * treats the paths as unknown (mode C with the step-up, fail closed).
   */
  paths: z.array(z.string().min(1).max(1024)).max(PATCH_MAX_FILES).optional(),
});
export type PushIntendedPayload = z.infer<typeof PushIntendedPayload>;

export const PushReceiptRecordedPayload = PushReceipt;

/** The `entry_type` of the ledger entry a push receipt gets. */
export const PUSH_LEDGER_ENTRY_TYPE = 'push.receipt';

// ---------------------------------------------------------------- Guards (the Unit's owner answers, the broker asks)

/** What the broker asks core before it writes: the Unit's current lease and whether an X2 is bound to the patch. */
export const PushLeaseFacts = z.strictObject({
  held: z.boolean(),
  epoch: z.number().int().min(0),
  lane: z.string().min(1).max(8),
  /** M16: the repo's governing readiness record is `suspended` (drift). Absent: not suspended (an older owner). */
  suspended: z.boolean().optional(),
});
export type PushLeaseFacts = z.infer<typeof PushLeaseFacts>;
