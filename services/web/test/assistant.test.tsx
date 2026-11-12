import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_ID,
  NOW,
  S0_ID,
  card,
  me,
  mockApi,
  projectOf,
  renderAt,
  repoOf,
  s0,
  summaryOf,
} from './helpers';

// PLAN M18 in the portal: the onboarding assistant beside the S0 page, "Ask the factory", and the notifications
// screens. The browser sends the question and nothing else (the bff adds the person and the data class); answers are
// text, citations are chips, proposals are buttons through the access layer that call the route they name.

const THREAD = '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a00';
const ASK = '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a01';
const SHA = 'b'.repeat(40);
const C4 = '01a1bc26-f0e5-719a-a52b-a88a4b6cbe44';
const payload = { payload_id: ASK, sha256: 'a'.repeat(64), redactions: [], erased_at: null };
const budget = {
  group_id: `assistant_user_day:${'c'.repeat(24)}:2026-11-08`,
  max_tokens: 200000,
  max_cost_micro_usd: 2000000,
  used_tokens: 1000,
  used_cost_micro_usd: 580000,
  exhausted: false,
  resets_at: '2026-11-09T00:00:00.000Z',
};
const thread = {
  thread_id: THREAD,
  owner: 'alice',
  subject: { kind: 's0', s0_id: S0_ID, project_id: 'testbed' },
  title: 'Why is this onboarding waiting?',
  turns: 2,
  created_at: NOW,
  updated_at: NOW,
};
const personTurn = {
  thread_id: THREAD,
  seq: 1,
  role: 'person',
  kind: 'message',
  at: NOW,
  payload,
  text: 'Why is this onboarding waiting?',
  citations: [],
  proposals: [],
  drafts: [],
  flags: [],
  refusal: null,
  grounding_sha: null,
  ask_id: ASK,
};
const botTurn = {
  ...personTurn,
  seq: 2,
  role: 'assistant',
  kind: 'drafts',
  text: 'Card 1 waits for you. <b>not html</b>',
  citations: [
    { kind: 'record', ref: `card:${CARD_ID}` },
    { kind: 'file', path: 'AGENTS.md', commit_sha: SHA, line_from: 4, line_to: 9 },
  ],
  proposals: [
    {
      action_id: 'open_card',
      label: 'Open card 1',
      kind: 'navigate',
      route: { method: 'GET', path: `/cards/${CARD_ID}` },
      pdp_action: 'project.view',
      resource: {
        type: 'Project',
        id: 'testbed',
        project: null,
        lane: null,
        item: null,
        gate_id: null,
      },
    },
    {
      action_id: 'recheck_controls',
      label: 'Re-check the controls',
      kind: 'call',
      route: { method: 'POST', path: `/api/cards/${C4}/recheck` },
      pdp_action: 'card.decide',
      resource: { type: 'Card', id: C4, project: 'testbed', lane: null, item: null, gate_id: null },
    },
  ],
  drafts: [
    {
      draft_id: 'd1',
      title: 'Release section',
      text: '## Release\nPeople cut releases.',
      card: 'C2',
      lint: [],
    },
  ],
  flags: ['planted_instruction'],
  grounding_sha: SHA,
};
const askResult = {
  thread,
  turns: [personTurn, botTurn],
  ask: {
    ask_id: ASK,
    thread_id: THREAD,
    principal: 'alice',
    budget_group: budget.group_id,
    vkey_id: 'k',
    grounding_sha: SHA,
    context_sha256: 'a'.repeat(64),
    outcome: 'answered',
    refusal: null,
    attempts: 1,
    tokens_in: 1,
    tokens_out: 1,
    started_at: NOW,
    finished_at: NOW,
  },
  budget,
};

/** Allows `project.view` and `card.decide`, denies the rest. */
const decisions = (allow: readonly string[]) => (c: { body: unknown }) => ({
  json: {
    decisions: (
      (c.body as { queries?: Array<{ action: string; resource: unknown }> }).queries ?? []
    ).map((q) => ({
      ...q,
      allow: allow.includes(q.action),
      reasons: allow.includes(q.action) ? [] : ['no_policy_permits'],
    })),
  },
});

function s0Routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/me': { json: me() },
    [`GET /api/s0/${S0_ID}`]: { json: s0({ status: 'card', states: { '0.1': 'card' } }) },
    [`GET /api/s0/${S0_ID}/cards`]: { json: [card()] },
    [`GET /api/s0/${S0_ID}/revision`]: { json: { revision: null } },
    'GET /api/projects/testbed': { json: { project: projectOf(), repos: [repoOf()], s0: [] } },
    'GET /api/assistant/budget': { json: budget },
    ...extra,
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the onboarding assistant beside the S0 page', () => {
  it('asks with the question only, and shows the answer as text with citations, drafts and buttons', async () => {
    let asked = false;
    const api = mockApi(
      s0Routes({
        'POST /api/me/decisions': decisions(['project.view', 'card.decide']),
        [`GET /api/assistant/threads?s0=${S0_ID}`]: () => ({
          json: { threads: asked ? [thread] : [] },
        }),
        [`GET /api/assistant/threads/${THREAD}`]: {
          json: {
            thread,
            turns: [personTurn, botTurn],
            grounding: { repo: 'reshif/asf-factory-testbed', census_sha: SHA, stale: true },
            budget,
          },
        },
        'POST /api/assistant/ask': () => {
          asked = true;
          return { status: 201, json: askResult };
        },
        [`POST /api/cards/${C4}/recheck`]: { json: { ok: true } },
      }),
    );
    renderAt(`/s0/${S0_ID}`);
    const panel = await screen.findByRole('region', { name: 'Onboarding assistant' });
    await userEvent.click(
      await within(panel).findByRole('button', { name: 'Why is this onboarding waiting?' }),
    );
    const sent = api.calls.find((c) => c.path === '/api/assistant/ask');
    expect(sent?.body).toEqual({
      subject: { kind: 's0', s0_id: S0_ID },
      text: 'Why is this onboarding waiting?',
    });
    expect(sent?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    // the answer is text: markup in it is not rendered
    expect(
      await within(panel).findByText('Card 1 waits for you. <b>not html</b>'),
    ).toBeInTheDocument();
    const cites = within(panel).getByLabelText('Citations');
    expect(within(cites).getByRole('link', { name: /card:/ })).toHaveAttribute(
      'href',
      `/cards/${CARD_ID}`,
    );
    expect(within(cites).getByText(/AGENTS\.md:4-9 @ bbbbbbb/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/head moved: I answer nothing about the new head/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/Repo text carried an instruction/)).toBeInTheDocument();
    expect(within(panel).getByText(/People cut releases/)).toBeInTheDocument();
    const actions = within(panel).getByRole('group', { name: 'Suggested actions' });
    expect(await within(actions).findByRole('link', { name: 'Open card 1' })).toHaveAttribute(
      'href',
      `/cards/${CARD_ID}`,
    );
    await userEvent.click(
      await within(actions).findByRole('button', { name: 'Re-check the controls' }),
    );
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.method === 'POST' && c.path === `/api/cards/${C4}/recheck`),
      ).toBe(true),
    );
    const recheck = api.calls.find((c) => c.path === `/api/cards/${C4}/recheck`);
    expect(recheck?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    expect(within(panel).getByText(/71% left/)).toBeInTheDocument();
  });

  it('locks a button the PDP denies, and says it answers only people who can see the onboarding', async () => {
    mockApi(
      s0Routes({
        'POST /api/me/decisions': decisions(['project.view']),
        [`GET /api/assistant/threads?s0=${S0_ID}`]: { json: { threads: [thread] } },
        [`GET /api/assistant/threads/${THREAD}`]: {
          json: {
            thread,
            turns: [personTurn, botTurn],
            grounding: { repo: 'reshif/asf-factory-testbed', census_sha: SHA, stale: false },
            budget: { ...budget, exhausted: true },
          },
        },
      }),
    );
    renderAt(`/s0/${S0_ID}`);
    const panel = await screen.findByRole('region', { name: 'Onboarding assistant' });
    const actions = await within(panel).findByRole('group', { name: 'Suggested actions' });
    await waitFor(() =>
      expect(
        within(actions).getByRole('button', { name: 'Re-check the controls' }),
      ).toHaveAttribute('aria-disabled', 'true'),
    );

    vi.unstubAllGlobals();
    mockApi(s0Routes());
    renderAt(`/s0/${S0_ID}`);
    expect(
      (await screen.findAllByText('The assistant answers only people who can see this onboarding.'))
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('Ask the factory', () => {
  it('starts a conversation about a project the person can see', async () => {
    const api = mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': decisions(['project.view']),
      'GET /api/projects': { json: [summaryOf()] },
      'GET /api/assistant/threads': { json: { threads: [] } },
      'GET /api/assistant/budget': { json: { ...budget, exhausted: true } },
      'POST /api/assistant/ask': {
        status: 201,
        json: {
          ...askResult,
          thread: { ...thread, subject: { kind: 'project', project_id: 'testbed' } },
        },
      },
      [`GET /api/assistant/threads/${THREAD}`]: {
        json: {
          thread: { ...thread, subject: { kind: 'project', project_id: 'testbed' } },
          turns: [personTurn, { ...botTurn, kind: 'answer', drafts: [], proposals: [] }],
          grounding: { repo: 'reshif/asf-factory-testbed', census_sha: SHA, stale: false },
          budget,
        },
      },
    });
    renderAt('/ask');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ask the factory' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/spent; it resets at 00:00 UTC/)).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText('Message'), 'What is waiting?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/api/assistant/ask')?.body).toEqual({
        subject: { kind: 'project', project_id: 'testbed' },
        text: 'What is waiting?',
      }),
    );
    expect(await screen.findByText('Card 1 waits for you. <b>not html</b>')).toBeInTheDocument();
  });
});

describe('notifications', () => {
  it('lists the person’s notifications with a link to the portal', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/me/notifications': {
        json: {
          notifications: [
            {
              notification_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a71',
              content: {
                kind: 'gate_waiting',
                project_id: 'testbed',
                gate_id: 'G3',
                gate_instance_id: null,
                card_id: null,
                kill_id: null,
                due_at: null,
                link_path: '/inbox',
              },
              reason: 'slot_holder',
              raised_at: NOW,
              deliveries: [
                {
                  delivery_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a72',
                  channel_id: 'team-slack',
                  status: 'delivered',
                  attempts: 1,
                  last_error: null,
                  next_attempt_at: null,
                  delivered_at: NOW,
                },
              ],
            },
          ],
        },
      },
    });
    renderAt('/me/notifications');
    expect(await screen.findByRole('link', { name: 'A gate waits for you' })).toHaveAttribute(
      'href',
      '/inbox',
    );
    expect(screen.getByText('team-slack: delivered')).toBeInTheDocument();
  });

  it('says so when the notifier is not there, and nothing else breaks', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/me/notifications': {
        status: 503,
        json: { error: { code: 'notifier_not_configured', message: 'off' } },
      },
    });
    renderAt('/me/notifications');
    expect(await screen.findByText('Notifications are not available')).toBeInTheDocument();
  });

  it('saves the person’s preferences; a kill cannot be muted', async () => {
    const view = {
      principal_id: 'alice',
      preferences: { channels: null, muted_kinds: [], slack_member_id: null },
      set_at: null,
      channels: [
        {
          channel_id: 'team-slack',
          kind: 'slack_webhook',
          display_name: 'Team channel',
          default_on: true,
          data_class_max: 'D1',
        },
      ],
    };
    const api = mockApi({
      'GET /api/me': { json: me() },
      'GET /api/me/notifications/preferences': { json: view },
      'PUT /api/me/notifications/preferences': (c) => ({
        json: {
          ...view,
          preferences: (c.body as { preferences: unknown }).preferences,
          set_at: NOW,
        },
      }),
    });
    renderAt('/me/notifications/preferences');
    expect(await screen.findByLabelText(/A kill switch was engaged/)).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Use the factory/));
    await userEvent.click(screen.getByLabelText(/Team channel/));
    await userEvent.click(screen.getByLabelText(/An item was handed off/));
    await userEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
        preferences: { channels: [], muted_kinds: ['handoff'], slack_member_id: null },
      }),
    );
    expect(api.calls.find((c) => c.method === 'PUT')?.headers['x-csrf-token']).toBe(
      'csrf-token-of-alice',
    );
  });
});
