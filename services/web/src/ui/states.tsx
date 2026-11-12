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

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <h2>{title}</h2>
      {children ? <div>{children}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

/**
 * The page-level refusal. 403 says what is refused and why. 404 is one text whatever the cause, so
 * a thing the person may not see and a thing that does not exist look exactly the same.
 */
export function ErrorState({
  status,
  reason,
  action,
}: {
  status: 403 | 404;
  /** 403 only: the policy's reason. Ignored for 404 on purpose. */
  reason?: string;
  action?: ReactNode;
}) {
  if (status === 404) {
    return (
      <section className="ui-errstate" role="alert" aria-labelledby="ui-404-h" data-status="404">
        <div className="ui-eyebrow">404</div>
        <h1 id="ui-404-h">Nothing here</h1>
        <p className="muted">
          The link may be old, or what it names is not visible to you. Things in projects you cannot
          see do not exist for you.
        </p>
        {action}
      </section>
    );
  }
  return (
    <section className="ui-errstate" role="alert" aria-labelledby="ui-403-h" data-status="403">
      <div className="ui-eyebrow">403</div>
      <h1 id="ui-403-h">You cannot open this</h1>
      <p className="muted">The policy decides what each role may do, and it said no here.</p>
      {reason ? <p className="ui-errstate-reason">{reason}</p> : null}
      {action}
    </section>
  );
}
