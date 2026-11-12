import { CATALOGUE, currentCatalogueRef } from '@aisdlc/catalogue';
import {
  Classification,
  FloorStage,
  feasibilityFlagged,
  type FleetView,
  type FloorProject,
  type FloorRoom,
  type GateId,
  type Lane,
} from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import { readCheckpoint } from '@aisdlc/record';
import { floorPlanOf } from '@aisdlc/work';
import {
  FLOOR_PROJECTION,
  FLOOR_WINDOW_MS,
  catchUpFloor,
  livePlace,
  waitingGateOf,
} from './floor.js';
import type { FloorReadDeps } from './floor.js';
import {
  catchUpSessionActivity,
  floorKillOf,
  floorLiveness,
  readActivity,
  recordHeartbeat,
} from './floor-live.js';
import { CORE_STATUS } from './errors.js';
import type { CoreDeps } from './journal.js';
import { catchUp } from './queries.js';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

// The fleet (PLAN M19, DM FloorProject; design reference docs/design/portal-prototype/src/floor.js `fleetRender`): one
// row per project with counts only, never an item, a key or a title. Core answers the SERVICE's view of every project
// (scope `work`); the bff cuts it per person: a confidential project the person has no role in is collapsed to how
// many items are in flight, and a project they may not see is left out (`GET /api/fleet`).
//
//   GET /v1/fleet   scope work

/** DM `opaque_key`: the first 16 hex digits of the hash of the project id. */
export const opaqueKeyOf = (project: string): string =>
  hashCanonical({ floor_project: project }).slice(0, 16);

interface Row {
  item_id: string;
  project_id: string;
  lane: Lane;
  node: string;
  stage: string | null;
  status: string;
  waiting: string | null;
  waiting_gates: Array<{ gate: GateId; gate_instance_id: string }>;
  in_session: boolean;
  in_session_since: Date | null;
  updated_at: Date;
}

export async function readFleet(d: FloorReadDeps): Promise<FleetView> {
  let stale: string | null = null;
  try {
    if (!(await catchUpFloor(d.pool))) stale = 'the floor read model needs a rebuild';
    else if (!(await catchUpSessionActivity(d.pool)))
      stale = 'the session activity read model needs a rebuild';
    await catchUp(d.pool);
  } catch {
    stale = 'the floor read model could not catch up with the record';
  }
  const now = d.now();
  const since = new Date(now.getTime() - FLOOR_WINDOW_MS);
  const liveness = await floorLiveness(d.pool);
  const projects = await d.pool.query<{
    project_id: string;
    name: string;
    team_id: string | null;
    classification: string;
    level: string | null;
  }>(
    `SELECT project_id, name, team_id, classification, level FROM core.project ORDER BY project_id`,
  );
  const rows = await d.pool.query<Row>(
    `SELECT item_id, project_id, lane, node, stage, status, waiting, waiting_gates, in_session, in_session_since,
            updated_at
       FROM core.floor_position
      WHERE status NOT IN ('done', 'declined') OR updated_at >= $1
      ORDER BY project_id, updated_at, item_id
      LIMIT 20000`,
    [since],
  );
  const acts = await readActivity(
    d.pool,
    rows.rows.filter((r) => r.in_session).map((r) => r.item_id),
  );
  const out: FloorProject[] = [];
  for (const p of projects.rows) {
    const mine = rows.rows.filter((r) => r.project_id === p.project_id);
    const row: FloorProject = {
      project_id: p.project_id as never,
      name: p.name,
      opaque_key: opaqueKeyOf(p.project_id),
      team_id: p.team_id as never,
      classification: Classification.catch('confidential').parse(p.classification),
      level: p.level,
      collapsed: null,
      in_flight: 0,
      done_24h: 0,
      stations: {},
      stuck_at: [],
      gates: {},
      rooms: {},
      status: { working: 0, waiting: 0, held: 0, stuck: 0 },
      infeasible_gates: 0,
      lanes: [],
      kill: await floorKillOf(d.kill, { project_id: p.project_id }),
    };
    const lanes = new Set<Lane>();
    const stuckAt = new Set<FloorStage>();
    for (const r of mine) {
      if (r.status === 'done' || r.status === 'declined') {
        if (r.status === 'done') row.done_24h += 1;
        continue;
      }
      row.in_flight += 1;
      lanes.add(r.lane);
      const live = livePlace(r, acts.get(r.item_id), liveness, now);
      const st = live.status as keyof FloorProject['status'];
      if (st in row.status) row.status[st] += 1;
      const [kind, ref] = r.node.split(':', 2) as [string, string];
      if (kind === 'station') {
        const s = FloorStage.parse(ref);
        row.stations[s] = (row.stations[s] ?? 0) + 1;
        if (live.status === 'stuck') stuckAt.add(s);
      } else if (kind === 'gate') {
        row.gates[ref] = (row.gates[ref] ?? 0) + 1;
      } else {
        const room = ref as FloorRoom;
        row.rooms[room] = (row.rooms[room] ?? 0) + 1;
        if (live.status === 'stuck' && r.stage) stuckAt.add(FloorStage.parse(r.stage));
      }
      for (const g of r.waiting_gates) {
        const w = await waitingGateOf(d, p.project_id, g.gate, g.gate_instance_id);
        if (feasibilityFlagged(w.feasibility)) row.infeasible_gates += 1;
      }
    }
    row.lanes = [...lanes].sort();
    row.stuck_at = FloorStage.options.filter((s) => stuckAt.has(s));
    out.push(row);
  }
  const cp = await readCheckpoint(d.pool, FLOOR_PROJECTION);
  const head = await d.pool.query<{ head: string }>(
    `SELECT COALESCE(max(global_seq), 0)::text AS head FROM record.record_event`,
  );
  return {
    plan: floorPlanOf(CATALOGUE, currentCatalogueRef()),
    projects: out,
    sessions: null,
    liveness,
    freshness: {
      as_of_seq: cp?.last_global_seq ?? 0,
      head_seq: Number(head.rows[0]?.head ?? 0),
      stale: stale !== null,
      reason: stale,
      read_at: now.toISOString(),
    },
  };
}

// ---------------------------------------------------------------- the routes

export interface FleetRouteDeps extends FloorReadDeps {
  readonly app: FastifyInstance;
  readonly allowed: (req: FastifyRequest, scope: 'work' | 'activity') => boolean;
  readonly core: CoreDeps;
}

export function registerFleetRoutes(d: FleetRouteDeps): void {
  d.app.get('/v1/fleet', async (req, reply) => {
    if (!d.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    try {
      return await readFleet(d);
    } catch {
      return sendError(reply, 503, 'unavailable', 'the fleet could not be read');
    }
  });

  /** A session reports that it is alive (recorded first; at most one per session and minute). */
  d.app.post('/v1/sessions/heartbeat', async (req, reply) => {
    if (!d.allowed(req, 'activity')) {
      return sendError(reply, 403, 'forbidden', 'scope activity is needed');
    }
    const r = await recordHeartbeat(d.core, req.body);
    if (!r.ok) return sendError(reply, CORE_STATUS[r.error.code], r.error.code, r.error.message);
    return reply.code(r.value.duplicate ? 200 : 201).send(r.value);
  });
}
