import { type CatalogueData, type LaneDef } from '@aisdlc/catalogue';
import {
  DEFAULT_GATING_PROFILE,
  FloorStage,
  GateIdValues,
  LaneValues,
  STEPS,
  type CatalogueRef,
  type FloorGateNode,
  type FloorLaneRoute,
  type FloorNode,
  type FloorPlan,
  type FloorRoom,
  type FloorItemStatus,
  type GateId,
  type PrrGatingProfile,
  type StageId,
  type StepId,
  type WorkItemPhase,
} from '@aisdlc/contracts';
import { scanText } from '@aisdlc/secrets-rules';
import { buildRoute, effectiveProfile, type Station } from './route.js';
import type { ItemState } from './state.js';

// The floor (PLAN M19, DM §3.10, DM gap 12): the plan and an item's place on it, both derived from the
// catalogue's route (`buildRoute`), never from a hand-written lane list. Pure: no I/O, no clock.

/** The floor station of a stage: S8a and S8b are one station; S0 is not on the floor. */
export function floorStageOf(stage: StageId): FloorStage | null {
  if (stage === 'S0') return null;
  if (stage === 'S8a' || stage === 'S8b') return 'S8';
  return stage;
}

const PHASE_STAGE: Readonly<Partial<Record<WorkItemPhase, FloorStage>>> = {
  Draft: 'S1',
  Clarifying: 'S1',
  S1: 'S1',
  S2: 'S2',
  S3: 'S3',
  S4: 'S4',
  S5: 'S5',
  Scheduling: 'S6',
  S6: 'S6',
  S7: 'S7',
  G4: 'S7',
  S8a: 'S8',
  S8b: 'S8',
  G5: 'S8',
  S9: 'S9',
  G6: 'S9',
};

const stepStage = (step: StepId): FloorStage => floorStageOf(STEPS[step].stage) ?? 'S1';

/** The key of a gate station on the floor: its gates joined by `+` in catalogue order. */
export const gateKeyOf = (gates: readonly GateId[]): string =>
  GateIdValues.filter((g) => gates.includes(g)).join('+');

/** The floor node key of one route station, or `null` for a marker that is not a station of its own. */
function nodeKeyOf(s: Station): string | null {
  switch (s.kind) {
    case 'step':
    case 'human':
      return stepStage(s.step);
    case 'gates':
      return gateKeyOf(s.gates);
    case 'human_led':
      return 'S6';
    case 'marker':
      return null;
  }
}

/** A lane's route on the floor: its stations and gate positions in order (consecutive repeats folded). */
export function floorRouteOf(route: readonly Station[]): {
  route: string[];
  gates: FloorGateNode[];
  human_led: boolean;
} {
  const out: string[] = [];
  const gates: FloorGateNode[] = [];
  let humanLed = false;
  for (const s of route) {
    if (s.kind === 'human_led') humanLed = true;
    const key = nodeKeyOf(s);
    if (key === null) continue;
    if (s.kind === 'gates' && !gates.some((g) => g.key === key)) {
      gates.push({
        key,
        gates: GateIdValues.filter((g) => s.gates.includes(g)),
        after_stage: stepStage(s.after),
        after_step: s.after,
      });
    }
    if (out[out.length - 1] !== key) out.push(key);
  }
  return { route: out, gates, human_led: humanLed };
}

/** Every gate a profile can switch on, on: the plan draws every gate position a project could have. */
const ALL_ON: PrrGatingProfile = { ...DEFAULT_GATING_PROFILE, project_deploys: null };

/** The route of a lane under a profile and tier, as the interpreter builds it. */
export const laneRoute = (lane: LaneDef, profile: unknown, tier: ItemState['tier']) =>
  buildRoute(lane, effectiveProfile(profile, tier));

/**
 * The floor plan of a catalogue: the nine stations, every gate position of any lane (drawn under a profile
 * with every toggle on, so nothing a project may switch on is missing), and each lane's route. Gate positions
 * are ordered by the station they follow, then by the order they appear in a route.
 */
export function floorPlanOf(
  cat: CatalogueData,
  ref: CatalogueRef,
  profile: unknown = ALL_ON,
): FloorPlan {
  const lanes: FloorLaneRoute[] = [];
  const gates: FloorGateNode[] = [];
  for (const id of LaneValues) {
    const def = cat.lanes[id];
    if (!def) continue;
    const r = floorRouteOf(laneRoute(def, profile, 'T0'));
    lanes.push({ lane: id, route: r.route, human_led: r.human_led });
    for (const g of r.gates) if (!gates.some((x) => x.key === g.key)) gates.push(g);
  }
  const order = FloorStage.options;
  gates.sort((a, b) => order.indexOf(a.after_stage) - order.indexOf(b.after_stage));
  return {
    catalogue: { version: ref.version, hash: ref.hash },
    stations: [...order],
    gates,
    lanes,
  };
}

// ---------------------------------------------------------------- an item's place

export interface FloorPosition {
  readonly node: FloorNode;
  readonly stage: FloorStage | null;
  readonly step: StepId | null;
  readonly status: FloorItemStatus;
  /** The gates the item waits at now (route or raised), with their instances. */
  readonly waiting_gates: ReadonlyArray<{ gate: GateId; gate_instance_id: string }>;
  readonly route: string[];
}

/** Gates a coding session waits on in HUMAN-WAIT: the item leaves its pod for the holding shelf. */
const HUMAN_WAIT_GATES: readonly GateId[] = ['G3o', 'X1', 'X3', 'E6'];

/** Where an item is on the floor, from its folded state and its pinned catalogue. */
export function floorPositionOf(s: ItemState, cat: CatalogueData): FloorPosition {
  const lane = cat.lanes[s.lane ?? s.proposed_lane];
  const route = lane ? laneRoute(lane, s.profile, s.tier) : [];
  const { route: keys } = floorRouteOf(route);
  const here = route[s.cursor];
  const stationStage = here ? (nodeKeyOf(here) ?? null) : null;
  const stage: FloorStage | null =
    here?.kind === 'gates'
      ? stepStage(here.after)
      : stationStage !== null && FloorStage.safeParse(stationStage).success
        ? (stationStage as FloorStage)
        : (PHASE_STAGE[s.underlying] ?? null);
  const step: StepId | null =
    here?.kind === 'step' || here?.kind === 'human'
      ? here.step
      : here?.kind === 'gates'
        ? here.after
        : null;
  const w = s.waiting;
  const pending =
    w?.kind === 'gates'
      ? s.gates
          .filter((g) => g.status === 'pending' && !g.consumed && w.gates.includes(g.gate))
          .map((g) => ({ gate: g.gate, gate_instance_id: g.gate_instance_id }))
      : [];
  const at = (node: FloorNode, status: FloorItemStatus): FloorPosition => ({
    node,
    stage,
    step,
    status,
    waiting_gates: pending,
    route: keys,
  });
  const room = (r: FloorRoom, status: FloorItemStatus) => at({ kind: 'room', room: r }, status);
  if (s.terminal !== null) {
    return {
      node: { kind: 'room', room: s.terminal === 'Done' ? 'DONE' : 'BIN' },
      stage: null,
      step: null,
      status: s.terminal === 'Done' ? 'done' : 'declined',
      waiting_gates: [],
      route: keys,
    };
  }
  const quarantined =
    s.phase === 'Quarantined' || (s.quarantines ?? []).some((q) => q.resolved === null);
  if (quarantined) return room('QUAR', 'held');
  if (w?.kind === 'handoff' || s.phase === 'Handoff') return room('DESK', 'waiting');
  if (s.holds.length > 0 || s.phase === 'Held') return room('HOLD', 'held');
  if (w?.kind === 'parked' || s.phase === 'Parked') return room('HOLD', 'waiting');
  if (w?.kind === 'release_held') return room('HOLD', 'held');
  if (w?.kind === 'stuck' || w?.kind === 'blocked') {
    return at({ kind: 'station', stage: stage ?? 'S1' }, 'stuck');
  }
  if (w?.kind === 'gates') {
    if (w.conditional !== null) {
      // A gate a stage raised mid-step: in S6 the session is released and the item waits on the shelf
      // (HUMAN-WAIT); elsewhere it waits at its station.
      if (stage === 'S6' && HUMAN_WAIT_GATES.includes(w.conditional.gate)) {
        return room('HOLD', 'waiting');
      }
      return at({ kind: 'station', stage: stage ?? 'S1' }, 'waiting');
    }
    return at({ kind: 'gate', key: gateKeyOf(w.gates) }, 'waiting');
  }
  if (s.underlying === 'Scheduling' || step === '6.0') return room('SCHED', 'waiting');
  const waits = w?.kind === 'human' || w?.kind === 'questions';
  return at({ kind: 'station', stage: stage ?? 'S1' }, waits ? 'waiting' : 'working');
}

// ---------------------------------------------------------------- the title

/** The longest title the floor shows. */
export const FLOOR_TITLE_MAX = 80;

/**
 * The floor's title of a request: its first non-empty line, at most `FLOOR_TITLE_MAX` characters. A line the
 * secret ruleset hits has no title (`null`): the floor never shows what the ruleset would refuse to store. The
 * text is data, never instructions; readers below data class D1 never get it (`cutFloorView`).
 */
export function floorTitleOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return null;
  if (scanText(line).length > 0) return null;
  return line.length > FLOOR_TITLE_MAX ? `${line.slice(0, FLOOR_TITLE_MAX - 1)}\u2026` : line;
}
