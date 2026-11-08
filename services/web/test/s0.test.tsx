import { STEPS } from '@aisdlc/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createQueryClient } from '../src/App';
import { S0Page } from '../src/pages/S0Page';
import { CARD_ID, card, me, mockApi, projectOf, renderAt, repoOf, s0, S0_ID } from './helpers';

const project = {
  json: { project: projectOf(), repos: [repoOf()], s0: [] },
};

function setup(overview: ReturnType<typeof s0>, cards = [card()]) {
  return mockApi({
    'GET /api/me': { json: me() },
    [`GET /api/s0/${S0_ID}`]: { json: overview },
    [`GET /api/s0/${S0_ID}/cards`]: { json: cards },
    'GET /api/projects/testbed': project,
  });
}

const step = (id: string) => document.querySelector(`[data-step="${id}"]`) as HTMLElement;

describe('the S0 record page', () => {
  it('shows steps 0.1 to 0.5 with their states and titles from the contracts, and the repo by name', async () => {
    setup(
      s0({
        status: 'card',
        states: { '0.1': 'card', '0.2': 'skip', '0.3': 'skip', '0.4': 'todo', '0.5': 'todo' },
      }),
    );
    renderAt(`/s0/${S0_ID}`);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Onboarding of reshif/asf-factory-testbed',
      }),
    ).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Onboarding steps' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('data-step')),
    ).toEqual(['0.1', '0.2', '0.3', '0.4', '0.5']);
    expect(within(step('0.1')).getByText(`0.1 ${STEPS['0.1'].title}`)).toBeInTheDocument();
    expect(within(step('0.1')).getByText('Card open')).toBeInTheDocument();
    expect(within(step('0.4')).getByText('To do')).toBeInTheDocument();
    // Not requested: skipped, with the reason.
    expect(within(step('0.2')).getByText('Skipped')).toBeInTheDocument();
    expect(within(step('0.2')).getByText('not_requested')).toBeInTheDocument();
    expect(screen.getByText('Waiting for a decision')).toBeInTheDocument();
  });

  it('covers running and done as well', async () => {
    setup(
      s0({ status: 'running', states: { '0.1': 'done', '0.2': 'running' }, level: 'light' }),
      [],
    );
    renderAt(`/s0/${S0_ID}`);
    await screen.findByRole('list', { name: 'Onboarding steps' });
    expect(within(step('0.1')).getByText('Done')).toBeInTheDocument();
    expect(within(step('0.2')).getByText('Running')).toBeInTheDocument();
    expect(screen.getByText(/No card yet/)).toBeInTheDocument();
  });

  it('"0.1 waiting: App not installed": the state, and how to fix it on that repo only', async () => {
    setup(
      s0({
        status: 'app',
        waiting: '0.1 waiting: App not installed',
        states: { '0.1': 'running' },
      }),
      [],
    );
    renderAt(`/s0/${S0_ID}`);
    const callout = await screen.findByRole('region', { name: '0.1 waiting: App not installed' });
    expect(within(callout).getByText(/Only select repositories/)).toBeInTheDocument();
    // The repo is named by its ref once the project has been read (first by its id).
    await waitFor(() => expect(callout).toHaveTextContent(/pick reshif\/asf-factory-testbed only/));
    expect(screen.getByText('Waiting for the GitHub App')).toBeInTheDocument();
  });

  it('blocked shows the cause of the step', async () => {
    setup(
      s0({
        status: 'blocked',
        states: { '0.1': 'blocked' },
        causes: { '0.1': 'machine.retries_exhausted' },
      }),
      [],
    );
    renderAt(`/s0/${S0_ID}`);
    const region = await screen.findByRole('region', { name: 'Blocked' });
    expect(within(region).getByText('machine.retries_exhausted')).toBeInTheDocument();
    expect(within(step('0.1')).getByText('Blocked')).toBeInTheDocument();
  });

  it('parked and rejected say why and what is possible', async () => {
    setup(s0({ status: 'parked' }), []);
    const first = renderAt(`/s0/${S0_ID}`);
    expect(await screen.findByRole('region', { name: 'Parked' })).toHaveTextContent(
      /5 business days/,
    );
    first.unmount();
    setup(s0({ status: 'rejected', rejected_at: '0.4' }), []);
    renderAt(`/s0/${S0_ID}`);
    expect(await screen.findByRole('region', { name: 'Rejected' })).toHaveTextContent(
      /at step 0\.4 Controls/,
    );
  });

  it('lists the cards with status, who decides, whether you may, and a link to open each', async () => {
    setup(s0({ status: 'card', states: { '0.1': 'card' } }), [
      card(),
      card({
        card_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbeaa' as never,
        card: 'C4',
        step: '0.4',
        status: 'decided',
        slot: 'admin',
        may_decide: false,
      }),
    ]);
    renderAt(`/s0/${S0_ID}`);
    const list = await screen.findByRole('list', { name: 'Cards' });
    const c1 = list.querySelector('[data-card="C1"]') as HTMLElement;
    expect(within(c1).getByRole('link', { name: 'Card C1' })).toHaveAttribute(
      'href',
      `/cards/${CARD_ID}`,
    );
    expect(within(c1).getByText('open')).toBeInTheDocument();
    expect(c1).toHaveTextContent(/admin slot \(you may decide\)/);
    const c4 = list.querySelector('[data-card="C4"]') as HTMLElement;
    expect(within(c4).getByText('decided')).toBeInTheDocument();
    expect(c4).toHaveTextContent(/admin slot \(not you\)/);
    expect(screen.getByText('1 open')).toBeInTheDocument();
  });

  it('refreshes by polling: the step moves from running to card, and the card appears, without a reload', async () => {
    const m = setup(s0({ status: 'running', states: { '0.1': 'running' } }), []);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <S0Page id={S0_ID} pollMs={40} />
      </QueryClientProvider>,
    );
    await screen.findByRole('list', { name: 'Onboarding steps' });
    expect(within(step('0.1')).getByText('Running')).toBeInTheDocument();
    m.table[`GET /api/s0/${S0_ID}`] = {
      json: s0({ status: 'card', states: { '0.1': 'card' } }),
    };
    m.table[`GET /api/s0/${S0_ID}/cards`] = { json: [card()] };
    await waitFor(() => expect(within(step('0.1')).getByText('Card open')).toBeInTheDocument());
    await screen.findByRole('link', { name: 'Card C1' });
    expect(screen.getByText('Waiting for a decision')).toBeInTheDocument();
  });

  it('stops polling once nothing can change (done)', async () => {
    const m = setup(s0({ status: 'done', states: { '0.1': 'done' } }), []);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <S0Page id={S0_ID} pollMs={20} />
      </QueryClientProvider>,
    );
    await screen.findByText('Done', { selector: '.status-line .badge' });
    const before = m.calls.filter((c) => c.path === `/api/s0/${S0_ID}`).length;
    await new Promise((r) => setTimeout(r, 150));
    expect(m.calls.filter((c) => c.path === `/api/s0/${S0_ID}`).length).toBe(before);
  });

  it('a record with no access is the refusal, a missing one is shown as such', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET /api/s0/${S0_ID}`]: {
        status: 404,
        json: { error: { code: 'not_found', message: 'no such record' } },
      },
    });
    renderAt(`/s0/${S0_ID}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no such record/);
    vi.unstubAllGlobals();
  });
});
