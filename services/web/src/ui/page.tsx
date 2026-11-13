import { createContext, useContext, type ReactNode } from 'react';
import type { Crumb } from './layout';

// The top of a v2 page (skeleton screens 2 to 4): the breadcrumb, one `h1`, a line of facts, the status beside the
// title and the page's actions. On a phone the actions wrap under the title.

/** The shell's own trail (section, page): a page header leaves out crumbs that repeat it. */
export const TrailContext = createContext<readonly string[]>([]);

export function Breadcrumb({
  crumbs,
  renderLink,
  label = 'Breadcrumb',
}: {
  crumbs: readonly Crumb[];
  /** The landmark's name; the shell's own trail is "Location". */
  label?: string;
  renderLink?: (to: string, label: string) => ReactNode;
}) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label={label}>
      <ol className="ui-crumbs">
        {crumbs.map((c, i) => (
          <li key={`${i}:${c.label}`}>
            {c.to === undefined ? (
              <span aria-current="page">{c.label}</span>
            ) : renderLink ? (
              renderLink(c.to, c.label)
            ) : (
              <a href={c.to}>{c.label}</a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  crumbs = [],
  meta,
  status,
  actions,
  icon,
  renderLink,
}: {
  title: ReactNode;
  crumbs?: readonly Crumb[];
  /** One line of facts under the title ("acme/payments-api · owner team Payments"). */
  meta?: ReactNode;
  /** Pills beside the title: what it waits on, its level. */
  status?: ReactNode;
  actions?: ReactNode;
  /** A square mark before the title (the project's initials). */
  icon?: ReactNode;
  renderLink?: (to: string, label: string) => ReactNode;
}) {
  const trail = useContext(TrailContext);
  const rest = crumbs.filter((c) => !trail.includes(c.label));
  // what is left is worth a line only when it says more than the current page, which the shell's tabs name
  const shown = rest.length >= 2 || rest.some((c) => c.to !== undefined) ? rest : [];
  return (
    <header className="ui-pageh">
      <Breadcrumb crumbs={shown} {...(renderLink ? { renderLink } : {})} />
      <div className="ui-pageh-row">
        {icon ? (
          <div className="ui-pageh-icon" aria-hidden="true">
            {icon}
          </div>
        ) : null}
        <div className="ui-pageh-t">
          <div className="ui-pageh-title">
            <h1>{title}</h1>
            {status ? <div className="ui-pageh-status">{status}</div> : null}
          </div>
          {meta ? <p className="ui-pageh-meta">{meta}</p> : null}
        </div>
        {actions ? <div className="ui-pageh-acts">{actions}</div> : null}
      </div>
    </header>
  );
}
