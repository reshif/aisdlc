import type { ReactNode } from 'react';
import type { Crumb } from './layout';

// The top of a v2 page (skeleton screens 2 to 4): the breadcrumb, one `h1`, a line of facts, the status beside the
// title and the page's actions. On a phone the actions wrap under the title.

export function Breadcrumb({
  crumbs,
  renderLink,
}: {
  crumbs: readonly Crumb[];
  renderLink?: (to: string, label: string) => ReactNode;
}) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb">
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
  return (
    <header className="ui-pageh">
      <Breadcrumb crumbs={crumbs} {...(renderLink ? { renderLink } : {})} />
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
