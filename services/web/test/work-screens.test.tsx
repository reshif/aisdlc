import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '@aisdlc/contracts';
import type { Me } from '../src/api';
import { needsYouRows } from '../src/work/HomeScreen';
import { dueText, stageOfPhase, waitingSentence } from '../src/work/words';
import {
  CARD_ID,
  NOW,
  S0_ID,
  me,
  mockApi,
  projectOf,
  renderAt,
  repoOf,
  summaryOf,
} from './helpers';
import { ITEM_A, ITEM_B, ITEM_C, allowOnly, itemRow } from './screenFixtures';

// Portal v2, the Work squad's screens (docs/design/screen-map.md §2.1, 2.2, 2.5, 2.8): Home, the inbox, the items list
// and Ask for work, in plain words (no code on screen), each with its empty, refused and failing states. The phone
// layout is CSS (`work.css`, `v2.css`): here the parts it hangs on (labelled cells, the board stacking, the modal).

const ITEM = '0190a1b2-c3d4-7e5f-8a6b-111111111111';
const WORK_CARD = '0190a1b2-c3d4-7e5f-8a6b-222222222222';
const CODE = /\b(G[0-6]|L[0-8]|S[1-9]|E[1-6]|X[1-4]|M[1-6]|C[1-5])\b/;

const inbox = (over: Record<string, unknown> = {}) => ({
  kind: 'work_gate',
  id: 'gate-1',
  project_id: 'testbed',
  s0_id: null,
  label: null,
  slot: 'intent',
  opened_at: NOW,
  sla_due_at: '2026-11-09T10:00:00.000Z',
  overdue: false,
  escalated: false,
  holders: ['alice'],
  item_id: ITEM,
  gate: 'G2',
  card_id: WORK_CARD,
  feasibility: 'feasible',
  feasibility_reason: null,
  may_decide: true,
  deciders: [{ principal_id: 'alice', display_name: 'Alice Admin' }],
  ...over,
});

/** alice, who /api/me says may ask for work on testbed. */
const requester = (fleet: Me['actions']['fleet'] = []): Me => ({
  ...me(fleet),
  actions: { fleet, projects: [{ project_id: 'testbed', actions: ['work.request'] }] },
});

describe('the words', () => {
  it('times are relative under a week, in working words; stages read off the phase', () => {
    const now = Date.parse('2026-11-08T10:00:00.000Z');
    expect(dueText('2026-11-08T12:00:00.000Z', false, now)).toBe('Due in 2 h');
    expect(dueText('2026-11-07T10:00:00.000Z', true, now)).toBe('Overdue by 1 day');
    expect(dueText(null, false, now)).toBe('No time limit');
    expect(stageOfPhase('G4')).toBe('S8');
    expect(stageOfPhase('Scheduling')).toBe('S6');
    expect(stageOfPhase('Done')).toBeNull();
    expect(waitingSentence('gates:G3+G3s', null)).toBe(
      'Waiting for the approvals: Approve the plan and Approve the outline.',
    );
    expect(waitingSentence('gates:ZZ', null)).toBe('Waiting for the approval: Unknown.');
  });

  it('needs you: the decisions waiting on me, then the questions on my requests', () => {
    const rows = needsYouRows(
      [inbox() as never],
      [itemRow({ item_id: ITEM_A, mine: true, phase: 'Clarifying', underlying: 'Clarifying' })],
    );
    expect(rows.map((r) => r.kind.kind)).toEqual(['gate', 'questions']);
    expect(rows[0]?.to).toBe(`/decide/${WORK_CARD}`);
    expect(rows[1]?.to).toBe(`/items/${ITEM_A}`);
  });
});

describe('Home', () => {
  it('needs you first, oldest due first and overdue flagged, then my requests and who they wait on', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/inbox': {
        json: {
          decide: [inbox(), inbox({ id: 'gate-2', gate: 'G4', card_id: CARD_ID, overdue: true })],
          view: [
            inbox({
              id: 'gate-3',
              item_id: ITEM_A,
              gate: 'G3',
              may_decide: false,
              deciders: [{ principal_id: 'bob', display_name: 'Bob Builder' }],
            }),
          ],
        },
      },
      'GET /api/items': {
        json: { items: [itemRow({ item_id: ITEM_A, mine: true, phase: 'S5', underlying: 'S5' })] },
      },
      'GET /api/projects': { json: [summaryOf()] },
    });
    renderAt('/');
    const needs = await screen.findByTestId('home-needs');
    const table = await within(needs).findByRole('table', { name: 'Needs you' });
    const rows = within(table).getAllByRole('row').slice(1);
    // the overdue one first, with its plain name and one verb that opens Decide
    expect(rows[0]).toHaveTextContent('Code review');
    expect(rows[0]).toHaveTextContent(/Overdue by/);
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: /Decide/ })).toHaveAttribute(
      'href',
      `/decide/${CARD_ID}`,
    );
    expect(rows[1]).toHaveTextContent('Approve the spec');
    // the cells carry their column's name: the phone stacks them as label and value
    expect(rows[1]?.querySelector('[data-label="Due"]')).not.toBeNull();
    expect(needs).not.toHaveTextContent(CODE);
    const mine = screen.getByTestId('home-requests');
    expect(mine).toHaveTextContent('Plan');
    expect(screen.getByTestId('home-waiting')).toHaveTextContent(
      'Approve the plan: waiting for Bob Builder',
    );
  });

  it('empty: nothing needs you, with the way to ask for work', async () => {
    mockApi({
      'GET /api/me': { json: requester() },
      'GET /api/items': { json: { items: [] } },
      'GET /api/projects': { json: [summaryOf()] },
    });
    renderAt('/');
    const needs = await screen.findByTestId('home-needs');
    await waitFor(() => expect(needs).toHaveTextContent('Nothing needs you.'));
    expect(within(needs).getByRole('link', { name: 'Ask for work' })).toHaveAttribute(
      'href',
      '/ask',
    );
    expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();
  });

  it('a block that fails says so and leaves the rest of the page', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/inbox': { status: 403, json: { error: { code: 'forbidden', message: 'x' } } },
      'GET /api/items': { json: { items: [] } },
      'GET /api/projects': { json: [summaryOf()] },
    });
    renderAt('/');
    expect(
      await within(await screen.findByTestId('home-needs')).findByRole('alert'),
    ).toHaveTextContent('nothing expires approved');
    expect(await screen.findByRole('link', { name: 'testbed' })).toBeInTheDocument();
  });

  it('Ask for work opens the form as a modal, locked with the reason for who may not ask', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: requester() },
      'GET /api/items': { json: { items: [] } },
      'GET /api/projects': { json: [summaryOf()] },
      'POST /api/me/decisions': allowOnly('work.request'),
    });
    renderAt('/');
    const button = await screen.findAllByRole('button', { name: 'Ask for work' });
    await waitFor(() => expect(button[0]).not.toHaveAttribute('aria-disabled'));
    await user.click(button[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Ask for work' });
    expect(await within(dialog).findByLabelText('What do you need?')).toBeInTheDocument();
  });
});

describe('the inbox', () => {
  it('cards say what, the item, the project, why it is mine and when it is due, in plain words', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/inbox': {
        json: {
          decide: [
            inbox(),
            inbox({ id: 'g-esc', gate: 'G3', escalated: true, overdue: true, card_id: 'c-2' }),
            inbox({
              kind: 'onboarding_card',
              id: CARD_ID,
              label: 'C4',
              s0_id: S0_ID,
              item_id: null,
              gate: null,
              card_id: CARD_ID,
            }),
          ],
          view: [
            inbox({
              id: 'g-x',
              gate: 'G0',
              may_decide: false,
              holders: [],
              deciders: [],
              feasibility: 'infeasible',
              feasibility_reason: null,
            }),
          ],
        },
      },
    });
    renderAt('/inbox');
    const list = await screen.findByRole('list', { name: 'Waiting on me' });
    const cards = within(list).getAllByRole('listitem');
    // overdue first
    expect(cards[0]).toHaveTextContent('Decide: Approve the plan');
    expect(cards[0]).toHaveTextContent('Overdue: you are the backup');
    expect(cards[1]).toHaveTextContent('You can decide');
    expect(
      within(cards[1] as HTMLElement).getByRole('link', { name: 'Item 0190a1b2' }),
    ).toHaveAttribute('href', `/items/${ITEM}`);
    // an onboarding's approvals are one row that opens its console
    expect(within(list).getByRole('link', { name: /^Open: Onboarding of / })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/onboard\//),
    );
    expect(list).not.toHaveTextContent(CODE);
    // the others: nobody can decide is flagged in red, with what to do
    await userEvent.click(screen.getByRole('tab', { name: /Others decide/ }));
    const other = await screen.findByRole('list', { name: 'Open approvals' });
    expect(other).toHaveTextContent('Nobody can decide');
    expect(other).toHaveTextContent('A project admin can give someone the role.');
  });

  it('filters by approval and overdue; an auditor sees the whole factory and the codes as chips', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/inbox': {
        json: { decide: [inbox(), inbox({ id: 'g-2', gate: 'G4', overdue: true })], view: [] },
      },
    });
    renderAt('/inbox');
    await screen.findByRole('list', { name: 'Waiting on me' });
    await user.click(screen.getByLabelText('Overdue only'));
    expect(
      within(screen.getByRole('list', { name: 'Waiting on me' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    await user.click(screen.getByLabelText('Overdue only'));
    await user.selectOptions(screen.getByLabelText('Approval'), 'Approve the spec');
    const one = within(screen.getByRole('list', { name: 'Waiting on me' })).getAllByRole(
      'listitem',
    );
    expect(one).toHaveLength(1);
    expect(one[0]?.querySelector('.ui-code')).toHaveTextContent('G2');
    expect(screen.getByRole('tab', { name: 'Whole factory' })).toBeInTheDocument();
  });

  it('empty and failing: says so, and that nothing expires approved', async () => {
    mockApi({ 'GET /api/me': { json: me() } });
    const { unmount } = renderAt('/inbox');
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
    unmount();
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/inbox': { status: 403, json: { error: { code: 'forbidden', message: 'x' } } },
    });
    renderAt('/inbox');
    expect(await screen.findByTestId('inbox-error')).toHaveTextContent('nothing expires approved');
  });
});

describe('items', () => {
  const rows = [
    itemRow({ item_id: ITEM_A, mine: true, phase: 'S2', underlying: 'S2' }),
    itemRow({ item_id: ITEM_B, mine: false, phase: 'Held', underlying: 'S6', holds: 1 }),
    itemRow({ item_id: ITEM_C, mine: true, terminal: 'Done', phase: 'Done', underlying: 'Done' }),
  ];

  it('lists number, project, track, stage, status, age and who it waits on; filters mine; no request text', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/items': { json: { items: rows } },
      'GET /api/inbox': {
        json: {
          decide: [],
          view: [
            inbox({
              item_id: ITEM_A,
              may_decide: false,
              deciders: [{ principal_id: 'bob', display_name: 'Bob Builder' }],
            }),
          ],
        },
      },
    });
    renderAt('/items');
    const table = await screen.findByRole('table', { name: 'Work items' });
    const body = within(table).getAllByRole('row').slice(1);
    expect(body).toHaveLength(3);
    expect(body[0]).toHaveTextContent('Research');
    expect(body[0]).toHaveTextContent('Approve the spec: Bob Builder');
    expect(body[1]).toHaveTextContent('Build');
    expect(body[1]).toHaveTextContent('On hold');
    expect(body[2]).toHaveTextContent('Done');
    expect(table).not.toHaveTextContent(CODE);
    // no CSV for someone who does not read the audit trail
    expect(screen.queryByRole('link', { name: 'Export CSV' })).toBeNull();
    await user.click(screen.getByLabelText('Only my requests'));
    expect(
      within(screen.getByRole('table', { name: 'Work items' })).getAllByRole('row'),
    ).toHaveLength(3);
  });

  it('the board puts a held item where it resumes and a finished one in Ended; an auditor may export', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/items': { json: { items: rows } },
    });
    renderAt('/items');
    await screen.findByRole('table', { name: 'Work items' });
    expect(screen.getByRole('link', { name: 'Export CSV' })).toHaveAttribute(
      'href',
      '/api/items/export.csv',
    );
    await user.click(screen.getByRole('button', { name: 'Board' }));
    const board = screen.getByTestId('board');
    expect(within(board).getByRole('region', { name: 'Build' })).toHaveTextContent('Item');
    expect(within(board).getByRole('region', { name: 'Ended' })).toHaveTextContent('1');
  });

  it('empty says how to make it appear; a refusal is the 403 page, never an empty list', async () => {
    mockApi({ 'GET /api/me': { json: me() }, 'GET /api/items': { json: { items: [] } } });
    const { unmount } = renderAt('/items');
    expect(await screen.findByText('No work items yet')).toBeInTheDocument();
    unmount();
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/items': { status: 403, json: { error: { code: 'forbidden', message: 'x' } } },
    });
    renderAt('/items');
    expect(await screen.findByRole('alert')).toHaveTextContent('The items could not load.');
  });
});

describe('Ask for work', () => {
  const projects = () => [
    summaryOf(),
    summaryOf({
      project: projectOf({ project_id: 'other', name: 'other' }),
      repos: [
        { ...repoOf(), repo_id: 'acme__api', repo_ref: 'acme/api', project_id: 'other' },
      ] as unknown as ProjectSummary['repos'],
    }),
  ];
  const receipt = (over: Record<string, unknown> = {}) => ({
    request_id: ITEM,
    item_id: ITEM,
    state: 'routed_l8',
    verdict: {
      repo: 'reshif/asf-factory-testbed',
      lane: 'L3',
      eligible: false,
      route: 'l8',
      reason: 'level_too_low',
      prr: null,
    },
    duplicate: false,
    dedupe_links: [],
    injection: { suspected: false, rules: [], lines: [], text_sha256: 'b'.repeat(64) },
    asked_lane: 'L3',
    proposed_lane: 'L8',
    lane_opens_at: 'light',
    request_text: {
      text: 'Add pagination to the orders list.',
      taint: 'untrusted',
      origin: 'request',
      provenance: {
        channel: 'N1',
        source: null,
        received_at: NOW,
        submitted_by: 'alice',
        raw_sha256: 'c'.repeat(64),
        normalised_sha256: 'd'.repeat(64),
      },
      flags: [],
    },
    deciders: [
      { gate: 'G0', slot: 'intent', holders: ['bob'], reason: null },
      { gate: 'G1', slot: 'intent', holders: null, reason: 'down' },
    ],
    principal_names: { bob: 'Bob Builder' },
    ...over,
  });

  it('sends the request with the CSRF token and the track by name, then says what happened in words', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: requester() },
      'GET /api/projects': { json: projects() },
      'POST /api/me/decisions': allowOnly('work.request'),
      'POST /api/requests': { status: 201, json: receipt() },
    });
    renderAt('/ask/testbed');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ask for work' }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('Project')).toHaveValue('testbed');
    expect(screen.getByLabelText('Repo')).toHaveValue('reshif/asf-factory-testbed');
    const track = screen.getByLabelText('Track you expect (optional)');
    expect(within(track).getByRole('option', { name: 'Small change' })).toBeInTheDocument();
    expect(track).not.toHaveTextContent(CODE);
    await user.selectOptions(track, 'L3');
    await user.type(screen.getByLabelText('What do you need?'), 'Add pagination  ');
    const send = screen.getByRole('button', { name: 'Ask for work' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    const post = m.calls.find((c) => c.method === 'POST' && c.path === '/api/requests');
    expect(post?.body).toEqual({
      project_id: 'testbed',
      repo: 'reshif/asf-factory-testbed',
      text: 'Add pagination',
      lane: 'L3',
    });
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    const lane = await screen.findByTestId('receipt-lane');
    expect(lane).toHaveTextContent('You asked forSmall change');
    expect(lane).toHaveTextContent('Done by a person');
    expect(lane).not.toHaveTextContent(CODE);
    const who = within(screen.getByRole('list', { name: 'Who decides first' }));
    expect(who.getAllByRole('listitem')[0]).toHaveTextContent('Accept the requestBob Builder');
    expect(who.getAllByRole('listitem')[1]).toHaveTextContent('Unknown');
    expect(screen.getByRole('link', { name: 'Open the work item' })).toHaveAttribute(
      'href',
      `/items/${ITEM}`,
    );
  });

  it('says what is missing and sends nothing without text; a refusal from the server is said', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: requester() },
      'GET /api/projects': { json: projects() },
      'POST /api/me/decisions': allowOnly('work.request'),
      'POST /api/requests': {
        status: 409,
        json: { error: { code: 'conflict', message: 'the repo is not ready' } },
      },
    });
    renderAt('/ask');
    const send = await screen.findByRole('button', { name: 'Ask for work' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    expect(screen.getByRole('alert')).toHaveTextContent('Say what you need first.');
    expect(m.calls.some((c) => c.path === '/api/requests')).toBe(false);
    await user.type(screen.getByLabelText('What do you need?'), 'x');
    await user.click(send);
    expect(await screen.findByText(/the repo is not ready/)).toHaveTextContent('Nothing was sent.');
  });

  it('forbidden: a person who may ask nowhere is told so, and nothing can be sent', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/projects': { json: projects() },
    });
    renderAt('/ask-for-work');
    expect(await screen.findByText('You may not ask for work yet')).toBeInTheDocument();
    expect(screen.queryByLabelText('What do you need?')).toBeNull();
  });

  it('empty: no project to ask on', async () => {
    mockApi({ 'GET /api/me': { json: requester() }, 'GET /api/projects': { json: [] } });
    renderAt('/ask');
    expect(await screen.findByText('No project to ask on')).toBeInTheDocument();
  });
});

describe('the work item', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    item_id: ITEM,
    project_id: 'testbed',
    repo: 'reshif/asf-factory-testbed',
    request_id: ITEM,
    phase: 'S3',
    lane: 'L3',
    proposed_lane: 'L3',
    terminal: null,
    waiting: 'gates:G2',
    holds: [],
    questions: [],
    gates: [
      {
        gate: 'G2',
        gate_instance_id: 'g-2',
        status: 'pending',
        outcome: null,
        card_id: WORK_CARD,
        ledger_entry_id: null,
      },
    ],
    outstanding: 1,
    terminal_cause: null,
    rework_total: 1,
    handoff: null,
    assumptions: [],
    catalogue_ref: { version: '1.4.0', hash: 'a'.repeat(64) },
    injection_suspected: false,
    dedupe_links: [],
    profile_gates: { on: ['G0', 'G1', 'G2', 'G3', 'G4'], off: ['G3d'] },
    clarify: null,
    pull_requests: [],
    may: { ready: false, answer: false, observe: false, plan: false },
    ...over,
  });
  const catalogue = {
    versions: [
      {
        ref: { version: '1.4.0', hash: 'a'.repeat(64) },
        current: true,
        pinned_items: 1,
        lanes: [
          {
            lane: 'L3',
            label: null,
            enter_at: null,
            stages: ['S1', 'S3', 'S5', 'S6', 'S7', 'S8', 'S9'],
            gates: [],
          },
        ],
      },
    ],
  };

  it('Now says what happens in one sentence and the one thing I can do; the strip greys skipped stages', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET /api/items/${ITEM}`]: { json: item() },
      'GET /api/catalogue': { json: catalogue },
      'GET /api/inbox': { json: { decide: [inbox()], view: [] } },
    });
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByTestId('item-waiting')).toHaveTextContent(
      'Waiting for the approval: Approve the spec.',
    );
    expect(await screen.findByTestId('now-decide')).toHaveAttribute('href', `/decide/${WORK_CARD}`);
    expect(screen.getByTestId('now-decide')).toHaveTextContent('Decide: Approve the spec');
    await waitFor(() =>
      expect(document.querySelector('.ui-stage-skipped')).toHaveTextContent('Research'),
    );
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent('Spec');
    // only this item's route: the off approval says so, nothing is invented
    const gates = screen.getByTestId('item-gates');
    expect(gates.querySelector('[data-gate="G3d"]')).toHaveAttribute('data-state', 'off');
    expect(gates.querySelector('[data-gate="G5"]')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Properties' })).toHaveTextContent(
      'Rework1 sent back',
    );
    expect(screen.getByTestId('item')).not.toHaveTextContent(CODE);
  });

  it('forbidden is the 403 page with the reason; missing is the one 404', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET /api/items/${ITEM}`]: {
        status: 403,
        json: { error: { code: 'forbidden', message: 'project.view denied' } },
      },
    });
    const { unmount } = renderAt(`/items/${ITEM}`);
    await waitFor(() => expect(document.querySelector('[data-status="403"]')).not.toBeNull());
    unmount();
    mockApi({
      'GET /api/me': { json: me() },
      [`GET /api/items/${ITEM}`]: {
        status: 404,
        json: { error: { code: 'not_found', message: 'no' } },
      },
    });
    renderAt(`/items/${ITEM}`);
    await waitFor(() => expect(document.querySelector('[data-status="404"]')).not.toBeNull());
  });
});

describe('Decide: moving through the inbox', () => {
  it('J opens the next approval in my inbox; the first has no previous', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/inbox': {
        json: {
          decide: [inbox({ id: 'a', card_id: 'card-a' }), inbox({ id: 'b', card_id: 'card-b' })],
          view: [],
        },
      },
      'GET /api/cards/card-a/kind': { json: { card_id: 'card-a', kind: 'work_gate' } },
      'GET /api/cards/card-a/gate': {
        json: {
          card_id: 'card-a',
          project_id: 'testbed',
          item_id: ITEM,
          status: 'open',
          gates: [
            {
              gate_instance_id: 'g',
              gate: 'X3',
              slot: 'x',
              status: 'pending',
              outcome: null,
              step_up_required: false,
            },
          ],
          subject_hash: 'c'.repeat(64),
          proposed_lane: null,
          base_sha: null,
          injection_suspected: false,
          deciders: { slots: ['x'], holders: ['bob'] },
          decisions_allowed: ['approve', 'reject'],
          decision_reason: null,
          may_decide: false,
          why_not: { code: 'not_slot_holder', reasons: [] },
          principal_names: { bob: 'Bob Builder' },
        },
      },
    });
    renderAt('/decide/card-a');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Allow new dependency' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Next/ })).toHaveAttribute(
      'href',
      '/decide/card-b',
    );
    expect(screen.queryByRole('link', { name: /Previous/ })).toBeNull();
    await userEvent.keyboard('j');
    await waitFor(() => expect(window.location.pathname).toBe('/decide/card-b'));
  });
});
