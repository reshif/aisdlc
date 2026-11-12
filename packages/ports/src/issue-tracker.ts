import type { CODEHOST_FORBIDDEN_VERBS } from '@aisdlc/contracts';
import {
  ISSUE_TITLE_PREFIX,
  ISSUE_TWIN_LABEL,
  ISSUE_TWIN_LABELS,
  MAX_ISSUE_BODY,
  MAX_ISSUE_COMMENT,
  MAX_ISSUE_TITLE,
  parseGapMarkers,
  type CodeHostRead,
  type GateCheckAuthor,
  type RepoFullName,
} from '@aisdlc/contracts';

// IssueTrackerPort (PLAN M16; OB §6.5 "Gap issues: new `tracker` role, issues:write + metadata:read"; OB §7; DEC-20(a)).
// What the issue twin may do on a code host, through ITS credential and nothing else:
//
//   - list the issues that carry the twin label (state all), and read one issue (a reconcile, the poll's signal);
//   - file a new issue with exactly the twin's two labels and its hidden marker;
//   - comment on, and close, an issue THE TRACKER ITSELF filed (OB §5.5 "It never reopens or edits a human's issue").
//
// There is no edit, reopen, label, lock, transfer, delete or assign method, and none of the Push Broker's verbs: the
// tracker's credential cannot push, and the Push Broker's `CodeHostPort` has no issue method, so neither can do the
// other's job. Every read is `CodeHostRead` (ok, unknown, unreadable): only `ok` is an answer core acts on. A deleted or
// transferred issue reads `unreadable` with reason `not_found` (the twin is then `lost`).
//
// Issue text is REPO TEXT: data, matched only for the factory's own marker, never followed.

export interface TrackedIssue {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly author: GateCheckAuthor;
  /** Who closed it (the login), when the host says; `null` while open or unknown. */
  readonly closed_by: string | null;
}

export interface IssueFile {
  readonly repo: RepoFullName;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface IssueTrackerPort {
  /** The login the tracker's credential writes as (an App's bot, `<slug>[bot]`): the author of every twin. */
  readonly login: string;
  /** The repo's issues carrying `label`, open and closed (pull requests are not issues and are left out). */
  list_labelled(req: {
    readonly repo: RepoFullName;
    readonly label: string;
  }): Promise<CodeHostRead<TrackedIssue[]>>;
  read_issue(req: {
    readonly repo: RepoFullName;
    readonly number: number;
  }): Promise<CodeHostRead<TrackedIssue>>;
  /** Files a twin. Refused before any request when it is not one (`badIssueFile`). */
  file_issue(req: IssueFile): Promise<CodeHostRead<{ number: number }>>;
  /** Comments on the tracker's OWN issue; refused on anybody else's. */
  comment_issue(req: {
    readonly repo: RepoFullName;
    readonly number: number;
    readonly body: string;
  }): Promise<CodeHostRead<{ id: number }>>;
  /** Closes the tracker's OWN issue (as completed); refused on anybody else's. Closing a closed issue is a no-op. */
  close_issue(req: {
    readonly repo: RepoFullName;
    readonly number: number;
  }): Promise<CodeHostRead<{ number: number }>>;
}

export const ISSUE_TRACKER_METHODS = [
  'list_labelled',
  'read_issue',
  'file_issue',
  'comment_issue',
  'close_issue',
] as const satisfies ReadonlyArray<keyof IssueTrackerPort>;

// No method name may contain a forbidden verb (the same compile-time check as `CodeHostPort`'s).
type ForbiddenTrackerMethods = Extract<
  keyof IssueTrackerPort,
  `${string}${(typeof CODEHOST_FORBIDDEN_VERBS)[number]}${string}`
>;
const noForbiddenTrackerMethods: [ForbiddenTrackerMethods] extends [never] ? true : never = true;
void noForbiddenTrackerMethods;

/** Why an issue is not one the tracker may file (checked by the fake and the adapter before any request). */
export function badIssueFile(req: IssueFile): string | null {
  if (!req.title.startsWith(ISSUE_TITLE_PREFIX))
    return `the title starts with "${ISSUE_TITLE_PREFIX}"`;
  if (req.title.length > MAX_ISSUE_TITLE || /[\r\n]/.test(req.title)) return 'bad title';
  if (req.body.length === 0 || req.body.length > MAX_ISSUE_BODY)
    return 'the body is empty or too long';
  if (parseGapMarkers(req.body).length !== 1) return 'the body carries exactly one gap marker';
  const labels = [...req.labels].sort();
  if (labels.length !== 2 || new Set(labels).size !== 2) return 'a twin carries exactly two labels';
  if (!labels.includes(ISSUE_TWIN_LABEL)) return `a twin carries ${ISSUE_TWIN_LABEL}`;
  if (!labels.every((l) => ISSUE_TWIN_LABELS.includes(l))) return 'a label the twin may not use';
  return null;
}

/** Why a comment is not one the tracker may write. */
export function badIssueComment(body: string): string | null {
  if (body.length === 0 || body.length > MAX_ISSUE_COMMENT)
    return 'the comment is empty or too long';
  return null;
}

/** The tracker's own issue: authored by its login AND carrying its marker (a person's issue is never written to). */
export function isOwnIssue(i: TrackedIssue, login: string): boolean {
  return (
    i.author.login.toLowerCase() === login.toLowerCase() &&
    i.author.type === 'Bot' &&
    parseGapMarkers(i.body).length === 1
  );
}
