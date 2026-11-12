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
  | { name: 'project'; id: string }
  | { name: 's0'; id: string }
  | { name: 'card'; id: string }
  | { name: 'item'; id: string }
  | { name: 'pack'; id: string }
  | { name: 'inbox' }
  | { name: 'revision'; id: string }
  | { name: 'readiness'; id: string }
  | { name: 'ledger'; id: string }
  | { name: 'access' }
  | { name: 'config' }
  | { name: 'configKey'; key: string }
  | { name: 'ask' }
  | { name: 'notifications' }
  | { name: 'notificationPrefs' }
  | { name: 'closeout'; id: string }
  | { name: 'learn'; id: string }
  | { name: 'factoryRevision'; id: string }
  | { name: StaticScreen }
  | { name: 'notfound' };

/** Screens with one fixed path (2026-11-12: home, lists, quality, operate, govern, admin). */
export const STATIC_SCREENS = {
  '/floor': 'floor',
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
  '/ledger': 'fleetLedger',
  '/audit': 'audit',
  '/catalogue': 'catalogue',
  '/people': 'people',
  '/teams': 'teams',
  '/roles': 'roles',
  '/access-requests': 'accessRequests',
  '/access-explain': 'explain',
} as const;
export type StaticScreen = (typeof STATIC_SCREENS)[keyof typeof STATIC_SCREENS];

export function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'home' };
  if (p === '/onboard') return { name: 'onboard' };
  const fixed = (STATIC_SCREENS as Readonly<Record<string, StaticScreen>>)[p];
  if (fixed) return { name: fixed };
  if (p === '/inbox') return { name: 'inbox' };
  if (p === '/me/access') return { name: 'access' };
  if (p === '/config') return { name: 'config' };
  if (p === '/ask') return { name: 'ask' };
  if (p === '/me/notifications') return { name: 'notifications' };
  if (p === '/me/notifications/preferences') return { name: 'notificationPrefs' };
  const cfg = /^\/config\/([^/]+)$/.exec(p);
  if (cfg) return { name: 'configKey', key: decodeURIComponent(cfg[1] as string) };
  const closeout = /^\/items\/([^/]+)\/closeout$/.exec(p);
  if (closeout) return { name: 'closeout', id: decodeURIComponent(closeout[1] as string) };
  const learn = /^\/projects\/([^/]+)\/learn$/.exec(p);
  if (learn) return { name: 'learn', id: decodeURIComponent(learn[1] as string) };
  const frev = /^\/config\/revisions\/([^/]+)$/.exec(p);
  if (frev) return { name: 'factoryRevision', id: decodeURIComponent(frev[1] as string) };
  const pack = /^\/items\/([^/]+)\/evidence$/.exec(p);
  if (pack) return { name: 'pack', id: decodeURIComponent(pack[1] as string) };
  const sub = /^\/projects\/([^/]+)\/(readiness|ledger)$/.exec(p);
  if (sub) {
    return {
      name: sub[2] === 'ledger' ? 'ledger' : 'readiness',
      id: decodeURIComponent(sub[1] as string),
    };
  }
  const m = /^\/(projects|s0|cards|revisions|items)\/([^/]+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[2] as string);
    return m[1] === 'projects'
      ? { name: 'project', id }
      : m[1] === 's0'
        ? { name: 's0', id }
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
