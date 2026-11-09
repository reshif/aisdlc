import { useQuery } from '@tanstack/react-query';
import type { CardKind } from '@aisdlc/contracts';
import { ApiError, api } from '../api';
import { Badge } from '../components/Badge';
import { ErrorNote, Loading } from '../components/Notice';
import { C1Form } from '../cards/C1Form';
import { C4Form } from '../cards/C4Form';
import { C5Panel } from '../cards/C5Panel';
import { GateArtefacts } from '../cards/GateArtefacts';
import { SecrForm } from '../cards/SecrForm';
import { shortTime } from '../format';
import { Link } from '../router';
import { stepName } from '../vocab';

const TITLE: Readonly<Partial<Record<CardKind, string>>> = {
  C1: 'Card 1: confirm the census',
  C4: 'Card 4: controls and who can do what',
  C5: 'Card 5: sign-off and M4',
  SECR: 'Security card: a secret in the history',
};

const STATUS_TONE = {
  open: 'attention',
  decided: 'good',
  sent_back: 'attention',
  rejected: 'bad',
  withdrawn: 'neutral',
  expired: 'bad',
  superseded: 'neutral',
} as const;

/**
 * One card: what it shows, who decides it, and the form that decides it. The form is a fieldset that
 * is disabled when the person may not decide (or the card is not open), so what they see is what the
 * decider saw, and nothing in it can be sent.
 */
export function CardPage({ id, csrf, me }: { id: string; csrf: string; me: string }) {
  const q = useQuery({
    queryKey: ['card', id],
    queryFn: () => api.card(id),
    // An open card the person cannot decide yet may become decidable (a revision is published).
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  if (q.isPending) return <Loading what="the card" />;
  // not an onboarding card: a work-item gate card (G1f, G2) shows the artefacts it decides
  if (q.isError && q.error instanceof ApiError && q.error.status === 404) {
    return <GateArtefacts id={id} csrf={csrf} />;
  }
  if (q.isError) return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  const card = q.data;
  const { summary } = card;
  const decidable = card.may_decide && summary.status === 'open' && summary.actionable;
  return (
    <>
      <p className="crumbs">
        <Link to="/inbox">Inbox</Link> / <Link to={`/s0/${summary.s0_id}`}>Onboarding record</Link>
      </p>
      <h1>{TITLE[summary.card] ?? `Card ${summary.card}`}</h1>
      <p className="status-line">
        <Badge tone={STATUS_TONE[summary.status]}>{summary.status.replace('_', ' ')}</Badge>{' '}
        <span>
          {stepName(summary.step)}, opened {shortTime(summary.opened_at)}
        </span>
      </p>
      <fieldset className="plain-fieldset" disabled={!decidable} aria-label="Card">
        {summary.card === 'C1' ? <C1Form card={card} csrf={csrf} me={me} /> : null}
        {summary.card === 'C4' ? <C4Form card={card} csrf={csrf} me={me} /> : null}
        {summary.card === 'C5' ? <C5Panel card={card} csrf={csrf} /> : null}
        {summary.card === 'SECR' ? <SecrForm card={card} csrf={csrf} /> : null}
        {!['C1', 'C4', 'C5', 'SECR'].includes(summary.card) ? (
          <p className="muted">The portal does not show this kind of card yet.</p>
        ) : null}
      </fieldset>
    </>
  );
}
