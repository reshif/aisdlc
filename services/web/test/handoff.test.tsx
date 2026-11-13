import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { parseReference } from '../src/items/HandoffPanel';
import { me, mockApi, renderAt } from './helpers';

// P1-4: the handoff panel of the item page. What was handed off and why, the E4 card, the choices the flow allows
// once the owner of record approved E4, and while a developer has the work: D5 with the PR or commit, and D4 once.
// Each button is shown only when the bff says the person may; a press sends exactly one request with the CSRF token.

const ITEM = '33333333-4444-4555-8666-777777777777';
const HANDOFF = '55555555-6666-4777-8888-999999999999';
const E4_GATE = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const E4_CARD = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const PATH = `/api/items/${ITEM}`;

const item = (over: Record<string, unknown> = {}) => ({
  item_id: ITEM,
  project_id: 'testbed',
  repo: 'reshif/asf-factory-testbed',
  request_id: ITEM,
  phase: 'Handoff',
  lane: 'L3',
  proposed_lane: 'L3',
  terminal: null,
  waiting: 'handoff:e4',
  holds: [],
  questions: [],
  gates: [],
  outstanding: 0,
  terminal_cause: null,
  rework_total: 0,
  handoff: handoff(),
  assumptions: [],
  catalogue_ref: { version: '1.0.0', hash: 'a'.repeat(64) },
  injection_suspected: false,
  dedupe_links: [],
  profile_gates: null,
  clarify: null,
  pull_requests: [],
  may: { ready: false, answer: false, observe: false, plan: false },
  ...over,
});

function handoff(over: Record<string, unknown> = {}) {
  return {
    handoff_id: HANDOFF,
    item_id: ITEM,
    n: 1,
    code: 'D1',
    trigger: 'ET1',
    origin_phase: 'S6',
    origin_step: null,
    pack: { pack_id: `handoff-pack:${HANDOFF}`, content_sha256: 'd'.repeat(64) },
    e4_gate_instance_id: E4_GATE,
    e4_decided: false,
    status: 'open',
    choice: null,
    chosen_by: null,
    extension: null,
    opened_at: '2026-11-09T10:00:00.000Z',
    chosen_at: null,
    ...over,
  };
}

const panel = (over: Record<string, unknown> = {}, may: Record<string, boolean> = {}) => ({
  item_id: ITEM,
  project_id: 'testbed',
  lane: 'L3',
  phase: 'Handoff',
  waiting: 'handoff:e4',
  handoff: handoff(),
  e4: {
    gate_instance_id: E4_GATE,
    card_id: E4_CARD,
    status: 'pending',
    outcome: null,
    approvers: [],
  },
  choices: [],
  extension_max_percent: 50,
  human_led: null,
  done: [],
  may: { decide_e4: false, choose: false, hand_back: false, human_done: false, ...may },
  ...over,
});
const result = { item: item(), duplicate: false };
const posts = (m: ReturnType<typeof mockApi>) => m.calls.filter((c) => c.method === 'POST');

describe('the handoff panel (P1-4)', () => {
  it('shows the trigger, the origin phase, the Handoff Pack by hash, and links the E4 card', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: item() },
      [`GET ${PATH}/handoff`]: { json: panel({}, { decide_e4: true }) },
    });
    renderAt(`/items/${ITEM}`);
    const facts = await screen.findByTestId('handoff-facts');
    expect(facts).toHaveTextContent('D1: HANDOFF from S6');
    expect(facts).toHaveTextContent('ET1 (budget 100%)');
    expect(facts).toHaveTextContent('From');
    expect(within(facts).getByTestId('pack-sha')).toHaveAttribute('title', 'd'.repeat(64));
    expect(screen.getByTestId('item-waiting')).toHaveTextContent(/owner of record: E4 is open/);
    const link = screen.getByRole('link', { name: 'Open the E4 card to decide it' });
    expect(link).toHaveAttribute('href', `/cards/${E4_CARD}`);
    // no choice before E4 is approved
    expect(screen.queryByRole('button', { name: 'Record my choice' })).toBeNull();
  });

  it("records the owner of record's choice with one POST; an extension names its percent within the limit", async () => {
    const m = mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: item({ waiting: 'handoff:choice' }) },
      [`GET ${PATH}/handoff`]: {
        json: panel(
          {
            waiting: 'handoff:choice',
            e4: {
              gate_instance_id: E4_GATE,
              card_id: E4_CARD,
              status: 'decided',
              outcome: 'approve',
              approvers: ['alice'],
            },
            choices: ['resume', 'extend', 'takeover', 'abandon'],
          },
          { choose: true },
        ),
      },
      [`POST ${PATH}/handoff/choose`]: { json: result },
    });
    renderAt(`/items/${ITEM}`);
    const record = await screen.findByRole('button', { name: 'Record my choice' });
    expect(record).toBeDisabled();
    expect(screen.queryByRole('radio', { name: /Re-plan/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: /One envelope extension/ }));
    const pct = screen.getByLabelText(/How much more envelope/);
    await userEvent.clear(pct);
    await userEvent.type(pct, '80');
    expect(record).toBeDisabled();
    await userEvent.clear(pct);
    await userEvent.type(pct, '25');
    await userEvent.click(screen.getByRole('radio', { name: /A developer takes over/ }));
    await userEvent.click(record);
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(posts(m)[0]).toMatchObject({
      path: `${PATH}/handoff/choose`,
      headers: { 'x-csrf-token': 'csrf-token-of-alice' },
      body: { handoff_id: HANDOFF, choice: 'takeover' },
    });
  });

  it('someone who did not approve E4 sees the choices are not theirs', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: item({ waiting: 'handoff:choice' }) },
      [`GET ${PATH}/handoff`]: {
        json: panel({
          e4: {
            gate_instance_id: E4_GATE,
            card_id: E4_CARD,
            status: 'decided',
            outcome: 'approve',
            approvers: ['bob'],
          },
          choices: ['resume', 'abandon'],
        }),
      },
    });
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByTestId('choose-not-mine')).toHaveTextContent(
      'Only who approved E4 records the choice',
    );
    expect(screen.queryByRole('button', { name: 'Record my choice' })).toBeNull();
  });

  it('D5: "I have done the work" needs a PR number or a full commit SHA, and sends it with the signal', async () => {
    const human = {
      lane: 'L8',
      phase: 'S6',
      waiting: 'human:human_led',
      handoff: handoff({ status: 'chosen', choice: 'takeover', chosen_by: 'bob' }),
      human_led: { taken_over: true, lane_before: 'L3', hand_backs_left: 1 },
    };
    const m = mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: item({ ...human, handoff: null }) },
      [`GET ${PATH}/handoff`]: { json: panel(human, { human_done: true, hand_back: true }) },
      [`POST ${PATH}/human-done`]: { json: result },
      [`POST ${PATH}/hand-back`]: { json: result },
    });
    renderAt(`/items/${ITEM}`);
    const done = await screen.findByRole('button', { name: 'I have done the work' });
    expect(done).toBeDisabled();
    const ref = screen.getByLabelText('Pull request number');
    await userEvent.type(ref, 'abc');
    expect(screen.getByRole('alert')).toHaveTextContent('by its number');
    expect(done).toBeDisabled();
    await userEvent.clear(ref);
    await userEvent.type(ref, '#42');
    await userEvent.click(done);
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(posts(m)[0]).toMatchObject({
      path: `${PATH}/human-done`,
      headers: { 'x-csrf-token': 'csrf-token-of-alice' },
      body: { reference: { kind: 'pr', number: 42 } },
    });
    // D4: once, with or without a changed plan
    expect(screen.getByText(/back to lane L3/)).toHaveTextContent('1 hand-back left');
    await userEvent.click(screen.getByRole('checkbox', { name: /The plan changed/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Hand it back' }));
    await waitFor(() => expect(posts(m)).toHaveLength(2));
    expect(posts(m)[1]).toMatchObject({
      path: `${PATH}/hand-back`,
      body: { plan_changed: true },
    });
  });

  it('a developer who may not hand back sees no D4; D4 used up says so', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { json: item({ lane: 'L8', waiting: 'human:human_led', handoff: null }) },
      [`GET ${PATH}/handoff`]: {
        json: panel(
          {
            waiting: 'human:human_led',
            handoff: handoff({ status: 'chosen', choice: 'takeover' }),
            human_led: { taken_over: true, lane_before: 'L3', hand_backs_left: 0 },
            done: [
              {
                by: 'dee',
                at: '2026-11-10T10:00:00.000Z',
                reference: { kind: 'commit', sha: 'c'.repeat(40) },
              },
            ],
          },
          { human_done: false },
        ),
      },
    });
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByText(/handed back once already/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hand it back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'I have done the work' })).toBeNull();
    expect(screen.getByLabelText('Work said done (D5)')).toHaveTextContent('commit cccccccccccc');
  });

  it('parses a reference the way the contract takes it', () => {
    expect(parseReference('pr', '#7')).toEqual({ kind: 'pr', number: 7 });
    expect(parseReference('pr', '0')).toBeNull();
    expect(parseReference('commit', 'A'.repeat(40))).toEqual({
      kind: 'commit',
      sha: 'a'.repeat(40),
    });
    expect(parseReference('commit', 'abc1234')).toBeNull();
  });
});
