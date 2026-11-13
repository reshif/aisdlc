import { term } from '@aisdlc/contracts';
import { useId, useState, type ReactNode } from 'react';

// A button the policy keeps locked, and the empty and error states of a page.

/**
 * An action the person cannot take here. It stays in the tab order (so the reason can be reached),
 * says it is unavailable (`aria-disabled`), and on press shows why and how to ask for access.
 */
export function LockedButton({
  label,
  reason,
  request,
  small,
}: {
  label: string;
  /** Why the policy says no, in words. */
  reason: string;
  /** The "request access" affordance (a link to where access is asked for). */
  request?: ReactNode;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="ui-locked" data-locked={label}>
      <button
        type="button"
        className={`ui-btn ui-btn-locked${small ? ' ui-btn-sm' : ''}`}
        aria-disabled="true"
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2" y="5" width="8" height="6" rx="1" fill="currentColor" />
          <path d="M4 5V3.5a2 2 0 0 1 4 0V5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        {label}
      </button>
      <span id={id} className={open ? 'ui-locked-why' : 'ui-sr'} role={open ? 'note' : undefined}>
        <p>{reason}</p>
        {open && request ? request : null}
      </span>
    </span>
  );
}

/** What will appear here and how to make it appear (glossary §1: "No work yet. Ask for work to start."). */
export function EmptyState({
  title,
  children,
  action,
  icon,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      {icon ? (
        <div className="ui-empty-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h2>{title}</h2>
      {children ? <div className="ui-empty-body">{children}</div> : null}
      {action ? <div className="ui-empty-act">{action}</div> : null}
    </div>
  );
}

/**
 * The page-level refusal. 403 says what is refused, why, and who to ask. 404 is one text whatever the cause, so
 * a thing the person may not see and a thing that does not exist look exactly the same (glossary §14).
 */
export function ErrorState({
  status,
  reason,
  ask,
  action,
}: {
  status: 403 | 404;
  /** 403 only: the policy's reason in words. Ignored for 404 on purpose. */
  reason?: string;
  /** 403 only: who can grant it ("Ask Ana Ruiz or a project admin."). */
  ask?: string;
  action?: ReactNode;
}) {
  const hid = useId();
  if (status === 404) {
    const t = term('concept', 'not_found_404');
    return (
      <section className="ui-errstate" role="alert" aria-labelledby={hid} data-status="404">
        <div className="ui-errstate-code" aria-hidden="true">
          404
        </div>
        <h1 id={hid}>{t.label}</h1>
        <p className="muted">
          The link may be old, or what it names is not visible to you. {t.explain}
        </p>
        {action}
      </section>
    );
  }
  const t = term('concept', 'forbidden_403');
  return (
    <section className="ui-errstate" role="alert" aria-labelledby={hid} data-status="403">
      <div className="ui-errstate-code" aria-hidden="true">
        403
      </div>
      <h1 id={hid}>{t.label}</h1>
      <p className="muted">Your roles decide what you can open, and they do not include this.</p>
      {reason ? <p className="ui-errstate-reason">{reason}</p> : null}
      {ask ? <p>{ask}</p> : null}
      {action}
    </section>
  );
}
