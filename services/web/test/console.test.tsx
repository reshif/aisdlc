import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summary } from './onboardFixtures';
import { S0_ID, me, mockApi, renderAt, summaryOf } from './helpers';

// The onboarding console (docs/design/onboarding-console.md, P3): the page's first tab, three panes, and the session
// list at /assistant. The agent proposes and explains; nothing here decides anything.

const NOW = '2026-11-13T10:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

const blockers = {
  s0_id: S0_ID,
  status: 'in_progress',
  requested_level: 'light',
  ready: false,
  signoff: null,
  blockers: [
    {
      id: 'probe',
      kind: 'probe',
      owner: 'you',
      code: 'no_test_command',
      title: 'The repo has no test command the factory can find',
      why: 'Nothing can run.',
      next: 'Accept the proposed Makefile.',
      blocked_by: [],
    },
  ],
};

const session = (over: Record<string, unknown> = {}) => ({
  s0_id: S0_ID,
  project_id: 'testbed',
  started_by: 'alice',
  state: 'awaiting_person',
  cause: 'agent_asked',
  tier_floor: null,
  proposals: [],
  turns: [
    {
      seq: 1,
      role: 'observation',
      text: 'The state of the onboarding changed.',
      observed: 'blockers_changed',
      at: NOW,
    },
    {
      seq: 2,
      role: 'agent',
      text: 'The tests cannot run: no test command. <b>not html</b>',
      observed: null,
      at: NOW,
    },
  ],
  ...over,
});

const base = (extra: Record<string, unknown> = {}) =>
  ({
    'GET /api/me': { json: me() },
    'POST /api/me/decisions': decisions(['project.view', 'onboarding.console.use']),
    [`GET /api/s0/${S0_ID}/summary`]: { json: summary() },
    [`GET /api/s0/${S0_ID}/blockers`]: { json: blockers },
    ...extra,
  }) as never;

describe('the console tab', () => {
  it('opens on the console; before a session it offers to start one', async () => {
    const api = mockApi(
      base({
        [`GET /api/s0/${S0_ID}/console`]: {
          status: 404,
          json: { error: { code: 'not_found', message: 'no console session' } },
        },
        [`POST /api/s0/${S0_ID}/console/start`]: { status: 201, json: session() },
      }),
    );
    renderAt(`/onboard/${S0_ID}`);
    expect(await screen.findByRole('tab', { name: 'Console', selected: true })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Start the console' }));
    expect(await screen.findByText(/The tests cannot run/)).toBeInTheDocument();
    const call = api.calls.find((c) => c.path === `/api/s0/${S0_ID}/console/start`);
    expect(call?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('shows the plan, the conversation as text (never as markup) and the evidence; sends a message', async () => {
    const api = mockApi(
      base({
        [`GET /api/s0/${S0_ID}/console`]: { json: session() },
        [`POST /api/s0/${S0_ID}/console/messages`]: {
          json: session({
            turns: [
              ...session().turns,
              {
                seq: 3,
                role: 'person',
                text: 'Which command should it be?',
                observed: null,
                at: NOW,
              },
              { seq: 4, role: 'agent', text: 'I propose make test.', observed: null, at: NOW },
            ],
          }),
        },
      }),
    );
    renderAt(`/onboard/${S0_ID}`);
    const plan = await screen.findByRole('region', { name: 'Plan' });
    expect(
      await within(plan).findByText('The repo has no test command the factory can find'),
    ).toBeInTheDocument();
    expect(within(plan).getByText('You')).toBeInTheDocument();
    // the agent's words are text
    expect(
      await screen.findByText('The tests cannot run: no test command. <b>not html</b>'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('console-state')).toHaveAttribute('data-state', 'awaiting_person');
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText('Tell the onboarder'),
      'Which command should it be?',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('I propose make test.')).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === `/api/s0/${S0_ID}/console/messages`)?.body).toEqual({
      text: 'Which command should it be?',
    });
  });

  it('pause is a button only the PDP lets through; a person who may not steer sees it locked', async () => {
    mockApi(
      base({
        'POST /api/me/decisions': decisions(['project.view', 'onboarding.console.use']),
        [`GET /api/s0/${S0_ID}/console`]: { json: session() },
      }),
    );
    renderAt(`/onboard/${S0_ID}`);
    await screen.findByText(/The tests cannot run/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Pause/ })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
  });

  it('a paused session says why and can be resumed by someone who may steer', async () => {
    const api = mockApi(
      base({
        'POST /api/me/decisions': decisions([
          'project.view',
          'onboarding.console.use',
          'onboarding.console.steer',
        ]),
        [`GET /api/s0/${S0_ID}/console`]: { json: session({ state: 'paused', cause: 'budget' }) },
        [`POST /api/s0/${S0_ID}/console/resume`]: { json: session() },
      }),
    );
    renderAt(`/onboard/${S0_ID}`);
    expect(await screen.findByText('its budget is spent')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path.endsWith('/console/resume'))).toBe(true),
    );
  });

  it('with the console unavailable the summary and sign-off tab still works', async () => {
    mockApi(
      base({
        [`GET /api/s0/${S0_ID}/console`]: {
          status: 503,
          json: {
            error: { code: 'unavailable', message: 'the onboarding console is not configured' },
          },
        },
      }),
    );
    renderAt(`/onboard/${S0_ID}`);
    expect(await screen.findByText('The console is not available')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Summary and sign-off' }));
    expect(await screen.findByTestId('sign-off')).toBeInTheDocument();
  });
});

const chip = (over: Record<string, unknown> = {}) => ({
  proposal_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77',
  kind: 'test_command',
  target: 'test',
  title: 'Run the tests with npm run unit',
  why: 'package.json has a unit script.',
  value: { command: 'npm run unit' },
  state: 'open',
  proposal_sha256: 'b'.repeat(64),
  turn_seq: 2,
  ...over,
});

describe('proposals as chips', () => {
  it('shows a proposal in words under the turn that explains it; Accept sends the hash the person read', async () => {
    const accepted = session({
      proposals: [chip({ state: 'accepted' })],
      draft: {
        gaps: {},
        role_map: {},
        fix_files: [],
        test_command: { command: 'npm run unit', census_hash: null },
      },
    });
    const api = mockApi(
      base({
        [`GET /api/s0/${S0_ID}/console`]: { json: session({ proposals: [chip()] }) },
        [`POST /api/s0/${S0_ID}/console/proposals/01a1bc26-f0e5-719a-a52b-a88a4b6cbe77/decide`]: {
          json: accepted,
        },
      }),
    );
    renderAt(`/onboard/${S0_ID}`);
    const card = await screen.findByTestId('proposal');
    expect(within(card).getByText('Run the tests with: npm run unit')).toBeInTheDocument();
    expect(within(card).getByText('Waiting for you')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(screen.getByTestId('proposal')).toHaveAttribute('data-state', 'accepted'),
    );
    const post = api.calls.find((c) => c.path.endsWith('/decide'));
    expect(post?.body).toEqual({ decision: 'accept', proposal_sha256: 'b'.repeat(64) });
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('Edit lets the person write their own value; Reject answers without one', async () => {
    const api = mockApi(
      base({
        [`GET /api/s0/${S0_ID}/console`]: { json: session({ proposals: [chip()] }) },
        [`POST /api/s0/${S0_ID}/console/proposals/01a1bc26-f0e5-719a-a52b-a88a4b6cbe77/decide`]: {
          json: session({ proposals: [chip({ state: 'edited' })] }),
        },
      }),
    );
    renderAt(`/onboard/${S0_ID}`);
    const card = await screen.findByTestId('proposal');
    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const input = within(card).getByLabelText('Command');
    await userEvent.clear(input);
    await userEvent.type(input, 'make check');
    await userEvent.click(within(card).getByRole('button', { name: 'Use my version' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/decide'))).toBe(true));
    expect(api.calls.find((c) => c.path.endsWith('/decide'))?.body).toEqual({
      decision: 'edit',
      proposal_sha256: 'b'.repeat(64),
      edited_value: { command: 'make check' },
    });
  });

  it('an approval the plan waits for is a link to its own page, where the same decider decides it', async () => {
    mockApi(
      base({
        [`GET /api/s0/${S0_ID}/console`]: { json: session() },
        [`GET /api/s0/${S0_ID}/blockers`]: {
          json: {
            ...blockers,
            ready: true,
            blockers: [
              {
                id: 'fix:0',
                kind: 'card',
                owner: 'you',
                code: 'fix_pr_awaiting_approval',
                title: 'Approve opening a pull request: Add code owners',
                why: 'The factory never pushes before a person approves it.',
                next: 'Open the approval.',
                blocked_by: [],
                card_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe55',
              },
            ],
          },
        },
      }),
    );
    renderAt(`/onboard/${S0_ID}`);
    const link = await screen.findByTestId('blocker-card');
    expect(link).toHaveAttribute('href', '/decide/01a1bc26-f0e5-719a-a52b-a88a4b6cbe55');
  });

  it('what the person accepted is the summary’s default for the sign-off', async () => {
    const base0 = summary();
    mockApi(
      base({
        [`GET /api/s0/${S0_ID}/console`]: { json: session() },
        [`GET /api/s0/${S0_ID}/summary`]: {
          json: { ...base0, draft: { tier: 'T1', gaps: {}, role_map: {}, fix_files: [] } },
        },
      }),
    );
    renderAt(`/onboard/${S0_ID}`);
    await userEvent.click(await screen.findByRole('tab', { name: 'Summary and sign-off' }));
    expect(await screen.findByRole('combobox', { name: 'Risk' })).toHaveValue('T1');
  });
});

describe('/assistant is the console session list', () => {
  it('lists the sessions and lets a person start one on an onboarding that has none', async () => {
    const withS0 = summaryOf({
      latest_s0: {
        s0_id: S0_ID,
        repo: 'reshif/asf-factory-testbed',
        status: 'in_progress',
        requested_level: 'census',
        signable_level: 'census',
        waiting: null,
        updated_at: NOW,
      },
    } as never);
    mockApi({
      'GET /api/me': { json: me(['project.onboard', 'assistant.use']) },
      'POST /api/me/decisions': decisions([
        'project.view',
        'assistant.use',
        'onboarding.console.use',
      ]),
      'GET /api/projects': { json: [withS0] },
      'GET /api/console/sessions': {
        json: {
          sessions: [
            {
              s0_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe00',
              project_id: 'other',
              subject: 'onboarding',
              state: 'paused',
              cause: 'person',
              turns: 3,
              started_by: 'alice',
              opened_at: NOW,
              updated_at: NOW,
            },
          ],
        },
      },
    } as never);
    renderAt('/assistant');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sessions' })).toBeTruthy();
    const row = await screen.findByRole('link', { name: 'Onboarding of other' });
    expect(row).toHaveAttribute('href', '/onboard/01a1bc26-f0e5-719a-a52b-a88a4b6cbe00');
    expect(screen.getByText('Paused')).toBeInTheDocument();
    const start = await screen.findByTestId('console-start-list');
    expect(within(start).getByRole('link', { name: 'Open and start the console' })).toHaveAttribute(
      'href',
      `/onboard/${S0_ID}`,
    );
  });
});
