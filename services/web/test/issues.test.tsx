import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt, type Call } from './helpers';

// PLAN M16: the GitHub issue twin screen (design reference `issues`). Twins with their sync state, the approved
// batches with the bodies hash, the security gaps that are never filed, and the "Propose a batch" form. The buttons
// follow the access layer's answers (config.propose, work.request); the bff and core decide every write.

const PATH = '/api/projects/acme/issue-twin';
const GAP_A = 'gap:acme.web:RS-DX-3:.';
const GAP_B = 'gap:acme.web:RS-DOC-2:.';
const GAP_C = 'gap:acme.web:RS-TH-4:.';
const SHA = '3f9c2ab'.padEnd(40, '0');

const twin = (o: Record<string, unknown>) => ({
  gap_id: GAP_A,
  criterion: 'RS-DX-3',
  severity: 'tracked',
  title: '[onboarding] .env.example (RS-DX-3)',
  number: 431,
  state: 'open',
  via: 'created',
  recheck: null,
  batch_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe22',
  request: null,
  ...o,
});

const view = (over: Record<string, unknown> = {}) => ({
  project_id: 'acme',
  may: { propose: true, request: true },
  repos: [
    {
      repo: 'acme/web',
      visibility: 'public',
      prr_version: 1,
      twins: [
        twin({}),
        twin({
          gap_id: GAP_B,
          criterion: 'RS-DOC-2',
          title: '[onboarding] CONTRIBUTING.md (RS-DOC-2)',
          number: 432,
          state: 'closed_verified',
          recheck: { result: 'pass', sha: SHA },
        }),
        twin({
          gap_id: GAP_C,
          criterion: 'RS-TH-4',
          title: '[onboarding] Flaky test list (RS-TH-4)',
          number: 433,
          state: 'closed_unverified',
        }),
      ],
      private_only: [{ gap_id: 'gap:acme.web:RS-SEC:.', criterion: 'RS-SEC' }],
      batches: [
        {
          batch_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe22',
          approved_by: 'alice',
          approved_at: '2026-11-08T10:00:00.000Z',
          filed: 3,
          tracked: 1,
          bodies_hash: 'ab'.repeat(32),
          ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe44',
        },
      ],
      candidates: [
        {
          gap_id: 'gap:acme.web:RS-DX-5:.',
          criterion: 'RS-DX-5',
          severity: 'blocking',
          visibility_class: 'public_safe',
          title: '[onboarding] Devcontainer (RS-DX-5)',
          disclosure: 'pass',
          default: 'file_issue',
          allowed: ['file_issue', 'track_only'],
        },
        {
          gap_id: 'gap:acme.web:RS-DOC-4:.',
          criterion: 'RS-DOC-4',
          severity: 'tracked',
          visibility_class: 'public_safe',
          title: '[onboarding] ADR seed (RS-DOC-4)',
          disclosure: 'pass',
          default: 'track_only',
          allowed: ['file_issue', 'track_only'],
        },
      ],
      polled_at: '2026-11-08T10:05:00.000Z',
      ...over,
    },
  ],
});

/** The access layer's answers: allow the listed actions on the project, deny the rest. */
const allow =
  (...actions: string[]) =>
  (c: Call) => ({
    json: {
      decisions: (
        (c.body as { queries: Array<{ action: string; resource: unknown }> }).queries ?? []
      ).map((q) =>
        actions.includes(q.action)
          ? { ...q, allow: true, reasons: [] }
          : { ...q, allow: false, reasons: ['no_policy_permits'] },
      ),
    },
  });

describe('the issue twin screen', () => {
  it('shows the twins with their sync state, the batches, and the security gaps that are never filed', async () => {
    mockApi({ 'GET /api/me': { json: me() }, [`GET ${PATH}`]: { json: view() } });
    renderAt('/projects/acme/issues');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'GitHub issue twin' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('twin-state-RS-DX-3')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('twin-state-RS-DOC-2')).toHaveTextContent('verified at 3f9c2ab');
    expect(screen.getByTestId('twin-state-RS-TH-4')).toHaveTextContent(/gap stays open/);
    expect(screen.getByText(`<!-- asf-gap: ${GAP_A} v1 -->`)).toBeInTheDocument();
    const stats = screen.getByRole('list', { name: 'Twins of acme/web' });
    expect(within(stats).getByText('Never filed').parentElement).toHaveTextContent('1');
    expect(screen.getByRole('list', { name: 'Security gaps never filed' })).toHaveTextContent(
      'RS-SEC',
    );
    expect(screen.getByText('abababababab'.slice(0, 10))).toBeInTheDocument();
  });

  it('proposes a batch with the per-row choices; the body is exactly the rows chosen', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allow('config.propose', 'work.request'),
      [`GET ${PATH}`]: { json: view() },
      [`POST ${PATH}/batches`]: {
        status: 201,
        json: {
          batch_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe55',
          filed: 1,
          tracked: 1,
          bodies_hash: 'cd'.repeat(32),
          ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe66',
        },
      },
    });
    renderAt('/projects/acme/issues');
    await user.click(await screen.findByRole('button', { name: 'Propose a batch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Propose a batch' });
    expect(within(dialog).getByLabelText('What to do with RS-DX-5')).toHaveValue('file_issue');
    await user.selectOptions(
      within(dialog).getByLabelText('What to do with RS-DOC-4'),
      'track_only',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Approve batch' }));
    await waitFor(() => expect(m.calls.some((c) => c.path === `${PATH}/batches`)).toBe(true));
    const sent = m.calls.find((c) => c.path === `${PATH}/batches`);
    expect(sent?.body).toEqual({
      repo: 'acme/web',
      rows: [
        { gap_id: 'gap:acme.web:RS-DX-5:.', disposition: 'file_issue' },
        { gap_id: 'gap:acme.web:RS-DOC-4:.', disposition: 'track_only' },
      ],
    });
    expect(sent?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    expect(await screen.findByText(/Batch approved: 1 issue will be filed/)).toBeInTheDocument();
  });

  it('turns an open twin into a request; without the actions the buttons are locked or absent', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allow('work.request'),
      [`GET ${PATH}`]: { json: view() },
      [`POST ${PATH}/requests`]: {
        status: 201,
        json: {
          request_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77',
          item_id: null,
          duplicate: false,
          injection_suspected: false,
        },
      },
    });
    renderAt('/projects/acme/issues');
    // config.propose is denied: the batch button is locked, with the reason
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Propose a batch' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    // a verified twin offers no request; the open and the unverified ones do
    const buttons = await screen.findAllByRole('button', { name: 'Make a request' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(m.calls.some((c) => c.path === `${PATH}/requests`)).toBe(true));
    expect(m.calls.find((c) => c.path === `${PATH}/requests`)?.body).toEqual({
      repo: 'acme/web',
      gap_id: GAP_A,
    });
    expect(await screen.findByText(/Remediation request made/)).toBeInTheDocument();
  });

  it('a project the person may not see is the one 404', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: { status: 404, json: { error: { code: 'not_found', message: 'no' } } },
    });
    renderAt('/projects/acme/issues');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('a repo with no readiness record offers nothing to file', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allow('config.propose'),
      [`GET ${PATH}`]: {
        json: view({ prr_version: null, twins: [], candidates: [], batches: [], private_only: [] }),
      },
    });
    renderAt('/projects/acme/issues');
    expect(await screen.findByText('No readiness record governs this repo')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose a batch' })).toBeNull();
  });
});
