import { type LaneDef } from '@aisdlc/catalogue';
import {
  GATES,
  GateIdValues,
  PrrGatingProfile,
  STEPS,
  StepIdValues,
  T2_GATING_FLOOR,
  WORK_ITEM_TRANSITIONS,
  effectiveSwitch,
  type GateId,
  type Lane,
  type RaisableGate,
  type StagePortName,
  type StepId,
  type Tier,
  type WorkItemPhase,
} from '@aisdlc/contracts';

// The route of a lane, derived from the catalogue and the project's gating profile (PLAN M9.2; FL
// FIX 7; OB §1C). Nothing about a lane is written here: its stages and steps, and where its gates
// sit, are the catalogue's `LaneDef`; whether a toggleable gate is there is the pinned profile's
// switch for its group on that lane. A gate that is off is ABSENT from the route, never approved;
// the always-required gates are in the route whatever the profile says.

// ---------------------------------------------------------------- Stations

export type Station =
  /** An automated step: a stage port runs it (or the eligibility check, for 1.4). */
  | {
      readonly key: string;
      readonly kind: 'step';
      readonly step: StepId;
      readonly phase: WorkItemPhase;
    }
  /** A step only a person completes: 1.6 Ready, 5.7 (human scheduling), 8.2 (the human merges). */
  | {
      readonly key: string;
      readonly kind: 'human';
      readonly step: StepId;
      readonly what: 'ready' | 'schedule' | 'merge';
      readonly phase: WorkItemPhase;
    }
  /** L8: a developer does S2-S6; the item waits for D5 (FL: L8 -> 7.1). */
  | { readonly key: string; readonly kind: 'human_led'; readonly phase: WorkItemPhase }
  /** The gates of one position, opened together (one card where the project is a single operator). */
  | {
      readonly key: string;
      readonly kind: 'gates';
      readonly gates: readonly GateId[];
      readonly after: StepId;
      readonly phase: WorkItemPhase;
    }
  /** Passes through a phase the table needs between two others (S8b -> S9 -> G6): no work. */
  | { readonly key: string; readonly kind: 'marker'; readonly phase: WorkItemPhase };

/**
 * Steps a person completes by deciding a gate: the step IS the gate. When the gate is off the step
 * is off with it (G3d off: there is no design review at 4.6). 8.1 "G4 review" is G4, which the
 * catalogue places after 7.6.
 */
export const HUMAN_GATE_STEPS: Readonly<Partial<Record<StepId, GateId>>> = {
  '2.5': 'G1f',
  '4.6': 'G3d',
  '5.8': 'G3',
  '8.1': 'G4',
  '9.2': 'G6',
};

/** 9.5 is the async mode-E audit sample (FIX 4): a branch off 9.3, not part of the route. */
const ASYNC_STEPS: readonly StepId[] = ['9.5'];

/** What an approval of a conditional gate does (see `CONDITIONAL_GATES`). */
export type ConditionalApprove =
  /** The step runs again with the gate approved (X1, X3 at 6.4: "approved: rehydrate, resume"). */
  | 'resume'
  /** The step is taken as done and the item goes on. */
  | 'continue'
  /** The next conditional gate of the same step opens (E6 -> G3o, FL: `E6 -.-> G3o`). */
  | { readonly chain: GateId }
  /** The item goes back to a step (G3o after E6 -> 6.4). */
  | { readonly jump: StepId }
  /** E1 approved: the downshift (R2) goes to 1.3 and G0 runs again (`relane`). */
  | { readonly relane: 'down' };

/**
 * What a stage can raise mid-step, and what an approval does: `resume` runs the step again with the
 * gate approved (X1, X3 at 6.4: "approved: rehydrate, resume"); `continue` takes the step as done
 * (G3o after 6.3 -> 6.4; X2 after 7.4 -> 7.5; E2 after 4.5 -> 4.6 and after 7.5 -> 7.6). B12 is the
 * chain at 7.2: E6 (the Test Change Request) -> G3o -> back to 6.4. `approve_at` overrides the
 * default for one step. A denial is the item's edge to a handoff or a back-edge (`onDenied`, interpret.ts).
 */
export const CONDITIONAL_GATES: Readonly<
  Record<
    RaisableGate,
    {
      steps: readonly StepId[];
      on_approve: ConditionalApprove;
      approve_at?: Readonly<Partial<Record<StepId, ConditionalApprove>>>;
    }
  >
> = {
  // M13: G3o is raised at 6.3 (oracle code deviates: approved, the step is done) and, after an E6 at 6.4 (the coder
  // needs a locked test changed), at 6.4 (approved: the coder resumes). At 7.2 it follows E6 and goes back to 6.4.
  G3o: {
    steps: ['6.3', '6.4', '7.2'],
    on_approve: 'continue',
    approve_at: { '6.4': 'resume', '7.2': { jump: '6.4' } },
  },
  X1: { steps: ['6.4'], on_approve: 'resume' },
  X3: { steps: ['6.4'], on_approve: 'resume' },
  X2: { steps: ['7.4'], on_approve: 'continue' },
  // R2: the work is smaller than the lane (2.3, 4.6). Approved: back to 1.3 and G0 again; denied: stay.
  E1: { steps: ['2.3', '4.6'], on_approve: { relane: 'down' } },
  E2: { steps: ['4.5', '7.5'], on_approve: 'continue' },
  // E6, the Test Change Request on locked tests: B12 at 7.2 (S7 found a locked test must change), and from S6 the
  // coder's own request (6.4) or the oracle check's (6.3). Each chains to G3o: a changed test is an oracle deviation.
  E6: { steps: ['6.3', '6.4', '7.2'], on_approve: { chain: 'G3o' } },
};

/** What approving `gate` raised at `step` does. */
export const approveOf = (gate: RaisableGate, step: StepId): ConditionalApprove =>
  CONDITIONAL_GATES[gate].approve_at?.[step] ?? CONDITIONAL_GATES[gate].on_approve;

/** The index of the station that runs `step` (a gate's step is the station that holds its gate), or -1. */
export function stationOfStep(route: readonly Station[], step: StepId): number {
  const gate = HUMAN_GATE_STEPS[step];
  if (gate !== undefined) return stationOfGate(route, gate);
  return route.findIndex((s) => (s.kind === 'step' || s.kind === 'human') && s.step === step);
}

/** The index of the station that opens `gate`, or -1. */
export function stationOfGate(route: readonly Station[], gate: GateId): number {
  return route.findIndex((s) => s.kind === 'gates' && s.gates.includes(gate));
}

/** Which stage port runs a step: planning S1-S5, coding S6, verify S7, release S8-S9. */
export function portOfStep(step: StepId): StagePortName {
  switch (STEPS[step].stage) {
    case 'S6':
      return 'coding';
    case 'S7':
      return 'verify';
    case 'S8':
    case 'S8a':
    case 'S8b':
    case 'S9':
      return 'release';
    default:
      return 'planning';
  }
}

// ---------------------------------------------------------------- Gating profile

/**
 * The profile as the engine uses it: parsed (an unreadable one is every toggle ON: more human
 * decisions, never fewer), and with the T2 floor applied (a T2 project cannot turn off G2, G3d or G3
 * on L4-L6, or G5 where it deploys; a profile that says so is overridden, not obeyed).
 */
export function effectiveProfile(raw: unknown, tier: Tier): PrrGatingProfile {
  const parsed = PrrGatingProfile.safeParse(raw);
  const base: PrrGatingProfile = parsed.success
    ? parsed.data
    : {
        gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
        schedule: 'auto',
        tier_floor_applied: true,
        project_deploys: null,
      };
  if (tier !== 'T2') return base;
  const by_lane: NonNullable<PrrGatingProfile['by_lane']> = { ...base.by_lane };
  for (const lane of T2_GATING_FLOOR.lanes) {
    const row = { ...by_lane[lane] };
    for (const g of T2_GATING_FLOOR.groups) row[g] = 'on';
    by_lane[lane] = row;
  }
  const gates = { ...base.gates };
  if (base.project_deploys !== false) {
    gates[T2_GATING_FLOOR.deployGroup] = 'on';
    for (const lane of Object.keys(by_lane) as Lane[]) {
      const row = by_lane[lane];
      if (row?.[T2_GATING_FLOOR.deployGroup] === 'off') row[T2_GATING_FLOOR.deployGroup] = 'on';
    }
  }
  return { ...base, gates, by_lane };
}

/**
 * The gates a lane has under a profile: the lane's `required` positions, its `by_profile` positions
 * whose group is on, and the lane profile's mandatory gates (G4 in every lane but L7). A `conditional`
 * gate is not in the route: a stage raises it when its trigger fires.
 */
export function presentGates(lane: LaneDef, profile: PrrGatingProfile): Set<GateId> {
  const out = new Set<GateId>();
  for (const p of lane.gates) {
    if (p.presence === 'required') out.add(p.gate);
    else if (p.presence === 'by_profile') {
      const group = GATES[p.gate].projectToggle;
      if (group !== null && effectiveSwitch(profile, group, lane.id) === 'on') out.add(p.gate);
    }
  }
  for (const g of lane.profile.mandatory_gates) out.add(g);
  return out;
}

/** The gates of a lane that exist under `profile`, in catalogue order (for the G0 card: the lane profile). */
export const gateSetOf = (lane: LaneDef, profile: PrrGatingProfile): GateId[] => {
  const present = presentGates(lane, profile);
  return GateIdValues.filter((g) => present.has(g));
};

// ---------------------------------------------------------------- Phases

const STAGE_PHASE: Readonly<Record<string, WorkItemPhase>> = {
  S1: 'S1',
  S2: 'S2',
  S3: 'S3',
  S4: 'S4',
  S5: 'S5',
  S6: 'S6',
  S7: 'S7',
  S8: 'S8a',
  S8a: 'S8a',
  S8b: 'S8b',
  S9: 'S9',
};

const stepPhase = (step: StepId): WorkItemPhase =>
  step === '6.0' ? 'Scheduling' : (STAGE_PHASE[STEPS[step].stage] as WorkItemPhase);

const GATE_PHASE: Readonly<Partial<Record<GateId, WorkItemPhase>>> = {
  G4: 'G4',
  G5: 'G5',
  G6: 'G6',
};

/** Phases an engine route moves through; a bridge may only pass through these. */
const ROUTE_PHASES: readonly WorkItemPhase[] = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'Scheduling',
  'S6',
  'S7',
  'G4',
  'S8a',
  'S8b',
  'G5',
  'S9',
  'G6',
];

/** The phases to pass through to get from `from` to `to` over the transition table, or `null`. */
function bridge(from: WorkItemPhase, to: WorkItemPhase): WorkItemPhase[] | null {
  if (from === to || WORK_ITEM_TRANSITIONS[from].includes(to)) return [];
  const seen = new Set<WorkItemPhase>([from]);
  let frontier: Array<{ at: WorkItemPhase; via: WorkItemPhase[] }> = [{ at: from, via: [] }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { at, via } of frontier) {
      for (const p of WORK_ITEM_TRANSITIONS[at]) {
        if (seen.has(p) || !ROUTE_PHASES.includes(p)) continue;
        if (p === to) return via;
        seen.add(p);
        next.push({ at: p, via: [...via, p] });
      }
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------- The route

type RawStation = Station extends infer S
  ? S extends { phase: WorkItemPhase }
    ? Omit<S, 'phase'> & { phase?: WorkItemPhase }
    : never
  : never;

const stepsOfStage = (lane: LaneDef, stage: string): StepId[] => {
  const ls = lane.stages.find((s) => s.stage === stage);
  if (!ls) return [];
  if (ls.steps !== null) return [...ls.steps];
  // `partial` or `unspecified` with no list: the flow says "partial" and no more. The engine runs the
  // whole stage (never fewer safeguards than the flow draws), see PLAN M9.2 notes.
  return StepIdValues.filter((s) => STEPS[s].stage === stage);
};

/**
 * The stations of a lane under a profile, in order. `schedule` is the profile's: with `auto`, 5.7 is
 * not a station (6.0 admission schedules); with `human`, it is a human station.
 */
export function buildRoute(lane: LaneDef, profile: PrrGatingProfile): Station[] {
  const present = presentGates(lane, profile);
  const raw: RawStation[] = [];
  let humanLedDone = false;
  const gateAfter = (step: StepId): void => {
    const here = lane.gates
      .filter((p) => p.step === step && p.presence !== 'conditional' && present.has(p.gate))
      .map((p) => p.gate);
    if (here.length === 0) return;
    const gates = GateIdValues.filter((g) => here.includes(g));
    raw.push({ key: `g:${gates.join('+')}`, kind: 'gates', gates, after: step });
  };
  for (const ls of lane.stages) {
    if (ls.stage === 'S0') continue;
    const unspecified = ls.mode === 'unspecified';
    const beforeClose = ['S2', 'S3', 'S4', 'S5', 'S6'].includes(ls.stage);
    if (unspecified && beforeClose) {
      // L8 human-led: a developer does S2-S6 (the flow does not say which of them the lane carries).
      if (!humanLedDone) raw.push({ key: 'human_led', kind: 'human_led' });
      humanLedDone = true;
      continue;
    }
    if (ls.mode === 'skipped') continue;
    for (const step of stepsOfStage(lane, ls.stage)) {
      if (ASYNC_STEPS.includes(step)) continue;
      const gateStep = HUMAN_GATE_STEPS[step];
      if (gateStep === undefined) {
        if (step === '1.6') raw.push({ key: 'h:1.6', kind: 'human', step, what: 'ready' });
        else if (step === '5.7') {
          if (profile.schedule === 'human') {
            raw.push({ key: 'h:5.7', kind: 'human', step, what: 'schedule' });
          }
        } else if (step === '8.2') {
          raw.push({ key: 'h:8.2', kind: 'human', step, what: 'merge', phase: 'S8a' });
        } else raw.push({ key: `s:${step}`, kind: 'step', step });
      }
      gateAfter(step);
    }
  }
  // Phases: a step's stage; a gate's own phase (G4, G5, G6) or its step's; what follows G6 stays in G6
  // (the table's only exit from G6 is Done, and FL runs 9.3 and 9.4 after acceptance).
  const out: Station[] = [];
  let prev: WorkItemPhase = 'S1';
  let afterG6 = false;
  for (const r of raw) {
    let phase: WorkItemPhase;
    if (r.phase !== undefined) phase = r.phase;
    else if (r.kind === 'gates') {
      const own = r.gates.map((g) => GATE_PHASE[g]).find((p) => p !== undefined);
      phase = own ?? stepPhaseOfGateStep(r.after);
    } else if (r.kind === 'human_led') phase = 'S6';
    else if (r.kind === 'marker') phase = r.phase ?? 'S1';
    else phase = stepPhase(r.step);
    if (afterG6 && phase === 'S9') phase = 'G6';
    const via = bridge(prev, phase);
    if (via === null) throw new Error(`lane ${lane.id}: no phase path ${prev} -> ${phase}`);
    for (const p of via) out.push({ key: `m:${p}@${out.length}`, kind: 'marker', phase: p });
    out.push({ ...r, phase } as Station);
    prev = phase;
    if (r.kind === 'gates' && r.gates.includes('G6')) afterG6 = true;
  }
  return out;
}

function stepPhaseOfGateStep(step: StepId): WorkItemPhase {
  return stepPhase(step);
}

/** Index of the first station of a route that is not 1.1 or 1.2 (done at intake). */
export function firstStationAfterIntake(route: readonly Station[]): number {
  const i = route.findIndex((s) => !(s.kind === 'step' && (s.step === '1.1' || s.step === '1.2')));
  return i === -1 ? route.length : i;
}
