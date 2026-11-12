import type { ActionId } from '@aisdlc/contracts';
import type { Me } from '../api';
import type { Route } from '../router';

// The navigation, grouped as in the prototype (Work, Decide, Projects, Operate, Quality, Govern,
// Admin). An entry is shown only when its guard passes for the person; a group with no entry the
// person may open is not shown at all. Groups whose screens are not built yet have no entries.
//
// The guard reads `/api/me` (the PDP's answers for the fleet, computed by the bff). It is a hint:
// the route itself, and every call it makes, is decided on the server.

export const NAV_GROUPS = [
  'Work',
  'Decide',
  'Projects',
  'Operate',
  'Quality',
  'Govern',
  'Admin',
] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export type NavGuard =
  | { readonly kind: 'signed_in' }
  /** The PDP allows the action on the fleet (from `/api/me`'s `actions.fleet`). */
  | { readonly kind: 'fleet_action'; readonly action: ActionId }
  /** The PDP allows any of these actions on the fleet. */
  | { readonly kind: 'fleet_any'; readonly actions: readonly ActionId[] };

export interface NavEntry {
  readonly group: NavGroup;
  readonly to: string;
  readonly label: string;
  readonly guard: NavGuard;
  /** The routes this entry is "current" for. */
  readonly current: (r: Route) => boolean;
}

export const NAV: readonly NavEntry[] = [
  {
    // M18: the assistant answers only from what the person can see; every thread is checked on its project
    group: 'Work',
    to: '/ask',
    label: 'Ask the factory',
    guard: { kind: 'signed_in' },
    current: (r) => r.name === 'ask',
  },
  {
    group: 'Decide',
    to: '/inbox',
    label: 'Inbox',
    guard: { kind: 'signed_in' },
    current: (r) => r.name === 'inbox' || r.name === 'card' || r.name === 'revision',
  },
  {
    // M18: what the notifier raised for the person; the inbox stays the record of what waits
    group: 'Decide',
    to: '/me/notifications',
    label: 'Notifications',
    guard: { kind: 'signed_in' },
    current: (r) => r.name === 'notifications' || r.name === 'notificationPrefs',
  },
  {
    group: 'Projects',
    to: '/',
    label: 'Projects',
    guard: { kind: 'signed_in' },
    current: (r) =>
      r.name === 'home' ||
      r.name === 'project' ||
      r.name === 's0' ||
      r.name === 'readiness' ||
      r.name === 'ledger',
  },
  {
    group: 'Projects',
    to: '/onboard',
    label: 'Onboard a repo',
    guard: { kind: 'fleet_action', action: 'project.onboard' },
    current: (r) => r.name === 'onboard',
  },
  {
    group: 'Govern',
    to: '/config',
    label: 'Configuration',
    guard: { kind: 'fleet_any', actions: ['config.propose', 'audit.read'] },
    current: (r) => r.name === 'config' || r.name === 'configKey',
  },
];

export const guardPasses = (g: NavGuard, me: Me): boolean =>
  g.kind === 'signed_in'
    ? true
    : g.kind === 'fleet_action'
      ? me.actions.fleet.includes(g.action)
      : g.actions.some((a) => me.actions.fleet.includes(a));

/** The groups and entries this person may open, in prototype order; empty groups dropped. */
export function navFor(me: Me): ReadonlyArray<{ group: NavGroup; entries: readonly NavEntry[] }> {
  return NAV_GROUPS.map((group) => ({
    group,
    entries: NAV.filter((e) => e.group === group && guardPasses(e.guard, me)),
  })).filter((g) => g.entries.length > 0);
}
