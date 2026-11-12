import type { PortalItemView } from '@aisdlc/contracts';
import { Link } from '../router';
import { Card, GateTag, Pill, Table, type Column, type PillTone } from '../ui';

// Every gate of a work item (P1-2): pending and decided, the outcome and the ledger entry of each decision, and for a
// pending gate the way to the card it is decided on. Gate status here is what core folded from the ledger's
// decisions; deciding happens on the card, where the PDP and the decision kernel are asked again.

type Gate = PortalItemView['gates'][number];

/** Approve is the only yes; a reject or changes asked is a no; an expired, closed or superseded gate approved nothing. */
const OUTCOME_TONE = (o: string | null): PillTone =>
  o === 'approve' ? 'ok' : o === 'reject' || o === 'request_changes' ? 'bad' : 'mute';

const columns: ReadonlyArray<Column<Gate>> = [
  {
    key: 'gate',
    header: 'Gate',
    rowHeader: true,
    render: (g) => <GateTag gate={g.gate} showTitle />,
  },
  {
    key: 'status',
    header: 'Status',
    render: (g) =>
      g.status === 'pending' ? (
        <Pill tone="warn">waiting for a decision</Pill>
      ) : (
        <Pill tone={OUTCOME_TONE(g.outcome)}>{g.outcome ?? 'decided'}</Pill>
      ),
  },
  {
    key: 'ledger',
    header: 'Ledger entry',
    render: (g) =>
      g.ledger_entry_id === null ? (
        <span className="muted">{g.status === 'pending' ? 'not yet' : 'none recorded'}</span>
      ) : (
        <code title={g.ledger_entry_id}>{g.ledger_entry_id.slice(0, 8)}</code>
      ),
  },
  {
    key: 'card',
    header: 'Card',
    render: (g) =>
      g.status !== 'pending' ? null : g.card_id === null ? (
        <span className="muted">its card is not on the record yet</span>
      ) : (
        <Link to={`/cards/${g.card_id}`} aria-label={`Open the decision card of ${g.gate}`}>
          Open the decision card
        </Link>
      ),
  },
];

export function ItemGates({ item }: { item: PortalItemView }) {
  return (
    <Card title="Gates" testId="item-gates">
      <Table
        caption="The gates of this item"
        captionHidden
        columns={columns}
        rows={item.gates}
        rowKey={(g) => g.gate_instance_id}
        empty={<p className="muted">No gate has opened for this item yet.</p>}
      />
    </Card>
  );
}
