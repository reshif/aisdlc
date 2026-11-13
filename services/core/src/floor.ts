import { readReleaseSetting, type ConfigRegistry } from '@aisdlc/config';
import {
  FloorNode,
  LaneValues,
  applyReleaseSetting,
  ITEM_EVENT,
  ITEM_STREAM_PREFIX,
  ItemCreatedPayload,
  PrincipalId,
  ProjectId,
  WORK_EVENT,
  WorkRequestedPayload,
  gatePolicy,
  pdpResource,
  type FloorFlowHour,
  type FloorItem,
  type FloorMove,
  type FloorView,
  type FloorPlan,
  type FloorWaitingGate,
  type GateId,
  type Lane,
  type RecordEvent,
} from '@aisdlc/contracts';
import {
  gateFeasibility,
  gateHolders,
  readGateState,
  type EligibilityPort,
} from '@aisdlc/decisions';
import type { Pdp } from '@aisdlc/pdp';
import {
  EVENT_COLUMNS,
  readCheckpoint,
  runProjection,
  toRecordEvent,
  type EventRow,
  type Executor,
  type Projection,
  type Tx,
} from '@aisdlc/record';
import { sendError } from '@aisdlc/service-kit';
import {
  CataloguePinUnavailable,
  floorPlanOf,
  floorPositionOf,
  floorRouteOf,
  laneRoute,
  floorTitleOf,
  foldItem,
  pinnedCatalogueResolver,
  sessionOpen,
  type ItemState,
} from '@aisdlc/work';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { activeControls } from './controls.js';
import {
  catchUpSessionActivity,
  floorKillOf,
  floorLiveness,
  floorScoreChips,
  livenessOf,
  readActivity,
  type KillVerdictPort,
} from './floor-live.js';
import { getProjectState } from './queries.js';
import { loadProjectSettings } from './settings.js';
import { itemView } from './work-view.js';
import { displayCatalogue } from './catalogue-pin.js';

// The floor's live read model (PLAN M19, DM §3.10 ItemPosition and FlowWindow). `core.floor_position` is one row per
// item, a fold of its `item:` stream through the interpreter under the item's pinned catalogue; `core.floor_move`
// holds the moves the fold saw (F forward, B back-edge, R re-lane). Both are a function of the record alone: dropping
// them and refolding gives the same rows (`expectRebuildEqualsLive`). The plan (stations, gates, every lane's route)
// is generated from the catalogue (`floorPlanOf`), never a hand-written list (DM gap 12).
//
//   GET /v1/floor/:project?on_behalf_of=   scope work   floor.read on the project, item.view_floor per item
//
// The answer is the service's (V3/D2, titles included); the bff cuts it to the person (`cutFloorView`) and adds the
// sandbox-controller's sessions. A read model that cannot catch up is served as it is, marked `stale`.

export const FLOOR_PROJECTION = 'floor';
/** How far back the floor's flow and recent moves reach. */
export const FLOOR_WINDOW_MS = 24 * 3_600_000;

async function streamUpTo(tx: Tx, stream: string, seq: number): Promise<RecordEvent[]> {
  const q = await tx.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event
      WHERE stream = $1 AND seq <= $2 ORDER BY record_event.seq`,
    [stream, seq],
  );
  return q.rows.map(toRecordEvent);
}

/** The request text of an item's request, from its `work.requested` event (the record), or `null`. */
async function requestTextOf(tx: Tx, requestId: string): Promise<string | null> {
  const q = await tx.query<{ body: unknown }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq LIMIT 1`,
    [`work:${requestId}`, WORK_EVENT.requested],
  );
  const row = q.rows[0];
  if (!row) return null;
  const p = WorkRequestedPayload.safeParse(row.body);
  return p.success ? (p.data.request_text?.text ?? null) : null;
}

const nodeText = (n: FloorNode): string =>
  n.kind === 'station'
    ? `station:${n.stage}`
    : n.kind === 'gate'
      ? `gate:${n.key}`
      : `room:${n.room}`;

function nodeOfText(t: string): FloorNode {
  const [kind, rest] = t.split(':', 2) as [string, string];
  return FloorNode.parse(
    kind === 'station'
      ? { kind, stage: rest }
      : kind === 'gate'
        ? { kind, key: rest }
        : { kind: 'room', room: rest },
  );
}

interface Prior {
  node: string;
  in_session: boolean;
  in_session_since: Date | null;
  rework: Record<string, number>;
  relanes: number;
  title: string | null;
}

interface Row {
  lane: Lane;
  lane_bound: boolean;
  node: string;
  stage: string | null;
  step: string | null;
  phase: string;
  status: string;
  waiting: string | null;
  waiting_gates: Array<{ gate: GateId; gate_instance_id: string }>;
  holds: Array<{ hold_id: string; reason: string }>;
  in_session: boolean;
  route: string[];
  rework: Record<string, number>;
  relanes: number;
  catalogue_version: string;
  pin_unavailable: boolean;
}

function rowOf(s: ItemState): Row {
  const cat = pinnedCatalogueResolver(s.catalogue_ref);
  if (cat === null) throw new CataloguePinUnavailable(s.catalogue_ref.version);
  const p = floorPositionOf(s, cat);
  return {
    lane: s.lane ?? s.proposed_lane,
    lane_bound: s.lane !== null,
    node: nodeText(p.node),
    stage: p.stage,
    step: p.step,
    phase: s.phase,
    status: p.status,
    waiting: itemView(s).waiting,
    waiting_gates: [...p.waiting_gates],
    holds: s.holds.map((h) => ({ hold_id: h.hold_id, reason: h.reason })),
    in_session: s.lease !== null || sessionOpen(s),
    route: p.route,
    rework: { ...s.rework.by_edge },
    relanes: s.relanes.length,
    catalogue_version: s.catalogue_ref.version,
    pin_unavailable: false,
  };
}

export interface FloorSnapshot {
  positions: unknown[];
  moves: unknown[];
}

export const floorProjection: Projection<FloorSnapshot> = {
  name: FLOOR_PROJECTION,
  version: 1,
  tables: ['core.floor_position', 'core.floor_move'],

  async apply(tx: Tx, e: RecordEvent) {
    if (!e.stream_id.startsWith(ITEM_STREAM_PREFIX)) return;
    const events = await streamUpTo(tx, e.stream_id, e.stream_seq);
    const first = events[0];
    if (!first || first.type !== ITEM_EVENT.created) return;
    const created = ItemCreatedPayload.parse(first.payload);
    const q = await tx.query<Prior>(
      `SELECT node, in_session, in_session_since, rework, relanes, title FROM core.floor_position WHERE item_id = $1`,
      [created.item_id],
    );
    const prior = q.rows[0] ?? null;
    const title = prior ? prior.title : floorTitleOf(await requestTextOf(tx, created.request_id));
    let row: Row;
    let relaneEdge: string | null = null;
    try {
      const f = foldItem(events, pinnedCatalogueResolver);
      if (!f) return;
      row = rowOf(f.state);
      relaneEdge = f.state.relanes[f.state.relanes.length - 1]?.edge ?? null;
    } catch (err) {
      if (!(err instanceof CataloguePinUnavailable)) throw err;
      // The pinned catalogue is not carried by this build: the item cannot be placed. Fail closed: it is
      // drawn stuck on the holding shelf, never at a station it may not be at.
      row = {
        lane: created.proposed_lane,
        lane_bound: false,
        node: 'room:HOLD',
        stage: null,
        step: null,
        phase: 'Held',
        status: 'stuck',
        waiting: 'stuck:catalogue_pin_unavailable',
        waiting_gates: [],
        holds: [],
        in_session: false,
        route: [],
        rework: prior?.rework ?? {},
        relanes: prior?.relanes ?? 0,
        catalogue_version: created.catalogue_ref.version,
        pin_unavailable: true,
      };
    }
    // The moves of this event: each back-edge counted, a re-lane, else a forward move when the node changed.
    const moves: Array<{ kind: 'F' | 'B' | 'R'; edge: string | null }> = [];
    if (prior) {
      for (const [edge, n] of Object.entries(row.rework).sort(([a], [b]) => (a < b ? -1 : 1))) {
        for (let k = prior.rework[edge] ?? 0; k < n; k += 1) moves.push({ kind: 'B', edge });
      }
      if (row.relanes > prior.relanes) moves.push({ kind: 'R', edge: relaneEdge });
      if (moves.length === 0 && prior.node !== row.node) moves.push({ kind: 'F', edge: null });
    }
    // when the item entered the session it is in: the silence clock of SessionActivity starts there
    const inSessionSince = !row.in_session
      ? null
      : prior?.in_session && prior.in_session_since
        ? prior.in_session_since
        : new Date(e.occurred_at);
    for (const [ord, m] of moves.entries()) {
      await tx.query(
        `INSERT INTO core.floor_move (item_id, seq, ord, project_id, lane, kind, edge, from_node, to_node, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          created.item_id,
          e.stream_seq,
          ord,
          created.project_id,
          row.lane,
          m.kind,
          m.edge,
          prior?.node ?? null,
          row.node,
          e.occurred_at,
        ],
      );
    }
    await tx.query(
      `INSERT INTO core.floor_position
         (item_id, project_id, lane, lane_bound, node, stage, step, phase, status, waiting, waiting_gates, holds,
          in_session, route, requester, title, rework, relanes, catalogue_version, pin_unavailable, seq, updated_at,
          in_session_since)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (item_id) DO UPDATE SET
         lane = EXCLUDED.lane, lane_bound = EXCLUDED.lane_bound, node = EXCLUDED.node, stage = EXCLUDED.stage,
         step = EXCLUDED.step, phase = EXCLUDED.phase, status = EXCLUDED.status, waiting = EXCLUDED.waiting,
         waiting_gates = EXCLUDED.waiting_gates, holds = EXCLUDED.holds, in_session = EXCLUDED.in_session,
         route = EXCLUDED.route, rework = EXCLUDED.rework, relanes = EXCLUDED.relanes,
         pin_unavailable = EXCLUDED.pin_unavailable, seq = EXCLUDED.seq, updated_at = EXCLUDED.updated_at,
         in_session_since = EXCLUDED.in_session_since`,
      [
        created.item_id,
        created.project_id,
        row.lane,
        row.lane_bound,
        row.node,
        row.stage,
        row.step,
        row.phase,
        row.status,
        row.waiting,
        JSON.stringify(row.waiting_gates),
        JSON.stringify(row.holds),
        row.in_session,
        JSON.stringify(row.route),
        created.requester,
        title,
        JSON.stringify(row.rework),
        row.relanes,
        row.catalogue_version,
        row.pin_unavailable,
        e.stream_seq,
        e.occurred_at,
        inSessionSince,
      ],
    );
  },

  async reset(tx: Tx) {
    await tx.query('DELETE FROM core.floor_move');
    await tx.query('DELETE FROM core.floor_position');
  },

  async snapshot(db: Executor) {
    const p = await db.query(
      `SELECT item_id, project_id, lane, lane_bound, node, stage, step, phase, status, waiting, waiting_gates, holds,
              in_session, route, requester, title, rework, relanes, catalogue_version, pin_unavailable, seq, updated_at,
              in_session_since
         FROM core.floor_position ORDER BY item_id`,
    );
    const m = await db.query(
      `SELECT item_id, seq, ord, project_id, lane, kind, edge, from_node, to_node, at
         FROM core.floor_move ORDER BY item_id, seq, ord`,
    );
    return { positions: p.rows, moves: m.rows };
  },
};

/** Catches the floor up with the record; `false` when it cannot (a version mismatch needs a rebuild). */
export async function catchUpFloor(pool: pg.Pool): Promise<boolean> {
  const r = await runProjection(pool, floorProjection);
  return r.ok;
}

// ---------------------------------------------------------------- the read

export interface FloorReadDeps {
  readonly pool: pg.Pool;
  readonly now: () => Date;
  /** Who holds a slot (identity's role map); without it the deciders are unknown. */
  readonly eligibility?: EligibilityPort | undefined;
  /** The kill switch's verdict (core-worker's `/admission`); without it the floor shows the project killed (AR9). */
  readonly kill?: KillVerdictPort | undefined;
  /** The config registry, to read the project's gating profile (P2-10); without it no gate is drawn off. */
  readonly registry?: ConfigRegistry | undefined;
}

/**
 * P2-10: the plan's gate nodes no lane has under the project's gating profile now (with its release choice, the T2
 * floor and its deploys applied, as an item pinned now would have them). Anything unreadable is no gate off.
 */
async function gatesOffFor(d: FloorReadDeps, project: string, plan: FloorPlan): Promise<string[]> {
  if (!d.registry) return [];
  try {
    const settings = await loadProjectSettings(d.pool, d.registry, project as never);
    const st = await getProjectState(d.pool, project);
    if (!settings.ok || !st) return [];
    const release = await readReleaseSetting(d.pool, project);
    const profile = applyReleaseSetting(
      { ...settings.value.settings.gating_profile, project_deploys: st.project.deploys ?? null },
      release.state === 'ok' ? release.value : null,
    );
    // no signed tier yet: drawn as T2 (more gates on, never fewer)
    const tier = settings.value.tier ?? st.attestations.tier_floor ?? 'T2';
    const on = new Set<string>();
    const shown = (await displayCatalogue(d.pool)).data;
    for (const lane of LaneValues) {
      const def = shown.lanes[lane];
      if (!def) continue;
      for (const g of floorRouteOf(laneRoute(def, profile, tier)).gates) on.add(g.key);
    }
    return plan.gates.map((g) => g.key).filter((k) => !on.has(k));
  } catch {
    return [];
  }
}

interface PositionRow {
  item_id: string;
  lane: Lane;
  lane_bound: boolean;
  node: string;
  stage: string | null;
  step: string | null;
  phase: string;
  status: string;
  waiting: string | null;
  waiting_gates: Array<{ gate: GateId; gate_instance_id: string }>;
  holds: Array<{ hold_id: string; reason: string }>;
  in_session: boolean;
  route: string[];
  requester: string;
  title: string | null;
  catalogue_version: string;
  updated_at: Date;
  in_session_since: Date | null;
}

/** Who may decide a waiting gate now: the slot's holders, narrowed by the gate's own deciders; `null` when unknown. */
export async function waitingGateOf(
  d: Pick<FloorReadDeps, 'pool' | 'eligibility'>,
  project: string,
  gate: GateId,
  instance: string,
): Promise<FloorWaitingGate> {
  const slot = gatePolicy(gate).slot;
  const unknown = (why: string): FloorWaitingGate => ({
    gate,
    gate_instance_id: instance,
    slot,
    deciders: null,
    feasibility: 'unknown',
    feasibility_reason: why,
  });
  if (!d.eligibility) return unknown('who decides is unknown: no identity is configured');
  try {
    const state = await readGateState(d.pool, instance);
    if (!state) return unknown('the gate instance is not on the record');
    const h = await gateHolders(d.eligibility, project as never, slot, state.open.payload.deciders);
    const f = await gateFeasibility(d.eligibility, state.open.payload, state.approvers as never);
    return {
      gate,
      gate_instance_id: instance,
      slot,
      deciders: h.ok ? ([...h.value].sort() as never) : null,
      feasibility: f.state,
      feasibility_reason: f.reason,
    };
  } catch (e) {
    return unknown(`who decides could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The status an item is drawn with at `now`: one in a session (S6, S7) that has been silent past its station's
 * threshold is `stuck` (`stuck:silent`), whatever the fold said it was doing; held, done and declined stay.
 */
export function livePlace(
  r: Pick<PositionRow, 'status' | 'waiting' | 'in_session' | 'in_session_since' | 'stage'>,
  act: Parameters<typeof livenessOf>[1],
  liveness: Parameters<typeof livenessOf>[3],
  now: Date,
): { status: string; waiting: string | null; activity: FloorItem['activity'] } {
  if (!r.in_session) return { status: r.status, waiting: r.waiting, activity: null };
  const activity = livenessOf(r.in_session_since, act, r.stage as never, liveness, now);
  if (activity.silent && r.status === 'working') {
    return { status: 'stuck', waiting: 'stuck:silent', activity };
  }
  return { status: r.status, waiting: r.waiting, activity };
}

export const shortKey = (itemId: string): string => itemId.replace(/-/g, '').slice(0, 8);

/**
 * The floor of a project for `principal`, before the person's cut. `visible` says whether the person may see one
 * item (the PDP's `item.view_floor`); an item they may not see is left out entirely.
 */
export async function readFloor(
  d: FloorReadDeps,
  project: string,
  principal: string,
  visible: (rows: ReadonlyArray<{ item_id: string; lane: Lane }>) => Promise<ReadonlySet<string>>,
): Promise<FloorView> {
  let stale: string | null = null;
  try {
    if (!(await catchUpFloor(d.pool))) stale = 'the floor read model needs a rebuild';
    else if (!(await catchUpSessionActivity(d.pool)))
      stale = 'the session activity read model needs a rebuild';
  } catch {
    stale = 'the floor read model could not catch up with the record';
  }
  const now = d.now();
  const liveness = await floorLiveness(d.pool);
  const since = new Date(now.getTime() - FLOOR_WINDOW_MS);
  const cp = await readCheckpoint(d.pool, FLOOR_PROJECTION);
  const head = await d.pool.query<{ head: string }>(
    `SELECT COALESCE(max(global_seq), 0)::text AS head FROM record.record_event`,
  );
  const rows = await d.pool.query<PositionRow>(
    `SELECT item_id, lane, lane_bound, node, stage, step, phase, status, waiting, waiting_gates, holds, in_session,
            route, requester, title, catalogue_version, updated_at, in_session_since
       FROM core.floor_position
      WHERE project_id = $1 AND (status NOT IN ('done', 'declined') OR updated_at >= $2)
      ORDER BY updated_at, item_id
      LIMIT 1000`,
    [project, since],
  );
  const items: FloorItem[] = [];
  const shown = new Set<string>();
  const acts = await readActivity(
    d.pool,
    rows.rows.filter((r) => r.in_session).map((r) => r.item_id),
  );
  const may = await visible(rows.rows);
  for (const r of rows.rows) {
    if (!may.has(r.item_id)) continue;
    shown.add(r.item_id);
    const gates: FloorWaitingGate[] = [];
    for (const g of r.waiting_gates) {
      gates.push(await waitingGateOf(d, project, g.gate, g.gate_instance_id));
    }
    const live = livePlace(r, acts.get(r.item_id), liveness, now);
    const waitsOnMe = gates.some((g) => g.deciders?.includes(principal as never) ?? false);
    items.push({
      item_id: r.item_id as never,
      key: shortKey(r.item_id),
      lane: r.lane,
      lane_bound: r.lane_bound,
      node: nodeOfText(r.node),
      stage: r.stage as never,
      step: r.step as never,
      phase: r.phase as never,
      status: live.status as never,
      waiting: live.waiting,
      waiting_gates: gates,
      holds: r.holds,
      in_session: r.in_session,
      activity: live.activity,
      route: r.route,
      catalogue_version: r.catalogue_version,
      title: r.title,
      requester: r.requester as never,
      mine: r.requester === principal || waitsOnMe,
      waits_on_me: waitsOnMe,
      updated_at: r.updated_at.toISOString(),
    });
  }
  const mv = await d.pool.query<{
    item_id: string;
    lane: Lane;
    kind: 'F' | 'B' | 'R';
    edge: string | null;
    from_node: string | null;
    to_node: string | null;
    at: Date;
  }>(
    `SELECT item_id, lane, kind, edge, from_node, to_node, at FROM core.floor_move
      WHERE project_id = $1 AND at >= $2 ORDER BY at DESC, item_id, seq DESC, ord DESC LIMIT 2000`,
    [project, since],
  );
  const moves = mv.rows.filter((m) => shown.has(m.item_id));
  const recent: FloorMove[] = moves
    .filter((m) => m.kind !== 'F')
    .slice(0, 50)
    .map((m) => ({
      item_id: m.item_id as never,
      key: shortKey(m.item_id),
      lane: m.lane,
      kind: m.kind,
      edge: m.edge,
      from: m.from_node,
      to: m.to_node,
      at: m.at.toISOString(),
    }));
  const hourMs = 3_600_000;
  const top = Math.floor(now.getTime() / hourMs) * hourMs;
  const flow: FloorFlowHour[] = Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(top - (23 - i) * hourMs).toISOString(),
    F: 0,
    B: 0,
    R: 0,
  }));
  for (const m of moves) {
    const i = 23 - Math.floor((top - Math.floor(m.at.getTime() / hourMs) * hourMs) / hourMs);
    const bucket = flow[i];
    if (bucket) bucket[m.kind] += 1;
  }
  const controls = (await activeControls(d.pool, now))
    .filter(
      (c) =>
        c.scope.kind === 'fleet' ||
        (c.scope.kind === 'project' && c.scope.ref === project) ||
        (c.scope.kind === 'lane' && c.scope.ref.startsWith(`${project}/`)),
    )
    .map((c) => ({
      control_id: c.control_id,
      kind: c.kind,
      scope: c.scope,
      expires_at: c.expires_at,
    }));
  const asOf = cp?.last_global_seq ?? 0;
  let scores: FloorView['scores'];
  try {
    scores = await floorScoreChips(d.pool, liveness.low_score);
  } catch {
    // no chips rather than no floor: a chip that cannot be read is not drawn (never as fine)
    scores = [];
  }
  const cat = await displayCatalogue(d.pool);
  const plan = floorPlanOf(cat.data, cat.ref);
  return {
    project_id: project as never,
    plan,
    gates_off: await gatesOffFor(d, project, plan),
    items,
    recent,
    flow,
    controls,
    sessions: null,
    scores,
    kill: await floorKillOf(d.kill, { project_id: project }),
    liveness,
    freshness: {
      as_of_seq: asOf,
      head_seq: Number(head.rows[0]?.head ?? 0),
      stale: stale !== null,
      reason: stale,
      read_at: now.toISOString(),
    },
    view_level: 'V3',
    data_class: 'D2',
  };
}

// ---------------------------------------------------------------- the route

export interface FloorRouteDeps extends FloorReadDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp | undefined;
  readonly allowed: (req: FastifyRequest, scope: 'work') => boolean;
}

export function registerFloorRoutes(d: FloorRouteDeps): void {
  d.app.get('/v1/floor/:project', async (req, reply) => {
    if (!d.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const who = PrincipalId.safeParse((req.query as Record<string, string>)['on_behalf_of']);
    if (!who.success) return sendError(reply, 400, 'invalid_input', 'on_behalf_of is needed');
    const project = ProjectId.safeParse((req.params as { project: string }).project);
    if (!project.success) return sendError(reply, 400, 'invalid_input', 'bad project id');
    const pdp = d.pdp;
    if (!pdp) return sendError(reply, 503, 'unavailable', 'no policy decision point is configured');
    const p = who.data;
    let out;
    try {
      out = await pdp.decide({
        principal: p,
        action: 'floor.read',
        resource: pdpResource.project(project.data),
      });
    } catch {
      return sendError(reply, 503, 'unavailable', 'the policy decision point did not answer');
    }
    if (out.decision !== 'allow') {
      return reply.code(403).send({
        error: { code: 'forbidden', message: 'floor.read denied', reasons: out.reasons },
      });
    }
    // one batch of probes for the whole floor (M19 load test: one bundle check and one read of the person's facts,
    // not one per item); an error is no item shown (fail closed)
    const visible = async (rows: ReadonlyArray<{ item_id: string; lane: Lane }>) => {
      try {
        const answers = await pdp.decideEach(
          p,
          'item.view_floor',
          rows.map((r) => pdpResource.item(project.data, r.item_id, r.lane)),
        );
        return new Set(
          rows.filter((_, i) => answers[i]?.decision === 'allow').map((r) => r.item_id),
        );
      } catch {
        return new Set<string>();
      }
    };
    try {
      return await readFloor(d, project.data, p, visible);
    } catch {
      return sendError(reply, 503, 'unavailable', 'the floor could not be read');
    }
  });
}
