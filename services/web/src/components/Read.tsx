import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Card, Pill } from '../ui';
import { Loading, PageError } from './Notice';

// The read states of a screen built on one query: loading, a refusal (403 with the reason; one 404),
// any other failure with a retry, then the content. And the honest "not built yet" state for a part
// of a screen whose backend does not exist: never example data in its place.

export function Read<T>({
  q,
  what,
  children,
}: {
  q: UseQueryResult<T>;
  /** "the agents": what is loading, for the status line. */
  what: string;
  children: (data: T) => ReactNode;
}) {
  if (q.isPending) return <Loading what={what} />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  return <>{children(q.data)}</>;
}

/** A part of a screen that waits for a backend: which milestone builds it and what it will show. */
export function NotBuilt({
  title,
  milestone,
  children,
}: {
  title: string;
  /** The milestone that builds the backend, e.g. `M19`. */
  milestone: string;
  children: ReactNode;
}) {
  return (
    <Card
      title={title}
      actions={<Pill tone="mute">not built yet ({milestone})</Pill>}
      testId="not-built"
    >
      <div className="muted">{children}</div>
    </Card>
  );
}

/** A short hash: the first 12 hex characters, the whole one in the tooltip and for a screen reader. */
export function ShortHash({ hash }: { hash: string }) {
  return (
    <code className="ui-mono" title={hash} aria-label={`hash ${hash}`}>
      {hash.slice(0, 12)}
    </code>
  );
}

/** An item's key as people say it: the first eight characters of its id. */
export const itemKey = (id: string): string => id.slice(0, 8);
