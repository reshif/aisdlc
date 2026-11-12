import { z } from 'zod';
import { GateId } from '../flow.js';
import { DataClass, Lane, StepId } from '../values.js';
import { WorkItemPhase } from '../states/work-item.js';
import { ViewLevel } from './access.js';
import { CatalogueRef } from './config.js';
import { AgentId } from './agent-definitions.js';
import { ControlKind, ControlScope } from './controls.js';
import { AgentScore } from './evals.js';
import { Classification } from './identity.js';
import { IsoDateTime, PrincipalId, ProjectId, Sha256Hex, TeamId, WorkItemId } from './ids.js';
import { RoleSlot } from './projects.js';
import { SandboxCaps, SandboxClass } from './sandbox.js';

// The floor (PLAN M19, DM §3.10, portal-coverage "floor"): where every item of a project is, read from the
// record. Three parts: the PLAN (stations, gate positions and every lane's route) is generated from the
// catalogue (`floorPlanOf` in `@aisdlc/work`, DM gap 12: never a hand-written lane list); the ITEMS are
// core's `core.floor_position` read model, a fold of the `item:` streams through the interpreter under each
// item's pinned catalogue; the MOVES (forward, back-edge, re-lane) are `core.floor_move`, derived in the
// same fold. Content-free by default: an item's title is the only content, and it is cut by data class.

/** The floor's stations: the stages an item moves through. S8a and S8b are one station (S8). */
export const FloorStage = z.enum(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
export type FloorStage = z.infer<typeof FloorStage>;

/** The side rooms: Scheduler (6.0), Holding shelf (held, parked, HUMAN-WAIT), Quarantine, Handoff desk, the bin, Done. */
export const FloorRoom = z.enum(['SCHED', 'HOLD', 'QUAR', 'DESK', 'BIN', 'DONE']);
export type FloorRoom = z.infer<typeof FloorRoom>;

/** A gate position on the belt: the gates a route opens together at one place (`G0+G1`), after a station. */
export const FloorGateNode = z.strictObject({
  /** The gates joined by `+`, in catalogue order: the node's key in a route. */
  key: z.string().regex(/^[A-Z][A-Za-z0-9]*(\+[A-Z][A-Za-z0-9]*)*$/),
  gates: z.array(GateId).min(1),
  after_stage: FloorStage,
  /** The step it follows in the route (the catalogue's position). */
  after_step: StepId,
});
export type FloorGateNode = z.infer<typeof FloorGateNode>;

/** One lane's route on the floor: station and gate keys in order (a station is a FloorStage, a gate a FloorGateNode key). */
export const FloorLaneRoute = z.strictObject({
  lane: Lane,
  route: z.array(z.string().min(1)),
  /** L8: a developer does S2-S6 (the catalogue leaves the stages unspecified); the route shows S6 for them. */
  human_led: z.boolean(),
});
export type FloorLaneRoute = z.infer<typeof FloorLaneRoute>;

/** The floor plan, a pure function of a catalogue (and the gating profile it is drawn under). */
export const FloorPlan = z.strictObject({
  catalogue: CatalogueRef,
  stations: z.array(FloorStage),
  gates: z.array(FloorGateNode),
  lanes: z.array(FloorLaneRoute),
});
export type FloorPlan = z.infer<typeof FloorPlan>;

/** Where an item is drawn. */
export const FloorNode = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('station'), stage: FloorStage }),
  z.strictObject({ kind: z.literal('gate'), key: z.string().min(1) }),
  z.strictObject({ kind: z.literal('room'), room: FloorRoom }),
]);
export type FloorNode = z.infer<typeof FloorNode>;

/** What an item is doing, in the floor's words (the prototype's states). */
export const FloorItemStatus = z.enum(['working', 'waiting', 'held', 'stuck', 'done', 'declined']);
export type FloorItemStatus = z.infer<typeof FloorItemStatus>;

// ---------------------------------------------------------------- GateFeasibility (DM §3.7, §3.10)

/**
 * `feasible`: enough eligible people (the slot's holders, narrowed by the gate's deciders, less the requester and the
 * authors where the SoD rule bars them) remain to reach the quorum frozen at open. `infeasible`: they do not (nobody
 * holds the slot, or two-person needs two and fewer can approve). `unknown`: identity could not be asked. The floor
 * and the inbox flag both `infeasible` and `unknown` (fail closed): neither ever reads as "someone will decide it".
 */
export const GateFeasibilityState = z.enum(['feasible', 'infeasible', 'unknown']);
export type GateFeasibilityState = z.infer<typeof GateFeasibilityState>;

export const GateFeasibility = z.strictObject({
  gate_instance_id: z.string().min(1),
  gate: GateId,
  state: GateFeasibilityState,
  /** The role slot that decides it (DM `missing_role` when nobody can). */
  slot: RoleSlot,
  /** Distinct approvals still needed (the frozen quorum less the approvals on the ledger). */
  needed: z.number().int().min(0),
  /** Eligible people who have not voted yet; `null`: unknown. */
  eligible: z.number().int().min(0).nullable(),
  reason: z.string().nullable(),
});
export type GateFeasibility = z.infer<typeof GateFeasibility>;

/** A gate a person must act on is flagged unless it is known to be feasible. */
export const feasibilityFlagged = (s: GateFeasibilityState): boolean => s !== 'feasible';

// ---------------------------------------------------------------- Heartbeat and SessionActivity (DM §3.6, §3.10)

/**
 * A session's heartbeat, recorded FIRST (record event `session.heartbeat` on `session:<item>`; the read model
 * `core.session_activity` is its fold). A reporter (the sandbox-controller, a runner) posts it to core
 * (`POST /v1/sessions/heartbeat`, scope `activity`); at most one is kept per session and minute (the idempotency
 * key). Content-free: who and when only.
 */
export const SESSION_EVENT = { heartbeat: 'session.heartbeat' } as const;
export const SESSION_STREAM_PREFIX = 'session:';
export const sessionStream = (itemId: string): string => `${SESSION_STREAM_PREFIX}${itemId}`;

export const SessionHeartbeat = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  /** The sandbox session (or agent run) that beats. */
  session_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  unit_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .nullable(),
  sandbox_class: SandboxClass.nullable(),
  /** When the session was last active (the reporter's clock; core records the later of nothing: never after its now). */
  at: IsoDateTime,
});
export type SessionHeartbeat = z.infer<typeof SessionHeartbeat>;

/** What counts as a session's activity: its heartbeat, a model call of the item (the gateway's record), a dispatch. */
export const ActivitySource = z.enum(['heartbeat', 'model_call', 'dispatch']);
export type ActivitySource = z.infer<typeof ActivitySource>;

/** An item's liveness while it is in a session (S6, S7): the newest activity, and the silence threshold. */
export const FloorActivity = z.strictObject({
  /** The newest activity of the item's sessions since it entered the session; `null`: none. */
  last_at: IsoDateTime.nullable(),
  source: ActivitySource.nullable(),
  /** When the item entered its session (silence counts from here when nothing beat since). */
  session_since: IsoDateTime.nullable(),
  silent_for_s: z.number().int().min(0),
  /** The threshold in force for the item's station (`factory.floor`). */
  stuck_after_s: z.number().int().min(1),
  /** Silent past the threshold: the item is drawn stuck (`waiting` = `stuck:silent`). */
  silent: z.boolean(),
});
export type FloorActivity = z.infer<typeof FloorActivity>;

/** The floor's tunables (`factory.floor`, factory layer, M1-gated like every revision). */
export const FLOOR_CONFIG_KEY = 'factory.floor';
export const FloorConfig = z.strictObject({
  /** Minutes without activity after which an item in a session is stuck (DM Heartbeat: drives `stuck`). */
  silence_minutes: z.number().int().min(1).max(1440),
  /** Per-station thresholds (DM: thresholds per step kind); a station not named uses `silence_minutes`. */
  by_stage: z.partialRecord(FloorStage, z.number().int().min(1).max(1440)),
  /** An agent score chip below this eval pass rate (or production acceptance rate) is marked low. */
  low_score: z.number().min(0).max(1),
});
export type FloorConfig = z.infer<typeof FloorConfig>;
/** The defaults: the prototype's "no heartbeat > 30m" and its 0.85 score line (docs/design/portal-prototype). */
export const DEFAULT_FLOOR_CONFIG: FloorConfig = {
  silence_minutes: 30,
  by_stage: {},
  low_score: 0.85,
};

/** The tunables in force and where they came from (`unreadable`: the published value fits no schema, the defaults are used and the floor says so). */
export const FloorLiveness = FloorConfig.extend({
  source: z.enum(['config', 'default', 'unreadable']),
});
export type FloorLiveness = z.infer<typeof FloorLiveness>;

/** The silence threshold of a station, in seconds. */
export const stuckAfterS = (c: FloorConfig, stage: FloorStage | null): number =>
  60 * ((stage === null ? undefined : c.by_stage[stage]) ?? c.silence_minutes);

// ---------------------------------------------------------------- agent score chips (DM §5.3 floor overlay)

/** One agent at a station with its score (AgentScore under the registry's current prompt, `foldAgentScores`). */
export const FloorScoreChip = z.strictObject({
  stage: FloorStage,
  agent_id: AgentId,
  name: z.string().nullable(),
  /** The registry's prompt sha the score is for (a score of an older prompt is not shown). */
  prompt_sha256: Sha256Hex,
  /** The worst of the agent's (provider, model) scores under that prompt; `null`: none yet. */
  score_id: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  pass_rate: z.number().min(0).max(1).nullable(),
  accept_rate: z.number().min(0).max(1).nullable(),
  status: AgentScore.shape.status,
  /** Below `low_score`, or `fail`/`flaky`. A chip with no score is `unknown`: neither low nor fine. */
  low: z.boolean(),
  /** The ScoreSignals behind it: eval trials and judged production runs. */
  eval_signals: z.number().int().min(0),
  production_signals: z.number().int().min(0),
});
export type FloorScoreChip = z.infer<typeof FloorScoreChip>;

// ---------------------------------------------------------------- the kill banner (AR9)

/**
 * The kill switch's verdict on agent work for the project as core-worker gives it (`GET /admission`): `clear`,
 * `killed` (a kill covers the project, a lane of it or the fleet), or `unreachable` (it could not be asked, or no
 * one configured where to ask). Per AR9 unreachable is shown as killed: `killed` is true for both.
 */
export const FloorKill = z.strictObject({
  state: z.enum(['clear', 'killed', 'unreachable']),
  killed: z.boolean(),
  kill_ids: z.array(z.string().min(1)),
  message: z.string().nullable(),
});
export type FloorKill = z.infer<typeof FloorKill>;

export const FloorWaitingGate = z.strictObject({
  gate: GateId,
  gate_instance_id: z.string().min(1),
  /** The project role slot that decides it. */
  slot: RoleSlot,
  /** Who may decide it now (the slot's holders, narrowed by the gate's own deciders); `null`: unknown. */
  deciders: z.array(PrincipalId).nullable(),
  /** DM `GateFeasibility`: can the people eligible now still reach the gate's quorum? Unknown is flagged too. */
  feasibility: GateFeasibilityState,
  /** Why it is not feasible (or unknown); `null` when feasible. */
  feasibility_reason: z.string().nullable(),
});
export type FloorWaitingGate = z.infer<typeof FloorWaitingGate>;

/** One item on the floor. `title` and `requester` are cut by the reader's view level and data class. */
export const FloorItem = z.strictObject({
  item_id: WorkItemId,
  /** A short key for the chip (the first 8 hex digits of the id). */
  key: z.string().min(1),
  lane: Lane,
  /** `false` until G0 binds the lane: the chip shows the proposed lane. */
  lane_bound: z.boolean(),
  node: FloorNode,
  /** The station of the item's position (also when it sits at a gate or in a room); `null` once closed. */
  stage: FloorStage.nullable(),
  step: StepId.nullable(),
  phase: WorkItemPhase,
  status: FloorItemStatus,
  /** What it waits for, as a short code (`gates`, `human:ready`, `parked:...`, `handoff:e4`), or `null`. */
  waiting: z.string().nullable(),
  waiting_gates: z.array(FloorWaitingGate),
  holds: z.array(z.strictObject({ hold_id: z.string().min(1), reason: z.string().min(1) })),
  /** An agent lease or a coding/verify session is open (S6, S7): the item is in a pod. */
  in_session: z.boolean(),
  /** Liveness while in a session (`null` otherwise). A silent one is `stuck` with `waiting` = `stuck:silent`. */
  activity: FloorActivity.nullable(),
  /** The item's own route, from its pinned catalogue and profile (station and gate keys). */
  route: z.array(z.string().min(1)),
  catalogue_version: z.string().min(1),
  /** The first line of the request, at data class D1 and view level V2 or above; `null` otherwise. */
  title: z.string().nullable(),
  requester: PrincipalId.nullable(),
  /** The person asking is the requester, or one of the deciders of a gate it waits at. */
  mine: z.boolean(),
  waits_on_me: z.boolean(),
  updated_at: IsoDateTime,
});
export type FloorItem = z.infer<typeof FloorItem>;

/** A move of an item from the fold: F forward, B back-edge, R re-lane (DM FlowWindow's kinds). */
export const FloorMoveKind = z.enum(['F', 'B', 'R']);
export type FloorMoveKind = z.infer<typeof FloorMoveKind>;

export const FloorMove = z.strictObject({
  item_id: WorkItemId,
  key: z.string().min(1),
  lane: Lane,
  kind: FloorMoveKind,
  /** The back-edge (B9, B13, ...) or re-lane (R1, R2); `null` for a forward move. */
  edge: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  at: IsoDateTime,
});
export type FloorMove = z.infer<typeof FloorMove>;

export const FloorFlowHour = z.strictObject({
  hour: IsoDateTime,
  F: z.number().int().min(0),
  B: z.number().int().min(0),
  R: z.number().int().min(0),
});
export type FloorFlowHour = z.infer<typeof FloorFlowHour>;

/** The sandbox-controller's sessions as the floor shows them: per class, and the coding pods. */
export const FloorSessions = z.strictObject({
  caps: SandboxCaps,
  caps_source: z.enum(['config', 'default']),
  used: z.record(SandboxClass, z.number().int().min(0)),
  free: z.record(SandboxClass, z.number().int().min(0)),
});
export type FloorSessions = z.infer<typeof FloorSessions>;

/**
 * How fresh the answer is. `stale` is set when the read model could not catch up with the record (the rows are
 * from an earlier point), and the floor shows a stale banner instead of fresh-looking data.
 */
export const FloorFreshness = z.strictObject({
  as_of_seq: z.number().int().min(0),
  head_seq: z.number().int().min(0),
  stale: z.boolean(),
  reason: z.string().nullable(),
  read_at: IsoDateTime,
});
export type FloorFreshness = z.infer<typeof FloorFreshness>;

/** `GET /v1/floor/:project` (core) and `GET /api/floor/:project` (bff, cut to the person). */
export const FloorView = z.strictObject({
  project_id: ProjectId,
  /** The plan of the catalogue current in this build (the items carry their own routes). */
  plan: FloorPlan,
  items: z.array(FloorItem),
  /** Back-edges and re-lanes of the last 24 hours, newest first (at most 50). */
  recent: z.array(FloorMove),
  /** Hourly FlowWindow counts of the last 24 hours, oldest first. */
  flow: z.array(FloorFlowHour),
  /** Active controls on the project, one of its lanes, or the fleet. */
  controls: z.array(
    z.strictObject({
      control_id: z.uuid(),
      kind: ControlKind,
      scope: ControlScope,
      expires_at: IsoDateTime.nullable(),
    }),
  ),
  /** The sandbox-controller's sessions; `null`: unknown (not configured or not reachable). Added by the bff. */
  sessions: FloorSessions.nullable(),
  /** The agents at each station with their score chips. */
  scores: z.array(FloorScoreChip),
  /** The kill switch's verdict on the project (AR9: unreachable reads killed). */
  kill: FloorKill,
  /** The silence thresholds and the score line in force. */
  liveness: FloorLiveness,
  freshness: FloorFreshness,
  /**
   * P2-10: the plan's gate nodes (keys) that no lane has under the project's current gating profile: drawn as "off for
   * this project" (an item pinned before keeps its own route). Empty when the profile cannot be read: unknown never
   * hides a gate.
   */
  gates_off: z.array(z.string().min(1)).default([]),
  /** The cut the reader got (the bff sets it; core answers at V3/D2 for the service). */
  view_level: ViewLevel,
  data_class: DataClass,
});
export type FloorView = z.infer<typeof FloorView>;

const VIEW_RANK: Readonly<Record<ViewLevel, number>> = { V1: 1, V2: 2, V3: 3 };
const DATA_RANK: Readonly<Record<DataClass, number>> = { D0: 0, D1: 1, D2: 2, D3: 3 };

/**
 * The floor cut to a reader. V1 (a viewer) sees positions, lanes and who a gate waits on, never a title or the
 * requester; a title also needs D1. The cut only removes: it never adds a field the view did not have.
 */
export function cutFloorView(v: FloorView, level: ViewLevel, dc: DataClass): FloorView {
  const titles = VIEW_RANK[level] >= 2 && DATA_RANK[dc] >= 1;
  const people = VIEW_RANK[level] >= 2;
  return {
    ...v,
    items: v.items.map((i) => ({
      ...i,
      title: titles ? i.title : null,
      requester: people ? i.requester : null,
    })),
    view_level: level,
    data_class: dc,
  };
}

// ---------------------------------------------------------------- the fleet (DM FloorProject)

/** Why a fleet row shows no positions: a confidential project the person has no role in, or no `floor.read` there. */
export const FleetCollapse = z.enum(['confidential', 'no_floor_read']);
export type FleetCollapse = z.infer<typeof FleetCollapse>;

export const FloorStatusCounts = z.strictObject({
  working: z.number().int().min(0),
  waiting: z.number().int().min(0),
  held: z.number().int().min(0),
  stuck: z.number().int().min(0),
});
export type FloorStatusCounts = z.infer<typeof FloorStatusCounts>;

/** DM `FloorProject`: one project's row of the fleet view (counts from `core.floor_position`, never an item). */
export const FloorProject = z.strictObject({
  project_id: ProjectId,
  name: z.string(),
  /** DM `opaque_key`: the hashed project id (the row's key in the web, never a lookup). */
  opaque_key: z.string().regex(/^[0-9a-f]{16}$/),
  team_id: TeamId.nullable(),
  classification: Classification,
  level: z.string().nullable(),
  /** `null`: the full row. Otherwise every count but `in_flight` is zero. */
  collapsed: FleetCollapse.nullable(),
  in_flight: z.number().int().min(0),
  done_24h: z.number().int().min(0),
  /** Items at each station (not at a gate or in a room). */
  stations: z.partialRecord(FloorStage, z.number().int().min(0)),
  /** Stations with a stuck item. */
  stuck_at: z.array(FloorStage),
  /** Items waiting at each gate key. */
  gates: z.record(z.string(), z.number().int().min(0)),
  rooms: z.partialRecord(FloorRoom, z.number().int().min(0)),
  status: FloorStatusCounts,
  /** Waiting gates whose quorum is infeasible or unknown (flagged). */
  infeasible_gates: z.number().int().min(0),
  /** Lanes of the items in flight (the lane ticks). */
  lanes: z.array(Lane),
  /** The kill switch's verdict on the project (AR9: unreachable reads killed); kept when collapsed. */
  kill: FloorKill,
});
export type FloorProject = z.infer<typeof FloorProject>;

/** `GET /v1/fleet` (core: every project, the service's view) and `GET /api/fleet` (bff: cut per project). */
export const FleetView = z.strictObject({
  plan: FloorPlan,
  projects: z.array(FloorProject),
  sessions: FloorSessions.nullable(),
  liveness: FloorLiveness,
  freshness: FloorFreshness,
});
export type FleetView = z.infer<typeof FleetView>;

/** Collapses a fleet row: the name stays, every position and count goes but how many are in flight. */
export function collapseFleetRow(p: FloorProject, why: FleetCollapse): FloorProject {
  return {
    ...p,
    collapsed: why,
    done_24h: 0,
    stations: {},
    stuck_at: [],
    gates: {},
    rooms: {},
    status: { working: 0, waiting: 0, held: 0, stuck: 0 },
    infeasible_gates: 0,
    lanes: [],
  };
}
