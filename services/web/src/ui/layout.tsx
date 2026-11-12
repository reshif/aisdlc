import { useId, type ReactNode } from 'react';

// Page head, card, stats and key/value: the surfaces every screen is built from.

export interface Crumb {
  readonly label: string;
  /** Omitted for the current page. */
  readonly to?: string;
}

/** The top of a page: one `h1`, an optional eyebrow, breadcrumbs, a sentence and the page's actions. */
export function PageHead({
  title,
  eyebrow,
  sub,
  crumbs,
  actions,
  renderLink,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  sub?: ReactNode;
  crumbs?: readonly Crumb[];
  actions?: ReactNode;
  /** How a crumb with `to` becomes a link (the router's `Link`); a plain anchor otherwise. */
  renderLink?: (to: string, label: string) => ReactNode;
}) {
  return (
    <header className="ui-ph">
      <div className="ui-ph-t">
        {crumbs && crumbs.length > 0 ? (
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
        ) : null}
        {eyebrow ? <div className="ui-eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {sub ? <p className="ui-ph-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="ui-ph-acts">{actions}</div> : null}
    </header>
  );
}

/** A titled surface. It is a labelled region, so a screen reader can jump between cards. */
export function Card({
  title,
  actions,
  footer,
  flush,
  children,
  className,
  testId,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** No inner padding (for a table or a list that draws its own rows). */
  flush?: boolean;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const id = useId();
  return (
    <section
      className={`ui-card${className ? ` ${className}` : ''}`}
      {...(title ? { 'aria-labelledby': id } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {title || actions ? (
        <div className="ui-card-hd">
          {title ? <h2 id={id}>{title}</h2> : <span style={{ flex: 1 }} />}
          {actions}
        </div>
      ) : null}
      <div className={`ui-card-bd${flush ? ' ui-flush' : ''}`}>{children}</div>
      {footer ? <div className="ui-card-ft">{footer}</div> : null}
    </section>
  );
}

export type StatTone = 'ok' | 'warn' | 'bad';

/** One number with its label and a line of detail. The tone is a bar, the label says it in words. */
export function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: StatTone;
}) {
  return (
    <li className={`ui-stat${tone ? ` ui-stat-${tone}` : ''}`}>
      <span className="ui-stat-k">{label}</span>
      <span className="ui-stat-v">{value}</span>
      {detail ? <span className="ui-stat-d">{detail}</span> : null}
    </li>
  );
}

export function Stats({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="ui-stats" aria-label={label}>
      {children}
    </ul>
  );
}

/** A definition list of facts. */
export function KeyValue({
  rows,
  label,
}: {
  rows: ReadonlyArray<readonly [ReactNode, ReactNode]>;
  label?: string;
}) {
  return (
    <dl className="ui-kv" {...(label ? { 'aria-label': label } : {})}>
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
