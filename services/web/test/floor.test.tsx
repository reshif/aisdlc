import type {
  FleetView,
  FloorItem,
  FloorProject,
  FloorScoreChip,
  FloorView,
} from '@aisdlc/contracts';
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

const OK = { feasibility: 'feasible', feasibility_reason: null } as const;

const chip = (
  o: Partial<FloorScoreChip> & Pick<FloorScoreChip, 'stage' | 'agent_id'>,
): FloorScoreChip => {
  const scored = o.pass_rate !== undefined;
  return {
    name: null,
    prompt_sha256: 'c'.repeat(64),
    score_id: scored ? `score-${o.agent_id}` : null,
    provider: scored ? 'fake' : null,
    model: scored ? 'fake-model' : null,
    pass_rate: null,
    accept_rate: null,
    status: 'unknown',
    low: false,
    eval_signals: scored ? 8 : 0,
    production_signals: 0,
    ...o,
  };
};

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
  activity: null,
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
        { gate: 'G0', gate_instance_id: 'g-0', slot: 'intent', deciders: ['bob' as never], ...OK },
        { gate: 'G1', gate_instance_id: 'g-1', slot: 'intent', deciders: ['bob' as never], ...OK },
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
      activity: {
        last_at: T,
        source: 'heartbeat',
        session_since: T,
        silent_for_s: 120,
        stuck_after_s: 1800,
        silent: false,
      },
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
  scores: [
    chip({ stage: 'S3', agent_id: 'A3', pass_rate: 0.62, status: 'flaky', low: true }),
    chip({ stage: 'S3', agent_id: 'A4', pass_rate: 0.95, status: 'pass', low: false }),
    chip({ stage: 'S6', agent_id: 'A6', pass_rate: 0.9, status: 'pass', low: false }),
    chip({ stage: 'S1', agent_id: 'A1' }),
  ],
  kill: { state: 'clear', killed: false, kill_ids: [], message: null },
  liveness: { silence_minutes: 30, by_stage: {}, low_score: 0.85, source: 'default' },
  freshness: { as_of_seq: 40, head_seq: 40, stale: false, reason: null, read_at: T },
  gates_off: [],
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
  it('on a phone: no floor plan, the list of what is stuck, waiting or on hold instead', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((q: string) => ({
        matches: q.includes('max-width'),
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    floorApi(admin(), () => ({ json: view(), headers: { etag: '"v1"' } }));
    renderAt('/floor');
    const list = await screen.findByTestId('floor-phone');
    expect(screen.queryByRole('region', { name: 'Floor plan' })).toBeNull();
    expect(list).toHaveTextContent('0190a1b2');
    vi.unstubAllGlobals();
  });

  it('draws the stations, the gate with who it waits on, the rooms, the pod and the chips', async () => {
    floorApi(admin(), () => ({ json: view(), headers: { etag: '"v1"' } }));
    renderAt('/floor');
    const plan = await screen.findByRole('region', { name: 'Floor plan' });
    expect(screen.getByRole('heading', { name: 'Floor: testbed' })).toBeInTheDocument();
    // the stage codes stay off the plan; an approval keeps its code as a small chip (glossary: secondary on Floor)
    expect(plan.querySelector('.fl-sthd')).not.toHaveTextContent(/\bS[1-9]\b/);
    for (const s of ['Intake', 'Build', 'Close']) {
      expect(within(plan).getByRole('button', { name: new RegExp(`^${s}`) })).toBeInTheDocument();
    }
    // the gate positions are the plan's, with the initials of who decides
    const gate = within(plan).getByRole('button', {
      name: /^Accept the request and Confirm the goal: 1 waiting, decided by bob/,
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
        name: /^Item 0190a1b2, Small change, Waiting at an approval: Export invoices as CSV/,
      }),
    ).toBeInTheDocument();
    expect(
      within(plan).getByRole('button', { name: /^On hold Paused items/ }),
    ).toHaveAccessibleDescription('1 here. Open the room');
    // counts, recent back-edges, the stations table, sessions per class
    expect(screen.getByLabelText('Items by status')).toHaveTextContent('1 working');
    expect(screen.getByLabelText('Items by status')).toHaveTextContent('1 on hold');
    expect(screen.getByText('Fixing check findings')).toBeInTheDocument();
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
      'Positions are 28 events behind; nothing here is current.',
    );
    expect(screen.getByRole('region', { name: 'Floor plan' })).toHaveClass('fl-stale');
    expect(screen.getByRole('button', { name: /Out of date/ })).toBeInTheDocument();
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
    const s6 = within(plan).getByRole('button', { name: /^Build/ });
    s6.focus();
    await userEvent.keyboard('{Enter}');
    const d = await screen.findByRole('dialog', { name: 'Build' });
    expect(within(d).getByText('Rename the orders table')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(
      within(plan).getByRole('button', { name: /^Accept the request and Confirm the goal/ }),
    );
    const g = await screen.findByRole('dialog', {
      name: 'Accept the request and Confirm the goal',
    });
    expect(g).toHaveTextContent('On the tracksSmall change, Feature');
    expect(g).toHaveTextContent('bob (BO)');
  });

  it("P2-10: a gate the project's gating profile has off is drawn and said off for this project", async () => {
    floorApi(admin(), () => ({ json: view({ gates_off: ['G3+G3s'] }) }));
    renderAt('/floor');
    const plan = await screen.findByRole('region', { name: 'Floor plan' });
    expect(plan.querySelector('[data-gate="G3+G3s"]')).toHaveAttribute('data-off', 'true');
    expect(plan.querySelector('[data-gate="G0+G1"]')).not.toHaveAttribute('data-off');
    await userEvent.click(
      within(plan).getByRole('button', {
        name: /^Approve the plan and Approve the outline \(off for this project\)/,
      }),
    );
    const g = await screen.findByRole('dialog', {
      name: 'Approve the plan and Approve the outline',
    });
    expect(g).toHaveTextContent('Off for this project');
  });

  it('filters by lane group: the other lanes dim, the button says it is pressed', async () => {
    floorApi(admin(), () => ({ json: view() }));
    renderAt('/floor');
    const lanes = await screen.findByRole('group', { name: 'Tracks' });
    const l45 = within(lanes).getByRole('button', { name: 'Feature' });
    await userEvent.click(l45);
    expect(l45).toHaveAttribute('aria-pressed', 'true');
    expect(within(lanes).getByRole('button', { name: 'Small change' })).toHaveAttribute(
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
    expect(screen.getByText(/The sandboxes did not answer/)).toBeInTheDocument();
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

describe('the floor overlays (M19)', () => {
  it('marks the lowest agent score of a station on its header, low ones flagged in words too', async () => {
    floorApi(admin(), () => ({ json: view() }));
    renderAt('/floor');
    const plan = await screen.findByRole('region', { name: 'Floor plan' });
    const s3 = plan.querySelector('[data-station="S3"] .fl-score');
    expect(s3).toHaveTextContent('A3 .62');
    expect(s3).toHaveClass('fl-score-low');
    expect(s3).toHaveTextContent('low score');
    expect(plan.querySelector('[data-station="S6"] .fl-score')).not.toHaveClass('fl-score-low');
    // an agent with no score yet draws no chip; the station drawer lists it as unknown
    expect(plan.querySelector('[data-station="S1"] .fl-score')).toBeNull();
    await userEvent.click(within(plan).getByRole('button', { name: /^Intake/ }));
    const d = await screen.findByRole('dialog', { name: 'Intake' });
    expect(within(d).getByText('no score for the current prompt yet')).toBeInTheDocument();
  });

  it('draws an item silent past the threshold as stuck, with how long and the threshold in force', async () => {
    const v = view();
    const items = v.items.map((i) =>
      i.item_id === B
        ? {
            ...i,
            status: 'stuck' as const,
            waiting: 'stuck:silent',
            activity: {
              ...i.activity!,
              last_at: null,
              source: null,
              silent_for_s: 2400,
              silent: true,
            },
          }
        : i,
    );
    floorApi(admin(), () => ({ json: { ...v, items } }));
    renderAt('/floor');
    const plan = await screen.findByRole('region', { name: 'Floor plan' });
    const b = within(plan).getByRole('button', { name: /^Item 0190b222, Feature, Stuck/ });
    expect(b).toHaveClass('fl-stuck');
    expect(screen.getByLabelText('Items by status')).toHaveTextContent('1 stuck');
    expect(screen.getByText(/silent for more than 30 min/)).toBeInTheDocument();
    await userEvent.click(b);
    const d = await screen.findByRole('dialog', { name: 'Item 0190b222' });
    expect(d).toHaveTextContent('no activity since it entered; silent 40 min of 30 min: stuck');
  });

  it('flags a gate nobody eligible can decide, on the plan and in its drawers', async () => {
    const v = view();
    const items = v.items.map((i) =>
      i.item_id === A
        ? {
            ...i,
            waiting_gates: i.waiting_gates.map((g) => ({
              ...g,
              deciders: [],
              feasibility: 'infeasible' as const,
              feasibility_reason: 'G0: nobody holds the slot (slot intent, 0 holder(s))',
            })),
          }
        : i,
    );
    floorApi(admin(), () => ({ json: { ...v, items } }));
    renderAt('/floor');
    const plan = await screen.findByRole('region', { name: 'Floor plan' });
    expect(plan.querySelector('[data-gate="G0+G1"]')).toHaveClass('fl-gate-flag');
    const gate = within(plan).getByRole('button', {
      name: /^Accept the request and Confirm the goal: 1 waiting, 2 cannot be decided as things stand/,
    });
    await userEvent.click(gate);
    const g = await screen.findByRole('dialog', {
      name: 'Accept the request and Confirm the goal',
    });
    expect(g).toHaveTextContent('Cannot be decided as things stand');
    expect(g).toHaveTextContent('Nobody can decide');
  });

  it('shows the kill banner when a kill covers the project, and an unreachable kill switch as killed', async () => {
    floorApi(admin(), () => ({
      json: view({
        kill: {
          state: 'killed',
          killed: true,
          kill_ids: ['k-1'],
          message: 'killed: project:testbed',
        },
      }),
    }));
    const { unmount } = renderAt('/floor');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Agents stopped on testbed. No agent work starts',
    );
    unmount();
    floorApi(admin(), () => ({
      json: view({
        kill: {
          state: 'unreachable',
          killed: true,
          kill_ids: [],
          message: 'core-worker answered 503',
        },
      }),
    }));
    renderAt('/floor');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Agents stopped (cannot reach the stop switch)',
    );
  });
});

const fleetRow = (
  o: Partial<FloorProject> & Pick<FloorProject, 'project_id' | 'opaque_key'>,
): FloorProject => ({
  name: o.project_id,
  team_id: null,
  classification: 'internal',
  level: 'light',
  collapsed: null,
  in_flight: 3,
  done_24h: 2,
  stations: { S1: 1, S6: 1 },
  stuck_at: ['S6'],
  gates: { 'G0+G1': 1 },
  rooms: { HOLD: 1 },
  status: { working: 1, waiting: 1, held: 1, stuck: 1 },
  infeasible_gates: 1,
  lanes: ['L3', 'L4'],
  kill: { state: 'clear', killed: false, kill_ids: [], message: null },
  ...o,
});

const fleet = (): FleetView => ({
  plan: view().plan,
  projects: [
    fleetRow({ project_id: 'testbed' as never, opaque_key: '0000000000000001' }),
    fleetRow({
      project_id: 'payments' as never,
      opaque_key: '0000000000000002',
      kill: { state: 'killed', killed: true, kill_ids: ['k-9'], message: null },
      stuck_at: [],
      infeasible_gates: 0,
      status: { working: 2, waiting: 0, held: 0, stuck: 0 },
    }),
    {
      ...fleetRow({ project_id: 'vault' as never, opaque_key: '0000000000000003' }),
      classification: 'confidential',
      collapsed: 'confidential',
      in_flight: 2,
      stations: {},
      stuck_at: [],
      gates: {},
      rooms: {},
      status: { working: 0, waiting: 0, held: 0, stuck: 0 },
      infeasible_gates: 0,
      lanes: [],
      done_24h: 0,
    },
  ],
  sessions: view().sessions,
  liveness: view().liveness,
  freshness: view().freshness,
});

describe('the fleet screen', () => {
  it('lists one row per project with its stations, gates, rooms, stuck and flagged; a confidential one collapsed', async () => {
    mockApi({ 'GET /api/me': { json: admin() }, 'GET /api/fleet': { json: fleet() } });
    renderAt('/fleet');
    expect(await screen.findByRole('heading', { name: 'Fleet' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Projects' });
    const rows = within(list)
      .getAllByRole('listitem')
      .filter((li) => li.classList.contains('fx-row'));
    expect(rows).toHaveLength(3);
    const testbed = rows[0]!;
    expect(within(testbed).getByRole('link', { name: 'testbed' })).toHaveAttribute(
      'href',
      '/floor?project=testbed',
    );
    expect(within(testbed).getByLabelText(/^Build: 1 here, one stuck/)).toHaveClass('fx-bad');
    expect(
      within(testbed).getByLabelText('Accept the request and Confirm the goal: 1 waiting'),
    ).toHaveClass('fx-on');
    expect(testbed).toHaveTextContent('1 held');
    expect(testbed).toHaveTextContent('1 gate nobody can decide');
    expect(rows[1]).toHaveTextContent('killed');
    // the confidential project: its name and how many are in flight, no station, no link
    const vault = rows[2]!;
    expect(vault).toHaveClass('fx-restricted');
    expect(vault).toHaveTextContent('2 items in flight · positions hidden');
    expect(within(vault).queryByRole('link')).toBeNull();
    expect(within(vault).queryByLabelText(/^S1/)).toBeNull();
    // the totals
    expect(screen.getByText('Items in flight').parentElement).toHaveTextContent('83 projects');
    expect(screen.getByText('Coding pods busy').parentElement).toHaveTextContent('1 / 1');
  });

  it('is in the navigation for anyone signed in, and says so when there is nothing to show', async () => {
    mockApi({
      'GET /api/me': { json: me([]) },
      'GET /api/fleet': { json: { ...fleet(), projects: [] } },
    });
    renderAt('/fleet');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'All projects' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByText('No project to show')).toBeInTheDocument();
  });
});
