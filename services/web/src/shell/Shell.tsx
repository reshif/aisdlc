import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, type Me } from '../api';
import { Link, type Route } from '../router';
import { useTheme } from '../theme';
import { navFor } from './nav';

// The app shell: a top bar (brand, menu toggle on narrow screens, the person, My access, sign-out),
// the grouped navigation rail and the main landmark. After a navigation the focus goes to `main`,
// so a keyboard or screen reader user starts at the top of the new page.

export function Shell({
  me,
  route,
  children,
}: {
  me: Me | null;
  route: Route;
  children: ReactNode;
}) {
  const mainRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const railId = useId();
  const here = JSON.stringify(route);
  const first = useRef(true);
  useEffect(() => {
    setOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [here]);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="top-inner">
          <Link to="/" className="brand">
            AISDLC Factory
          </Link>
          {me ? (
            <button
              type="button"
              className="ui-btn ui-btn-sm menu-btn"
              aria-expanded={open}
              aria-controls={railId}
              onClick={() => setOpen((v) => !v)}
            >
              Menu
            </button>
          ) : null}
          <div className="who">
            {me ? <Account me={me} /> : null}
            <ThemeToggle />
          </div>
        </div>
      </header>
      <div className={me ? 'shell' : 'shell shell-signed-out'}>
        {me ? (
          <nav
            id={railId}
            className={open ? 'rail rail-open' : 'rail'}
            aria-label="Main"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
          >
            <Rail me={me} route={route} />
          </nav>
        ) : null}
        <main id="main" tabIndex={-1} ref={mainRef}>
          {children}
        </main>
      </div>
    </>
  );
}

function Rail({ me, route }: { me: Me; route: Route }) {
  const groups = navFor(me);
  const projects = me.actions.projects;
  return (
    <>
      {groups.map((g) => {
        const hid = `nav-${g.group.toLowerCase()}`;
        return (
          <section key={g.group} aria-labelledby={hid}>
            <h2 id={hid}>{g.group}</h2>
            <ul>
              {g.entries.map((e) => (
                <li key={e.to}>
                  <Link
                    to={e.to}
                    {...(e.current(route) ? { 'aria-current': 'page' as const } : {})}
                  >
                    {e.label}
                  </Link>
                </li>
              ))}
              {g.group === 'Projects'
                ? projects.map((p) => (
                    <li key={p.project_id}>
                      <Link
                        to={`/projects/${encodeURIComponent(p.project_id)}`}
                        {...(route.name === 'project' && route.id === p.project_id
                          ? { 'aria-current': 'page' as const }
                          : {})}
                      >
                        <span className="ui-mono">{p.project_id}</span>
                      </Link>
                    </li>
                  ))
                : null}
            </ul>
          </section>
        );
      })}
      <div className="rail-foot">
        Every screen and button follows the policy. What you cannot open is not listed.{' '}
        <Link to="/me/access">What can I do?</Link>
      </div>
    </>
  );
}

/** P3-1: light or dark for this browser; pressed means light. The default follows the system. */
function ThemeToggle() {
  const [theme, set] = useTheme();
  return (
    <button
      type="button"
      className="btn btn-quiet"
      aria-pressed={theme === 'light'}
      onClick={() => set(theme === 'light' ? 'dark' : 'light')}
    >
      Light theme
    </button>
  );
}

function Account({ me }: { me: Me }) {
  const qc = useQueryClient();
  const out = useMutation({
    mutationFn: () => api.logout(me.csrf_token),
    // The session is gone on the server: forget everything it let us read. Whatever happened, the next
    // question is "who am I", and the bff answers 401 once the session has ended.
    onSuccess: () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      qc.setQueryData(['me'], null);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });
  return (
    <>
      <span className="who-name" title={me.principal.principal_id}>
        {me.principal.display_name}
      </span>
      <Link to="/me/access">My access</Link>
      <button
        type="button"
        className="btn btn-quiet"
        onClick={() => out.mutate()}
        disabled={out.isPending}
      >
        Sign out
      </button>
    </>
  );
}
