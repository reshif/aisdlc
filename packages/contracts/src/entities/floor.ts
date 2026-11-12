import { z } from 'zod';
import { GateId } from '../flow.js';
import { DataClass, Lane, StepId } from '../values.js';
import { WorkItemPhase } from '../states/work-item.js';
import { ViewLevel } from './access.js';
import { CatalogueRef } from './config.js';
import { ControlKind, ControlScope } from './controls.js';
import { IsoDateTime, PrincipalId, ProjectId, WorkItemId } from './ids.js';
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

export const FloorWaitingGate = z.strictObject({
  gate: GateId,
  gate_instance_id: z.string().min(1),
  /** The project role slot that decides it. */
  slot: RoleSlot,
  /** Who may decide it now (the slot's holders, narrowed by the gate's own deciders); `null`: unknown. */
  deciders: z.array(PrincipalId).nullable(),
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
  freshness: FloorFreshness,
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
