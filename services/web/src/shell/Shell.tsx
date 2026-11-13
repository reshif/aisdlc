import { label } from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMe } from '../access';
import { api, type Me } from '../api';
import { leave } from '../leave';
import { Link, useNavigate, type Route } from '../router';
import { useTheme } from '../theme';
import {
  AppShell,
  CommandPalette,
  MenuButton,
  type PaletteItem,
  type RenderLink,
  type ShellNavEntry,
  type ShellNavGroup,
} from '../ui';
import { guardPasses, navFor, openablePages, TOP_BAR, type NavEntry } from './nav';

// The portal's shell over the library's AppShell (skeleton screen 1): the logo, the project switcher, ⌘K search,
// the emergency-stop state, Ask for work, the assistant, notifications, the theme and the avatar menu in the top
// bar; the grouped navigation the person may open on the left. Every word is the glossary's.

const renderLink: RenderLink = (to, children, props) => (
  <Link to={to} {...props}>
    {children}
  </Link>
);

/** Routes that belong to one project: the switcher shows that project. */
const projectOf = (r: Route): string | null => {
  switch (r.name) {
    case 'project':
    case 'readiness':
    case 'knowledge':
    case 'ledger':
    case 'issues':
    case 'drift':
    case 'reaffirm':
    case 'projectSettings':
    case 'learn':
      return r.id;
    default:
      return null;
  }
};

/** /design: the component review page, for a factory admin, or anyone on a dev build. */
export function mayOpenDesign(dev: boolean, fleetRoles: readonly string[] | undefined): boolean {
  return dev || (fleetRoles ?? []).includes('factory.admin');
}

/** Asks `/api/me/access` only on a production build (a dev build opens it to anyone). */
export function useMayOpenDesign(): boolean {
  const me = useMe();
  const dev = import.meta.env.DEV;
  const access = useQuery({
    queryKey: ['access', me.principal.principal_id],
    queryFn: () => api.myAccess(),
    staleTime: 30_000,
    enabled: !dev,
  });
  return mayOpenDesign(dev, access.data?.fleet.roles);
}

export function Shell({
  me,
  route,
  children,
}: {
  me: Me | null;
  route: Route;
  children: ReactNode;
}) {
  const brand = (
    <Link to="/" className="ui-wordmark" aria-label="AISDLC home">
      AI<b>SDLC</b>
    </Link>
  );
  const here = JSON.stringify(route);
  if (!me) {
    return (
      <AppShell
        brand={brand}
        nav={null}
        actions={<ThemeToggle />}
        locationKey={here}
        renderLink={renderLink}
      >
        {children}
      </AppShell>
    );
  }
  return (
    <SignedInShell me={me} route={route} brand={brand} here={here}>
      {children}
    </SignedInShell>
  );
}

function SignedInShell({
  me,
  route,
  brand,
  here,
  children,
}: {
  me: Me;
  route: Route;
  brand: ReactNode;
  here: string;
  children: ReactNode;
}) {
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api.inbox(),
    refetchInterval: 15_000,
  });
  const waiting = inbox.data?.decide.length;
  const nav = useMemo(() => toShellNav(me, route, waiting), [me, route, waiting]);
  const may = (to: string) => {
    const e = TOP_BAR.find((x) => x.to === to);
    return e ? guardPasses(e.guard, me) : false;
  };
  const stopper =
    me.actions.fleet.includes('kill.request') ||
    me.actions.projects.some((p) => p.actions.includes('kill.request'));
  const opsReader = me.actions.fleet.includes('ops.read');
  const kills = useQuery({
    queryKey: ['kills', 'active'],
    queryFn: () => api.activeKills(),
    enabled: opsReader,
    refetchInterval: 15_000,
  });
  const stopped = kills.data?.kills.length ?? 0;
  return (
    <AppShell
      brand={brand}
      switcher={<ProjectSwitcher me={me} current={projectOf(route)} />}
      search={<Search me={me} />}
      status={
        opsReader ? (
          <KillPill state={kills.isError ? 'unknown' : kills.isPending ? null : stopped} />
        ) : null
      }
      actions={
        <>
          {may('/ask') ? (
            <Link to="/ask" className="ui-btn ui-btn-primary ui-btn-sm ui-top-hide-phone">
              {label('screen', 'ask_for_work')}
            </Link>
          ) : null}
          {stopper ? (
            <Link to="/operate/stop" className="ui-stopbtn ui-top-hide-phone">
              {label('action', 'kill.request')}
            </Link>
          ) : null}
          {may('/assistant') ? (
            <Link
              to="/assistant"
              className="ui-iconbtn ui-top-hide-phone"
              aria-label={label('screen', 'assistant')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 5h16v11H9l-5 4V5Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          ) : null}
          <Link
            to="/me/notifications"
            className="ui-iconbtn"
            aria-label={label('screen', 'my_notifications')}
            {...(route.name === 'notifications' ? { 'aria-current': 'page' as const } : {})}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 10a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Zm4 9a2 2 0 0 0 4 0"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <ThemeToggle />
        </>
      }
      account={<Account me={me} />}
      nav={nav}
      navFoot={
        <>
          The menu shows only what you may open. <Link to="/me/access">What can I do?</Link>
        </>
      }
      banners={stopped > 0 ? <KillBanner count={stopped} /> : null}
      locationKey={here}
      renderLink={renderLink}
    >
      {children}
    </AppShell>
  );
}

function toShellNav(me: Me, route: Route, waiting: number | undefined): ShellNavGroup[] {
  const conv = (e: NavEntry): ShellNavEntry => ({
    id: e.id,
    label: e.label,
    to: e.to,
    current: e.current(route),
    ...(e.id === 'inbox' && waiting !== undefined
      ? { count: waiting, countLabel: 'waiting on you' }
      : {}),
    ...(e.children && e.children.length > 0 ? { children: e.children.map(conv) } : {}),
  });
  return navFor(me).map((g) => ({
    id: g.group,
    label: g.label,
    entries: g.entries.map(conv),
    // Work's pages are destinations of their own; the other groups are sets of related pages
    tabs: g.group !== 'work',
  }));
}

// ---------------------------------------------------------------- top bar parts

/** The emergency stop's state: running, stopped, or unknown (shown as such, never as running). */
function KillPill({ state }: { state: number | 'unknown' | null }) {
  if (state === null) return null;
  const stop = label('concept', 'kill_switch');
  if (state === 'unknown') {
    return (
      <Link
        to="/operate/stop"
        className="ui-killpill ui-killpill-unknown"
        title={`${stop}: unknown`}
      >
        <span className="ui-killpill-t">{stop}: unknown</span>
      </Link>
    );
  }
  return state > 0 ? (
    <Link to="/operate/stop" className="ui-killpill ui-killpill-stopped">
      <span className="ui-killpill-t">
        {label('hold', 'kill')}: {state}
      </span>
    </Link>
  ) : (
    <Link to="/operate/stop" className="ui-killpill" title={`${stop}: off`}>
      <span className="ui-killpill-t">Agents running</span>
    </Link>
  );
}

function KillBanner({ count }: { count: number }) {
  return (
    <div className="ui-banner" role="status">
      <span>
        <strong>{label('hold', 'kill')}.</strong>{' '}
        {count === 1 ? 'An emergency stop is on.' : `${count} emergency stops are on.`}{' '}
        <Link to="/operate/stop">See the stops</Link>
      </span>
    </div>
  );
}

function ProjectSwitcher({ me, current }: { me: Me; current: string | null }) {
  const projects = me.actions.projects;
  return (
    <MenuButton
      label={current ? `Project: ${current}` : 'Choose a project'}
      align="start"
      button={
        <>
          <span className="ui-mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {current ?? label('screen', 'fleet')}
          </span>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
          </svg>
        </>
      }
    >
      {(close) => (
        <ul>
          <li>
            <Link to="/projects" className="ui-menu-item" onClick={close}>
              {label('screen', 'fleet')}
            </Link>
          </li>
          {projects.length > 0 ? <li className="ui-menu-sep" aria-hidden="true" /> : null}
          {projects.map((p) => (
            <li key={p.project_id}>
              <Link
                to={`/projects/${encodeURIComponent(p.project_id)}`}
                className="ui-menu-item"
                onClick={close}
                {...(p.project_id === current ? { 'aria-current': 'page' as const } : {})}
              >
                <span className="ui-mono">{p.project_id}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </MenuButton>
  );
}

function Search({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const items = useMemo<PaletteItem[]>(
    () => [
      ...openablePages(me).map((e) => ({ id: `s-${e.id}`, label: e.label, to: e.to })),
      ...me.actions.projects.map((p) => ({
        id: `p-${p.project_id}`,
        label: p.project_id,
        hint: label('concept', 'project'),
        to: `/projects/${encodeURIComponent(p.project_id)}`,
      })),
    ],
    [me],
  );
  return (
    <>
      <button
        type="button"
        className="ui-search-btn"
        aria-haspopup="dialog"
        aria-label="Search screens and projects"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setOpen(true)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span>Search screens and projects</span>
        <kbd className="ui-kbd" aria-hidden="true">
          ⌘K
        </kbd>
      </button>
      {open ? (
        <CommandPalette items={items} onPick={navigate} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** Light or dark for this browser; pressed means light. The default follows the system. */
function ThemeToggle() {
  const [theme, set] = useTheme();
  return (
    <button
      type="button"
      className="ui-iconbtn"
      aria-label="Light theme"
      aria-pressed={theme === 'light'}
      title={theme === 'light' ? 'Switch to the dark theme' : 'Switch to the light theme'}
      onClick={() => set(theme === 'light' ? 'dark' : 'light')}
    >
      {theme === 'light' ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

function Account({ me }: { me: Me }) {
  const qc = useQueryClient();
  const design = useMayOpenDesign();
  const out = useMutation({
    mutationFn: () => api.logout(me.csrf_token),
    // The session is gone on the server: forget everything it let us read. With the IdP's logout URL the browser
    // goes there (it ends the IdP's session and comes back to the portal, signed out, which goes to the sign-in);
    // without one the shell is signed out here, and goes to the sign-in itself.
    onSuccess: (r) => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      if (r.redirect) {
        leave(r.redirect);
        return;
      }
      qc.setQueryData(['me'], null);
    },
    // Whatever went wrong, the next question is "who am I": the bff answers 401 once the session has ended.
    onError: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const name = me.principal.display_name;
  return (
    <MenuButton
      label={`Account: ${name}`}
      className="ui-menu-avatar"
      button={
        <span className="ui-avatar" title={me.principal.principal_id}>
          {initials(name)}
        </span>
      }
    >
      {(close) => (
        <>
          <div className="ui-menu-h">
            <strong>{name}</strong>
            {me.principal.principal_id}
          </div>
          <ul>
            <li>
              <Link to="/me" className="ui-menu-item" onClick={close}>
                {label('screen', 'my_profile')}
              </Link>
            </li>
            <li>
              <Link to="/me/access" className="ui-menu-item" onClick={close}>
                {label('screen', 'my_access')}
              </Link>
            </li>
            <li>
              <Link to="/me/notifications" className="ui-menu-item" onClick={close}>
                {label('screen', 'my_notifications')}
              </Link>
            </li>
            {design ? (
              <li>
                <Link to="/design" className="ui-menu-item" onClick={close}>
                  {label('screen', 'design')}
                </Link>
              </li>
            ) : null}
            <li className="ui-menu-sep" aria-hidden="true" />
            <li>
              <button
                type="button"
                className="ui-menu-item"
                onClick={() => out.mutate()}
                disabled={out.isPending}
              >
                Sign out
              </button>
            </li>
          </ul>
        </>
      )}
    </MenuButton>
  );
}
