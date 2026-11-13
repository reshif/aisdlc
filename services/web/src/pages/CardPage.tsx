import { useQuery } from '@tanstack/react-query';
import type { CardKind } from '@aisdlc/contracts';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { PageError, Loading } from '../components/Notice';
import { C2Form } from '../cards/C2Form';
import { C3Form } from '../cards/C3Form';
import { SecrForm } from '../cards/SecrForm';
import { shortTime } from '../format';
import { Link } from '../router';
import { stepName } from '../vocab';

const TITLE: Readonly<Partial<Record<CardKind, string>>> = {
  C1: 'Card 1: confirm the census',
  C2: 'Card 2: claims, intent and instruction text',
  C3: 'Card 3: the Full baseline, seeds and exam',
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
 * An onboarding card (C1 to C5, SECR) as Decide shows it: what it shows, who decides it, and the form that decides
 * it. The form is a fieldset that is disabled when the person may not decide (or the card is not open), so what they
 * see is what the decider saw, and nothing in it can be sent. Work-item approvals are `work/DecideScreen`.
 */
export function OnboardingCard({ id, csrf }: { id: string; csrf: string; me?: string }) {
  const q = useQuery({
    queryKey: ['card', id],
    queryFn: () => api.card(id),
    // An open card the person cannot decide yet may become decidable (a revision is published).
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  if (q.isPending) return <Loading what="the card" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const card = q.data;
  const { summary } = card;
  const decidable = card.may_decide && summary.status === 'open' && summary.actionable;
  return (
    <>
      <p className="crumbs">
        <Link to="/inbox">Inbox</Link> / <Link to={`/onboard/${summary.s0_id}`}>Onboarding</Link>
      </p>
      <h1>{TITLE[summary.card] ?? `Card ${summary.card}`}</h1>
      <p className="status-line">
        <Badge tone={STATUS_TONE[summary.status]}>{summary.status.replace('_', ' ')}</Badge>{' '}
        <span>
          {stepName(summary.step)}, opened {shortTime(summary.opened_at)}
        </span>
      </p>
      <fieldset className="plain-fieldset" disabled={!decidable} aria-label="Card">
        {['C1', 'C4', 'C5'].includes(summary.card) ? (
          <p data-testid="decided-on-summary">
            This step is decided by the one onboarding sign-off.{' '}
            <Link to={`/onboard/${summary.s0_id}`}>Open the onboarding summary</Link>
          </p>
        ) : null}
        {summary.card === 'C2' ? <C2Form card={card} csrf={csrf} /> : null}
        {summary.card === 'C3' ? <C3Form card={card} csrf={csrf} /> : null}
        {summary.card === 'SECR' ? <SecrForm card={card} csrf={csrf} /> : null}
        {!['C1', 'C2', 'C3', 'C4', 'C5', 'SECR'].includes(summary.card) ? (
          <p className="muted">The portal does not show this kind of card yet.</p>
        ) : null}
      </fieldset>
    </>
  );
}
