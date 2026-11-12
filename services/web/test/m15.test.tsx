import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';
import { SHA_A, SHA_B, T, allowOnly } from './screenFixtures';

// M15's screens: G5's release status and RELHOLD re-request, B14 on the item page, the 9.3 close-out record with
// the 9.5 audit and B17, 9.4 Learn with B19's lift, and deciding a factory configuration revision.

const ITEM = '33333333-4444-4555-8666-777777777777';
const GATE = '0193a1b2-0000-7000-8000-0000000000f1';
const SHA40 = 'c'.repeat(40);

const view = (over: Record<string, unknown> = {}) => ({
  item_id: ITEM,
  project_id: 'testbed',
  repo: 'reshif/asf-factory-testbed',
  request_id: ITEM,
  phase: 'S8b',
  lane: 'L3',
  proposed_lane: 'L3',
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
  catalogue_ref: { version: '1.3.0', hash: SHA_A },
  injection_suspected: false,
  dedupe_links: [],
  may: { ready: false, answer: false, observe: false, plan: false },
  ...over,
});
const gate = (g: string, status: string, outcome: string | null, n = 1) => ({
  gate: g,
  gate_instance_id: `${g}-${n}`,
  status,
  outcome,
});

describe('the item page: release and review', () => {
  it('RELHOLD: a turned-down G5 offers the re-request, sent with a retry key and the CSRF token', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me([]) },
      [`GET /api/items/${ITEM}`]: { json: view({ gates: [gate('G5', 'decided', 'reject')] }) },
      'POST /api/me/decisions': allowOnly('item.release'),
      [`POST /api/items/${ITEM}/release/re-request`]: {
        json: { item: view(), duplicate: false },
      },
    });
    renderAt(`/items/${ITEM}`);
    const card = await screen.findByTestId('item-release');
    expect(within(card).getByText('reject')).toBeInTheDocument();
    // the button is offered once the PDP's hint has arrived (pending is a disabled placeholder)
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: 'Re-request the release' })).toBeEnabled(),
    );
    await user.click(within(card).getByRole('button', { name: 'Re-request the release' }));
    expect(await within(card).findByText('The release is requested again.')).toBeInTheDocument();
    const call = m.calls.find((c) => c.path.endsWith('/release/re-request'));
    expect((call?.body as { key: string }).key).toMatch(/^portal-/);
    expect(call?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('B14 is offered at a pending G4 only to whom the PDP allows item.unsure; a pending G5 offers no re-request', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      [`GET /api/items/${ITEM}`]: {
        json: view({
          phase: 'G4',
          gates: [gate('G4', 'pending', null), gate('G5', 'pending', null)],
        }),
      },
    });
    renderAt(`/items/${ITEM}`);
    const unsure = await screen.findByTestId('item-unsure');
    await waitFor(() =>
      expect(within(unsure).queryByRole('button', { name: /unsure/ })).toBeNull(),
    );
    expect(
      within(screen.getByTestId('item-release')).getByText('waiting for a decision'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-request the release' })).toBeNull();
  });
});

const closeout = (audit: unknown) => ({
  closeout_sha256: SHA_B,
  record: {
    schema: 'aisdlc-closeout/1',
    item_id: ITEM,
    project_id: 'testbed',
    repo: 'reshif/asf-factory-testbed',
    lane: 'L3',
    requester: 'dn',
    catalogue: { version: '1.3.0', hash: SHA_A },
    gates: [
      { gate: 'G0', gate_instance_id: 'g0', outcome: 'approve', ledger_entry_id: 'le-1' },
      { gate: 'G4', gate_instance_id: 'g4', outcome: 'approve', ledger_entry_id: 'le-2' },
    ],
    merged_sha: SHA40,
    units: [
      {
        unit_key: 'main',
        pr_number: 7,
        head_sha: SHA40,
        merge_commit_sha: SHA40,
        pack_sha256: SHA_A,
      },
    ],
    g4: { gate_instance_id: 'g4', mode: 'E', deciders: ['ar'] },
    release_output: null,
    acceptance: { outcome: 'approve', by: 'dn' },
    break_glass: [],
    rework: { total: 1, by_edge: { B9: 1 } },
  },
  escapes: [],
  audit,
});

describe('the close-out record', () => {
  it('shows the record; a drawn mode-E merge offers the audit, and the result says what it did', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me([]) },
      [`GET /api/items/${ITEM}/closeout`]: {
        json: closeout({ sampled: true, outcome: null, audited_by: null }),
      },
      'POST /api/me/decisions': allowOnly('audit.record'),
      [`POST /api/items/${ITEM}/audit`]: { json: { sampled: 20, missed: 3, suspended: true } },
    });
    renderAt(`/items/${ITEM}/closeout`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Close-out of 33333333' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Gates of the item' })).toHaveTextContent('le-2');
    expect(screen.getByText('1 back-edge(s): B9 ×1')).toBeInTheDocument();
    const audit = screen.getByTestId('closeout-audit');
    await user.click(await within(audit).findByRole('radio', { name: /A gate miss/ }));
    await user.type(within(audit).getByRole('textbox', { name: 'Reason code' }), 'evidence_thin');
    await user.click(within(audit).getByRole('button', { name: 'Record the audit' }));
    expect(await within(audit).findByText(/mode E is now suspended/)).toBeInTheDocument();
    expect(m.calls.find((c) => c.path.endsWith('/audit'))?.body).toEqual({
      outcome: 'gate_miss',
      reason_code: 'evidence_thin',
    });
    // B17 is not offered without item.escape
    expect(
      within(screen.getByTestId('closeout-escapes')).queryByRole('button', {
        name: 'Report an escape',
      }),
    ).toBeNull();
  });

  it('a merge not in mode E is never sampled; an escape is reported as L0 or L1 with a key', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me([]) },
      [`GET /api/items/${ITEM}/closeout`]: { json: closeout(null) },
      'POST /api/me/decisions': allowOnly('item.escape'),
      [`POST /api/items/${ITEM}/escape`]: { json: { duplicate: false } },
    });
    renderAt(`/items/${ITEM}/closeout`);
    expect(await screen.findByText(/does not sample it/)).toBeInTheDocument();
    const esc = screen.getByTestId('closeout-escapes');
    await user.selectOptions(await within(esc).findByRole('combobox', { name: 'Fix it as' }), 'L0');
    await user.type(within(esc).getByRole('textbox', { name: 'Reason code' }), 'prod_defect');
    await user.click(within(esc).getByRole('button', { name: 'Report an escape' }));
    expect(await within(esc).findByText(/linked item is opened/)).toBeInTheDocument();
    const body = m.calls.find((c) => c.path.endsWith('/escape'))?.body as Record<string, string>;
    expect(body).toMatchObject({ lane: 'L0', reason_code: 'prod_defect' });
    expect(body['key']).toMatch(/^portal-/);
  });

  it('no close-out yet is the one 404', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      [`GET /api/items/${ITEM}/closeout`]: {
        status: 404,
        json: { error: { code: 'not_found', message: 'the item has no close-out record' } },
      },
    });
    renderAt(`/items/${ITEM}/closeout`);
    await waitFor(() => expect(document.querySelector('[data-status="404"]')).not.toBeNull());
  });
});

describe('9.4 Learn and B19', () => {
  const learn = (over: Record<string, unknown> = {}) => ({
    project_id: 'testbed',
    proposals: [
      {
        proposal_id: SHA_A,
        proposal: {
          project_id: 'testbed',
          kind: 'mode_e_lift',
          meta_gate: 'M5',
          signal: 'clean_since_suspension',
          evidence: [SHA_B],
          change: { kind: 'mode_e_lift' },
        },
        gate_instance_id: GATE,
        card_id: 'card-9',
        status: 'pending',
        outcome: null,
        effect: null,
        proposed_at: T,
      },
    ],
    earned_autonomy: null,
    mode_e_suspended: true,
    may_propose: true,
    ...over,
  });

  it('lists proposals with their META gate and card; a suspended mode E can be asked to lift', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/projects/testbed/learn': { json: learn() },
      'POST /api/projects/testbed/learn/mode-e-lift': {
        status: 201,
        json: { proposal_id: SHA_A, gate_instance_id: GATE, duplicate: true },
      },
    });
    renderAt('/projects/testbed/learn');
    const t = await screen.findByRole('table', { name: 'Learn proposals of testbed' });
    expect(within(t).getByRole('link', { name: 'Open the card' })).toHaveAttribute(
      'href',
      '/cards/card-9',
    );
    expect(t).toHaveTextContent('clean since mode E was suspended');
    expect(screen.getByTestId('learn-autonomy')).toHaveTextContent('suspended (B19)');
    await user.click(screen.getByRole('button', { name: 'Ask for the lift (M5)' }));
    expect(await screen.findByText(/already asked for/)).toBeInTheDocument();
    expect(m.calls.find((c) => c.path.endsWith('/mode-e-lift'))?.headers['x-csrf-token']).toBe(
      'csrf-token-of-alice',
    );
  });

  it('without learn.propose: nothing to run and no lift button', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/projects/testbed/learn': {
        json: learn({ may_propose: false, mode_e_suspended: false, proposals: [] }),
      },
    });
    renderAt('/projects/testbed/learn');
    expect(await screen.findByText('No proposal yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run 9.4 now' })).toBeNull();
    expect(screen.queryByTestId('learn-lift')).toBeNull();
  });
});

describe('deciding a factory configuration revision', () => {
  const rev = (over: Record<string, unknown> = {}) => ({
    gate_instance_id: GATE,
    rev_hash: SHA_A,
    parent_rev_hash: SHA_B,
    proposed_by: 'lt',
    status: 'pending',
    outcome: null,
    published: false,
    changes: [
      { key: 'sandbox.caps', before: { total: 4, coding: 1 }, after: { total: 6, coding: 1 } },
    ],
    evidence_hash: SHA_B,
    policy: { role: 'factory.admin', approvers: 1 },
    deciders: ['oh'],
    quorum: 1,
    may_decide: true,
    ...over,
  });

  it('prepare, the evidence viewed, then the vote bound to that nonce', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: me(['config.propose']) },
      [`GET /api/config/revisions/${GATE}`]: { json: rev() },
      [`POST /api/config/revisions/${GATE}/prepare`]: {
        json: { nonce: 'nonce-1', expires_at: T, evidence_hash: SHA_B },
      },
      [`POST /api/config/revisions/${GATE}/evidence`]: { json: { evidence_viewed: true } },
      [`POST /api/config/revisions/${GATE}/decide`]: { json: { ok: true } },
    });
    renderAt(`/config/revisions/${GATE}`);
    const changes = await screen.findByTestId('frev-changes');
    expect(
      within(changes).getByRole('region', { name: 'Change of sandbox.caps' }),
    ).toHaveTextContent('"total": 6');
    await user.click(screen.getByRole('button', { name: 'I have read the changes' }));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Your decision is on the ledger.')).toBeInTheDocument();
    expect(m.calls.find((c) => c.path.endsWith('/evidence'))?.body).toEqual({
      nonce: 'nonce-1',
      evidence_hash: SHA_B,
    });
    expect(m.calls.find((c) => c.path.endsWith('/decide'))?.body).toEqual({
      nonce: 'nonce-1',
      decision: 'approve',
    });
  });

  it('the proposer reads it and is told why they do not decide it', async () => {
    mockApi({
      'GET /api/me': {
        json: {
          ...me(['config.propose']),
          principal: { principal_id: 'lt', display_name: 'Luis Torres' },
        },
      },
      [`GET /api/config/revisions/${GATE}`]: { json: rev({ may_decide: false }) },
    });
    renderAt(`/config/revisions/${GATE}`);
    expect(await screen.findByTestId('frev-why-not')).toHaveTextContent('You proposed it');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
