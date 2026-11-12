import { useQuery } from '@tanstack/react-query';
import type { CardKind } from '@aisdlc/contracts';
import { ApiError, api } from '../api';
import { Badge } from '../components/Badge';
import { PageError, Loading } from '../components/Notice';
import { C1Form } from '../cards/C1Form';
import { C2Form } from '../cards/C2Form';
import { C3Form } from '../cards/C3Form';
import { C4Form } from '../cards/C4Form';
import { C5Panel } from '../cards/C5Panel';
import { GateArtefacts } from '../cards/GateArtefacts';
import { EXCEPTION_GATES, ExceptionGate } from '../cards/ExceptionGate';
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
    return <WorkGateCard id={id} csrf={csrf} me={me} />;
  }
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
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
        {summary.card === 'C2' ? <C2Form card={card} csrf={csrf} /> : null}
        {summary.card === 'C3' ? <C3Form card={card} csrf={csrf} /> : null}
        {summary.card === 'C4' ? <C4Form card={card} csrf={csrf} me={me} /> : null}
        {summary.card === 'C5' ? <C5Panel card={card} csrf={csrf} /> : null}
        {summary.card === 'SECR' ? <SecrForm card={card} csrf={csrf} /> : null}
        {!['C1', 'C2', 'C3', 'C4', 'C5', 'SECR'].includes(summary.card) ? (
          <p className="muted">The portal does not show this kind of card yet.</p>
        ) : null}
      </fieldset>
    </>
  );
}

/**
 * A work-item gate card: an exception or quarantine gate (Q1 through SECT, E6, X2, X3, E2; M14.6) on its own screen,
 * any other (G0 and G1, G1f, G2, G3d, G3, E1) on the artefacts it decides.
 */
function WorkGateCard({ id, csrf, me }: { id: string; csrf: string; me: string }) {
  const q = useQuery({
    queryKey: ['gate-card', id],
    queryFn: () => api.gateCard(id),
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  if (q.isPending) return <Loading what="the card" />;
  // the artefacts screen reads (and explains) its own refusals; its decision part says why it cannot decide
  if (q.isError) return <GateArtefacts id={id} csrf={csrf} />;
  const exception = q.data.gates.some((g) => EXCEPTION_GATES.includes(g.gate as never));
  return exception ? (
    <ExceptionGate id={id} csrf={csrf} me={me} card={q.data} />
  ) : (
    <GateArtefacts id={id} csrf={csrf} />
  );
}
