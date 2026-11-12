import type { ActionId } from '@aisdlc/contracts';
import type { Me } from '../api';
import type { Route } from '../router';

// The navigation, grouped as in the prototype (Work, Decide, Projects, Operate, Quality, Govern,
// Admin). An entry is shown only when its guard passes for the person; a group with no entry the
// person may open is not shown at all.
//
// The guard reads `/api/me` (the PDP's answers for the fleet and per project, computed by the bff). It
// is a hint: the route itself, and every call it makes, is decided on the server. Operate, Quality and
// the factory-wide parts of Govern and Admin are guarded by `audit.read` on the fleet until the proposed
// `ops.read` and `quality.read` actions exist (portal-coverage §5 item 6).

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
  | { readonly kind: 'fleet_any'; readonly actions: readonly ActionId[] }
  /** The PDP allows the action on the fleet or on at least one project (from `actions.projects`). */
  | { readonly kind: 'somewhere'; readonly action: ActionId };

export interface NavEntry {
  readonly group: NavGroup;
  readonly to: string;
  readonly label: string;
  readonly guard: NavGuard;
  /** The routes this entry is "current" for. */
  readonly current: (r: Route) => boolean;
}

const FLEET_AUDIT: NavGuard = { kind: 'fleet_action', action: 'audit.read' };
const SIGNED_IN: NavGuard = { kind: 'signed_in' };
const at =
  (...names: Array<Route['name']>) =>
  (r: Route): boolean =>
    names.includes(r.name);

const entry = (
  group: NavGroup,
  to: string,
  label: string,
  guard: NavGuard,
  current: (r: Route) => boolean,
): NavEntry => ({ group, to, label, guard, current });

export const NAV: readonly NavEntry[] = [
  entry('Work', '/', 'Home', SIGNED_IN, at('home')),
  entry('Work', '/board', 'Board', SIGNED_IN, at('board')),
  entry('Work', '/items', 'Items', SIGNED_IN, at('items', 'item', 'pack')),
  // M18: the assistant answers only from what the person can see; every thread is checked on its project
  entry('Work', '/ask', 'Ask the factory', SIGNED_IN, at('ask')),
  entry('Decide', '/inbox', 'Inbox', SIGNED_IN, at('inbox', 'card', 'revision')),
  // M18: what the notifier raised for the person; the inbox stays the record of what waits
  entry(
    'Decide',
    '/me/notifications',
    'Notifications',
    SIGNED_IN,
    at('notifications', 'notificationPrefs'),
  ),
  entry(
    'Projects',
    '/projects',
    'Projects',
    SIGNED_IN,
    at('projects', 'project', 's0', 'readiness', 'knowledge', 'ledger', 'issues'),
  ),
  entry(
    'Projects',
    '/onboard',
    'Onboard a repo',
    { kind: 'fleet_action', action: 'project.onboard' },
    at('onboard'),
  ),
  entry('Operate', '/scheduler', 'Scheduler', FLEET_AUDIT, at('scheduler')),
  entry('Operate', '/sandboxes', 'Sandboxes', FLEET_AUDIT, at('sandboxes')),
  entry('Operate', '/controls', 'Controls', FLEET_AUDIT, at('controls')),
  entry('Operate', '/kill', 'Kill switch', FLEET_AUDIT, at('kill')),
  entry('Operate', '/health', 'Health', FLEET_AUDIT, at('health')),
  entry('Quality', '/agents', 'Agents', FLEET_AUDIT, at('agents')),
  entry('Quality', '/evals', 'Evals', FLEET_AUDIT, at('evals')),
  entry('Quality', '/models', 'Models and routes', FLEET_AUDIT, at('models')),
  entry('Quality', '/integrations', 'Integrations', FLEET_AUDIT, at('integrations')),
  entry(
    'Govern',
    '/ledger',
    'Ledger',
    { kind: 'somewhere', action: 'audit.read' },
    at('fleetLedger'),
  ),
  entry('Govern', '/audit', 'Audit', FLEET_AUDIT, at('audit')),
  entry('Govern', '/catalogue', 'Catalogue', SIGNED_IN, at('catalogue')),
  entry(
    'Govern',
    '/config',
    'Configuration',
    { kind: 'fleet_any', actions: ['config.propose', 'audit.read'] },
    at('config', 'configKey'),
  ),
  entry('Admin', '/people', 'People', FLEET_AUDIT, at('people')),
  entry('Admin', '/teams', 'Teams', FLEET_AUDIT, at('teams')),
  entry('Admin', '/roles', 'Roles', SIGNED_IN, at('roles')),
  entry('Admin', '/access-requests', 'Access requests', SIGNED_IN, at('accessRequests')),
  entry(
    'Admin',
    '/access-explain',
    'Who can do what',
    { kind: 'somewhere', action: 'access.explain' },
    at('explain'),
  ),
];

export const guardPasses = (g: NavGuard, me: Me): boolean => {
  switch (g.kind) {
    case 'signed_in':
      return true;
    case 'fleet_action':
      return me.actions.fleet.includes(g.action);
    case 'fleet_any':
      return g.actions.some((a) => me.actions.fleet.includes(a));
    case 'somewhere':
      return (
        me.actions.fleet.includes(g.action) ||
        me.actions.projects.some((p) => p.actions.includes(g.action))
      );
  }
};

/** The guard of the nav entry at `to`; a direct link to a screen the nav hides is then a 403 page. */
export const guardOf = (to: string): NavGuard | null => NAV.find((e) => e.to === to)?.guard ?? null;

/** The action a guard names, for the 403's reason. */
export const guardAction = (g: NavGuard): ActionId | null =>
  g.kind === 'signed_in' ? null : g.kind === 'fleet_any' ? (g.actions[0] ?? null) : g.action;

/** The groups and entries this person may open, in prototype order; empty groups dropped. */
export function navFor(me: Me): ReadonlyArray<{ group: NavGroup; entries: readonly NavEntry[] }> {
  return NAV_GROUPS.map((group) => ({
    group,
    entries: NAV.filter((e) => e.group === group && guardPasses(e.guard, me)),
  })).filter((g) => g.entries.length > 0);
}
