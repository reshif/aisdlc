import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CARD_ID, NOW, S0_ID, emptyAccess, me, mockApi, renderAt, summaryOf } from './helpers';
import { ITEM_A, ITEM_B, ITEM_C, itemRow } from './screenFixtures';

const inboxItem = (over: Record<string, unknown> = {}) => ({
  kind: 'onboarding_card',
  id: CARD_ID,
  project_id: 'testbed',
  s0_id: S0_ID,
  label: 'C1',
  slot: 'admin',
  opened_at: NOW,
  sla_due_at: null,
  overdue: true,
  escalated: false,
  holders: ['alice'],
  may_decide: true,
  deciders: [{ principal_id: 'alice', display_name: 'Alice Admin' }],
  ...over,
});

const access = () => ({
  ...emptyAccess(),
  bindings: [
    {
      binding_id: 'b1',
      role_id: 'project.requester',
      scope: { kind: 'project', ref: 'testbed' },
      project_id: 'testbed',
      group_id: 'rm.testbed.requesters',
      group_display: 'testbed requesters',
      source: 'manual',
      expiry: null,
      blockers: [],
    },
    {
      binding_id: 'b2',
      role_id: 'project.admin',
      scope: { kind: 'project', ref: 'old' },
      project_id: 'old',
      group_id: 'rm.old.admin',
      group_display: 'old admin',
      source: 'manual',
      expiry: null,
      blockers: ['expired'],
    },
  ],
});

const items = [
  itemRow({ item_id: ITEM_A, mine: true, phase: 'S2', underlying: 'S2' }),
  itemRow({
    item_id: ITEM_B,
    mine: false,
    phase: 'Held',
    underlying: 'S6',
    holds: 1,
    in_flight: false,
  }),
  itemRow({ item_id: ITEM_C, mine: true, terminal: 'Done', phase: 'Done', underlying: 'Done' }),
];

describe('home', () => {
  it('per person: what needs you, your requests, your projects and the roles in force', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/me/access': { json: access() },
      'GET /api/inbox': { json: { decide: [inboxItem()], view: [] } },
      'GET /api/projects': { json: [summaryOf()] },
      'GET /api/items': { json: { items } },
    });
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: /Alice$/ })).toBeInTheDocument();
    const needs = await screen.findByRole('list', { name: 'Waiting for you' });
    expect(within(needs).getByRole('link', { name: 'Card 1: confirm the census' })).toHaveAttribute(
      'href',
      `/cards/${CARD_ID}`,
    );
    expect(within(needs).getByText('overdue')).toBeInTheDocument();
    expect(await screen.findByText('1 decision waits for you.')).toBeInTheDocument();
    // your requests: only the person's own items
    const mine = await screen.findByRole('list', { name: 'Your requests' });
    expect(within(mine).getAllByRole('listitem')).toHaveLength(2);
    expect(within(mine).queryByRole('link', { name: `item ${ITEM_B.slice(0, 8)}` })).toBeNull();
    // roles: in force only (the expired admin binding is not a role the person holds)
    const roles = await screen.findByRole('list', { name: 'Your roles' });
    expect(roles).toHaveTextContent('May request work');
    expect(roles).not.toHaveTextContent('Project administrator');
    // projects
    const p = screen.getByTestId('home-project-testbed');
    expect(within(p).getByRole('link', { name: 'testbed' })).toHaveAttribute(
      'href',
      '/projects/testbed',
    );
    // the factory glance is for the fleet's audit readers only
    expect(screen.queryByTestId('home-glance')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Onboard a repo' })).not.toBeInTheDocument();
  });

  it('a block that fails says so and leaves the rest of the page', async () => {
    mockApi({
      'GET /api/me': { json: me(['audit.read', 'project.onboard']) },
      'GET /api/inbox': { status: 403, json: { error: { code: 'forbidden', message: 'down' } } },
      'GET /api/projects': { json: [] },
      'GET /api/items': { json: { items: [] } },
    });
    renderAt('/');
    const needs = await screen.findByTestId('home-needs');
    expect(await within(needs).findByRole('alert')).toHaveTextContent('down');
    expect(await screen.findByText(/You have asked for no work yet/)).toBeInTheDocument();
    expect(screen.getByTestId('home-glance')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Onboard a repo' }).length).toBeGreaterThan(0);
  });
});

describe('items and the board', () => {
  it('lists the items with lane, place and state; carries no request text; filters to my requests', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/me': { json: me([]) }, 'GET /api/items': { json: { items } } });
    renderAt('/items');
    const table = await screen.findByRole('table', { name: '3 items' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText('S6, held')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('held')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: `item ${ITEM_A.slice(0, 8)}` })).toHaveAttribute(
      'href',
      `/items/${ITEM_A}`,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Only my requests' }));
    expect(await screen.findByRole('table', { name: '2 items' })).toBeInTheDocument();
  });

  it('the board puts a held item where it resumes and a finished one in Closed', async () => {
    mockApi({ 'GET /api/me': { json: me([]) }, 'GET /api/items': { json: { items } } });
    renderAt('/board');
    const board = await screen.findByRole('list', { name: 'Board' });
    expect(within(board).getByRole('listitem', { name: 'Plan: 1' })).toBeInTheDocument();
    expect(within(board).getByRole('listitem', { name: 'Build: 1' })).toHaveTextContent('held');
    expect(within(board).getByRole('listitem', { name: 'Closed: 1' })).toBeInTheDocument();
    expect(within(board).getByRole('listitem', { name: 'Intake: 0' })).toBeInTheDocument();
  });

  it('a refusal of the list is the 403 page, not an empty board', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/items': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'project.view denied' } },
      },
    });
    renderAt('/items');
    await waitFor(() => expect(document.querySelector('[data-status="403"]')).not.toBeNull());
  });
});
