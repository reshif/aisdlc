import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { diffValues } from '../src/config/SchemaForm';
import { fieldWord, valueWord } from '../src/settings/words';
import { me, mockApi, renderAt } from './helpers';
import { CAPS_SCHEMA, GATE, decide, keyView, preview, proposed, summary } from './settingsFixtures';

// Settings (screen map §2.11): sections in plain words; one setting is changed by preview, then propose, or apply now
// as the factory admin with a reason; what waits for approval says who decides; nobody sees a raw key as a label.

const keysList = (over: Record<string, unknown> = {}) => ({
  json: {
    keys: [
      summary('sandbox.caps', CAPS_SCHEMA),
      summary('sandbox.probe'),
      summary('gates.policy'),
      summary('catalogue.lanes'),
      summary('pdp.bundle'),
    ],
    may_propose: true,
    may_apply_now: false,
    ...over,
  },
});

const PROPOSER = () => me(['config.propose']);

describe('Settings: the sections', () => {
  it('lists the sections that have settings, and each setting with its effect and when it applies', async () => {
    mockApi({
      'GET /api/me': { json: PROPOSER() },
      'GET /api/config/keys': keysList(),
      'GET /api/config/keys/sandbox.caps': {
        json: keyView('sandbox.caps', CAPS_SCHEMA, { total: 4, coding: 1 }),
      },
      'GET /api/config/keys/sandbox.probe': {
        json: keyView('sandbox.probe', {}, { grant_ttl_s: 1200 }, { pending: [{}] }),
      },
    });
    renderAt('/settings/sandboxes');
    const sections = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(
      within(sections)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Tracks', 'Approvals', 'Sandboxes', 'Access policy']);
    expect(within(sections).getByRole('link', { name: 'Sandboxes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const list = screen.getByRole('list', { name: 'Settings in Sandboxes' });
    const caps = within(list).getByRole('link', { name: 'Sandbox limits' }).closest('li');
    expect(caps).toHaveTextContent('Applies now');
    expect(caps).toHaveTextContent('at most 8 coding');
    expect(await within(caps as HTMLElement).findByText('Now: Total: 4 · Coding: 1')).toBeVisible();
    const probe = within(list).getByRole('link', { name: 'Test-run lease' }).closest('li');
    expect(await within(probe as HTMLElement).findByText('1 waiting for approval')).toBeVisible();
    expect(list).not.toHaveTextContent('sandbox.caps');
  });

  it('a catalogue section says a change applies to new items only', async () => {
    mockApi({
      'GET /api/me': { json: PROPOSER() },
      'GET /api/config/keys': keysList(),
      'GET /api/config/keys/catalogue.lanes': { json: keyView('catalogue.lanes', {}, {}) },
    });
    renderAt('/settings/tracks');
    const list = await screen.findByRole('list', { name: 'Settings in Tracks' });
    expect(list).toHaveTextContent('New items only');
  });

  it('without the right to read settings the page is the 403, before any call', async () => {
    const m = mockApi({ 'GET /api/me': { json: me(['quality.read']) } });
    renderAt('/settings');
    expect(await screen.findByText(/See my access/)).toBeInTheDocument();
    expect(m.calls.some((c) => c.path.startsWith('/api/config'))).toBe(false);
  });

  it('works at phone width: the sections and the list are there, one column', async () => {
    window.innerWidth = 375;
    window.dispatchEvent(new Event('resize'));
    mockApi({
      'GET /api/me': { json: PROPOSER() },
      'GET /api/config/keys': keysList(),
      'GET /api/config/keys/gates.policy': { json: keyView('gates.policy', {}, { gates: {} }) },
    });
    renderAt('/settings/approvals');
    expect(await screen.findByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Settings in Approvals' })).toBeVisible();
    window.innerWidth = 1024;
  });

  it('the old address /config opens Settings', async () => {
    mockApi({ 'GET /api/me': { json: PROPOSER() }, 'GET /api/config/keys': keysList() });
    renderAt('/config');
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });
});

describe('Settings: one setting', () => {
  const routes = (over: Record<string, unknown> = {}) => ({
    'GET /api/me': { json: PROPOSER() },
    'GET /api/config/keys': keysList(),
    'GET /api/config/keys/sandbox.caps': {
      json: keyView('sandbox.caps', CAPS_SCHEMA, { total: 4, coding: 1 }, over),
    },
    'POST /api/me/decisions': decide((q) => q.action === 'config.propose'),
    'POST /api/config/keys/sandbox.caps/preview': { json: preview('sandbox.caps') },
    'POST /api/config/keys/sandbox.caps/proposals': { status: 201, json: proposed },
  });

  it('change, preview what it does, then propose: it waits for approval', async () => {
    const user = userEvent.setup();
    const m = mockApi(routes());
    renderAt('/settings/sandboxes/sandbox.caps');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sandbox limits' })).toBeVisible();
    const eff = await screen.findByTestId('cfg-effective');
    expect(eff).toHaveTextContent('Coding1');
    expect(eff).toHaveTextContent('The default');
    const form = screen.getByRole('form', { name: 'Draft of the change' });
    const coding = within(form).getByRole('spinbutton', { name: 'Coding' });
    const propose = screen.getByRole('button', { name: 'Propose this change' });
    expect(propose).toBeDisabled();
    await user.clear(coding);
    await user.type(coding, '2');
    // propose only after a preview of exactly this draft
    expect(propose).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Preview the change' }));
    const pv = await screen.findByTestId('st-preview');
    expect(pv).toHaveTextContent('Coding sandboxes at once: 1 → 2.');
    expect(pv).toHaveTextContent('Applies now');
    expect(m.calls.find((c) => c.path.endsWith('/preview'))?.body).toEqual({
      value: { total: 4, coding: 2 },
    });
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    await screen.findByText(/It waits for approval; nothing changed yet/);
    const post = m.calls.find((c) => c.path.endsWith('/proposals'));
    expect(post?.body).toEqual({ value: { total: 4, coding: 2 }, parent_rev_hash: null });
    expect(post?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('a draft the schema refuses is said in words and cannot be previewed or sent', async () => {
    const user = userEvent.setup();
    mockApi(routes());
    renderAt('/settings/sandboxes/sandbox.caps');
    const coding = await screen.findByRole('spinbutton', { name: 'Coding' });
    await user.clear(coding);
    await user.type(coding, '9');
    expect(screen.getByRole('alert', { name: 'Problems with the draft' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview the change' })).toBeDisabled();
  });

  it('the factory admin applies now with a reason; the reason goes with every step', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      ...routes({ may_apply_now: true }),
      [`POST /api/config/revisions/${GATE}/prepare`]: {
        json: {
          nonce: 'n1',
          expires_at: '2026-11-13T10:00:00.000Z',
          evidence_hash: 'e'.repeat(64),
        },
      },
      [`POST /api/config/revisions/${GATE}/evidence`]: { json: { evidence_viewed: true } },
      [`POST /api/config/revisions/${GATE}/decide`]: {
        json: { outcome: 'approve', published: true, publish_error: null },
      },
    });
    renderAt('/settings/sandboxes/sandbox.caps');
    const coding = await screen.findByRole('spinbutton', { name: 'Coding' });
    await user.clear(coding);
    await user.type(coding, '2');
    await user.click(screen.getByRole('button', { name: 'Preview the change' }));
    await screen.findByTestId('st-preview');
    await user.click(screen.getByRole('button', { name: 'Apply now as factory admin' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply now as factory admin' });
    const go = within(dialog).getByRole('button', { name: 'Apply now' });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Reason (required)'), 'night build needs two');
    await user.click(go);
    await screen.findByText(/Applied\. The change is in force/);
    const decideCall = m.calls.find((c) => c.path.endsWith('/decide'));
    expect(decideCall?.body).toEqual({ nonce: 'n1', decision: 'approve' });
    for (const step of ['/prepare', '/evidence', '/decide']) {
      const c = m.calls.find((x) => x.path.endsWith(step));
      expect(decodeURIComponent(c?.headers['x-aisdlc-override-reason'] ?? '')).toBe(
        'night build needs two',
      );
    }
  });

  it('a change waiting for approval says who decides it and links to deciding it', async () => {
    mockApi(
      routes({
        pending: [
          {
            revision: {
              rev_hash: 'd'.repeat(64),
              parent_rev_hash: null,
              state: 'proposed',
              gate_instance_id: GATE,
              ledger_entry_id: null,
              proposed_by: 'alice',
              proposed_at: '2026-11-13T09:00:00.000Z',
              published_at: null,
              value: { total: 4, coding: 3 },
              set: true,
              changes_key: true,
            },
            gate_status: 'pending',
            deciders: { slot: 'admin', holders: ['carol'] },
          },
        ],
      }),
    );
    renderAt('/settings/sandboxes/sandbox.caps');
    const pending = await screen.findByTestId('cfg-pending');
    expect(pending).toHaveTextContent('Waiting for approval');
    expect(pending).toHaveTextContent('Proposed by Alice Admin');
    expect(pending).toHaveTextContent('Carol Approver');
    expect(within(pending).getByRole('link', { name: 'Open it to decide' })).toHaveAttribute(
      'href',
      `/config/revisions/${GATE}`,
    );
  });

  it('someone who may only read sees the value and no way to change it', async () => {
    mockApi({
      ...routes({ may_propose: false }),
      'GET /api/me': { json: me(['audit.read']) },
      'GET /api/config/keys': keysList({ may_propose: false }),
    });
    renderAt('/settings/sandboxes/sandbox.caps');
    expect(await screen.findByTestId('cfg-read-only')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose this change' })).toBeNull();
  });

  it('the generated access policy is shown, never edited', async () => {
    mockApi({
      'GET /api/me': { json: PROPOSER() },
      'GET /api/config/keys': keysList(),
      'GET /api/config/keys/pdp.bundle': { json: keyView('pdp.bundle', {}, { version: 1 }) },
    });
    renderAt('/settings/access_policy/pdp.bundle');
    expect(await screen.findByTestId('st-generated')).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Draft of the change' })).toBeNull();
  });

  it('an unknown setting is the one 404', async () => {
    mockApi({ 'GET /api/me': { json: PROPOSER() }, 'GET /api/config/keys': keysList() });
    renderAt('/settings/general/no.such_key');
    expect(await screen.findByText('Not found')).toBeVisible();
  });
});

describe('the words of a setting', () => {
  it('reads field names and codes in plain words', () => {
    expect(fieldWord('max_turns')).toBe('Max turns');
    expect(fieldWord('run_time_s')).toBe('Run time (seconds)');
    expect(fieldWord('G3')).not.toBe('G3');
    expect(fieldWord('g6')).not.toMatch(/g6/i);
    expect(valueWord(true)).toBe('yes');
    expect(valueWord(['a', 'b'])).toBe('a, b');
  });

  it('diffValues names changed leaves by path, with added and removed ones', () => {
    expect(diffValues({ a: 1, b: [1, 2] }, { a: 2, b: [1], c: true })).toEqual([
      { path: 'a', before: 1, after: 2 },
      { path: 'b[1]', before: 2, after: undefined },
      { path: 'c', before: undefined, after: true },
    ]);
  });
});
