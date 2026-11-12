import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CARD_ID, me, mockApi, renderAt } from './helpers';

// P1-2: the item page lists every gate of the item (pending and decided, the outcome and the ledger entry) and links
// a pending one to the card it is decided on.

const ITEM = '0190a1b2-c3d4-7e5f-8a6b-111111111111';

describe('the gates of a work item (P1-2)', () => {
  const view = (gates: unknown[]) => ({
    item_id: ITEM,
    project_id: 'testbed',
    repo: 'reshif/asf-factory-testbed',
    request_id: ITEM,
    phase: 'S2',
    lane: 'L3',
    proposed_lane: 'L3',
    terminal: null,
    waiting: 'gates:G2',
    holds: [],
    questions: [],
    gates,
    outstanding: 0,
    terminal_cause: null,
    rework_total: 0,
    handoff: null,
    assumptions: [],
    catalogue_ref: { version: '1.0.0', hash: 'a'.repeat(64) },
    injection_suspected: false,
    dedupe_links: [],
    may: { ready: false, answer: false, observe: false, plan: false },
  });
  const gate = (g: string, over: Record<string, unknown>) => ({
    gate: g,
    gate_instance_id: `gi-${g}`,
    status: 'decided',
    outcome: 'approve',
    card_id: CARD_ID,
    ledger_entry_id: '0190a1b2-c3d4-7e5f-8a6b-444444444444',
    ...over,
  });

  it('lists pending and decided gates with outcome and ledger entry, and links a pending one to its card', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      [`GET /api/items/${ITEM}`]: {
        json: view([
          gate('G0', {}),
          gate('G1', { outcome: 'reject', ledger_entry_id: null }),
          gate('G2', { status: 'pending', outcome: null, ledger_entry_id: null }),
          gate('E1', { status: 'pending', outcome: null, ledger_entry_id: null, card_id: null }),
        ]),
      },
    });
    renderAt(`/items/${ITEM}`);
    const card = await screen.findByTestId('item-gates');
    const rows = within(card).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('approve');
    expect(rows[0]).toHaveTextContent('0190a1b2');
    expect(within(rows[0] as HTMLElement).queryByRole('link')).toBeNull();
    expect(rows[1]).toHaveTextContent('reject');
    expect(rows[1]).toHaveTextContent('none recorded');
    expect(rows[2]).toHaveTextContent('waiting for a decision');
    expect(
      within(rows[2] as HTMLElement).getByRole('link', { name: 'Open the decision card of G2' }),
    ).toHaveAttribute('href', `/cards/${CARD_ID}`);
    expect(rows[3]).toHaveTextContent('its card is not on the record yet');
  });

  it('says when no gate has opened yet', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      [`GET /api/items/${ITEM}`]: { json: view([]) },
    });
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByTestId('item-gates')).toHaveTextContent(
      'No gate has opened for this item yet.',
    );
  });
});
