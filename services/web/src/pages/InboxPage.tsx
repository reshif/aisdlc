import { useQuery } from '@tanstack/react-query';
import type { PortalInboxItem } from '@aisdlc/contracts';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { PageError, Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { PageHead } from '../ui';

const CARD_TITLE = {
  C1: 'Card 1: confirm the census',
  C2: 'Card 2',
  C3: 'Card 3: the Full baseline',
  C4: 'Card 4: controls and roles',
  C5: 'Card 5: sign-off and M4',
  SECR: 'Security card',
  BATCH: 'Batch card',
  X2: 'Exception card',
} as const;

export const titleOf = (i: PortalInboxItem): string =>
  i.kind === 'settings_revision'
    ? 'Settings revision: publish the role map'
    : (CARD_TITLE[i.label as keyof typeof CARD_TITLE] ?? 'Card');
export const hrefOf = (i: PortalInboxItem): string =>
  i.kind === 'settings_revision' ? `/revisions/${i.id}` : `/cards/${i.id}`;

function Item({ i }: { i: PortalInboxItem }) {
  const due = i.sla_due_at ? new Date(i.sla_due_at).getTime() : null;
  return (
    <li className="card" data-kind={i.kind} data-label={i.label ?? ''} data-overdue={i.overdue}>
      <div className="card-head">
        <Link to={hrefOf(i)} className="card-link">
          {titleOf(i)}
        </Link>
        {i.overdue ? <Badge tone="bad">overdue</Badge> : null}
        {i.escalated ? <Badge tone="attention">escalated</Badge> : null}
      </div>
      <dl className="facts">
        <div>
          <dt>Project</dt>
          <dd>
            <Link to={`/projects/${i.project_id}`}>{i.project_id}</Link>
          </dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd>{shortTime(i.opened_at)}</dd>
        </div>
        <div>
          <dt>Answer due</dt>
          <dd>{due === null ? 'no time limit' : shortTime(i.sla_due_at)}</dd>
        </div>
        <div>
          <dt>Decided by</dt>
          <dd>
            {i.deciders.length === 0
              ? `nobody holds the ${i.slot} role yet`
              : i.deciders.map((d) => d.display_name).join(', ')}
          </dd>
        </div>
      </dl>
    </li>
  );
}

/**
 * The inbox: the open cards the person may decide, with when an answer is due, and below them the
 * ones they can see but may not decide, with who does. Nothing is decided from this page.
 */
export function InboxPage() {
  const q = useQuery({ queryKey: ['inbox'], queryFn: () => api.inbox(), refetchInterval: 15_000 });
  if (q.isPending) return <Loading what="your inbox" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const { decide, view } = q.data;
  return (
    <>
      <PageHead
        eyebrow="Decide"
        title="Inbox"
        sub="The open cards you may decide, with when an answer is due, then the ones you can only see."
      />
      <h2>
        Waiting for you {decide.length > 0 ? <span className="count">{decide.length}</span> : null}
      </h2>
      {decide.length === 0 ? (
        <p className="muted" data-testid="inbox-empty">
          Nothing is waiting for your decision.
        </p>
      ) : (
        <ul className="cards" aria-label="Waiting for you">
          {decide.map((i) => (
            <Item key={`${i.kind}:${i.id}`} i={i} />
          ))}
        </ul>
      )}
      <h2>Open, but not yours to decide</h2>
      {view.length === 0 ? (
        <p className="muted">Nothing else is open in the projects you can see.</p>
      ) : (
        <ul className="cards" aria-label="Not yours to decide">
          {view.map((i) => (
            <Item key={`${i.kind}:${i.id}`} i={i} />
          ))}
        </ul>
      )}
    </>
  );
}
