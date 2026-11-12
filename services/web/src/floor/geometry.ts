import type {
  FloorGateNode,
  FloorItem,
  FloorItemStatus,
  FloorNode,
  FloorRoom,
  FloorStage,
} from '@aisdlc/contracts';

// Where things are drawn on the floor (the design reference's plan, docs/design/portal-prototype/src/floor.js).
// Only the drawing lives here: which stations exist, which gate positions a lane has and where each sits come from
// the plan the server generates from the catalogue (`FloorPlan`). A gate position is placed by the station it
// follows, so a catalogue that adds or moves a gate moves it on the floor without a change here.

export const PLAN_W = 1500;
export const PLAN_H = 1010;
/** The belt: top run, bottom run, the right-hand drop. */
export const BT = 175;
export const BB = 721;
export const VX = 1452;
/** The two bypass tracks. */
export const Y1 = 312;
export const Y2 = 578;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const STATIONS: Readonly<Record<FloorStage, Box>> = {
  S1: { x: 50, y: 82, w: 214, h: 186 },
  S2: { x: 339, y: 82, w: 214, h: 186 },
  S3: { x: 628, y: 82, w: 214, h: 186 },
  S4: { x: 917, y: 82, w: 214, h: 186 },
  S5: { x: 1206, y: 82, w: 214, h: 186 },
  S9: { x: 50, y: 615, w: 188, h: 212 },
  S8: { x: 318, y: 615, w: 200, h: 212 },
  S7: { x: 598, y: 615, w: 186, h: 212 },
  S6: { x: 866, y: 615, w: 560, h: 212 },
};

export const ROOMS: Readonly<Record<FloorRoom, Box>> = {
  BIN: { x: 50, y: 352, w: 214, h: 196 },
  HOLD: { x: 304, y: 352, w: 241, h: 196 },
  QUAR: { x: 585, y: 352, w: 241, h: 196 },
  DESK: { x: 866, y: 352, w: 294, h: 196 },
  SCHED: { x: 1200, y: 352, w: 214, h: 196 },
  DONE: { x: 50, y: 905, w: 1376, h: 92 },
};

export type GateShape = 'belt' | 'side' | 'below';
export interface GateSpot {
  readonly x: number;
  readonly y: number;
  readonly shape: GateShape;
}

/** Where the gate positions of a plan sit: between the station they follow and the next one on the belt. */
export function gateSpots(gates: readonly FloorGateNode[]): ReadonlyMap<string, GateSpot> {
  const out = new Map<string, GateSpot>();
  const seen: Partial<Record<FloorStage, number>> = {};
  const between = (a: Box, b: Box) => (a.x + a.w + b.x) / 2;
  const back = (a: Box, b: Box) => (b.x + b.w + a.x) / 2;
  for (const g of gates) {
    const n = seen[g.after_stage] ?? 0;
    seen[g.after_stage] = n + 1;
    const shift = n * 40;
    const S = STATIONS;
    let spot: GateSpot;
    switch (g.after_stage) {
      case 'S1':
        spot = { x: between(S.S1, S.S2) + shift, y: BT, shape: 'belt' };
        break;
      case 'S2':
        spot = { x: between(S.S2, S.S3) + shift, y: BT, shape: 'belt' };
        break;
      case 'S3':
        spot = { x: between(S.S3, S.S4) + shift, y: BT, shape: 'belt' };
        break;
      case 'S4':
        spot = { x: between(S.S4, S.S5) + shift, y: BT, shape: 'belt' };
        break;
      case 'S5':
        spot = { x: VX, y: 440 + shift, shape: 'side' };
        break;
      case 'S6':
        spot = { x: back(S.S6, S.S7) - shift, y: BB, shape: 'belt' };
        break;
      case 'S7':
        spot = { x: back(S.S7, S.S8) - shift, y: BB, shape: 'belt' };
        break;
      case 'S8':
        spot = { x: back(S.S8, S.S9) - shift, y: BB, shape: 'belt' };
        break;
      case 'S9':
        spot = { x: 144 + shift, y: 868, shape: 'below' };
        break;
    }
    out.set(g.key, spot);
  }
  return out;
}

/** The coding pods inside S6: as many as the coding cap allows (at least one drawn). */
export function podBoxes(count: number): Box[] {
  const n = Math.max(1, Math.min(8, count));
  const s6 = STATIONS.S6;
  const gap = 10;
  const total = s6.w - 28;
  const w = (total - (n - 1) * gap) / n;
  return Array.from({ length: n }, (_, i) => ({
    x: s6.x + 14 + i * (w + gap),
    y: s6.y + 86,
    w,
    h: 112,
  }));
}

export interface ChipSpot {
  readonly x: number;
  readonly y: number;
  /** The pod index (0-based) when the item is in one. */
  readonly pod: number | null;
}

export const nodeKey = (n: FloorNode): string =>
  n.kind === 'station' ? n.stage : n.kind === 'gate' ? `gate:${n.key}` : `room:${n.room}`;

/** An item in a coding pod: in S6, working, with a lease or session open. */
export const inPod = (i: FloorItem): boolean =>
  i.node.kind === 'station' && i.node.stage === 'S6' && i.in_session && i.status === 'working';

const CHIP_W = 48;
const CHIP_H = 32;

/** Where each item's chip is: in a grid inside its station or room, in a column below its gate, or in a pod. */
export function layoutChips(
  items: readonly FloorItem[],
  spots: ReadonlyMap<string, GateSpot>,
  pods: readonly Box[],
): ReadonlyMap<string, ChipSpot> {
  const groups = new Map<string, FloorItem[]>();
  let podIndex = 0;
  const out = new Map<string, ChipSpot>();
  for (const it of items) {
    if (inPod(it) && podIndex < pods.length) {
      const p = pods[podIndex] as Box;
      out.set(it.item_id, { x: p.x + 58, y: p.y + 16, pod: podIndex });
      podIndex += 1;
      continue;
    }
    const k = nodeKey(it.node);
    const list = groups.get(k) ?? [];
    list.push(it);
    groups.set(k, list);
  }
  for (const list of groups.values()) {
    list.forEach((it, i) => {
      const n = it.node;
      if (n.kind === 'gate') {
        const g = spots.get(n.key) ?? { x: STATIONS.S1.x, y: BT, shape: 'belt' as const };
        const spot =
          g.shape === 'below'
            ? { x: g.x + 26 + i * CHIP_W, y: g.y - 12 }
            : { x: g.x - 22, y: g.y + 24 + i * 30 };
        out.set(it.item_id, { ...spot, pod: null });
        return;
      }
      const box = n.kind === 'station' ? STATIONS[n.stage] : ROOMS[n.room];
      const s6 = n.kind === 'station' && n.stage === 'S6';
      const left = s6 ? 250 : 14;
      const top = n.kind === 'room' ? (n.room === 'DONE' ? 44 : 66) : s6 ? 16 : 86;
      const cols = Math.max(1, Math.floor((box.w - left - 10) / CHIP_W));
      out.set(it.item_id, {
        x: box.x + left + (i % cols) * CHIP_W,
        y: box.y + top + Math.floor(i / cols) * CHIP_H,
        pod: null,
      });
    });
  }
  return out;
}

/** Counts per status for the bar. */
export function countByStatus(items: readonly FloorItem[]): Record<FloorItemStatus, number> {
  const c: Record<FloorItemStatus, number> = {
    working: 0,
    waiting: 0,
    held: 0,
    stuck: 0,
    done: 0,
    declined: 0,
  };
  for (const i of items) c[i.status] += 1;
  return c;
}

/** Two letters for a person on a gate: their principal id's first two letters, upper case. */
export const initials = (principal: string): string =>
  principal
    .split(/[._-]/)
    .filter((p) => p.length > 0)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
    .padEnd(2, principal[1]?.toUpperCase() ?? '');
