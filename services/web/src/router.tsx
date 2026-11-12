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
  | { name: 'notfound' };

export function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'home' };
  if (p === '/onboard') return { name: 'onboard' };
  if (p === '/inbox') return { name: 'inbox' };
  if (p === '/me/access') return { name: 'access' };
  if (p === '/config') return { name: 'config' };
  const cfg = /^\/config\/([^/]+)$/.exec(p);
  if (cfg) return { name: 'configKey', key: decodeURIComponent(cfg[1] as string) };
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
