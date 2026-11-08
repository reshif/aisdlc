import {
  EMPTY_ROLE_MAP,
  type Collaborator,
  type PrincipalId,
  type RoleMap,
  type RoleSlot,
} from '@aisdlc/contracts';
import { parseCodeowners } from '@aisdlc/codeowners';
import { repoKey } from '@aisdlc/ports';
import type { CardDeps } from './model.js';

// The role map card 4 proposes (OB §1B): from CODEOWNERS (the path owners, who are the G4
// reviewers) and the repo's collaborators with their GitHub permission. Read-only, and RECORDED
// when a read fails (SP-FID-2): the proposal then falls back to the person who asked for the
// onboarding, and says so. A login with no `github_login` link to a principal is reported, never
// invented. The person confirms or edits it; nothing here changes any setting.

export interface RoleProposal {
  readonly role_map: RoleMap;
  readonly basis: {
    readonly codeowners_read: 'ok' | 'unknown' | 'unreadable';
    readonly codeowners_logins: readonly string[];
    readonly collaborators_read: 'ok' | 'unknown' | 'unreadable';
    readonly collaborators: ReadonlyArray<{
      login: string;
      permission: string;
      principal: PrincipalId | null;
    }>;
    readonly unmapped_logins: readonly string[];
    /** The requester stands in as admin because no collaborator with admin rights is linked. */
    readonly fallback_admin_used: boolean;
    readonly links_read: 'ok' | 'unavailable';
  };
}

const ADMIN_PERMS = new Set(['admin']);
const MAINTAIN_PERMS = new Set(['admin', 'maintain']);
const WRITE_PERMS = new Set(['admin', 'maintain', 'write']);

const sorted = (xs: Iterable<PrincipalId>): PrincipalId[] => [...new Set(xs)].sort();

export async function proposeRoleMap(
  deps: Pick<CardDeps, 'source' | 'links'>,
  repo: string,
  fallbackAdmin: PrincipalId,
): Promise<RoleProposal> {
  const { source } = deps;
  const full = repo as Parameters<typeof source.branch_head>[0]['repo'];
  const repos = await source.list_repos();
  const branch =
    repos.state === 'ok'
      ? repos.value.find((r) => repoKey(r.full_name) === repoKey(repo))?.default_branch
      : undefined;
  const head = branch ? await source.branch_head({ repo: full, branch }) : null;
  const file =
    head?.state === 'ok' ? await source.codeowners({ repo: full, sha: head.value }) : null;
  const parsed = file?.state === 'ok' && file.value ? parseCodeowners(file.value.content) : null;
  const codeownersLogins = (parsed?.owners ?? []).flatMap((o) =>
    o.kind === 'user' ? [o.login] : [],
  );
  const collab = await source.collaborators({ repo: full });
  const collaborators: Collaborator[] = collab.state === 'ok' ? collab.value : [];

  const logins = [...new Set([...codeownersLogins, ...collaborators.map((c) => c.login)])].map(
    (l) => l.toLowerCase(),
  );
  const links = logins.length === 0 ? null : await deps.links.githubLogins(logins);
  const linked = links?.ok ? links.value : {};
  const principalOf = (login: string): PrincipalId | null => linked[login.toLowerCase()] ?? null;

  const holding = (perms: Set<string>): PrincipalId[] =>
    sorted(
      collaborators
        .filter((c) => perms.has(c.permission))
        .map((c) => principalOf(c.login))
        .filter((p): p is PrincipalId => p !== null),
    );
  let admins = holding(ADMIN_PERMS);
  const fallback = admins.length === 0;
  if (fallback) admins = [fallbackAdmin];
  const maintainers = holding(MAINTAIN_PERMS);
  const writers = holding(WRITE_PERMS);
  const principals = (xs: PrincipalId[]): RoleMap[RoleSlot] => ({
    kind: 'principals',
    principals: xs,
  });
  const orAdmins = (xs: PrincipalId[]) => (xs.length > 0 ? xs : admins);

  const slots: Record<RoleSlot, RoleMap[RoleSlot]> = {
    ...EMPTY_ROLE_MAP,
    admin: principals(admins),
    requesters: principals(orAdmins(writers)),
    intent: principals(orAdmins(maintainers)),
    design: principals(orAdmins(maintainers)),
    // G4 is the code owners on GitHub (OB §1B): the slot says so; it names no principal here.
    g4: { kind: 'codeowners' },
    g5: principals(admins),
    x: principals(admins),
    sec: principals(admins),
    m4: principals(admins),
    kill: principals(admins),
  };
  const unmapped = logins.filter((l) => principalOf(l) === null).sort();
  return {
    role_map: slots,
    basis: {
      codeowners_read: file ? file.state : 'unknown',
      codeowners_logins: [...new Set(codeownersLogins.map((l) => l.toLowerCase()))].sort(),
      collaborators_read: collab.state,
      collaborators: collaborators
        .map((c) => ({ login: c.login, permission: c.permission, principal: principalOf(c.login) }))
        .sort((a, b) => (a.login < b.login ? -1 : 1)),
      unmapped_logins: unmapped,
      fallback_admin_used: fallback,
      links_read: links === null || links.ok ? 'ok' : 'unavailable',
    },
  };
}
