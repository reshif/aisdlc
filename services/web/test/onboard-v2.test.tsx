import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OnboardingSummaryView } from '@aisdlc/contracts';
import { summary } from './onboardFixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S0_ID, me, mockApi, projectOf, renderAt, repoOf } from './helpers';

// Portal v2 agent-led onboarding (screen-map §2.10) and the projects screens (§2.7, §2.9): the picker, the one
// summary with the agent's findings and fix PRs, the one sign-off (with "confirm it's you" for the scorecard), the
// denied and empty states and the phone layout.

const H = 'a'.repeat(64);

const project = { project: projectOf(), repos: [repoOf()], s0: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Onboard a repo: pick (step 1)', () => {
  it('lists the repos the App can see; a project’s repo cannot be chosen; start goes to the onboarding', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me(['project.onboard']) },
      'GET /api/onboard/repos': {
        json: {
          repos: [
            {
              full_name: 'reshif/held',
              default_branch: 'main',
              private: false,
              archived: false,
              registered: true,
            },
            {
              full_name: 'reshif/new-one',
              default_branch: 'main',
              private: true,
              archived: false,
              registered: false,
            },
          ],
        },
      },
      'POST /api/onboard': { status: 201, json: { s0_id: S0_ID, duplicate: false } },
      [`GET /api/s0/${S0_ID}/summary`]: {
        json: summary({
          sign_off: {
            state: 'not_ready',
            note: null,
            may_sign: true,
            step_up: null,
            started_by: null,
          },
          agent: null,
        }),
      },
      [`GET /api/assistant/threads?s0=${S0_ID}`]: { json: { threads: [] } },
      'GET /api/assistant/budget': { json: { used_tokens: 0, limit_tokens: 1, exhausted: false } },
    });
    renderAt('/onboard');
    expect(await screen.findByRole('radio', { name: /reshif\/held/ })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /reshif\/new-one/ }));
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('new-one');
    await user.click(screen.getByRole('button', { name: 'Start onboarding' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/onboard/${S0_ID}`));
    const post = m.calls.find((c) => c.method === 'POST' && c.path === '/api/onboard');
    expect(post?.body).toEqual({ project_id: 'new-one', repo: 'reshif/new-one', level: 'census' });
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    expect(await screen.findByTestId('agent-working')).toBeInTheDocument();
  });

  it('empty: no repo visible says to install the App; a person without the right is told before trying', async () => {
    mockApi({ 'GET /api/me': { json: me([]) }, 'GET /api/onboard/repos': { json: { repos: [] } } });
    renderAt('/onboard');
    expect(await screen.findByText('No repos visible')).toBeInTheDocument();
    expect(screen.getByTestId('may-not-onboard')).toBeInTheDocument();
  });
});

describe('Onboard a repo: the summary and the one sign-off', () => {
  const routes = (s: OnboardingSummaryView, extra: Record<string, unknown> = {}) => ({
    'GET /api/me': { json: me(['project.onboard']) },
    [`GET /api/s0/${S0_ID}/summary`]: { json: s },
    [`GET /api/assistant/threads?s0=${S0_ID}`]: { json: { threads: [] } },
    'GET /api/assistant/budget': { json: { used_tokens: 0, limit_tokens: 1, exhausted: false } },
    ...extra,
  });

  it('shows what the agent learned, the fix PRs and their state, and what a person must do; the factory never merges', async () => {
    mockApi(routes(summary()) as never);
    renderAt(`/onboard/${S0_ID}`);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Onboarding of reshif/asf-factory-testbed',
      }),
    ).toBeInTheDocument();
    const fixes = screen.getByTestId('fixes');
    expect(within(fixes).getByRole('link', { name: 'Pull request #7 on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/reshif/asf-factory-testbed/pull/7',
    );
    expect(within(fixes).getByText('PR open')).toBeInTheDocument();
    expect(within(fixes).getByText('Do it on GitHub')).toBeInTheDocument();
    expect(within(fixes).getByText('The factory never merges a PR.')).toBeInTheDocument();
    expect(screen.getByTestId('person-must')).toHaveTextContent('Protect main on GitHub.');
    // no code is shown as a label
    expect(document.body.textContent).not.toMatch(/\b(C1|C4|C5|LF2|S0|M4)\b/);
  });

  it('signs once with the adjusted content and the summary hash; then confirms it is you for the scorecard', async () => {
    const user = userEvent.setup();
    let state = summary();
    const m = mockApi(
      routes(state, {
        [`GET /api/s0/${S0_ID}/summary`]: () => ({ json: state }),
        [`POST /api/s0/${S0_ID}/sign-off`]: () => {
          state = summary({
            sign_off: {
              state: 'needs_step_up',
              note: 'Confirm it’s you to sign the readiness scorecard.',
              may_sign: true,
              step_up: { bound_hash: 'b'.repeat(64) as never, card: 'C5' },
              started_by: 'alice',
            },
          });
          return {
            json: {
              state: 'needs_step_up',
              note: null,
              decided: [{ card: 'C1', card_id: 'card-c1', ledger_seqs: [12] }],
              step_up: null,
            },
          };
        },
        'POST /api/step-up': {
          json: { status: 'ready', method: 'dev', proof: 'proof-1', bound_hash: 'b'.repeat(64) },
        },
      }) as never,
    );
    renderAt(`/onboard/${S0_ID}`);
    const sign = await screen.findByRole('button', { name: 'Sign off' });
    expect(sign).toBeDisabled(); // the attestations are the person's to give
    await user.click(screen.getByRole('checkbox', { name: /no production use/ }));
    for (const name of [
      /bypass list/,
      /selected repositories only/,
      /read-only/,
      /create or approve/,
      /fork pull requests/,
    ]) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    await user.selectOptions(screen.getByRole('combobox', { name: 'Secret scanning' }), 'on');
    await user.selectOptions(screen.getByRole('combobox', { name: 'GitHub plan' }), 'free');
    await user.click(screen.getByRole('button', { name: 'Sign off' }));
    await waitFor(() =>
      expect(m.calls.some((c) => c.path === `/api/s0/${S0_ID}/sign-off`)).toBe(true),
    );
    const post = m.calls.find((c) => c.path === `/api/s0/${S0_ID}/sign-off`);
    expect(post?.body).toMatchObject({
      summary_hash: H,
      c1: {
        owners: ['alice'],
        tier: 'T0',
        t0_attestation: true,
        gaps: [{ gap_id: 'g1', disposition: 'file_issue' }],
      },
      c4: { controls_report_hash: H, attestations: { secret_scanning: 'on', plan: 'free' } },
    });
    expect(post?.body).not.toHaveProperty('on_behalf_of');
    expect(await screen.findByTestId('receipt')).toHaveTextContent(
      'Owners and risk: recorded in the decision log (#12)',
    );
    await user.click(await screen.findByRole('button', { name: 'Confirm it’s you' }));
    await waitFor(() =>
      expect(m.calls.filter((c) => c.path === `/api/s0/${S0_ID}/sign-off`)).toHaveLength(2),
    );
    expect(m.calls.filter((c) => c.path === `/api/s0/${S0_ID}/sign-off`)[1]?.body).toEqual({
      step_up: { proof: 'proof-1', bound_hash: 'b'.repeat(64) },
    });
  });

  it('denied: a person who may not sign is told who can; the button stays off', async () => {
    mockApi(
      routes(
        summary({
          sign_off: {
            state: 'ready',
            note: null,
            may_sign: false,
            step_up: null,
            started_by: null,
          },
        }),
      ) as never,
    );
    renderAt(`/onboard/${S0_ID}`);
    expect(await screen.findByTestId('may-not-sign')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign off' })).toBeDisabled();
  });

  it('the factory admin may sign alone with a reason, sent as the override header', async () => {
    const user = userEvent.setup();
    const m = mockApi(
      routes(
        summary({
          sign_off: {
            state: 'ready',
            note: null,
            may_sign: false,
            step_up: null,
            started_by: null,
          },
        }),
        {
          'GET /api/me': { json: me(['project.onboard', 'project.delete']) },
          [`POST /api/s0/${S0_ID}/sign-off`]: {
            json: { state: 'in_progress', note: null, decided: [], step_up: null },
          },
        },
      ) as never,
    );
    renderAt(`/onboard/${S0_ID}`);
    await user.type(
      await screen.findByRole('textbox', { name: /Sign off as factory admin/ }),
      'owner away',
    );
    await user.click(screen.getByRole('checkbox', { name: /no production use/ }));
    for (const name of [
      /bypass list/,
      /selected repositories only/,
      /read-only/,
      /create or approve/,
      /fork pull requests/,
    ]) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    await user.selectOptions(screen.getByRole('combobox', { name: 'Secret scanning' }), 'on');
    await user.selectOptions(screen.getByRole('combobox', { name: 'GitHub plan' }), 'free');
    await user.click(screen.getByRole('button', { name: 'Sign off' }));
    await waitFor(() =>
      expect(m.calls.some((c) => c.path === `/api/s0/${S0_ID}/sign-off`)).toBe(true),
    );
    expect(
      m.calls.find((c) => c.path === `/api/s0/${S0_ID}/sign-off`)?.headers[
        'x-aisdlc-override-reason'
      ],
    ).toBe('owner%20away');
  });
});

describe('Projects and the project page', () => {
  it('empty: no projects says how to start', async () => {
    mockApi({
      'GET /api/me': { json: me(['project.onboard']) },
      'GET /api/projects': { json: [] },
    });
    renderAt('/projects');
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Onboard a repo' }).length).toBeGreaterThan(0);
  });

  it('lists projects in plain words, never a code', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/projects': {
        json: [
          {
            project: projectOf({ level: 'census', tier: 'T0' }),
            repos: [repoOf()],
            latest_s0: {
              s0_id: S0_ID,
              repo: 'reshif/asf-factory-testbed',
              status: 'done',
              requested_level: 'census',
              signable_level: 'census',
              waiting: null,
              updated_at: '2026-11-13T10:00:00.000Z',
            },
          },
        ],
      },
    });
    renderAt('/projects');
    const t = await screen.findByRole('table', { name: 'Projects' });
    expect(within(t).getByText('Read only')).toBeInTheDocument();
    expect(within(t).getByText('Low risk')).toBeInTheDocument();
    expect(t.textContent).not.toMatch(/\b(T0|census)\b/);
  });

  it('the settings tab shows the approvals each track will have from the settings in force, and the delete flow', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me(['project.delete']) },
      'GET /api/projects/testbed': { json: project },
      'GET /api/projects/testbed/prr': { json: { project_id: 'testbed', repos: [] } },
      'GET /api/catalogue': {
        json: {
          versions: [
            {
              ref: { version: '1.0.0', hash: H },
              current: true,
              pinned_items: 0,
              lanes: [
                {
                  lane: 'L4',
                  label: null,
                  enter_at: null,
                  stages: [],
                  gates: [
                    { gate: 'G2', step: '3.4', presence: 'always' },
                    { gate: 'G4', step: '8.1', presence: 'always' },
                  ],
                },
              ],
            },
          ],
        },
      },
      'GET /api/projects/testbed/config/keys/project.gating_profile': {
        json: {
          effective: {
            value: {
              gates: { g0g1: 'on', g2: 'off', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
              schedule: 'auto',
              tier_floor_applied: true,
            },
          },
        },
      },
      'GET /api/projects/testbed/config/keys/project.role_map': {
        json: { effective: { value: summary().role_map?.proposed } },
      },
      'GET /api/projects/testbed/config/keys': { json: { keys: [], may_propose: false } },
      'POST /api/deletions/preview': {
        json: {
          kind: 'repo',
          id: 'reshif.asf-factory-testbed',
          counts: {
            record_events_removed: 3,
            record_events_redacted: 1,
            ledger_entries_redacted: 2,
            read_model_rows: 4,
            objects: 0,
          },
          tables: [],
          blockers: [],
        },
      },
      'DELETE /api/repos/reshif__asf-factory-testbed': { json: {} },
    });
    renderAt('/projects/testbed?tab=settings');
    const tracks = await screen.findByTestId('track-approvals');
    await waitFor(() =>
      expect(tracks.querySelector('[data-gate="G2"]')).toHaveAttribute('data-on', 'false'),
    );
    expect(tracks.querySelector('[data-gate="G4"]')).toHaveAttribute('data-on', 'true');
    await user.click(screen.getByRole('button', { name: /repo reshif\/asf-factory-testbed/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/keeps 2 hashes/)).toBeInTheDocument();
    expect(m.calls.find((c) => c.path === '/api/deletions/preview')?.body).toEqual({
      kind: 'repo',
      id: 'reshif__asf-factory-testbed',
    });
  });

  it('a project the person may not see is the 403 page', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/projects/secret': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'no' } },
      },
      'GET /api/projects/secret/prr': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'no' } },
      },
    });
    renderAt('/projects/secret');
    expect(await screen.findByRole('alert')).toHaveAttribute('data-status', '403');
  });
});

describe('on a phone', () => {
  it('the onboarding page renders in one column at 375 px with no control without a name', async () => {
    window.innerWidth = 375;
    mockApi({
      'GET /api/me': { json: me(['project.onboard']) },
      [`GET /api/s0/${S0_ID}/summary`]: { json: summary() },
      [`GET /api/assistant/threads?s0=${S0_ID}`]: { json: { threads: [] } },
      'GET /api/assistant/budget': { json: { used_tokens: 0, limit_tokens: 1, exhausted: false } },
    });
    renderAt(`/onboard/${S0_ID}`);
    await screen.findByTestId('sign-off');
    for (const el of document.querySelectorAll('input,select,textarea')) {
      const named =
        (el as HTMLInputElement).labels?.length ||
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby');
      expect(named, el.outerHTML.slice(0, 80)).toBeTruthy();
    }
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });
});
