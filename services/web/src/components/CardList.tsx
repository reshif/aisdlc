import type { PortalCardSummary } from '@aisdlc/contracts';
import { shortTime } from '../format';
import { Link } from '../router';
import { stepName } from '../vocab';
import { Badge } from './Badge';

const CARD_STATUS_TONE = {
  open: 'attention',
  decided: 'good',
  sent_back: 'attention',
  rejected: 'bad',
  withdrawn: 'neutral',
  expired: 'bad',
  superseded: 'neutral',
} as const satisfies Record<PortalCardSummary['status'], string>;

/** The open and past cards of one S0 record. The Decide screen itself comes with M8.3. */
export function CardList({ cards }: { cards: readonly PortalCardSummary[] }) {
  if (cards.length === 0) {
    return <p className="muted">No card yet. Cards open when a step needs a decision.</p>;
  }
  return (
    <ul className="cards" aria-label="Cards">
      {cards.map((c) => (
        <li key={c.card_id} className="card" data-card={c.card} data-status={c.status}>
          <div className="card-head">
            <Link to={`/cards/${c.card_id}`} className="card-link">
              Card {c.card}
            </Link>
            <Badge tone={CARD_STATUS_TONE[c.status]}>{c.status.replace('_', ' ')}</Badge>
          </div>
          <dl className="facts">
            <div>
              <dt>Step</dt>
              <dd>{stepName(c.step)}</dd>
            </div>
            <div>
              <dt>Decided by</dt>
              <dd>
                the project&rsquo;s <strong>{c.slot}</strong> slot
                {c.may_decide ? ' (you may decide)' : ' (not you)'}
              </dd>
            </div>
            <div>
              <dt>Opened</dt>
              <dd>{shortTime(c.opened_at)}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
