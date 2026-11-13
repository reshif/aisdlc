import type { ReactNode } from 'react';

/** The head of one tab of a page with tabs (Operate, Integrations): an `h2` under the page's one `h1`. */
export function TabHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="st-tabhead">
      <div>
        <h2 className="st-h2">{title}</h2>
        {sub ? <p className="muted">{sub}</p> : null}
      </div>
      {actions ? <div className="st-inline">{actions}</div> : null}
    </header>
  );
}
