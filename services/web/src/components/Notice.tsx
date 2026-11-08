import type { ReactNode } from 'react';
import { describeError } from '../format';

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
