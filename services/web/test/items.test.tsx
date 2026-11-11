import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';

// The portal's actions on a work item during planning (PLAN M12.5): answers to S1's questions, the Ready decision
// (1.6), the observed signals while G3d is open (B4, R2) and the plan a person writes (B5). Each button is shown
// only when the bff says the person may, and a press sends exactly one request with the CSRF token.

const ITEM = '33333333-4444-4555-8666-777777777777';
const PATH = `/api/items/${ITEM}`;

const view = (over: Record<string, unknown> = {}, may: Record<string, boolean> = {}) => ({
  item_id: ITEM,
  project_id: 'testbed',
  repo: 'reshif/asf-factory-testbed',
  request_id: ITEM,
  phase: 'S1',
  lane: null,
  proposed_lane: 'L4',
  terminal: null,
  waiting: null,
  holds: [],
  questions: [],
  gates: [],
  outstanding: 0,
  terminal_cause: null,
  rework_total: 0,
  handoff: null,
  assumptions: [],
  catalogue_ref: { version: '1.0.0', hash: 'a'.repeat(64) },
  injection_suspected: false,
  dedupe_links: [],
  may: { ready: false, answer: false, observe: false, plan: false, ...may },
  ...over,
});

const question = (over: Record<string, unknown> = {}) => ({
  question_id: 'q-1',
  item_id: ITEM,
  stage: 'S1',
  step: '1.5',
  round: 1,
  material: 'blocking',
  text: 'Which table holds the audit log?',
  state: 'open',
  asked_at: '2026-11-09T10:00:00.000Z',
  answered_at: null,
  answered: false,
  answer_flagged: false,
  ...over,
});
const result = (it = view()) => ({ item: it, duplicate: false });
const posts = (m: ReturnType<typeof mockApi>) => m.calls.filter((c) => c.method === 'POST');

describe('the work item page', () => {
  it('says where the item is and what it waits for, and shows no action to someone who may do none', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: {
        json: view({ waiting: 'human:ready', questions: [question({ answered: true })] }),
      },
    });
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Work item' })).toBeInTheDocument();
    expect(screen.getByTestId('item-waiting')).toHaveTextContent(/ready for the first approval/);
    expect(screen.getByTestId('item-lane')).toHaveTextContent('L4 (proposed, not yet approved)');
    expect(screen.queryByRole('button', { name: 'Say it is ready' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Ready decision' })).toBeNull();
    expect(screen.getByText(/Answered\./)).toBeInTheDocument();
  });

  it('answers a clarification question: one POST with the CSRF token, the answer text only in the body', async () => {
    const m = mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: {
        json: view({ waiting: 'questions:q-1', questions: [question()] }, { answer: true }),
      },
      [`POST ${PATH}/answers`]: { json: result() },
    });
    renderAt(`/items/${ITEM}`);
    const box = await screen.findByLabelText('Your answer');
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send).toBeDisabled();
    await userEvent.type(box, 'The audit_log table.');
    await userEvent.click(send);
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(posts(m)[0]).toMatchObject({
      path: `${PATH}/answers`,
      headers: { 'x-csrf-token': 'csrf-token-of-alice' },
      body: { question_id: 'q-1', text: 'The audit_log table.' },
    });
  });

  it('a flagged answer is said to be read as data; someone who may not answer sees the question only', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: {
        json: view({
          questions: [
            question({ answered: true, answer_flagged: true }),
            question({ question_id: 'q-2', text: 'Another?' }),
          ],
        }),
      },
    });
    renderAt(`/items/${ITEM}`);
    expect(
      await screen.findByText(/looks like it tries to instruct the factory/),
    ).toBeInTheDocument();
    expect(screen.getByText('Waiting for the requester to answer.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your answer')).toBeNull();
  });

  it('decides Ready with one press: no body but the empty one, nothing on its own', async () => {
    const m = mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: view({ waiting: 'human:ready' }, { ready: true }) },
      [`POST ${PATH}/ready`]: { json: result() },
    });
    renderAt(`/items/${ITEM}`);
    const region = await screen.findByRole('region', { name: 'Ready decision' });
    expect(posts(m)).toHaveLength(0);
    await userEvent.click(within(region).getByRole('button', { name: 'Say it is ready' }));
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(posts(m)[0]).toMatchObject({
      path: `${PATH}/ready`,
      headers: { 'x-csrf-token': 'csrf-token-of-alice' },
      body: {},
    });
  });

  it('shows a refusal from the factory instead of pretending it worked', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: view({ waiting: 'human:ready' }, { ready: true }) },
      [`POST ${PATH}/ready`]: {
        status: 409,
        json: {
          error: { code: 'conflict', message: 'the item is not waiting for the Ready decision' },
        },
      },
    });
    renderAt(`/items/${ITEM}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Say it is ready' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /not waiting for the Ready decision/,
    );
  });

  it('while G3d is open: B4 sends the spec back with a reason code; R2 asks for a smaller lane (only smaller ones are offered)', async () => {
    const m = mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: {
        json: view(
          {
            lane: 'L4',
            phase: 'S4',
            waiting: 'gates:G3d',
            gates: [{ gate: 'G3d', gate_instance_id: 'gi-1', status: 'pending', outcome: null }],
          },
          { observe: true },
        ),
      },
      [`POST ${PATH}/observe`]: { json: result() },
    });
    renderAt(`/items/${ITEM}`);
    const region = await screen.findByRole('region', { name: 'What the design review found' });
    // the lanes offered are smaller than L4, and never the special ones
    const lanes = within(region)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(lanes).toEqual(expect.arrayContaining(['L1', 'L2', 'L3']));
    expect(lanes).not.toContain('L4');
    expect(lanes).not.toContain('L8');

    await userEvent.selectOptions(
      within(region).getByLabelText('What is wrong with the spec'),
      'spec_ambiguous',
    );
    await userEvent.click(within(region).getByRole('button', { name: 'Send the spec back (B4)' }));
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(posts(m)[0]?.body).toMatchObject({ edge: 'B4', reason_code: 'spec_ambiguous' });
    expect((posts(m)[0]?.body as { key: string }).key).toBeTruthy();
    expect((posts(m)[0]?.body as Record<string, unknown>)['on_behalf_of']).toBeUndefined();

    await userEvent.selectOptions(within(region).getByLabelText('Move it to lane'), 'L2');
    await userEvent.click(
      within(region).getByRole('button', { name: 'Ask for a smaller lane (R2)' }),
    );
    await waitFor(() => expect(posts(m)).toHaveLength(2));
    expect(posts(m)[1]?.body).toMatchObject({
      edge: 'R2',
      to_lane: 'L2',
      reason_code: 'smaller_than_lane',
    });
  });

  it('no observation is offered when the person may not, or when G3d is not open', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: view({ waiting: 'gates:G3d' }) },
    });
    renderAt(`/items/${ITEM}`);
    await screen.findByTestId('item-waiting');
    expect(screen.queryByRole('region', { name: 'What the design review found' })).toBeNull();
  });
});

describe('B5: the plan a person writes', () => {
  const waitingForPlan = { waiting: 'human:plan', lane: 'L4', phase: 'S5' };

  it('builds the four parts in the planner’s shapes from the fields, sends them once, and says G3 decides', async () => {
    const m = mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: view(waitingForPlan, { plan: true }) },
      [`POST ${PATH}/plan`]: {
        json: {
          item: view(),
          units: 1,
          base_sha: 'b'.repeat(40),
          outputs: { '5.1': 'c'.repeat(64) },
        },
      },
    });
    renderAt(`/items/${ITEM}`);
    const form = await screen.findByRole('region', { name: 'Write the plan' });
    const send = within(form).getByRole('button', { name: 'Send the plan for approval' });
    expect(send).toBeDisabled();
    const t = userEvent.setup();
    await t.type(within(form).getByLabelText('Name (a short lowercase key)'), 'export-route');
    await t.type(within(form).getByLabelText('What it does'), 'Add the export route');
    await t.type(within(form).getByLabelText(/Paths it may touch/), 'src/audit/, src/index.ts');
    await t.selectOptions(within(form).getByLabelText('Size'), 'medium');
    await t.type(within(form).getByLabelText(/^Tasks, one per line/), 'Add GET /export | npm test');
    await t.type(within(form).getByLabelText(/Oracles that verify it/), 'o1, o2');
    await t.type(within(form).getByLabelText('Why this order'), 'one Unit');
    expect(send).toBeEnabled();
    await t.click(send);
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    const body = posts(m)[0]?.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(posts(m)[0]?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    expect(body['split']).toEqual({
      units: [
        {
          unit_key: 'export-route',
          title: 'Add the export route',
          paths: ['src/audit/', 'src/index.ts'],
          size: 'medium',
          depends_on: [],
        },
      ],
    });
    expect(body['sequence']).toEqual({ order: ['export-route'], rationale: 'one Unit' });
    expect(body['tasks']).toEqual({
      units: [
        {
          unit_key: 'export-route',
          tasks: [{ task_id: 't1', description: 'Add GET /export', verification: 'npm test' }],
        },
      ],
    });
    expect(body['verification']).toEqual({
      bindings: [{ unit_key: 'export-route', oracle_ids: ['o1', 'o2'] }],
    });
    expect(body['on_behalf_of']).toBeUndefined();
    expect(await screen.findByTestId('plan-stored')).toHaveTextContent(/design approvers \(G3\)/);
  });

  it('shows the factory’s findings when the plan fails the same checks as an agent plan, and stores nothing', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: view(waitingForPlan, { plan: true }) },
      [`POST ${PATH}/plan`]: {
        status: 400,
        json: { error: { code: 'invalid_input', message: 'split: units dependency_cycle' } },
      },
    });
    renderAt(`/items/${ITEM}`);
    const form = await screen.findByRole('region', { name: 'Write the plan' });
    const t = userEvent.setup();
    await t.type(within(form).getByLabelText('Name (a short lowercase key)'), 'a');
    await t.type(within(form).getByLabelText('What it does'), 'a');
    await t.type(within(form).getByLabelText(/Paths it may touch/), 'src/');
    await t.type(within(form).getByLabelText(/^Tasks, one per line/), 'x | y');
    await t.type(within(form).getByLabelText(/Oracles that verify it/), 'o1');
    await t.type(within(form).getByLabelText('Why this order'), 'r');
    await t.click(within(form).getByRole('button', { name: 'Send the plan for approval' }));
    expect(await screen.findByTestId('plan-problem')).toHaveTextContent(/dependency_cycle/);
    expect(screen.getByTestId('plan-problem')).toHaveTextContent(/Nothing was stored/);
    // the form is still there to fix
    expect(within(form).getByRole('button', { name: 'Send the plan for approval' })).toBeEnabled();
  });

  it('can add and remove Units', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: view(waitingForPlan, { plan: true }) },
    });
    renderAt(`/items/${ITEM}`);
    const form = await screen.findByRole('region', { name: 'Write the plan' });
    await userEvent.click(within(form).getByRole('button', { name: 'Add a Unit' }));
    expect(within(form).getAllByRole('group', { name: /^Unit \d/ })).toHaveLength(2);
    await userEvent.click(within(form).getByRole('button', { name: 'Remove Unit 2' }));
    expect(within(form).getAllByRole('group', { name: /^Unit \d/ })).toHaveLength(1);
  });

  it('shows no plan form to someone who may not write it', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: view(waitingForPlan) },
    });
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByTestId('item-waiting')).toHaveTextContent(/person to write the plan/);
    expect(screen.queryByRole('region', { name: 'Write the plan' })).toBeNull();
  });
});
