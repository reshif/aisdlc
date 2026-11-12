import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt, type Call } from './helpers';

// PLAN M16 after onboarding (OB §4.2, §8; DEC-21; the design reference's project "Drift" tab): the banner, the drift
// page (findings, served files, the one-click restore with the bypass re-attestation, level-up and re-sign, history)
// and the re-affirm card with its step-up. The buttons follow the access layer; the bff and core decide every write.

const PATH = '/api/projects/acme/drift';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const HASH = 'c'.repeat(64);

const repo = (o: Record<string, unknown> = {}) => ({
  repo: 'acme/web',
  prr: {
    version: 1,
    status: 'suspended',
    level: 'light',
    fresh_until: '2027-02-07T10:00:00.000Z',
    expired: false,
  },
  head_sha: '3f9c2ab'.padEnd(40, '0'),
  files_polled_at: '2026-11-12T10:00:00.000Z',
  rules_polled_at: '2026-11-12T10:00:00.000Z',
  findings: [
    {
      kind: 'protect_main',
      effect: 'suspend',
      subject: 'main',
      reasons: ['gate_check_not_pinned'],
      expected: null,
      observed: null,
    },
    {
      kind: 'instruction_text',
      effect: 'reaffirm',
      subject: 'AGENTS.md',
      reasons: ['file_changed'],
      expected: SHA_A,
      observed: SHA_B,
    },
  ],
  files: [{ path: 'AGENTS.md', state: 'drift', served_sha256: SHA_A, observed_sha256: SHA_B }],
  suspension: { at: '2026-11-12T10:00:00.000Z', findings: [] },
  restore: { ready: true, why_not: null, bypass: { logins: ['carol'], list_hash: HASH } },
  level_up: ['full'],
  security: null,
  krl: {
    signed: 2,
    current: 1,
    effective_signed: 'A1',
    effective_now: 'A0',
    lowered: [
      {
        area: '*',
        path: 'AGENTS.md',
        at: '2026-11-12T10:00:00.000Z',
        ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe45',
      },
    ],
  },
  history: [
    {
      at: '2026-11-12T10:00:00.000Z',
      type: 'suspended',
      summary: 'record suspended: agent lanes closed, new items go L8',
      by: null,
      ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe44',
    },
  ],
  ...o,
});
const view = (r = repo()) => ({
  project_id: 'acme',
  repos: [r],
  may: { restore: true, reaffirm: true, recheck: true, request_version: true },
});

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

describe('the drift page', () => {
  it('shows the suspension banner, what drifted and what the factory serves; restore needs both attestations', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allow('project.settings.edit', 'config.propose', 'project.onboard'),
      [`GET ${PATH}`]: { json: view() },
      [`POST ${PATH}/restore`]: {
        status: 201,
        json: {
          prr_version: 1,
          status: 'active',
          ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe55',
        },
      },
    });
    renderAt('/projects/acme/drift');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Drift and readiness' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('drift-banner-suspended')).toHaveTextContent(
      /Agent lanes are suspended/,
    );
    expect(screen.getByTestId('prr-status')).toHaveAttribute('data-status', 'suspended');
    expect(screen.getByTestId('file-state-AGENTS.md')).toHaveAttribute('data-state', 'drift');
    // OB §4.2: the drifted AGENTS.md lowered KRL by one, and the autonomy with it, until it is re-affirmed
    const krl = screen.getByTestId('krl');
    expect(krl).toHaveAttribute('data-krl', '1');
    expect(krl).toHaveTextContent(/KRL 1 \(signed 2\)/);
    expect(krl).toHaveTextContent(/autonomy A0 \(signed A1\)/);
    const findings = screen.getByRole('table', { name: 'What drifted in acme/web' });
    expect(within(findings).getByText('suspends the record')).toBeInTheDocument();
    expect(within(findings).getByRole('link', { name: 'Open the re-affirm card' })).toHaveAttribute(
      'href',
      '/projects/acme/reaffirm/acme%2Fweb/AGENTS.md',
    );
    const restore = await screen.findByRole('button', { name: 'Restore' });
    await waitFor(() => expect(restore).toBeDisabled());
    await user.click(screen.getByLabelText(/exactly @carol/));
    expect(restore).toBeDisabled();
    await user.click(screen.getByLabelText(/No App/));
    expect(restore).toBeEnabled();
    await user.click(restore);
    await waitFor(() => expect(m.calls.some((c) => c.path === `${PATH}/restore`)).toBe(true));
    const sent = m.calls.find((c) => c.path === `${PATH}/restore`);
    expect(sent?.body).toEqual({
      repo: 'acme/web',
      bypass: { logins: ['carol'], list_hash: HASH },
      attestation: { bypass_matches_list: true, bypass_has_no_app: true },
    });
    expect(sent?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('a restore that cannot go ahead says why and stays disabled; without the action it is locked', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${PATH}`]: {
        json: view(
          repo({
            restore: {
              ready: false,
              why_not: 'still loosened: protect_main main',
              bypass: { logins: [], list_hash: HASH },
            },
          }),
        ),
      },
    });
    renderAt('/projects/acme/drift');
    expect(await screen.findByTestId('restore-why-not')).toHaveTextContent('still loosened');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Restore' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    expect(screen.getByText('Nobody: an unchecked merge here is unauthorised')).toBeInTheDocument();
  });

  it('a security event (OB §8): the work is held; the security card confirms the installation shown by its hash', async () => {
    const user = userEvent.setup();
    const IHASH = 'e'.repeat(64);
    const m = mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allow('project.settings.edit', 'config.propose'),
      [`GET ${PATH}`]: {
        json: view(
          repo({
            prr: { ...repo().prr, status: 'active' },
            findings: [
              {
                kind: 'installation',
                effect: 'security',
                subject: '4242',
                reasons: ['selection_widened'],
                expected: SHA_A,
                observed: IHASH,
              },
            ],
            security: {
              held: true,
              installation: {
                observed: {
                  installation_id: 4242,
                  repository_selection: 'all',
                  permissions: { contents: 'read', metadata: 'read' },
                },
                hash: IHASH,
                widened: true,
              },
              new_findings: 1,
            },
          }),
        ),
      },
      [`POST ${PATH}/security/confirm`]: {
        status: 201,
        json: { installation_hash: IHASH, ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77' },
      },
    });
    renderAt('/projects/acme/drift');
    const card = await screen.findByTestId('drift-security');
    expect(card).toHaveTextContent(/Agent work is held/);
    expect(card).toHaveTextContent(/Repositories\s*all/);
    expect(screen.getByTestId('drift-security-secrets')).toHaveTextContent(/1 open secret finding/);
    const findings = screen.getByRole('table', { name: 'What drifted in acme/web' });
    expect(within(findings).getByText('holds agent work')).toBeInTheDocument();
    const btn = await within(card).findByRole('button', { name: 'Confirm the installation' });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    await waitFor(() =>
      expect(m.calls.some((c) => c.path === `${PATH}/security/confirm`)).toBe(true),
    );
    expect(m.calls.find((c) => c.path === `${PATH}/security/confirm`)?.body).toEqual({
      repo: 'acme/web',
      installation_hash: IHASH,
    });
  });

  it('an expired record offers the re-sign at its level, not a restore', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allow('project.onboard'),
      [`GET ${PATH}`]: {
        json: view(
          repo({
            prr: {
              version: 1,
              status: 'expired',
              level: 'light',
              fresh_until: '2026-11-01T10:00:00.000Z',
              expired: true,
            },
            findings: [],
            files: [],
            suspension: null,
            level_up: [],
          }),
        ),
      },
      'POST /api/projects/acme/onboarding-versions': {
        status: 201,
        json: {
          s0_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe66',
          level: 'light',
          reason: 're_sign',
          duplicate: false,
        },
      },
    });
    renderAt('/projects/acme/drift');
    expect(await screen.findByTestId('drift-banner-expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: /Re-sign at Light/ }));
    await waitFor(() =>
      expect(
        m.calls.find((c) => c.path === '/api/projects/acme/onboarding-versions')?.body,
      ).toEqual({
        repo: 'acme/web',
        reason: 're_sign',
        level: 'light',
      }),
    );
  });
});

describe('the re-affirm card', () => {
  const card = (o: Record<string, unknown> = {}) => ({
    repo: 'acme/web',
    path: 'AGENTS.md',
    head_sha: '3f9c2ab'.padEnd(40, '0'),
    affirmed_sha256: SHA_A,
    affirmed_text: '# Agents\n',
    repo_sha256: SHA_B,
    repo_text: '# Agents\n\nUse pnpm.\n',
    lint: [],
    secret_hit: false,
    bound_hash: SHA_B,
    why_not: null,
    ...o,
  });
  const CARD = `/api/projects/acme/drift/reaffirm?repo=acme%2Fweb&path=AGENTS.md`;

  it('shows both texts; the step-up is bound to the text hash; the re-affirmation sends the proof', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allow('project.settings.edit'),
      [`GET ${CARD}`]: { json: card() },
      'POST /api/step-up': {
        json: { status: 'ready', method: 'confirm', proof: 'proof-1', bound_hash: SHA_B },
      },
      [`POST ${PATH}/reaffirm`]: {
        status: 201,
        json: {
          path: 'AGENTS.md',
          text_sha256: SHA_B,
          ledger_entry_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe77',
        },
      },
    });
    renderAt('/projects/acme/reaffirm/acme%2Fweb/AGENTS.md');
    expect(await screen.findByLabelText('Affirmed text')).toHaveTextContent('# Agents');
    expect(screen.getByLabelText('Text in git')).toHaveTextContent('Use pnpm.');
    await user.click(await screen.findByRole('button', { name: 'Confirm your identity' }));
    expect(m.calls.find((c) => c.path === '/api/step-up')?.body).toMatchObject({
      subject_hash: SHA_B,
    });
    await user.click(await screen.findByRole('button', { name: 'Re-affirm (with the step-up)' }));
    await waitFor(() =>
      expect(m.calls.find((c) => c.path === `${PATH}/reaffirm`)?.body).toEqual({
        repo: 'acme/web',
        path: 'AGENTS.md',
        text_sha256: SHA_B,
        step_up: { proof: 'proof-1' },
      }),
    );
    expect(await screen.findByText(/Re-affirmed\./)).toBeInTheDocument();
  });

  it('a text the secret ruleset hit is not shown and cannot be affirmed', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'POST /api/me/decisions': allow('project.settings.edit'),
      [`GET ${CARD}`]: {
        json: card({
          repo_text: null,
          secret_hit: true,
          bound_hash: null,
          why_not: 'the shared secret ruleset hit the text',
        }),
      },
    });
    renderAt('/projects/acme/reaffirm/acme%2Fweb/AGENTS.md');
    expect(await screen.findByText(/it is not shown and cannot be affirmed/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Text in git')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm your identity' })).toBeNull();
  });
});

describe('the inbox lists the after-onboarding items and the pack X2', () => {
  it('a restore, a re-affirmation and the X2 card each link where they are decided', async () => {
    const item = (o: Record<string, unknown>) => ({
      kind: 'onboarding_card',
      id: 'acme/web',
      project_id: 'acme',
      s0_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe54',
      label: null,
      slot: 'admin',
      opened_at: '2026-11-12T10:00:00.000Z',
      sla_due_at: null,
      overdue: false,
      escalated: false,
      holders: ['alice'],
      may_decide: true,
      deciders: [{ principal_id: 'alice', display_name: 'Alice Admin' }],
      ...o,
    });
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/inbox': {
        json: {
          decide: [
            item({ kind: 'prr_restore' }),
            item({ kind: 'drift_reaffirm' }),
            item({
              id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe99',
              label: 'X2',
              slot: 'x',
              sla_due_at: '2026-11-13T10:00:00.000Z',
            }),
          ],
          view: [],
        },
      },
    });
    renderAt('/inbox');
    expect(
      await screen.findByRole('link', { name: 'Restore a suspended readiness record: acme/web' }),
    ).toHaveAttribute('href', '/projects/acme/drift');
    expect(
      screen.getByRole('link', { name: 'Re-affirm changed instruction text: acme/web' }),
    ).toHaveAttribute('href', '/projects/acme/drift');
    expect(screen.getByRole('link', { name: 'X2: the onboarding pack PR' })).toHaveAttribute(
      'href',
      '/cards/01a1bc26-f0e5-719a-a52b-a88a4b6cbe99',
    );
  });
});
