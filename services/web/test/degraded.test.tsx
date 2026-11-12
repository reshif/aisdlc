import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { KillNotices, NotaryNotice, StaleNotices } from '../src/components/Degraded';
import { CARD_ID, NOW, S0_ID, me, mockApi, renderAt } from './helpers';

// M19, the degraded states on the work screens (portal coverage §4): the kill switch unreachable is shown as killed,
// the Notary down says decisions are refused and operator actions wait for the backfill, a stale read model says the
// page may be behind, and a check that cannot be made reads as stopped, never as fine.

const T = NOW;
const clearNotary = { state: 'ok', detail_code: 'ok', as_of: T, pending_ops_actions: 0 } as const;
const fresh = [{ name: 'work_item', as_of_seq: 9, head_seq: 9, stale: false, reason: null }];
const card = {
  kind: 'onboarding_card',
  id: CARD_ID,
  project_id: 'testbed',
  s0_id: S0_ID,
  label: 'C1',
  slot: 'admin',
  opened_at: NOW,
  sla_due_at: null,
  overdue: false,
  escalated: false,
  holders: ['alice'],
  item_id: null,
  gate: null,
  feasibility: 'feasible',
  feasibility_reason: null,
  may_decide: true,
  deciders: [{ principal_id: 'alice', display_name: 'Alice Admin' }],
};

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('the degraded notices', () => {
  it('a kill switch that could not be asked reads killed; a clear project shows nothing', () => {
    wrap(
      <KillNotices
        kills={[
          {
            project_id: 'testbed',
            state: 'unreachable',
            killed: true,
            kill_ids: [],
            message: 'core-worker answered 503',
          },
          { project_id: 'other', state: 'clear', killed: false, kill_ids: [], message: null },
        ]}
      />,
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('Kill switch unreachable: testbed is treated as killed');
    expect(alerts[0]).toHaveTextContent('core-worker answered 503');
  });

  it('the Notary down: decisions refused, operator actions pending for the backfill', () => {
    wrap(
      <NotaryNotice
        notary={{ state: 'down', detail_code: 'unreachable', as_of: T, pending_ops_actions: 2 }}
      />,
    );
    const a = screen.getByRole('alert');
    expect(a).toHaveTextContent('The Notary is unreachable');
    expect(a).toHaveTextContent('refused until it answers');
    expect(a).toHaveTextContent('2 operator action(s) are in force and wait to be ledgered');
  });

  it('the Notary unknown is said as unknown; ok with nothing pending says nothing; a backfill in progress is said', () => {
    const { unmount } = wrap(
      <NotaryNotice
        notary={{ state: 'unknown', detail_code: 'stale', as_of: T, pending_ops_actions: 0 }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('health is unknown');
    expect(screen.getByRole('status')).toHaveTextContent('older than two minutes');
    unmount();
    const ok = wrap(<NotaryNotice notary={clearNotary} />);
    expect(ok.container).toBeEmptyDOMElement();
    ok.unmount();
    wrap(<NotaryNotice notary={{ ...clearNotary, pending_ops_actions: 1 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Backfill in progress');
  });

  it('a stale read model the page reads is said; one it does not read is not', () => {
    const models = [
      {
        name: 'work_item',
        as_of_seq: 3,
        head_seq: 9,
        stale: true,
        reason: 'the work_item read model needs a rebuild',
      },
      { name: 'floor', as_of_seq: 1, head_seq: 9, stale: true, reason: 'floor behind' },
    ];
    const { unmount } = wrap(<StaleNotices models={models} names={['work_item']} />);
    const s = screen.getByRole('status');
    expect(s).toHaveTextContent('This page may be behind the record');
    expect(s).toHaveTextContent('needs a rebuild');
    expect(s).not.toHaveTextContent('floor behind');
    unmount();
    const none = wrap(<StaleNotices models={fresh} names={['work_item']} />);
    expect(none.container).toBeEmptyDOMElement();
  });
});

describe('on the inbox and the item page', () => {
  it('the inbox asks about its projects and shows the kill and the Notary first', async () => {
    const m = mockApi({
      'GET /api/me': { json: me() },
      'GET /api/inbox': { json: { decide: [card], view: [] } },
      'GET /api/degraded?projects=testbed': {
        json: {
          as_of: T,
          kills: [
            {
              project_id: 'testbed',
              state: 'killed',
              killed: true,
              kill_ids: ['k-1'],
              message: null,
            },
          ],
          notary: { state: 'down', detail_code: 'unreachable', as_of: T, pending_ops_actions: 0 },
          read_models: fresh,
        },
      },
    });
    renderAt('/inbox');
    expect(await screen.findByTestId('kill-notice')).toHaveTextContent('Kill active on testbed');
    expect(screen.getByTestId('kill-notice')).toHaveTextContent('Kill k-1');
    expect(screen.getByTestId('notary-notice')).toHaveTextContent('The Notary is unreachable');
    expect(m.calls.some((c) => c.path === '/api/degraded?projects=testbed')).toBe(true);
  });

  it('a degraded check that cannot be read says agent work is to be treated as stopped', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/inbox': { json: { decide: [card], view: [] } },
      'GET /api/degraded?projects=testbed': {
        status: 502,
        json: { error: { code: 'upstream', message: 'x' } },
      },
    });
    renderAt('/inbox');
    // a server failure is asked again twice (the client's retry), then said
    expect(await screen.findByTestId('degraded-unknown', {}, { timeout: 8_000 })).toHaveTextContent(
      'treat agent work as stopped',
    );
  }, 15_000);
});
