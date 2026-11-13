import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from 'react';

// A router in forty lines: the bff serves the shell for any path, so these are real URLs.

export type Route =
  | { name: 'home' }
  | { name: 'onboard' }
  /** Portal v2: one onboarding, agent-led (`/onboard/<s0 id>`; `/s0/<id>` is the same page). */
  | { name: 'onboardRecord'; id: string }
  | { name: 'project'; id: string }
  | { name: 'card'; id: string }
  /** portal v2: deciding an approval (`/decide/<card>`; `/cards/<card>` is the same screen). */
  | { name: 'decide'; id: string }
  | { name: 'item'; id: string }
  | { name: 'pack'; id: string }
  | { name: 'inbox' }
  | { name: 'revision'; id: string }
  | { name: 'readiness'; id: string }
  | { name: 'knowledge'; id: string }
  | { name: 'ledger'; id: string }
  | { name: 'issues'; id: string }
  | { name: 'drift'; id: string }
  | { name: 'reaffirm'; id: string; repo: string; path: string }
  | { name: 'access' }
  | { name: 'config' }
  | { name: 'configKey'; key: string }
  | { name: 'ask' }
  /** P1-1: the Ask-for-work form, with a project chosen (`/ask-for-work/<project>`) or not. */
  | { name: 'askForWork'; project: string | null }
  | { name: 'notifications' }
  | { name: 'notificationPrefs' }
  | { name: 'closeout'; id: string }
  | { name: 'learn'; id: string }
  | { name: 'projectSettings'; id: string }
  | { name: 'factoryRevision'; id: string }
  | { name: 'accessGrant'; id: string }
  /** P2-3: one agent (`/agents/<id>`), under the same guard as `/agents`. */
  | { name: 'agent'; id: string }
  | { name: StaticScreen }
  | { name: 'notfound' };

/** Screens with one fixed path (2026-11-12: home, lists, quality, operate, govern, admin). */
export const STATIC_SCREENS = {
  '/floor': 'floor',
  '/fleet': 'fleet',
  '/projects': 'projects',
  '/items': 'items',
  '/board': 'board',
  '/agents': 'agents',
  '/evals': 'evals',
  '/models': 'models',
  '/integrations': 'integrations',
  '/scheduler': 'scheduler',
  '/sandboxes': 'sandboxes',
  '/controls': 'controls',
  '/kill': 'kill',
  '/health': 'health',
  // P2-8: Operate › Budgets and Govern › Cost
  '/budgets': 'budgets',
  '/cost': 'cost',
  '/ledger': 'fleetLedger',
  '/audit': 'audit',
  '/catalogue': 'catalogue',
  '/people': 'people',
  '/teams': 'teams',
  '/roles': 'roles',
  '/access-requests': 'accessRequests',
  '/access-explain': 'explain',
  // PLAN §7a: guarded by `assistant.use` somewhere, so a direct link is the 403 page like the others
  // (portal v2: `/ask` is Ask for work, screen-map §2.8)
  '/assistant': 'ask',
  // portal v2: every component in both themes, for review (a factory admin, or a dev build)
  '/design': 'design',
} as const;
export type StaticScreen = (typeof STATIC_SCREENS)[keyof typeof STATIC_SCREENS];

export function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'home' };
  if (p === '/onboard') return { name: 'onboard' };
  const ob = /^\/onboard\/([^/]+)$/.exec(p);
  if (ob) return { name: 'onboardRecord', id: decodeURIComponent(ob[1] as string) };
  const fixed = (STATIC_SCREENS as Readonly<Record<string, StaticScreen>>)[p];
  if (fixed) return { name: fixed };
  if (p === '/inbox') return { name: 'inbox' };
  if (p === '/me/access') return { name: 'access' };
  if (p === '/config') return { name: 'config' };
  if (p === '/ask-for-work' || p === '/ask') return { name: 'askForWork', project: null };
  const askFor = /^\/ask(?:-for-work)?\/([^/]+)$/.exec(p);
  if (askFor) return { name: 'askForWork', project: decodeURIComponent(askFor[1] as string) };
  if (p === '/me/notifications') return { name: 'notifications' };
  if (p === '/me/notifications/preferences') return { name: 'notificationPrefs' };
  const cfg = /^\/config\/([^/]+)$/.exec(p);
  if (cfg) return { name: 'configKey', key: decodeURIComponent(cfg[1] as string) };
  const closeout = /^\/items\/([^/]+)\/closeout$/.exec(p);
  if (closeout) return { name: 'closeout', id: decodeURIComponent(closeout[1] as string) };
  const settings = /^\/projects\/([^/]+)\/settings$/.exec(p);
  if (settings) return { name: 'projectSettings', id: decodeURIComponent(settings[1] as string) };
  const learn = /^\/projects\/([^/]+)\/learn$/.exec(p);
  if (learn) return { name: 'learn', id: decodeURIComponent(learn[1] as string) };
  const grantRoute = /^\/access\/grants\/([^/]+)$/.exec(p);
  if (grantRoute) return { name: 'accessGrant', id: decodeURIComponent(grantRoute[1] as string) };
  const frev = /^\/config\/revisions\/([^/]+)$/.exec(p);
  if (frev) return { name: 'factoryRevision', id: decodeURIComponent(frev[1] as string) };
  const agent = /^\/agents\/([^/]+)$/.exec(p);
  if (agent) return { name: 'agent', id: decodeURIComponent(agent[1] as string) };
  const decide = /^\/decide\/([^/]+)$/.exec(p);
  if (decide) return { name: 'decide', id: decodeURIComponent(decide[1] as string) };
  const pack = /^\/items\/([^/]+)\/evidence$/.exec(p);
  if (pack) return { name: 'pack', id: decodeURIComponent(pack[1] as string) };
  const reaffirm = /^\/projects\/([^/]+)\/reaffirm\/([^/]+)\/([^/]+)$/.exec(p);
  if (reaffirm) {
    return {
      name: 'reaffirm',
      id: decodeURIComponent(reaffirm[1] as string),
      repo: decodeURIComponent(reaffirm[2] as string),
      path: decodeURIComponent(reaffirm[3] as string),
    };
  }
  const drift = /^\/projects\/([^/]+)\/drift$/.exec(p);
  if (drift) return { name: 'drift', id: decodeURIComponent(drift[1] as string) };
  const sub = /^\/projects\/([^/]+)\/(readiness|ledger|issues|knowledge)$/.exec(p);
  if (sub) {
    return {
      name:
        sub[2] === 'ledger'
          ? 'ledger'
          : sub[2] === 'issues'
            ? 'issues'
            : sub[2] === 'knowledge'
              ? 'knowledge'
              : 'readiness',
      id: decodeURIComponent(sub[1] as string),
    };
  }
  const m = /^\/(projects|s0|cards|revisions|items)\/([^/]+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[2] as string);
    return m[1] === 'projects'
      ? { name: 'project', id }
      : m[1] === 's0'
        ? { name: 'onboardRecord', id }
        : m[1] === 'revisions'
          ? { name: 'revision', id }
          : m[1] === 'items'
            ? { name: 'item', id }
            : { name: 'card', id };
  }
  return { name: 'notfound' };
}

export function useRoute(): { route: Route; navigate: (to: string) => void } {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, '', to);
    setPath(new URL(to, window.location.origin).pathname);
    window.scrollTo?.(0, 0);
  }, []);
  return { route: parseRoute(path), navigate };
}

/** Whether a click is a plain left click the router may take (not a new-tab or download gesture). */
const plain = (e: MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export const NavContext = createContext<(to: string) => void>((to) => {
  window.location.assign(to);
});
export const useNavigate = () => useContext(NavContext);

export function Link({
  to,
  ...rest
}: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const navigate = useNavigate();
  return (
    <a
      {...rest}
      href={to}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || !plain(e)) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
