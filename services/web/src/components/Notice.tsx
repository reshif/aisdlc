import type { ReactNode } from 'react';
import { ApiError } from '../api';
import { describeError } from '../format';
import { Link } from '../router';
import { ErrorState } from '../ui';

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="notice notice-bad" role="alert">
      <p>{describeError(error)}</p>
      {retry ? (
        <button type="button" className="btn btn-quiet" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="muted">
      Loading {what}…
    </p>
  );
}

export function Callout({
  title,
  tone = 'attention',
  children,
}: {
  title: string;
  tone?: 'attention' | 'good';
  children: ReactNode;
}) {
  return (
    <section className={`notice notice-${tone}`} aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/**
 * A page that could not load: a refusal (403) says why; "not found" (404) is the same page whatever
 * the cause, so an invisible thing and a missing one look alike; anything else is an alert with a retry.
 */
export function PageError({ error, retry }: { error: unknown; retry?: () => void }) {
  if (error instanceof ApiError && error.status === 404) {
    return <ErrorState status={404} action={<Link to="/">Back to projects</Link>} />;
  }
  if (error instanceof ApiError && error.status === 403) {
    return (
      <ErrorState
        status={403}
        reason={describeError(error)}
        action={<Link to="/me/access">See my access</Link>}
      />
    );
  }
  return <ErrorNote error={error} {...(retry ? { retry } : {})} />;
}
