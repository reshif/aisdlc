import { z } from 'zod';
import { CriterionId } from './criteria.js';
import { RepoFullName, type GithubPermissions } from './codehost.js';
import {
  GitSha,
  IsoDateTime,
  LedgerEntryId,
  PrincipalId,
  ProjectId,
  RepoId,
  S0RecordId,
  Sha256Hex,
  WorkItemId,
  WorkRequestId,
} from './ids.js';
import { RepoVisibility } from './projects.js';
import { GapId, GapSeverity, GapVisibilityClass } from './readiness.js';

// The GitHub issue twin (PLAN M16; OB §7 "Gaps -> GitHub issues"; DEC-20(a)). The factory record is the system of
// record for gaps; a GitHub issue is a human-facing TWIN, filed only from a batch a person approved, and its state comes
// back only as a SIGNAL. One vocabulary for the port in `@aisdlc/ports`, the fake, the GitHub adapter and core.
//
//   - Approving a batch is a decision event (not a gate): a record event AND a ledger entry carry the exact list and
//     the hash of the rendered bodies; the tracker files exactly that list, idempotently.
//   - Dedupe, in order: the record's gap -> issue map; a reconcile of labelled issues by their hidden marker; a person
//     linking a duplicate. GitHub search is never the source of truth.
//   - Sync is poll-only: a person closes the issue -> the factory re-checks the criterion at the default branch's head
//     (pass: `closed_verified`; anything else: `closed_unverified`, ONE comment, the issue is not reopened); the
//     factory's re-check passes while the issue is open -> it comments "verified at <sha>" and closes its own issue; a
//     deleted or transferred issue -> `lost`. Edits to labels or titles are ignored. An issue never closes a gap.
//   - Disclosure (SEC-OB-4, OB §5.3): a `private_only` gap (a security finding) is never filed, on any repo; every
//     rendered body passes the content lint and the secret ruleset before anything is recorded.

// ---------------------------------------------------------------- the tracker's App

/**
 * OB §6.5 "Gap issues: new `tracker` role, issues:write + metadata:read". Its own credential (a separate App or
 * installation token), never the Push Broker's and never gate-check's: neither of those can write an issue, and this
 * one can do nothing else.
 */
export const TRACKER_APP_PERMISSIONS: GithubPermissions = {
  issues: 'write',
  metadata: 'read',
};

// ---------------------------------------------------------------- issue format

/** OB §7 "two labels only": the twin label, and the severity label. */
export const ISSUE_TWIN_LABEL = 'factory:onboarding-gap';
export const gapSeverityLabel = (s: GapSeverity): string => `gap:${s}`;
/** Every label the tracker may put on an issue. */
export const ISSUE_TWIN_LABELS: readonly string[] = [
  ISSUE_TWIN_LABEL,
  gapSeverityLabel('blocking'),
  gapSeverityLabel('tracked'),
];

/** `<!-- asf-gap: <gap_id> v1 -->`: the hidden marker that lets a reconcile find a twin the record lost track of. */
export const gapMarker = (gapId: string): string => `<!-- asf-gap: ${gapId} v1 -->`;

const MARKER_RE = /<!-- asf-gap: (gap:[A-Za-z0-9_.-]+:RS-[A-Z]+(?:-\d+)?(?::[^\s>]+)?) v1 -->/g;

/** Every gap id an issue body's markers name, in order (an issue a person wrote names none). */
export function parseGapMarkers(body: string): string[] {
  return [...body.matchAll(MARKER_RE)].map((m) => m[1] as string);
}

/** OB §7 "title `[onboarding] <criterion> (<RS-id>)`". */
export const ISSUE_TITLE_PREFIX = '[onboarding] ';
export const MAX_ISSUE_TITLE = 200;
export const MAX_ISSUE_BODY = 8_000;
export const MAX_ISSUE_COMMENT = 2_000;

// ---------------------------------------------------------------- states

/**
 * The twin's state. `pending`: approved and intended, not yet seen on the host. The others are `IssueLinkState`'s
 * (`open`, `closed_verified`, `closed_unverified`, `lost`).
 */
export const IssueTwinState = z.enum([
  'pending',
  'open',
  'closed_verified',
  'closed_unverified',
  'lost',
]);
export type IssueTwinState = z.infer<typeof IssueTwinState>;
export const IssueTwinStateValues: readonly IssueTwinState[] = IssueTwinState.options;

/** A batch row's choice: file a twin, or keep the gap in the factory only. Waivers are card 1's, never a batch's. */
export const IssueTwinDisposition = z.enum(['file_issue', 'track_only']);
export type IssueTwinDisposition = z.infer<typeof IssueTwinDisposition>;

/** How a twin came to be linked: the tracker filed it, a reconcile found it by its marker, or a person linked it. */
export const IssueTwinLinkVia = z.enum(['created', 'reconciled', 'linked']);
export type IssueTwinLinkVia = z.infer<typeof IssueTwinLinkVia>;

/** What a factory re-check of a criterion at the default branch's head said. Unknown is unmet (fail closed). */
export const GapRecheckResult = z.enum(['pass', 'fail', 'unknown']);
export type GapRecheckResult = z.infer<typeof GapRecheckResult>;

/** The two writes the factory makes on its own twin after it is filed (OB §7 "Sync"). */
export const IssueTwinWrite = z.enum(['comment_unverified', 'verified_close']);
export type IssueTwinWrite = z.infer<typeof IssueTwinWrite>;

/** Why a gap is not filed even when a person chose `file_issue`. */
export const IssueTwinDisclosure = z.enum(['pass', 'private_only', 'lint_failed']);
export type IssueTwinDisclosure = z.infer<typeof IssueTwinDisclosure>;

// ---------------------------------------------------------------- streams and events

/** The record stream of one repo's twins. Repo names compare without case. */
export const issueTwinStream = (repo: string): string => `issue_twin:${repo.toLowerCase()}`;
export const ISSUE_TWIN_STREAM_PREFIX = 'issue_twin:';

export const ISSUE_TWIN_EVENT = {
  batch_approved: 'issue_twin.batch_approved',
  file_intended: 'issue_twin.file_intended',
  linked: 'issue_twin.linked',
  signal_observed: 'issue_twin.signal_observed',
  rechecked: 'issue_twin.rechecked',
  write_intended: 'issue_twin.write_intended',
  write_done: 'issue_twin.write_done',
  state_changed: 'issue_twin.state_changed',
  request_made: 'issue_twin.request_made',
} as const;
export type IssueTwinEventType = (typeof ISSUE_TWIN_EVENT)[keyof typeof ISSUE_TWIN_EVENT];

/** The `entry_type` of the ledger entry an approved batch gets. */
export const ISSUE_TWIN_LEDGER_ENTRY_TYPE = 'issue_twin.batch';

/** One row of an approved batch. `body_sha256` is the hash of the rendered body for a filed row, `null` otherwise. */
export const IssueTwinBatchRow = z.strictObject({
  gap_id: GapId,
  criterion: CriterionId,
  severity: GapSeverity,
  disposition: IssueTwinDisposition,
  title: z.string().min(1).max(MAX_ISSUE_TITLE),
  body_sha256: Sha256Hex.nullable(),
});
export type IssueTwinBatchRow = z.infer<typeof IssueTwinBatchRow>;

export const IssueTwinBatchApproved = z.strictObject({
  batch_id: z.uuid(),
  project_id: ProjectId,
  repo: RepoFullName,
  repo_id: RepoId,
  /** The S0 record whose readiness record the gaps are from (the ledger entry's subject). */
  s0_id: S0RecordId,
  prr_version: z.number().int().min(1),
  record_hash: Sha256Hex,
  visibility: RepoVisibility,
  /** Ordered by gap id. */
  rows: z.array(IssueTwinBatchRow).min(1),
  /** sha256 of the canonical JSON of `[{gap_id, body_sha256}]` of the filed rows: what the ledger binds. */
  bodies_hash: Sha256Hex,
  approved_by: PrincipalId,
  approved_at: IsoDateTime,
  ledger_entry_id: LedgerEntryId,
});
export type IssueTwinBatchApproved = z.infer<typeof IssueTwinBatchApproved>;

export const IssueTwinFileIntended = z.strictObject({
  batch_id: z.uuid(),
  gap_id: GapId,
  body_sha256: Sha256Hex,
});
export type IssueTwinFileIntended = z.infer<typeof IssueTwinFileIntended>;

export const IssueTwinLinked = z.strictObject({
  gap_id: GapId,
  number: z.number().int().min(1),
  via: IssueTwinLinkVia,
  batch_id: z.uuid().nullable(),
  /** A person who linked a duplicate; `null` for the tracker's own. */
  by: PrincipalId.nullable(),
});
export type IssueTwinLinked = z.infer<typeof IssueTwinLinked>;

/** What the poll saw of one twin (record first: the signal is stored before anything acts on it). */
export const IssueTwinSignal = z.strictObject({
  gap_id: GapId,
  number: z.number().int().min(1),
  seen: z.enum(['open', 'closed', 'missing']),
  /** The issue was closed by the tracker's own login (the factory's verified close). */
  closed_by_factory: z.boolean(),
});
export type IssueTwinSignal = z.infer<typeof IssueTwinSignal>;

export const IssueTwinRechecked = z.strictObject({
  gap_id: GapId,
  /** The default branch's head the criterion was checked at; `null` when it could not be read. */
  sha: GitSha.nullable(),
  result: GapRecheckResult,
  /** Why: the re-check's own reason, never repo text. */
  reason: z.string().max(200),
});
export type IssueTwinRechecked = z.infer<typeof IssueTwinRechecked>;

export const IssueTwinWriteIntended = z.strictObject({
  gap_id: GapId,
  number: z.number().int().min(1),
  write: IssueTwinWrite,
  sha: GitSha.nullable(),
  body_sha256: Sha256Hex,
});
export type IssueTwinWriteIntended = z.infer<typeof IssueTwinWriteIntended>;

export const IssueTwinWriteDone = z.strictObject({
  gap_id: GapId,
  number: z.number().int().min(1),
  write: IssueTwinWrite,
});
export type IssueTwinWriteDone = z.infer<typeof IssueTwinWriteDone>;

export const IssueTwinStateChanged = z.strictObject({
  gap_id: GapId,
  to: IssueTwinState,
  reason: z.string().min(1).max(200),
});
export type IssueTwinStateChanged = z.infer<typeof IssueTwinStateChanged>;

export const IssueTwinRequestMade = z.strictObject({
  gap_id: GapId,
  number: z.number().int().min(1).nullable(),
  request_id: WorkRequestId,
  item_id: WorkItemId.nullable(),
  by: PrincipalId,
});
export type IssueTwinRequestMade = z.infer<typeof IssueTwinRequestMade>;

// ---------------------------------------------------------------- the portal's view

export const IssueTwinRowView = z.strictObject({
  gap_id: GapId,
  criterion: CriterionId,
  severity: GapSeverity,
  /** The factory's rendered title (never what the issue says on GitHub now: edits there are ignored). */
  title: z.string(),
  number: z.number().int().min(1).nullable(),
  state: IssueTwinState,
  via: IssueTwinLinkVia.nullable(),
  /** The last re-check: what it said and at which head. */
  recheck: z.strictObject({ result: GapRecheckResult, sha: GitSha.nullable() }).nullable(),
  batch_id: z.uuid().nullable(),
  /** The remediation request made from this twin (N6), if any. */
  request: z.strictObject({ request_id: WorkRequestId, item_id: WorkItemId.nullable() }).nullable(),
});
export type IssueTwinRowView = z.infer<typeof IssueTwinRowView>;

export const IssueTwinBatchView = z.strictObject({
  batch_id: z.uuid(),
  approved_by: PrincipalId,
  approved_at: IsoDateTime,
  filed: z.number().int().min(0),
  tracked: z.number().int().min(0),
  bodies_hash: Sha256Hex,
  ledger_entry_id: LedgerEntryId,
});
export type IssueTwinBatchView = z.infer<typeof IssueTwinBatchView>;

/** A gap of the governing readiness record that no batch has disposed of yet: a row the person may put in a batch. */
export const IssueTwinCandidate = z.strictObject({
  gap_id: GapId,
  criterion: CriterionId,
  severity: GapSeverity,
  visibility_class: GapVisibilityClass,
  title: z.string(),
  disclosure: IssueTwinDisclosure,
  default: IssueTwinDisposition,
  allowed: z.array(IssueTwinDisposition).min(1),
});
export type IssueTwinCandidate = z.infer<typeof IssueTwinCandidate>;

export const IssueTwinRepoView = z.strictObject({
  repo: RepoFullName,
  visibility: RepoVisibility.nullable(),
  /** `null` when no readiness record governs the repo: nothing can be filed. */
  prr_version: z.number().int().min(1).nullable(),
  twins: z.array(IssueTwinRowView),
  /** Gaps kept in the factory only because they are security findings (never filed, on any repo). */
  private_only: z.array(z.strictObject({ gap_id: GapId, criterion: CriterionId })),
  batches: z.array(IssueTwinBatchView),
  candidates: z.array(IssueTwinCandidate),
  /** When the poll last recorded a signal for this repo; `null` before the first. */
  polled_at: IsoDateTime.nullable(),
});
export type IssueTwinRepoView = z.infer<typeof IssueTwinRepoView>;

export const IssueTwinView = z.strictObject({
  project_id: ProjectId,
  repos: z.array(IssueTwinRepoView),
});
export type IssueTwinView = z.infer<typeof IssueTwinView>;

// ---------------------------------------------------------------- requests to core

export const IssueTwinBatchRequest = z.strictObject({
  repo: RepoFullName,
  /** One row per gap the person disposes of now; at least one. */
  rows: z
    .array(z.strictObject({ gap_id: GapId, disposition: IssueTwinDisposition }))
    .min(1)
    .max(200),
  on_behalf_of: PrincipalId,
});
export type IssueTwinBatchRequest = z.infer<typeof IssueTwinBatchRequest>;

export const IssueTwinBatchResult = z.strictObject({
  batch_id: z.uuid(),
  filed: z.number().int().min(0),
  tracked: z.number().int().min(0),
  bodies_hash: Sha256Hex,
  ledger_entry_id: LedgerEntryId,
});
export type IssueTwinBatchResult = z.infer<typeof IssueTwinBatchResult>;

/** A person links an issue already on GitHub as the twin of a gap (dedupe step 3). */
export const IssueTwinLinkRequest = z.strictObject({
  repo: RepoFullName,
  gap_id: GapId,
  number: z.number().int().min(1),
  on_behalf_of: PrincipalId,
});
export type IssueTwinLinkRequest = z.infer<typeof IssueTwinLinkRequest>;

/** Turn a twin's gap into a remediation request (N6 -> S1 as L2 -> G0). */
export const IssueTwinRequestRequest = z.strictObject({
  repo: RepoFullName,
  gap_id: GapId,
  on_behalf_of: PrincipalId,
});
export type IssueTwinRequestRequest = z.infer<typeof IssueTwinRequestRequest>;

export const IssueTwinRequestResult = z.strictObject({
  request_id: WorkRequestId,
  item_id: WorkItemId.nullable(),
  duplicate: z.boolean(),
  injection_suspected: z.boolean(),
});
export type IssueTwinRequestResult = z.infer<typeof IssueTwinRequestResult>;

/**
 * What the bff serves the portal: the view and what the person may do on it (the PDP's answers, as hints: every
 * write is decided again on the server). `propose`: approve a batch or link a duplicate (`config.propose`);
 * `request`: turn a twin into a remediation request (`work.request`).
 */
export const PortalIssueTwinView = IssueTwinView.extend({
  may: z.strictObject({ propose: z.boolean(), request: z.boolean() }),
});
export type PortalIssueTwinView = z.infer<typeof PortalIssueTwinView>;
