import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt, type Call } from './helpers';

// PLAN M19: Govern › Audit over the audit service. Exports are listed with their anchor and a download of the signed
// file, and written from a form; erasure and legal holds are guarded by the action the server decides them under
// (`identity.admin` on the fleet: a factory admin's), so an auditor sees them locked; the retention classes are read
// from the published config with a link to change them there.

const T = '2026-11-12T10:00:00.000Z';
const EXPORT = {
  export_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a90',
  scope: { kind: 'project', project_id: 'acme' },
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-11-13T00:00:00.000Z',
  reason: 'SOC 2',
  requested_by: 'alice',
  export_sha256: 'a'.repeat(64),
  bucket: 'audit-exports',
  object_key: 'b'.repeat(64),
  size: 10,
  key_id: 'dev:notary',
  checkpoint_seq: 3,
  covered_to: 40,
  entries: 7,
  events: 21,
  uncovered: 2,
  produced_at: T,
  entry_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a91',
  entry_seq: 41,
};
const ERASURE = {
  erasure_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a93',
  basis: 'request',
  subject: { principal_id: 'vic', project_id: 'acme' },
  state: 'requested',
  reason: 'SAR-9',
  requested_by: 'fran',
  requested_at: T,
  approved_by: null,
  approved_at: null,
  matter_ref: null,
  entry_seq: null,
  targets: [
    {
      kind: 'conversation_payload',
      payload_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a94',
      thread_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a95',
      owner: 'vic',
      project_id: 'acme',
      sha256: 'c'.repeat(64),
      erased: false,
    },
  ],
  blocked_by: [],
  rejected_by: null,
  executed_at: null,
};
const HOLD = {
  hold_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a92',
  scope: { kind: 'principal', principal_id: 'vic' },
  matter_ref: 'LA-3',
  reason: 'litigation',
  state: 'active',
  placed_by: 'root',
  placed_at: T,
  place_entry_seq: 30,
  released_by: null,
  released_at: null,
  release_reason: null,
  release_entry_seq: null,
};

/** The PDP's capability probes: `identity.admin` only when `admin`. */
const decide = (admin: boolean) => (c: Call) => ({
  json: {
    decisions: (
      (c.body as { queries?: Array<{ action: string; resource: unknown }> }).queries ?? []
    ).map((q) => ({
      ...q,
      allow: q.action === 'audit.read' || (admin && q.action === 'identity.admin'),
      reasons: [],
    })),
  },
});

const EMPTY_LOG = { json: { entries: [], head: null, next_before: null } };
/** What the Decision log & audit page reads besides the panels (portal v2). */
const LOG = {
  'GET /api/audit/ledger?filter=all': EMPTY_LOG,
  'GET /api/audit/ledger?filter=deletions': EMPTY_LOG,
  'GET /api/people': { json: { people: [] } },
};

describe('govern: audit (M19)', () => {
  it('lists the signed exports with their anchor and download, and writes one from the form', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'POST /api/me/decisions': decide(false),
      'GET /api/audit/exports': { json: { exports: [EXPORT] } },
      'POST /api/audit/exports': { status: 201, json: { ...EXPORT, entry_seq: 42 } },
    });
    renderAt('/audit?tab=exports');
    const t = await screen.findByRole('table', { name: 'Signed exports' });
    const row = within(t).getAllByRole('row')[1] as HTMLElement;
    expect(row).toHaveTextContent('project acme');
    expect(row).toHaveTextContent('checkpoint 3 (1..40), 2 after it');
    expect(within(row).getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      `/api/audit/exports/${EXPORT.export_id}/signed`,
    );
    const form = await screen.findByRole('form', { name: 'Request an export' });
    await user.type(within(form).getByLabelText('Project'), 'acme');
    await user.type(within(form).getByLabelText('Why'), 'SOC 2 sample');
    await user.click(within(form).getByRole('button', { name: 'Write the export' }));
    expect(await screen.findByText(/on the ledger at #42/)).toBeInTheDocument();
    const post = m.calls.find((c) => c.method === 'POST' && c.path === '/api/audit/exports');
    expect(post?.body).toMatchObject({
      scope: { kind: 'project', project_id: 'acme' },
      reason: 'SOC 2 sample',
    });
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('an auditor sees erasure and holds locked; a factory admin approves an erasure under a matter reference', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'POST /api/me/decisions': decide(false),
      'GET /api/audit/exports': { json: { exports: [] } },
      ...LOG,
      'GET /api/audit/erasures': { json: { erasures: [ERASURE] } },
      'GET /api/audit/holds': { json: { holds: [HOLD] } },
    });
    const view = renderAt('/audit');
    await user.click(await screen.findByRole('tab', { name: 'Deletions' }));
    await screen.findByRole('table', { name: 'Erasure requests' });
    expect(await screen.findByRole('button', { name: /Request the erasure/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByRole('button', { name: 'Approve and erase' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Legal holds' }));
    const holds = await screen.findByRole('table', { name: 'Legal holds' });
    expect(within(holds).getAllByRole('row')[1]).toHaveTextContent('principal vic');
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    view.unmount();

    const m = mockApi({
      'GET /api/me': { json: me(['audit.read', 'identity.admin']) },
      'POST /api/me/decisions': decide(true),
      'GET /api/audit/exports': { json: { exports: [] } },
      ...LOG,
      'GET /api/audit/erasures': { json: { erasures: [ERASURE] } },
      [`POST /api/audit/erasures/${ERASURE.erasure_id}/approve`]: {
        json: {
          ...ERASURE,
          state: 'executed',
          approved_by: 'alice',
          matter_ref: 'LA-2',
          entry_seq: 50,
        },
      },
    });
    renderAt('/audit');
    await user.click(await screen.findByRole('tab', { name: 'Deletions' }));
    const approve = await screen.findByRole('button', { name: 'Approve and erase' });
    await user.type(
      screen.getByLabelText(`Matter reference for erasure ${ERASURE.erasure_id}`),
      'LA-2',
    );
    await user.type(
      screen.getByLabelText(`Reason for erasure ${ERASURE.erasure_id}`),
      'counsel ok',
    );
    await user.click(approve);
    await waitFor(() =>
      expect(
        m.calls.some((c) => c.path === `/api/audit/erasures/${ERASURE.erasure_id}/approve`),
      ).toBe(true),
    );
    const call = m.calls.find(
      (c) => c.path === `/api/audit/erasures/${ERASURE.erasure_id}/approve`,
    );
    expect(call?.body).toEqual({ matter_ref: 'LA-2', reason: 'counsel ok' });
  });

  it('shows a refusal from the server where the person acted (a hold blocks the erasure)', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me(['audit.read', 'identity.admin']) },
      'POST /api/me/decisions': decide(true),
      'GET /api/audit/exports': { json: { exports: [] } },
      ...LOG,
      'GET /api/audit/erasures': { json: { erasures: [ERASURE] } },
      [`POST /api/audit/erasures/${ERASURE.erasure_id}/approve`]: {
        status: 409,
        json: { error: { code: 'legal_hold', message: 'a legal hold covers the subject' } },
      },
    });
    renderAt('/audit');
    await user.click(await screen.findByRole('tab', { name: 'Deletions' }));
    await user.type(
      await screen.findByLabelText(`Matter reference for erasure ${ERASURE.erasure_id}`),
      'LA-2',
    );
    await user.type(screen.getByLabelText(`Reason for erasure ${ERASURE.erasure_id}`), 'ok');
    await user.click(screen.getByRole('button', { name: 'Approve and erase' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/legal hold/);
  });

  it('retention: the classes in force from the published config, with the way to change them', async () => {
    mockApi({
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/audit/exports': { json: { exports: [] } },
      ...LOG,
      'GET /api/audit/retention': {
        json: {
          config: { classes: { conversation_payload: { days: 365 } } },
          rev_hash: 'd'.repeat(64),
          last_sweeps: [
            {
              class: 'conversation_payload',
              days: 365,
              rev_hash: null,
              due: 4,
              held: 1,
              erasure_id: null,
              at: T,
            },
          ],
        },
      },
    });
    renderAt('/audit?tab=retention');
    expect(await screen.findByText('365 days, then erased by the sweep')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change them in Settings' })).toHaveAttribute(
      'href',
      '/config/audit.retention',
    );
    const sweeps = screen.getByRole('table', { name: 'Retention sweeps' });
    expect(within(sweeps).getAllByRole('row')[1]).toHaveTextContent('4');
  });
});
