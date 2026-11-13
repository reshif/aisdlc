import {
  DELETION_ROUTES,
  OVERRIDE_REASON_HEADER,
  type AccessDecideResult,
  type DeletionKind,
  type DeletionPreview,
  type DeletionResult,
  type FleetLedgerFilter,
  type FleetLedgerView,
  type PeopleListView,
  type PersonDetailView,
  type Scope,
  type TeamDetailView,
  type TeamListView,
} from '@aisdlc/contracts';
import { ApiError, type PreparedRevision } from '../api';

// The admin lifecycle's calls (portal v2: people, teams, role assignments, deletion, the factory admin's override).
// Every write carries the CSRF token and, when the factory admin gives one, the override's reason in its header
// (`x-aisdlc-override-reason`, URI-encoded); the bff carries it on to the service that decides and records it.

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export async function adminRequest<T>(
  method: Method,
  path: string,
  o: { body?: unknown; csrf?: string; reason?: string | undefined } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.csrf !== undefined) headers['x-csrf-token'] = o.csrf;
  if (o.reason !== undefined) headers[OVERRIDE_REASON_HEADER] = encodeURIComponent(o.reason);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    });
  } catch {
    throw new ApiError(0, 'network', 'The factory could not be reached.');
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'error',
      e?.message ?? `The request failed (${res.status}).`,
    );
  }
  return json as T;
}

const enc = encodeURIComponent;

export interface NewPerson {
  readonly principal_id: string;
  readonly display_name: string;
  readonly display_handle: string;
  readonly upn: string | null;
  readonly breakglass: boolean;
}

export interface NewTeam {
  readonly team_id: string;
  readonly name: string;
  readonly classification: 'internal' | 'confidential';
}

export const adminApi = {
  people: () => adminRequest<PeopleListView>('GET', '/api/people'),
  person: (id: string) => adminRequest<PersonDetailView>('GET', `/api/people/${enc(id)}`),
  teams: () => adminRequest<TeamListView>('GET', '/api/teams'),
  team: (id: string) => adminRequest<TeamDetailView>('GET', `/api/teams/${enc(id)}`),
  ledger: (filter: FleetLedgerFilter, before: number | null) =>
    adminRequest<FleetLedgerView>(
      'GET',
      `/api/audit/ledger?filter=${filter}${before ? `&before=${before}` : ''}`,
    ),

  createPerson: (p: NewPerson, csrf: string, reason?: string) =>
    adminRequest<unknown>('POST', '/api/people', {
      csrf,
      reason,
      body: { principal: { kind: 'human', logins: [], ...p } },
    }),
  updatePerson: (
    id: string,
    changes: { display_name?: string; display_handle?: string; upn?: string | null },
    csrf: string,
    reason?: string,
  ) =>
    adminRequest<unknown>('POST', `/api/people/${enc(id)}/update`, {
      csrf,
      reason,
      body: { changes },
    }),
  setStatus: (
    id: string,
    status: 'active' | 'disabled',
    why: string,
    csrf: string,
    reason?: string,
  ) =>
    adminRequest<unknown>('POST', `/api/people/${enc(id)}/status`, {
      csrf,
      reason,
      body: { status, reason: why },
    }),
  /** A team is a group (its members) and the team that names it. */
  createTeam: async (t: NewTeam, csrf: string, reason?: string) => {
    const group = `team.${t.team_id}`;
    await adminRequest<unknown>('POST', '/api/groups', {
      csrf,
      reason,
      body: { group: { group_id: group, display: t.name, pim_managed: false, protected: false } },
    });
    return adminRequest<unknown>('POST', '/api/teams', {
      csrf,
      reason,
      body: { team: { ...t, idp_group: group } },
    });
  },
  addMember: (group: string, principal: string, csrf: string, reason?: string) =>
    adminRequest<unknown>('POST', `/api/groups/${enc(group)}/members`, {
      csrf,
      reason,
      body: { principal_id: principal },
    }),
  removeMember: (group: string, principal: string, why: string, csrf: string, reason?: string) =>
    adminRequest<unknown>('POST', `/api/groups/${enc(group)}/members/remove`, {
      csrf,
      reason,
      body: { principal_id: principal, reason: why },
    }),
  /** Give a role to a group (a team's, or a person's own `person.<id>` group). */
  grant: (
    b: { group_id: string; role_id: string; scope: Scope; expiry: string | null },
    csrf: string,
    reason?: string,
  ) => adminRequest<unknown>('POST', '/api/bindings', { csrf, reason, body: b }),
  /** A person's own group, for a role given to them alone. */
  ensurePersonGroup: async (principal: string, name: string, csrf: string, reason?: string) => {
    const group = `person.${principal}`;
    try {
      await adminRequest<unknown>('POST', '/api/groups', {
        csrf,
        reason,
        body: { group: { group_id: group, display: name, pim_managed: false, protected: false } },
      });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
    }
    try {
      await adminRequest<unknown>('POST', `/api/groups/${enc(group)}/members`, {
        csrf,
        reason,
        body: { principal_id: principal },
      });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
    }
    return group;
  },

  previewDelete: (kind: DeletionKind, id: string, csrf: string) =>
    adminRequest<DeletionPreview>('POST', '/api/deletions/preview', {
      csrf,
      body: { kind, id },
    }),
  remove: (kind: DeletionKind, id: string, why: string, csrf: string, reason?: string) =>
    adminRequest<DeletionResult>('DELETE', `/api/${DELETION_ROUTES[kind]}/${enc(id)}`, {
      csrf,
      reason,
      body: { reason: why, confirm: id },
    }),

  // an access request's decision, with the override's reason when the factory admin answers outside the slot
  prepareAccess: (id: string, csrf: string, reason?: string) =>
    adminRequest<PreparedRevision>('POST', `/api/access/grants/${enc(id)}/prepare`, {
      csrf,
      reason,
      body: {},
    }),
  accessEvidence: (
    id: string,
    b: { nonce: string; evidence_hash: string },
    csrf: string,
    reason?: string,
  ) =>
    adminRequest<unknown>('POST', `/api/access/grants/${enc(id)}/evidence`, {
      csrf,
      reason,
      body: b,
    }),
  decideAccess: (
    id: string,
    b: { nonce: string; decision: 'approve' | 'reject'; step_up?: { proof: string } },
    csrf: string,
    reason?: string,
  ) =>
    adminRequest<AccessDecideResult>('POST', `/api/access/grants/${enc(id)}/decide`, {
      csrf,
      reason,
      body: b,
    }),
};
