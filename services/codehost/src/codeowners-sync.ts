import {
  type CodeHostNotOk,
  type CodeownersParseError,
  type CodeownersSyncReport,
  type CodeownersSyncRequest,
  type PrincipalId,
  type ProjectId,
} from '@aisdlc/contracts';
import {
  err,
  ok,
  systemClock,
  taggedError,
  type Clock,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';
import { repoKey } from '@aisdlc/ports';
import { parseCodeowners } from './codeowners.js';
import type { IdentityLinksError, IdentityLinksPort } from './identity-client.js';
import type { AllowListedCodeHost } from './repo-allow-list.js';

// The CODEOWNERS feed (PLAN M5.2, the M4.4 follow-up). For a project, read CODEOWNERS at the
// default-branch head of each of its repos, take the owners, map GitHub logins to principals
// through IdentityLink and set the members of the project's generated g4 group through identity.
//
// Fail closed, in this order of care:
//   * only the default-branch head is read (never a PR branch: repo content proposes, a merged and
//     reviewed CODEOWNERS decides); a caller's sha must BE that head;
//   * a repo must be registered to THIS project and reached by the installation;
//   * anything unreadable (a repo, the head, the file) or an identity error aborts: nothing is
//     changed, so a transient failure never empties the group;
//   * unmapped logins are reported, never invented; `@org/team` and e-mail owners are recorded as
//     unresolved (no team-membership source yet; an e-mail does not name a GitHub account).

export type CodeownersSyncErrorCode =
  | 'invalid_input'
  | 'repo_not_allowed'
  | 'stale_sha'
  | 'host_unknown'
  | 'host_unreadable'
  | 'identity_unavailable'
  | 'identity_refused';

export const CodeownersSyncError = taggedError('CodeownersSyncError');
export type CodeownersSyncError = TaggedError<
  'CodeownersSyncError',
  { code: CodeownersSyncErrorCode; message: string }
>;
const fail = (code: CodeownersSyncErrorCode, message: string): CodeownersSyncError =>
  CodeownersSyncError({ code, message });

export const CODEOWNERS_SYNC_STATUS: Readonly<Record<CodeownersSyncErrorCode, number>> = {
  invalid_input: 400,
  repo_not_allowed: 403,
  stale_sha: 409,
  host_unknown: 503,
  host_unreadable: 502,
  identity_unavailable: 503,
  identity_refused: 502,
};

export const MAX_OWNER_LOGINS = 500;

export interface CodeownersSyncDeps {
  readonly host: AllowListedCodeHost;
  readonly identity: IdentityLinksPort;
  readonly clock?: Clock;
}

const hostFail = (what: string, r: CodeHostNotOk): CodeownersSyncError =>
  fail(r.state === 'unknown' ? 'host_unknown' : 'host_unreadable', `${what}: ${r.reason}`);

const identityFail = (e: IdentityLinksError): CodeownersSyncError =>
  fail(e.code === 'unavailable' ? 'identity_unavailable' : 'identity_refused', e.message);

export async function syncCodeowners(
  deps: CodeownersSyncDeps,
  project: ProjectId,
  req: CodeownersSyncRequest,
): Promise<Result<CodeownersSyncReport, CodeownersSyncError>> {
  const seen = new Set<string>();
  for (const r of req.repos) {
    if (seen.has(repoKey(r.repo))) return err(fail('invalid_input', `${r.repo} is listed twice`));
    seen.add(repoKey(r.repo));
  }
  const installed = await deps.host.list_repos();
  if (installed.state !== 'ok') return err(hostFail('installation repos', installed));

  const users = new Set<string>();
  const teams = new Set<string>();
  const emails = new Set<string>();
  const repos: CodeownersSyncReport['repos'] = [];
  const refs: string[] = [];

  for (const want of req.repos) {
    const owner = await deps.host.projectOf(want.repo);
    if (owner.state !== 'ok') return err(hostFail(`registry for ${want.repo}`, owner));
    if (owner.value !== project) {
      return err(fail('repo_not_allowed', `${want.repo} is not registered to project ${project}`));
    }
    const info = installed.value.find((r) => repoKey(r.full_name) === repoKey(want.repo));
    if (!info) {
      return err(fail('repo_not_allowed', `${want.repo} is not reached by the installation`));
    }
    const head = await deps.host.branch_head({ repo: want.repo, branch: info.default_branch });
    if (head.state !== 'ok') return err(hostFail(`head of ${want.repo}`, head));
    if (want.sha !== undefined && want.sha !== head.value) {
      return err(
        fail(
          'stale_sha',
          `${want.sha} is not the head of ${want.repo}'s default branch (${head.value})`,
        ),
      );
    }
    const file = await deps.host.codeowners({ repo: want.repo, sha: head.value });
    if (file.state !== 'ok') return err(hostFail(`CODEOWNERS of ${want.repo}`, file));
    const parsed = file.value ? parseCodeowners(file.value.content) : null;
    for (const o of parsed?.owners ?? []) {
      if (o.kind === 'user') users.add(o.login);
      else if (o.kind === 'team') teams.add(`${o.org}/${o.slug}`);
      else emails.add(o.email);
    }
    const gh = file.value
      ? await deps.host.codeowners_errors({ repo: want.repo, ref: head.value })
      : null;
    const parse_errors: CodeownersParseError[] = [...(parsed?.errors ?? [])];
    repos.push({
      repo: info.full_name,
      sha: head.value,
      path: file.value?.path ?? null,
      blob_sha: file.value?.blob_sha ?? null,
      parse_errors,
      github_errors: gh && gh.state === 'ok' ? gh.value : null,
    });
    refs.push(`${info.full_name}@${head.value}`);
  }

  const logins = [...users].sort();
  if (logins.length > MAX_OWNER_LOGINS) {
    return err(fail('invalid_input', `more than ${MAX_OWNER_LOGINS} owner logins`));
  }
  const mapped: Array<{ login: string; principal_id: PrincipalId }> = [];
  const unmapped: string[] = [];
  for (const login of logins) {
    const r = await deps.identity.resolveGithubLogin(login);
    if (!r.ok) return err(identityFail(r.error));
    if (r.value === null) unmapped.push(login);
    else mapped.push({ login, principal_id: r.value });
  }
  const principals = [...new Set(mapped.map((m) => m.principal_id))].sort();
  const set = await deps.identity.setCodeownerMembers(project, {
    principals,
    source_ref: refs.join(', ').slice(0, 2000),
  });
  if (!set.ok) return err(identityFail(set.error));
  return ok({
    project_id: project,
    repos,
    mapped,
    unmapped_logins: unmapped,
    unresolved_teams: [...teams].sort(),
    unresolved_emails: [...emails].sort(),
    members: set.value.members,
    added: set.value.added,
    removed: set.value.removed,
    synced_at: (deps.clock ?? systemClock).now().toISOString(),
  });
}
