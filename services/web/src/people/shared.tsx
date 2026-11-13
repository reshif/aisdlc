import { useQuery } from '@tanstack/react-query';
import {
  label,
  lookupTerm,
  term,
  type ActionId,
  type AccessGrantStatus,
  type RoleDef,
  type Scope,
} from '@aisdlc/contracts';
import type { ReactNode } from 'react';
import { useAccess } from '../access';
import { api, type Me } from '../api';
import { Link } from '../router';
import { Pill, type PillTone } from '../ui';

// What the People, teams & roles screens share: the words for a role, a scope and a status; who may do what here
// (hints from `/api/me`; the server decides every write); the screen's own sub-navigation.

/** A role in plain words. A custom role (from the roles setting) reads as its description, never its id. */
export function roleLabel(roleId: string, def?: Pick<RoleDef, 'description'> | null): string {
  const t = lookupTerm('role', roleId);
  if (t) return t.label;
  return def?.description.split(/[:;.]/)[0]?.trim() || 'Custom role';
}

export const roleExplain = (roleId: string, def?: Pick<RoleDef, 'description'> | null): string =>
  lookupTerm('role', roleId)?.explain ?? def?.description ?? '';

export function RoleName({ id, def }: { id: string; def?: RoleDef | null }) {
  return (
    <span className="ui-term" title={roleExplain(id, def)}>
      {roleLabel(id, def)}
    </span>
  );
}

/** Where a role applies, in words. */
export function scopeLabel(s: Pick<Scope, 'kind' | 'ref'>): string {
  switch (s.kind) {
    case 'fleet':
      return label('concept', 'role_scope_fleet');
    case 'project':
      return `${label('concept', 'project')} ${s.ref}`;
    case 'team':
      return `${label('concept', 'team')} ${s.ref}`;
    default:
      return s.ref;
  }
}

export function StatusPill({ status }: { status: 'active' | 'disabled' | 'deleted' }) {
  const t = term('concept', status === 'active' ? 'person_active' : 'person_suspended');
  return (
    <Pill tone={status === 'active' ? 'ok' : 'warn'}>
      <span title={t.explain}>{t.label}</span>
    </Pill>
  );
}

export const signInLabel = (s: 'sso' | 'local'): string =>
  label('concept', s === 'sso' ? 'sign_in_sso' : 'sign_in_local');

const GRANT_WORDS: Readonly<Record<AccessGrantStatus, [string, PillTone]>> = {
  pending: ['Waiting for an answer', 'warn'],
  approved: ['Approved', 'ok'],
  applied: ['Granted', 'ok'],
  rejected: ['Rejected', 'mute'],
  ended: ['Ended', 'mute'],
};
export function GrantStatusPill({ status }: { status: AccessGrantStatus }) {
  const [w, tone] = GRANT_WORDS[status];
  return <Pill tone={tone}>{w}</Pill>;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

export function Person({ name, sub, to }: { name: string; sub?: ReactNode; to?: string }) {
  return (
    <span className="adm-person">
      <span className="adm-avatar" aria-hidden="true">
        {initials(name) || '?'}
      </span>
      <span>
        {to ? <Link to={to}>{name}</Link> : name}
        {sub ? <span className="adm-muted"> · {sub}</span> : null}
      </span>
    </span>
  );
}

const has = (me: Me, a: ActionId) => me.actions.fleet.includes(a);

/** What this person may do on these screens (hints; the PDP decides on the server). */
export function peopleRights(me: Me) {
  return {
    read: has(me, 'audit.read') || has(me, 'identity.admin') || has(me, 'access.manage'),
    admin: has(me, 'identity.admin'),
    manage: has(me, 'access.manage'),
    deletePerson: has(me, 'person.delete'),
    deleteTeam: has(me, 'team.delete'),
    deleteBinding: has(me, 'binding.delete'),
  };
}

/** Is the signed-in person a factory admin (a fleet binding of the role in force)? Unknown reads as no. */
export function useIsFactoryAdmin(): boolean {
  const q = useAccess();
  return q.data?.fleet.roles.some((r) => r === 'factory.admin') ?? false;
}

/** The sub-navigation of People, teams & roles (screen map §2.13's tabs, each its own page). */
const SECTIONS: ReadonlyArray<{ to: string; screen: Parameters<typeof label<'screen'>>[1] }> = [
  { to: '/people', screen: 'people' },
  { to: '/teams', screen: 'teams' },
  { to: '/roles', screen: 'roles' },
  { to: '/access-requests', screen: 'access_requests' },
  { to: '/who-can', screen: 'who_can' },
];

export function PeopleNav({ me }: { me: Me }) {
  const r = peopleRights(me);
  const visible = SECTIONS.filter(
    (s) => (s.to !== '/people' && s.to !== '/teams') || r.read,
  ).filter((s) => s.to !== '/who-can' || canExplainSomewhere(me));
  const here = window.location.pathname;
  return (
    <nav aria-label={label('screen', 'people_roles')} className="adm-filters">
      {visible.map((s) => {
        const cur = here === s.to || here.startsWith(`${s.to}/`);
        return (
          <Link
            key={s.to}
            to={s.to}
            className="ui-btn ui-btn-sm"
            {...(cur ? { 'aria-current': 'page' as const } : {})}
          >
            {label('screen', s.screen)}
          </Link>
        );
      })}
    </nav>
  );
}

export const canExplainSomewhere = (me: Me): boolean =>
  me.actions.fleet.includes('access.explain') ||
  me.actions.projects.some((p) => p.actions.includes('access.explain'));

/** The projects list for pickers (fleet readers); others pick among the projects `/api/me` names. */
export function useProjectIds(me: Me, action: ActionId): string[] {
  const fleet = me.actions.fleet.includes(action);
  const q = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects,
    enabled: fleet,
  });
  return fleet
    ? (q.data ?? []).map((p) => p.project.project_id)
    : me.actions.projects.filter((p) => p.actions.includes(action)).map((p) => p.project_id);
}
