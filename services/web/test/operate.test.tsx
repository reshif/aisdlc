import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt } from './helpers';
import { ITEM_A, ITEM_B, SHA_A, T, allowOnly, grant, tile } from './screenFixtures';

/** PLAN §7a: Operate is `ops.read` on the fleet (an auditor, a factory admin, ...). */
const AUDITOR = () => me(['ops.read']);
const CONTROL = '55555555-6666-4777-8888-999999999999';

describe('operate: scheduler and sandboxes', () => {
  it('scheduler: the coding slot against its cap, held items with their reasons, HUMAN-WAIT', async () => {
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/admission': {
        json: {
          as_of: T,
          coding_session_cap: 1,
          sessions_in_slot: 1,
          active: [grant()],
          waiting: [
            grant({
              grant_id: 'g-2',
              item_id: ITEM_B,
              unit_id: `${ITEM_B}:api`,
              status: 'waiting',
              snapshot_ref: 'snap-1',
            }),
          ],
          held: [
            {
              item_id: ITEM_B,
              project_id: 'testbed',
              lane: 'L3',
              underlying: 'S6',
              reasons: ['H2'],
              since: T,
            },
          ],
        },
      },
    });
    renderAt('/scheduler');
    const stats = await screen.findByRole('list', { name: 'Admission' });
    expect(stats).toHaveTextContent('1 / 1');
    const held = screen.getByRole('table', { name: 'Held items' });
    expect(within(held).getByText('H2')).toBeInTheDocument();
    expect(within(held).getByText('S6')).toBeInTheDocument();
    expect(
      within(screen.getByRole('table', { name: 'Waiting grants' })).getByText('snap-1'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('table', { name: 'Active grants' })).getByRole('link', {
        name: ITEM_A.slice(0, 8),
      }),
    ).toHaveAttribute('href', `/items/${ITEM_A}`);
  });

  it('sandboxes: caps and sessions from the controller; when it does not answer the slots read unknown', async () => {
    const m = mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/slots': {
        json: {
          host_id: 'local',
          caps: { total: 4, coding: 1 },
          caps_source: 'config',
          used_total: 1,
          used: { K: 0, 'K-exec': 0, P: 0, W: 1, O: 0, V: 0 },
          free: { K: 3, 'K-exec': 3, P: 3, W: 0, O: 3, V: 3 },
          sessions: [{ session_id: 'ses-1', class: 'W', grant_id: 'g-1', started_at: T }],
        },
      },
    });
    const view = renderAt('/sandboxes');
    const stats = await screen.findByRole('list', { name: 'Slots' });
    expect(stats).toHaveTextContent('1 / 4');
    expect(stats).toHaveTextContent('0 free');
    expect(screen.getByRole('table', { name: 'Sessions' })).toHaveTextContent('ses-1');
    expect(screen.getByRole('table', { name: 'Sandbox classes' })).toHaveTextContent('no NIC');
    view.unmount();
    m.table['GET /api/slots'] = {
      status: 502,
      json: { error: { code: 'sandbox_controller_unavailable', message: 'no answer' } },
    };
    renderAt('/sandboxes');
    expect(await screen.findByText(/free slots are\s+unknown/)).toBeInTheDocument();
  });
});

describe('operate: controls', () => {
  it('preview first, then apply with the nonce of that preview and the CSRF token', async () => {
    const user = userEvent.setup();
    const m = mockApi({
      'GET /api/me': { json: AUDITOR() },
      'POST /api/me/decisions': allowOnly('control.apply'),
      'GET /api/controls': { json: { controls: [], banners: [] } },
      'POST /api/controls/preview': {
        status: 201,
        json: {
          preview_id: CONTROL,
          verb: 'control.hold',
          actor: 'alice',
          blast_radius: {
            scope: { kind: 'project', ref: 'testbed' },
            projects: ['testbed'],
            lanes: [],
            items: 3,
            items_in_flight: 1,
            overlapping_controls: 0,
          },
          blast_radius_hash: SHA_A,
          nonce: 'n'.repeat(32),
          expires_at: T,
          consumed_at: null,
        },
      },
      'POST /api/controls': { status: 201, json: { ok: true } },
    });
    renderAt('/controls');
    await user.type(await screen.findByRole('textbox', { name: 'Project' }), 'testbed');
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    const preview = await screen.findByTestId('control-preview');
    expect(preview).toHaveTextContent('3');
    expect(m.calls.find((c) => c.path === '/api/controls/preview')?.body).toEqual({
      kind: 'hold',
      scope: { kind: 'project', ref: 'testbed' },
    });
    await user.click(within(preview).getByRole('button', { name: 'Apply hold' }));
    await waitFor(() =>
      expect(m.calls.some((c) => c.path === '/api/controls' && c.method === 'POST')).toBe(true),
    );
    const applied = m.calls.find((c) => c.path === '/api/controls' && c.method === 'POST');
    expect(applied?.body).toEqual({
      kind: 'hold',
      scope: { kind: 'project', ref: 'testbed' },
      preview_id: CONTROL,
      nonce: 'n'.repeat(32),
    });
    expect(applied?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
  });

  it('the PDP says no: Preview is a locked button with the reason, and lift is not offered', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/controls': {
        json: {
          controls: [
            {
              control_id: CONTROL,
              kind: 'hold',
              scope: { kind: 'fleet', ref: '*' },
              origin_kind: 'operator',
              state: 'active',
              expires_at: null,
              params: {},
              created_by_action: CONTROL,
              created_at: T,
              lifted_at: null,
            },
          ],
          banners: [],
        },
      },
    });
    renderAt('/controls');
    await user.type(await screen.findByRole('textbox', { name: 'Project' }), 'testbed');
    const locked = await screen.findByRole('button', { name: 'Preview' });
    await waitFor(() => expect(locked).toHaveAttribute('aria-disabled', 'true'));
    const table = await screen.findByRole('table', { name: 'Active controls' });
    expect(within(table).getByText('the whole factory')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'Lift' })).toBeNull();
  });
});

describe('operate: kill switch and health', () => {
  const JOURNAL = {
    observed_head: 2,
    journal: [
      {
        ks_seq: 2,
        kind: 'kill.requested',
        subject: 'k-1',
        actor: 'carol',
        entry_hash: SHA_A,
        signed: false,
        at: T,
      },
      {
        ks_seq: 1,
        kind: 'kill.holders_synced',
        subject: 'testbed',
        actor: null,
        entry_hash: SHA_A,
        signed: true,
        at: T,
      },
    ],
  };
  const KILL = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const active = (over: Record<string, unknown> = {}) => ({
    kills: [
      {
        kill_id: KILL,
        scope: { kind: 'project', ref: 'testbed' },
        state: 'release_pending',
        requested_by: 'carol',
        reason: 'runaway agent',
        requested_at: T,
        release_required: 2,
        release_approvals: ['dora'],
        released_at: null,
        may_release: true,
        approved_by_me: false,
        ...over,
      },
    ],
  });

  it('kill switch: the verified journal, a pending signature flagged; no kill button without the right', async () => {
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/kills': { json: JOURNAL },
      'GET /api/kills/active': { json: active() },
    });
    renderAt('/kill');
    const table = await screen.findByRole('table', { name: 'Kill switch journal' });
    expect(within(table).getByText('pending')).toBeInTheDocument();
    expect(within(table).getByText('the kill switch')).toBeInTheDocument();
    const inForce = await screen.findByRole('table', { name: 'Kills in force' });
    expect(within(inForce).getByText('1 of 2')).toBeInTheDocument();
    // the PDP said no to kill.request and kill.release: locked, never a live button
    await userEvent.setup().type(screen.getByLabelText('Project'), 'testbed');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Request the kill' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await waitFor(() =>
      expect(within(inForce).getByRole('button', { name: 'Approve the release' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
  });

  it('kill switch: request a kill with a step-up bound to exactly the act, then send it with the proof', async () => {
    const BOUND = 'c'.repeat(64);
    const m = mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/kills': { json: JOURNAL },
      'GET /api/kills/active': { json: { kills: [] } },
      'POST /api/me/decisions': allowOnly('kill.request', 'kill.release'),
      'POST /api/kills/prepare': { json: { bound_hash: BOUND } },
      // the reconfirm mode: the proof comes back at once (re-authentication redirects instead)
      'POST /api/step-up': {
        json: {
          status: 'ready',
          method: 'reconfirm',
          proof: 'su1.claims.sig',
          bound_hash: BOUND,
          expires_at: T,
        },
      },
      'POST /api/kills': {
        status: 201,
        json: { ...active().kills[0], state: 'active', release_approvals: [] },
      },
    });
    renderAt('/kill');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Project'), 'testbed');
    await user.type(screen.getByLabelText('Reason'), 'runaway agent');
    const go = await screen.findByRole('button', { name: 'Request the kill' });
    await waitFor(() => expect(go).toBeEnabled());
    await user.click(go);
    await waitFor(() =>
      expect(m.calls.some((c) => c.method === 'POST' && c.path === '/api/kills')).toBe(true),
    );
    const prep = m.calls.find((c) => c.path === '/api/kills/prepare');
    expect(prep?.body).toEqual({
      scope: { kind: 'project', ref: 'testbed' },
      reason: 'runaway agent',
    });
    expect(m.calls.find((c) => c.path === '/api/step-up')?.body).toEqual({
      subject_hash: BOUND,
      return_to: '/operate/stop',
    });
    expect(m.calls.find((c) => c.method === 'POST' && c.path === '/api/kills')?.body).toEqual({
      scope: { kind: 'project', ref: 'testbed' },
      reason: 'runaway agent',
      step_up: { proof: 'su1.claims.sig' },
    });
  });

  it('kill switch: a second person approves the release; who already approved is told another must', async () => {
    const BOUND = 'd'.repeat(64);
    const m = mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/kills': { json: JOURNAL },
      'GET /api/kills/active': { json: active() },
      'POST /api/me/decisions': allowOnly('kill.release'),
      [`POST /api/kills/${KILL}/release/prepare`]: { json: { bound_hash: BOUND } },
      'POST /api/step-up': {
        json: {
          status: 'ready',
          method: 'reconfirm',
          proof: 'su1.b.s',
          bound_hash: BOUND,
          expires_at: T,
        },
      },
      [`POST /api/kills/${KILL}/release`]: {
        json: { ...active().kills[0], state: 'released', release_approvals: ['dora', 'alice'] },
      },
    });
    renderAt('/kill');
    const user = userEvent.setup();
    const inForce = await screen.findByRole('table', { name: 'Kills in force' });
    const btn = within(inForce).getByRole('button', { name: 'Approve the release' });
    await waitFor(() => expect(btn).toBeEnabled());
    await user.click(btn);
    await waitFor(() =>
      expect(m.calls.find((c) => c.path === `/api/kills/${KILL}/release`)?.body).toEqual({
        step_up: { proof: 'su1.b.s' },
      }),
    );

    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/kills': { json: JOURNAL },
      'GET /api/kills/active': { json: active({ approved_by_me: true }) },
      'POST /api/me/decisions': allowOnly('kill.release'),
    });
    renderAt('/kill');
    expect(await screen.findAllByText('You approved; another person must')).not.toHaveLength(0);
  });

  it('health: service and loop tiles from the snapshots, integrations beside them; unknown is never ok', async () => {
    const st = (
      tile_id: string,
      state: string,
      over: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      tile_id,
      domain: tile_id.startsWith('loop.') ? 'loop' : 'service',
      label: tile_id.split('.').slice(1).join(' / '),
      state,
      detail_code: state === 'ok' ? 'ok' : 'unreachable',
      sli_value: 4,
      as_of: T,
      stale: false,
      ...over,
    });
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/integrations': {
        json: {
          health: { as_of: T, registry_revision: null, tiles: [tile({ state: 'down' })] },
          events: [],
        },
      },
      'GET /api/health': {
        json: {
          as_of: T,
          overall: 'down',
          counts: { ok: 1, degraded: 0, down: 1, unknown: 2 },
          tiles: [
            st('service.notary', 'ok'),
            st('service.gateway', 'down'),
            st('service.core', 'unknown', { detail_code: 'stale', stale: true, sli_value: null }),
            st('service.verify', 'unknown', {
              detail_code: 'no_report',
              as_of: null,
              sli_value: null,
            }),
            st('loop.core-worker.outbox_watch', 'ok', { label: 'core-worker / outbox_watch' }),
          ],
        },
      },
    });
    renderAt('/health');
    const services = await screen.findByRole('list', { name: 'Services' });
    const card = (name: string) => within(services).getByText(name).closest('li') as HTMLElement;
    expect(card('notary')).toHaveAttribute('data-state', 'ok');
    expect(card('notary')).toHaveTextContent('4 ms');
    expect(card('gateway')).toHaveTextContent('unreachable');
    expect(card('core')).toHaveAttribute('data-state', 'unknown');
    expect(card('core')).toHaveTextContent('reading older than two minutes');
    expect(card('verify')).toHaveTextContent('nothing has read it');
    expect(
      within(screen.getByRole('list', { name: 'Loops' })).getByText('core-worker / outbox_watch'),
    ).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Unknown is not healthy');
    expect(screen.getByRole('list', { name: 'Health summary' })).toHaveTextContent('down');
    expect(screen.getByRole('list', { name: 'Integrations and their health' })).toHaveTextContent(
      'Down',
    );
    expect(screen.queryByTestId('not-built')).toBeNull();
  });

  it('health: the tiles that cannot be read say so (never an empty green page)', async () => {
    mockApi({
      'GET /api/me': { json: AUDITOR() },
      'GET /api/integrations': {
        json: { health: { as_of: T, registry_revision: null, tiles: [] }, events: [] },
      },
      'GET /api/health': { status: 502, json: { error: { code: 'upstream', message: 'x' } } },
    });
    renderAt('/health');
    expect(await screen.findByText(/service and loop tiles/i)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Services' })).toBeNull();
  });
});

describe('operate: the guard is ops.read (PLAN §7a)', () => {
  it('audit.read alone no longer opens Operate: the 403 page names ops.read, no Operate entry, no Operate call', async () => {
    const { calls } = mockApi({ 'GET /api/me': { json: me(['audit.read']) } });
    renderAt('/scheduler');
    await waitFor(() => expect(document.querySelector('[data-status="403"]')).not.toBeNull());
    expect(document.querySelector('[data-status="403"]')).toHaveTextContent('See Operate');
    expect(calls.map((c) => c.path)).not.toContain('/api/admission');
    for (const name of ['Scheduler', 'Sandboxes', 'Controls', 'Kill switch', 'Health']) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
  });
});
