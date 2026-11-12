import type { FloorItem, FloorView } from '@aisdlc/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../src/api';
import { FLOOR_POLL_MS } from '../src/floor/FloorPage';
import { me, mockApi, renderAt, summaryOf, type Call } from './helpers';

// The floor screen (PLAN M19): drawn from the bff's FloorView (the plan from the catalogue, the items from the live
// read model, cut to the person). A viewer sees positions and never a title; a read model that is behind, or a poll
// that fails, shows a stale banner and greys the plan; polls send the last ETag; every part is a keyboard control.

const A = '0190a1b2-c3d4-7e5f-8a6b-111111111111';
const B = '0190a1b2-c3d4-7e5f-8a6b-222222222222';
const C = '0190a1b2-c3d4-7e5f-8a6b-333333333333';
const T = '2026-11-12T10:00:00.000Z';

const item = (o: Partial<FloorItem> & Pick<FloorItem, 'item_id' | 'key'>): FloorItem => ({
  lane: 'L3',
  lane_bound: true,
  node: { kind: 'station', stage: 'S3' },
  stage: 'S3',
  step: '3.1',
  phase: 'S3',
  status: 'working',
  waiting: null,
  waiting_gates: [],
  holds: [],
  in_session: false,
  route: ['S1', 'G0+G1', 'S3', 'G2', 'S5', 'G3+G3s', 'S6', 'S7', 'G4', 'S8', 'S9'],
  catalogue_version: '1.3.0',
  title: null,
  requester: null,
  mine: false,
  waits_on_me: false,
  updated_at: T,
  ...o,
});

const view = (o: Partial<FloorView> = {}): FloorView => ({
  project_id: 'testbed' as never,
  plan: {
    catalogue: { version: '1.3.0', hash: 'a'.repeat(64) },
    stations: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'],
    gates: [
      { key: 'G0+G1', gates: ['G0', 'G1'], after_stage: 'S1', after_step: '1.6' },
      { key: 'G2', gates: ['G2'], after_stage: 'S3', after_step: '3.5' },
      { key: 'G3+G3s', gates: ['G3', 'G3s'], after_stage: 'S5', after_step: '5.8' },
      { key: 'G4', gates: ['G4'], after_stage: 'S7', after_step: '7.6' },
    ],
    lanes: [
      {
        lane: 'L3',
        route: ['S1', 'G0+G1', 'S3', 'G2', 'S5', 'G3+G3s', 'S6', 'S7', 'G4', 'S8', 'S9'],
        human_led: false,
      },
      {
        lane: 'L4',
        route: [
          'S1',
          'G0+G1',
          'S2',
          'S3',
          'G2',
          'S4',
          'S5',
          'G3+G3s',
          'S6',
          'S7',
          'G4',
          'S8',
          'S9',
        ],
        human_led: false,
      },
    ],
  },
  items: [
    item({
      item_id: A as never,
      key: '0190a1b2',
      node: { kind: 'gate', key: 'G0+G1' },
      stage: 'S1',
      step: '1.6',
      status: 'waiting',
      waiting: 'gates:G0+G1',
      waiting_gates: [
        { gate: 'G0', gate_instance_id: 'g-0', slot: 'intent', deciders: ['bob' as never] },
        { gate: 'G1', gate_instance_id: 'g-1', slot: 'intent', deciders: ['bob' as never] },
      ],
      title: 'Export invoices as CSV',
      requester: 'ria' as never,
    }),
    item({
      item_id: B as never,
      key: '0190b222',
      lane: 'L4',
      node: { kind: 'station', stage: 'S6' },
      stage: 'S6',
      step: '6.4',
      phase: 'S6',
      in_session: true,
      title: 'Rename the orders table',
    }),
    item({
      item_id: C as never,
      key: '0190c333',
      node: { kind: 'room', room: 'HOLD' },
      stage: 'S6',
      status: 'held',
      holds: [{ hold_id: 'adm:h2', reason: 'H2' }],
      title: 'Held one',
    }),
  ],
  recent: [
    {
      item_id: B as never,
      key: '0190b222',
      lane: 'L4',
      kind: 'B',
      edge: 'B9',
      from: 'station:S7',
      to: 'station:S6',
      at: T,
    },
  ],
  flow: Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(Date.parse(T) - (23 - i) * 3_600_000).toISOString(),
    F: i % 3,
    B: i === 20 ? 1 : 0,
    R: 0,
  })),
  controls: [],
  sessions: {
    caps: { total: 4, coding: 1 },
    caps_source: 'config',
    used: { K: 0, 'K-exec': 0, P: 0, W: 1, O: 0, V: 0 },
    free: { K: 3, 'K-exec': 3, P: 3, W: 0, O: 3, V: 3 },
  },
  freshness: { as_of_seq: 40, head_seq: 40, stale: false, reason: null, read_at: T },
  view_level: 'V3',
  data_class: 'D2',
  ...o,
});

/** The viewer's cut, as the bff makes it (contracts `cutFloorView`). */
const viewerView = () => {
  const v = view({ view_level: 'V1', data_class: 'D0' });
  return { ...v, items: v.items.map((i) => ({ ...i, title: null, requester: null })) };
};

const admin = (): Me => me(['floor.read', 'audit.read']);
const viewer = (): Me => ({
  ...me([]),
  actions: {
    fleet: [],
    projects: [{ project_id: 'testbed', actions: ['floor.read', 'project.view'] }],
  },
});

function floorApi(
  who: Me,
  floor: (c: Call) => { status?: number; json?: unknown; headers?: Record<string, string> },
) {
  return mockApi({
    'GET /api/me': { json: who },
    'GET /api/projects': { json: [summaryOf()] },
    'GET /api/floor/testbed': floor,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the floor screen', () => {
  it('draws the stations, the gate with who it waits on, the rooms, the pod and the chips', async () => {
    floorApi(admin(), () => ({ json: view(), headers: { etag: '"v1"' } }));
    renderAt('/floor');
    const plan = await screen.findByRole('region', { name: 'Floor plan' });
    expect(screen.getByRole('heading', { name: 'Floor: testbed' })).toBeInTheDocument();
    for (const s of ['S1 Intake & triage', 'S6 Build in sandbox', 'S9 Close & learn']) {
      expect(within(plan).getByRole('button', { name: new RegExp(`^${s}`) })).toBeInTheDocument();
    }
    // the gate positions are the plan's, with the initials of who decides
    const gate = within(plan).getByRole('button', {
      name: /^Gate G0\+G1: 1 waiting, decided by bob/,
    });
    expect(gate).toBeInTheDocument();
    expect(plan.querySelector('[data-gate="G0+G1"] .fl-who')).toHaveTextContent('BO');
    expect(plan.querySelector('[data-gate="G3+G3s"]')).not.toBeNull();
    // the item in S6 with a session is in the pod; the pod says so
    expect(plan.querySelector('[data-pod="1"]')).toHaveTextContent(
      'coding slot 1 of 1, 0190 · 6.4',
    );
    // a project admin sees the title in the chip's name
    expect(
      within(plan).getByRole('button', {
        name: /^Item 0190a1b2, lane L3, waiting at gate G0\+G1: Export invoices as CSV/,
      }),
    ).toBeInTheDocument();
    expect(
      within(plan).getByRole('button', { name: /^Holding shelf: 1 here/ }),
    ).toBeInTheDocument();
    // counts, recent back-edges, the stations table, sessions per class
    expect(screen.getByLabelText('Items by status')).toHaveTextContent('1 working');
    expect(screen.getByLabelText('Items by status')).toHaveTextContent('1 held');
    expect(screen.getByText('B9')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Items per station' })).toBeInTheDocument();
    expect(screen.queryByText(/Stale/)).toBeNull();
  });

  it('shows a viewer positions only: no title anywhere, and says why', async () => {
    floorApi(viewer(), () => ({ json: viewerView() }));
    renderAt('/floor');
    expect(await screen.findByText(/You see this floor as a viewer/)).toBeInTheDocument();
    const plan = screen.getByRole('region', { name: 'Floor plan' });
    const chip = within(plan).getByRole('button', { name: /^Item 0190a1b2/ });
    expect(chip.getAttribute('aria-label')).not.toContain('Export');
    expect(document.body.textContent).not.toContain('Export invoices');
    await userEvent.click(chip);
    const d = await screen.findByRole('dialog', { name: 'Item 0190a1b2' });
    expect(d).toHaveTextContent('Title hidden at your view level');
    expect(d).toHaveTextContent('decided by bob');
  });

  it('shows the stale banner and greys the plan when the read model is behind the record', async () => {
    floorApi(admin(), () => ({
      json: view({
        freshness: {
          as_of_seq: 12,
          head_seq: 40,
          stale: true,
          reason: 'the floor read model needs a rebuild',
          read_at: T,
        },
      }),
    }));
    renderAt('/floor');
    expect(await screen.findByText(/the floor is behind the record/)).toHaveTextContent(
      'Positions are as of record entry 12; the record is at 40',
    );
    expect(screen.getByRole('region', { name: 'Floor plan' })).toHaveClass('fl-stale');
    expect(screen.getByRole('button', { name: /Stale/ })).toBeInTheDocument();
  });

  it('polls with the last ETag, keeps the floor on a 304, and turns stale when a poll fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    const m = floorApi(admin(), () => {
      n += 1;
      if (n === 1) return { json: view(), headers: { etag: '"v1"' } };
      if (n === 2) return { status: 304 };
      return {
        status: 502,
        json: {
          error: { code: 'core_unavailable', message: 'the factory core could not be reached' },
        },
      };
    });
    renderAt('/floor');
    expect(await screen.findByRole('region', { name: 'Floor plan' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLOOR_POLL_MS + 100);
    });
    await waitFor(() => expect(n).toBe(2));
    const second = m.calls.filter((c) => c.path === '/api/floor/testbed')[1];
    expect(second?.headers['if-none-match']).toBe('"v1"');
    expect(screen.getByRole('region', { name: 'Floor plan' })).not.toHaveClass('fl-stale');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLOOR_POLL_MS + 100);
    });
    expect(await screen.findByText(/could not be refreshed since/)).toBeInTheDocument();
    // the last positions stay, greyed, never fresh-looking
    expect(screen.getByRole('region', { name: 'Floor plan' })).toHaveClass('fl-stale');
    expect(screen.getByRole('button', { name: /^Item 0190a1b2/ })).toBeInTheDocument();
  });

  it('is a keyboard map: a station opens with Enter, a gate drawer lists who decides, Escape closes', async () => {
    floorApi(admin(), () => ({ json: view() }));
    renderAt('/floor');
    const plan = await screen.findByRole('region', { name: 'Floor plan' });
    const s6 = within(plan).getByRole('button', { name: /^S6 Build in sandbox/ });
    s6.focus();
    await userEvent.keyboard('{Enter}');
    const d = await screen.findByRole('dialog', { name: 'S6 Build in sandbox' });
    expect(within(d).getByText('Rename the orders table')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(within(plan).getByRole('button', { name: /^Gate G0\+G1/ }));
    const g = await screen.findByRole('dialog', { name: 'Gate G0+G1' });
    expect(g).toHaveTextContent('On the route ofL3, L4');
    expect(g).toHaveTextContent('bob (BO)');
  });

  it('filters by lane group: the other lanes dim, the button says it is pressed', async () => {
    floorApi(admin(), () => ({ json: view() }));
    renderAt('/floor');
    const lanes = await screen.findByRole('group', { name: 'Lanes' });
    const l45 = within(lanes).getByRole('button', { name: 'L4' });
    await userEvent.click(l45);
    expect(l45).toHaveAttribute('aria-pressed', 'true');
    expect(within(lanes).getByRole('button', { name: 'L3' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    const plan = screen.getByRole('region', { name: 'Floor plan' });
    expect(within(plan).getByRole('button', { name: /^Item 0190a1b2/ })).toHaveClass('fl-dim');
    expect(within(plan).getByRole('button', { name: /^Item 0190b222/ })).not.toHaveClass('fl-dim');
  });

  it('shows the pods as unknown when the sandbox-controller could not be asked', async () => {
    floorApi(admin(), () => ({ json: view({ sessions: null }) }));
    renderAt('/floor');
    const plan = await screen.findByRole('region', { name: 'Floor plan' });
    expect(plan.querySelector('[data-pod="1"]')).toHaveTextContent('coding slot 1 of 1, unknown');
    expect(screen.getByText(/The sandbox-controller did not answer/)).toBeInTheDocument();
  });
});

describe('the floor in the navigation', () => {
  it('is listed for a person with floor.read somewhere, and a 403 for one without', async () => {
    floorApi(viewer(), () => ({ json: viewerView() }));
    renderAt('/floor');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Floor' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('refuses a person with no floor.read anywhere before any call', async () => {
    const m = mockApi({ 'GET /api/me': { json: me([]) } });
    renderAt('/floor');
    expect(await screen.findByText(/403/)).toBeInTheDocument();
    expect(m.calls.some((c) => c.path.startsWith('/api/floor'))).toBe(false);
  });
});
