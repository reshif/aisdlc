import { label, type ActionId, type GlossaryValue } from '@aisdlc/contracts';
import type { Me } from '../api';
import type { Route } from '../router';

// The navigation of portal v2 (docs/design/screen-map.md §1.2): Work (Home, Inbox, Items, Floor), Projects
// (Projects, Onboard a repo), Run (Operate, Agents), Govern (Settings, Integrations, People, teams & roles,
// Decision log & audit). Every label is the glossary's (`screen`, `navGroup`). The screens that exist today and
// have no place of their own in the screen map are sub-entries of the entry they belong to (Operate's tabs are
// the Emergency stop, Pauses and notices, Queue and capacity, Sandboxes, Health and Spend pages), listed while
// that entry is current, until the squads build each screen.
//
// An entry is shown only when its guard passes for the person; an entry whose own page the person may not open
// still shows (linking to its first sub-entry they may open) when one of its sub-entries passes; a group with no
// entry is not shown. The guard reads `/api/me` (the PDP's answers for the fleet and per project, computed by the
// bff). It is a hint: the route itself, and every call it makes, is decided on the server.

export const NAV_GROUPS = ['work', 'projects', 'run', 'govern'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export type NavGuard =
  | { readonly kind: 'signed_in' }
  /** The PDP allows the action on the fleet (from `/api/me`'s `actions.fleet`). */
  | { readonly kind: 'fleet_action'; readonly action: ActionId }
  /** The PDP allows any of these actions on the fleet. */
  | { readonly kind: 'fleet_any'; readonly actions: readonly ActionId[] }
  /** The PDP allows the action on the fleet or on at least one project (from `actions.projects`). */
  | { readonly kind: 'somewhere'; readonly action: ActionId }
  /** Any of these guards passes (People is the directory's readers and whoever manages access somewhere). */
  | { readonly kind: 'any'; readonly guards: readonly NavGuard[] }
  /** A section with no page of its own: shown when one of its sub-entries is. */
  | { readonly kind: 'section' };

export type ScreenId = GlossaryValue<'screen'>;

export interface NavEntry {
  readonly id: ScreenId;
  readonly to: string;
  readonly label: string;
  readonly guard: NavGuard;
  /** The routes this entry is "current" for. */
  readonly current: (r: Route) => boolean;
  readonly children?: readonly NavEntry[];
}

export interface NavSection {
  readonly group: NavGroup;
  readonly label: string;
  readonly entries: readonly NavEntry[];
}

const FLEET_QUALITY: NavGuard = { kind: 'fleet_action', action: 'quality.read' };
const SIGNED_IN: NavGuard = { kind: 'signed_in' };
const PEOPLE_READERS: NavGuard = {
  kind: 'fleet_any',
  actions: ['audit.read', 'identity.admin', 'access.manage'],
};
const SECTION: NavGuard = { kind: 'section' };
const at =
  (...names: Array<Route['name']>) =>
  (r: Route): boolean =>
    names.includes(r.name);

const entry = (
  id: ScreenId,
  to: string,
  guard: NavGuard,
  current: (r: Route) => boolean,
  children?: readonly NavEntry[],
): NavEntry => ({
  id,
  to,
  label: label('screen', id),
  guard,
  current,
  ...(children ? { children } : {}),
});

export const NAV: Readonly<Record<NavGroup, readonly NavEntry[]>> = {
  work: [
    entry('home', '/', SIGNED_IN, at('home')),
    entry('inbox', '/inbox', SIGNED_IN, at('inbox', 'card', 'decide', 'revision')),
    entry('items', '/items', SIGNED_IN, at('items', 'item', 'pack', 'closeout'), [
      entry('board', '/board', SIGNED_IN, at('board')),
    ]),
    // the floor of a project the person may read (floor.read on the fleet or a project)
    entry('floor', '/floor', { kind: 'somewhere', action: 'floor.read' }, at('floor'), [
      // every project the person may see, one row each (the bff collapses a confidential one without a role)
      entry('fleet', '/fleet', SIGNED_IN, at('fleet')),
    ]),
  ],
  projects: [
    entry(
      'projects',
      '/projects',
      SIGNED_IN,
      at(
        'projects',
        'project',
        'onboardRecord',
        'readiness',
        'knowledge',
        'ledger',
        'issues',
        'drift',
        'reaffirm',
        'projectSettings',
        'learn',
      ),
    ),
    entry(
      'onboard',
      '/onboard',
      { kind: 'fleet_action', action: 'project.onboard' },
      at('onboard'),
    ),
  ],
  run: [
    // one page with tabs (screen map §2.15); each tab checks its own read (ops.read, Spend's cost quality.read)
    entry(
      'operate',
      '/operate',
      { kind: 'fleet_any', actions: ['ops.read', 'quality.read'] },
      at('operate'),
    ),
    entry('agents', '/agents', FLEET_QUALITY, at('agents', 'agent'), [
      entry('evals', '/evals', FLEET_QUALITY, at('evals')),
    ]),
  ],
  govern: [
    entry(
      'settings',
      '/settings',
      { kind: 'fleet_any', actions: ['config.propose', 'audit.read'] },
      at('settings', 'setting', 'factoryRevision'),
      [entry('catalogue', '/catalogue', SIGNED_IN, at('catalogue'))],
    ),
    entry('integrations', '/integrations', FLEET_QUALITY, at('integrations')),
    entry('people_roles', '/people', SECTION, () => false, [
      // the fleet's readers and whoever runs access or sign-in on the fleet (portal v2, People squad)
      entry('people', '/people', PEOPLE_READERS, at('people', 'person')),
      entry('teams', '/teams', PEOPLE_READERS, at('teams', 'team')),
      entry('roles', '/roles', SIGNED_IN, at('roles')),
      entry('access_requests', '/access-requests', SIGNED_IN, at('accessRequests', 'accessGrant')),
      entry('who_can', '/who-can', { kind: 'somewhere', action: 'access.explain' }, at('explain')),
    ]),
    // the decision log and its audit tabs; a project's own readers see their projects' log there
    entry(
      'audit_log',
      '/audit',
      { kind: 'somewhere', action: 'audit.read' },
      at('audit', 'fleetLedger'),
    ),
  ],
};

/**
 * Screens reached from the top bar, not the nav: they are guarded the same way (a direct link to one the person
 * may not open is the 403 page).
 */
export const TOP_BAR: readonly NavEntry[] = [
  entry('ask_for_work', '/ask', { kind: 'somewhere', action: 'work.request' }, at('askForWork')),
  // the assistant answers only from what the person can see; every thread is checked on its project
  entry('assistant', '/assistant', { kind: 'somewhere', action: 'assistant.use' }, at('ask')),
  entry(
    'my_notifications',
    '/me/notifications',
    SIGNED_IN,
    at('notifications', 'notificationPrefs'),
  ),
  entry('my_access', '/me/access', SIGNED_IN, at('access')),
  entry('my_profile', '/me', SIGNED_IN, at('profile')),
];

export const guardPasses = (g: NavGuard, me: Me): boolean => {
  switch (g.kind) {
    case 'signed_in':
      return true;
    case 'section':
      return false;
    case 'fleet_action':
      return me.actions.fleet.includes(g.action);
    case 'fleet_any':
      return g.actions.some((a) => me.actions.fleet.includes(a));
    case 'somewhere':
      return (
        me.actions.fleet.includes(g.action) ||
        me.actions.projects.some((p) => p.actions.includes(g.action))
      );
    case 'any':
      return g.guards.some((x) => guardPasses(x, me));
  }
};

/** Every entry with a page of its own, sub-entries included, then the top bar's. */
export function flatNav(): NavEntry[] {
  const out: NavEntry[] = [];
  const walk = (e: NavEntry) => {
    if (e.guard.kind !== 'section') out.push(e);
    for (const c of e.children ?? []) walk(c);
  };
  for (const g of NAV_GROUPS) for (const e of NAV[g]) walk(e);
  for (const e of TOP_BAR) walk(e);
  return out;
}

/** The guard of the page at `to`; a direct link to a screen the nav hides is then a 403 page. */
export const guardOf = (to: string): NavGuard | null =>
  flatNav().find((e) => e.to === to)?.guard ?? null;

/** The action a guard names, for the 403's reason. */
export const guardAction = (g: NavGuard): ActionId | null =>
  g.kind === 'signed_in' || g.kind === 'section'
    ? null
    : g.kind === 'fleet_any'
      ? (g.actions[0] ?? null)
      : g.kind === 'any'
        ? (g.guards.map(guardAction).find((a) => a !== null) ?? null)
        : g.action;

/** An entry as this person sees it: `null` when neither it nor any sub-entry may be opened. */
function visible(e: NavEntry, me: Me): NavEntry | null {
  const kids = (e.children ?? [])
    .map((c) => visible(c, me))
    .filter((c): c is NavEntry => c !== null);
  const own = guardPasses(e.guard, me);
  if (!own && kids.length === 0) return null;
  const first = kids[0];
  return {
    ...e,
    // a section, or a page the person may not open, links to its first sub-entry they may open
    to: own || !first ? e.to : first.to,
    children: kids,
  };
}

/** The groups and entries this person may open, in screen-map order; empty groups dropped. */
export function navFor(me: Me): readonly NavSection[] {
  return NAV_GROUPS.map((group) => ({
    group,
    label: label('navGroup', group),
    entries: NAV[group].map((e) => visible(e, me)).filter((e): e is NavEntry => e !== null),
  })).filter((g) => g.entries.length > 0);
}

/** The pages this person may open (for the search palette): the nav's and the top bar's, no sections. */
export function openablePages(me: Me): NavEntry[] {
  return flatNav().filter((e) => guardPasses(e.guard, me));
}
