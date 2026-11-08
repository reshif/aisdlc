import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { ErrorNote, Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { stepName } from '../vocab';

/** A card's header. Deciding it is M8.3; this page says who may and links back to the record. */
export function CardPage({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['card', id], queryFn: () => api.card(id) });
  if (q.isPending) return <Loading what="the card" />;
  if (q.isError) return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  const { summary, may_decide } = q.data;
  return (
    <>
      <p className="crumbs">
        <Link to={`/s0/${summary.s0_id}`}>Onboarding record</Link>
      </p>
      <h1>Card {summary.card}</h1>
      <p>
        <Badge tone={summary.status === 'open' ? 'attention' : 'neutral'}>{summary.status}</Badge>
      </p>
      <dl className="facts facts-wide">
        <div>
          <dt>Step</dt>
          <dd>{stepName(summary.step)}</dd>
        </div>
        <div>
          <dt>Decided by</dt>
          <dd>the project&rsquo;s {summary.slot} slot</dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd>{shortTime(summary.opened_at)}</dd>
        </div>
        <div>
          <dt>You</dt>
          <dd>{may_decide ? 'may decide this card' : 'may not decide this card'}</dd>
        </div>
      </dl>
      <p className="muted">The decision screen arrives with the next release of the portal.</p>
    </>
  );
}
