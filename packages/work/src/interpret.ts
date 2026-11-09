import { type CatalogueData } from '@aisdlc/catalogue';
import {
  ADMISSION_HOLD_PREFIX,
  BACK_EDGES,
  CAUSE_B18_REJECTED,
  CAUSE_B22_DECLINED,
  CAUSE_E4_ABANDON,
  CAUSE_E4_HANDED_OVER,
  CAUSE_PARK_TIMEOUT,
  GATE_ARTEFACT_STEPS,
  ITEM_EVENT,
  RELANE_SOURCES,
  SPAWN_RULES,
  STEP_ARTEFACT,
  canTransitionWorkItem,
  type BackEdgeId,
  type BreakerSource,
  type GateId,
  type Handoff,
  type HandoffCode,
  type ItemCommand,
  type ItemEvent,
  type ItemEventPayload,
  type Lane,
  type PrrGatingProfile,
  type RaisableGate,
  type SpawnEdge,
  type SpawnKind,
  type StepId,
  type TerminalState,
  type TriggerId,
  type WorkItemPhase,
} from '@aisdlc/contracts';
import { deterministicId, hashCanonical, sha256Hex } from '@aisdlc/kernel';
import {
  approveOf,
  buildRoute,
  effectiveProfile,
  firstStationAfterIntake,
  gateSetOf,
  portOfStep,
  stationOfGate,
  stationOfStep,
  CONDITIONAL_GATES,
  type Station,
} from './route.js';
import {
  alternativeLimit,
  effectiveLimit,
  extensionRules,
  handBackLimit,
  isCountUnit,
  reworkTotalLimit,
} from './limits.js';
import type { ItemState } from './state.js';

// The interpreter (PLAN M9.2, ADR-0001 "Departure from the runtime review"): a PURE fold over an
// item's event stream, driven by the catalogue. `interpret(state, event, catalogue, pinnedProfile)`
// returns the next state and the commands that event causes. No clock, no randomness, no I/O: the
// same events always give the same state and the same commands, with the same keys. What the item
// is waiting on is part of the state (`outstanding`), so anything the execution side loses can be
// derived again from the record alone.
//
// What it never reads: request text. The interpreter sees hashes and flags (FL FIX 15, B27), so no
// text can change a lane, a gate, a tool, an egress rule or a budget. Gates come from the catalogue
// intersected with the profile the item PINNED at creation (a later change applies to new items
// only); a gate the profile turned off is absent from the route and is never approved by anyone.

export interface InterpretResult {
  readonly state: ItemState;
  readonly commands: ItemCommand[];
}

/** The profile handed to `interpret` is not the one the item pinned: refused, never "close enough". */
export class ProfilePinMismatch extends Error {
  override readonly name = 'ProfilePinMismatch';
}
/** A transition the phase table does not allow: a bug in the route or the interpreter, never silently taken. */
export class IllegalPhaseTransition extends Error {
  override readonly name = 'IllegalPhaseTransition';
}

const MAX_IGNORED = 20;

const routeOf = (s: ItemState, cat: CatalogueData): Station[] =>
  buildRoute(cat.lanes[s.lane ?? s.proposed_lane], effectiveProfile(s.profile, s.tier));

const held = (s: ItemState): boolean => s.holds.length > 0;

/** The B1 round limit of the catalogue (2 rounds, then PARK). */
const clarifyRounds = (cat: CatalogueData): number => {
  const b1 = cat.back_edge_limits.B1;
  const l = b1.kind === 'limited' ? b1.limits.find((x) => x.key === 'rounds') : undefined;
  return l?.value ?? 2;
};

// ---------------------------------------------------------------- Phase

function setUnderlying(s: ItemState, to: WorkItemPhase): void {
  if (s.underlying === to) return;
  // A phase is entered from the phase the item is in under its holds: `Held` hides it from the table.
  if (!canTransitionWorkItem(s.underlying, to) && !(held(s) && canTransitionWorkItem('Held', to))) {
    throw new IllegalPhaseTransition(`${s.underlying} -> ${to}`);
  }
  s.underlying = to;
  s.trail.push(to);
  if (!held(s)) s.phase = to;
}

// ---------------------------------------------------------------- Commands

const cmdKey = (s: ItemState, ...parts: Array<string | number>): string =>
  [s.item_id, ...parts].join('/');

function issue(s: ItemState, c: ItemCommand, out: ItemCommand[]): void {
  s.outstanding.push(c);
  out.push(c);
}

const bump = (s: ItemState, key: string): number => {
  const n = (s.attempts[key] ?? 0) + 1;
  s.attempts[key] = n;
  return n;
};

/** The facts a card carries for a gate station: the lane profile (G0 binds it), the text hash and the B27 flags. */
function gateFacts(
  s: ItemState,
  cat: CatalogueData,
  gates: readonly GateId[],
  stationKey: string,
  extra: Record<string, unknown> = {},
) {
  const lane = s.proposed_lane;
  const def = cat.lanes[lane];
  const eff = effectiveProfile(s.profile, s.tier);
  const lane_profile = {
    lane,
    gates: gateSetOf(def, eff),
    stages: def.stages.map((x) => ({ stage: x.stage, mode: x.mode })),
    mandatory_steps: def.profile.mandatory_steps,
    mandatory_gates: def.profile.mandatory_gates,
    oracle_source: def.profile.oracle_source,
    default_envelope: def.profile.default_envelope,
  };
  const lane_profile_sha256 = hashCanonical(lane_profile);
  // M12: what the gate decides, by hash. The latest output of each step the gate binds (G1f: what S2
  // produced; G2: the spec, the oracle specs and the review beside them) is in the card and in the
  // subject hash, so a changed artefact is a different subject and an old approval cannot cover it.
  const artefacts = gates.flatMap((g) =>
    (GATE_ARTEFACT_STEPS[g] ?? []).flatMap((step) => {
      const sha256 = s.outputs[step];
      const type = STEP_ARTEFACT[step];
      return sha256 === undefined || type === undefined ? [] : [{ step, type, sha256 }];
    }),
  );
  const facts: Record<string, unknown> = {
    item_id: s.item_id,
    station: stationKey,
    gates: [...gates],
    proposed_lane: lane,
    lane_profile,
    lane_profile_sha256,
    catalogue_ref: s.catalogue_ref,
    // The request's text is DATA (FIX 15): the card carries its hash and the scan, never the text as a field.
    request_text_sha256: s.intake.text_sha256,
    request_taint: 'untrusted',
    injection: s.intake.injection,
    dedupe_links: s.intake.dedupe_links,
    conflict_candidates: s.intake.conflict_candidates,
    ...(s.review_mode !== null ? { review_mode: s.review_mode } : {}),
    ...(artefacts.length > 0 ? { artefacts } : {}),
    ...extra,
  };
  return { facts, lane_profile_sha256, artefacts };
}

function openGates(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  o: {
    stationKey: string;
    gates: readonly GateId[];
    step: StepId | null;
    /** More facts for the card (a handoff's pack, an extension's percent). */
    extra?: Record<string, unknown>;
  },
): void {
  const attempt = bump(s, `open:${o.stationKey}`);
  const { facts, lane_profile_sha256, artefacts } = gateFacts(
    s,
    cat,
    o.gates,
    o.stationKey,
    o.extra,
  );
  const subject_hash = hashCanonical({
    item_id: s.item_id,
    station: o.stationKey,
    gates: [...o.gates],
    lane: s.proposed_lane,
    lane_profile_sha256,
    text_sha256: s.intake.text_sha256,
    // A conditional gate binds what was approved before it, so a resume cannot reuse an old approval.
    approved: o.step === null ? [] : (s.approved[o.step] ?? []),
    ...(artefacts.length > 0 ? { artefacts } : {}),
    ...(o.extra ? { extra: o.extra } : {}),
  });
  issue(
    s,
    {
      type: 'open_gates',
      key: cmdKey(s, o.stationKey, 'open', attempt),
      gates: [...o.gates],
      attempt,
      subject_hash,
      facts,
    },
    out,
  );
}

// ---------------------------------------------------------------- Terminals

function terminate(
  s: ItemState,
  to: TerminalState,
  cause: string | null,
  seq: number,
  out: ItemCommand[],
): void {
  let from: WorkItemPhase = held(s) ? 'Held' : s.underlying;
  // A hold hides the phase, it does not move the item: a decision folded under a hold can still end it.
  if (!canTransitionWorkItem(from, to) && held(s)) from = s.underlying;
  if (!canTransitionWorkItem(from, to)) throw new IllegalPhaseTransition(`${from} -> ${to}`);
  s.holds = [];
  s.clock.frozen_since = null;
  s.phase = to;
  s.underlying = to;
  s.trail.push(to);
  s.terminal = to;
  s.terminal_cause = cause;
  s.waiting = null;
  s.outstanding = [];
  s.lease = null;
  s.park = null;
  s.clarify = null;
  const pending = s.gates.filter((g) => g.status === 'pending').map((g) => g.gate_instance_id);
  if (pending.length > 0) {
    const c: ItemCommand = {
      type: 'withdraw_gates',
      key: cmdKey(s, 'withdraw', seq),
      gate_instance_ids: pending,
      reason: `item ${to.toLowerCase()}`,
    };
    s.outstanding.push(c);
    out.push(c);
  }
}

// ---------------------------------------------------------------- Moving the item

/** Can the item be in `to` next: the phase table, with a hold applied on top (`Held` resumes to any holdable phase). */
const phaseReachable = (s: ItemState, to: WorkItemPhase): boolean =>
  s.underlying === to ||
  canTransitionWorkItem(s.underlying, to) ||
  (held(s) && canTransitionWorkItem('Held', to));

const stuck = (
  s: ItemState,
  reason: string,
  step: StepId | null = null,
  gate: GateId | null = null,
): void => {
  s.waiting = { kind: 'stuck', reason, step, gate };
};

/** The station's gate instances will not count again (the station was left, by approval or by an edge). */
function consumeStation(s: ItemState, station: string): void {
  s.gates = s.gates.map((g) =>
    g.station === station && g.consumed !== true ? { ...g, consumed: true } : g,
  );
}

/**
 * Leaves what the item was doing: commands that wait for an answer are dropped (their results will be
 * stale), and gates that are pending are withdrawn. A spawn, a breaker signal and an unfinished
 * withdrawal stay.
 */
function dropInFlight(s: ItemState, out: ItemCommand[], tag: string): void {
  s.outstanding = s.outstanding.filter(
    (c) => c.type === 'withdraw_gates' || c.type === 'spawn_item' || c.type === 'breaker_signal',
  );
  const pending = s.gates.filter((g) => g.status === 'pending' && g.consumed !== true);
  s.gates = s.gates.map((g) => (g.consumed === true ? g : { ...g, consumed: true }));
  if (pending.length > 0) {
    const c: ItemCommand = {
      type: 'withdraw_gates',
      key: cmdKey(s, 'withdraw', s.seq, tag),
      gate_instance_ids: pending.map((g) => g.gate_instance_id),
      reason: `item moved: ${tag}`,
    };
    s.outstanding.push(c);
    out.push(c);
  }
}

type JumpTarget = { readonly step: StepId } | { readonly gate: GateId };

/** The index of the station of a target in the item's route, when the item can go there. */
function stationFor(s: ItemState, cat: CatalogueData, t: JumpTarget): number {
  const route = routeOf(s, cat);
  const i = 'step' in t ? stationOfStep(route, t.step) : stationOfGate(route, t.gate);
  const st = route[i];
  if (st === undefined || !phaseReachable(s, st.phase)) return -1;
  return i;
}

/** Moves the cursor to a station (phase, in-flight work dropped). `false`, changing nothing, when it cannot. */
function jumpTo(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  t: JumpTarget,
  tag: string,
): boolean {
  const i = stationFor(s, cat, t);
  if (i < 0) return false;
  dropInFlight(s, out, tag);
  s.waiting = null;
  s.skip = [];
  s.relane_pending = null;
  s.cursor = i;
  setUnderlying(s, (routeOf(s, cat)[i] as Station).phase);
  return true;
}

// ---------------------------------------------------------------- The circuit breaker's inputs (R3)

/**
 * One count toward the ET14 breaker of this item's project and lane (the catalogue's `counts_from`:
 * Q1, E4 abandon, E4 takeover, the rework budget). The item keeps its own tally and issues a
 * `breaker_signal`, whose key is deterministic, so core appends it to the breaker's stream once however
 * often the item is replayed. The breaker itself, and what it does, is core's projection (M9.5).
 */
function countEt14(s: ItemState, out: ItemCommand[], source: BreakerSource, lane?: Lane): void {
  const n = (s.et14[source] ?? 0) + 1;
  s.et14[source] = n;
  issue(
    s,
    {
      type: 'breaker_signal',
      key: cmdKey(s, 'breaker', source, n),
      source,
      lane: lane ?? s.lane ?? s.proposed_lane,
    },
    out,
  );
}

// ---------------------------------------------------------------- The rework budget and back-edges

/** FIX 14: total at or over the catalogue's budget, or the item older than its age limit. */
function budgetExhausted(s: ItemState, cat: CatalogueData): boolean {
  const limit = reworkTotalLimit(cat);
  return (limit !== null && s.rework.total >= limit) || s.clock.age_exceeded;
}

interface EdgeAsk {
  readonly edge: BackEdgeId;
  /** The limit this round counts against (default: the edge's first). */
  readonly loop?: string | undefined;
  readonly observed?: number | undefined;
  /** No count of its own: only the rework budget bounds it (B15b, a runtime E2 denial). */
  readonly unbounded?: boolean;
}

type EdgeVerdict = 'loop' | 'moved';

/**
 * Counts a back-edge against the item (`rework.total`, the edge, its loop) and decides what it does:
 * `loop` (the caller takes the edge), or `moved` (the catalogue's limit or the item's budget was hit:
 * the item is already in its handoff or waiting for a person). Every edge B2-B26 adds 1, and nothing
 * ever resets the counters, so they survive a re-lane and a handoff. The limit is exceeded on the
 * round after the last allowed one: B8 "1st: split Unit" loops once, the 2nd goes to D1.
 */
function countEdge(s: ItemState, cat: CatalogueData, out: ItemCommand[], r: EdgeAsk): EdgeVerdict {
  s.rework.total += 1;
  s.rework.by_edge[r.edge] = (s.rework.by_edge[r.edge] ?? 0) + 1;
  const lim = cat.back_edge_limits[r.edge];
  let exceeded = false;
  if (lim.kind === 'limited' && r.unbounded !== true) {
    const l = r.loop === undefined ? lim.limits[0] : lim.limits.find((x) => x.key === r.loop);
    if (l !== undefined) {
      const key = `${r.edge}:${l.key}`;
      const n = (s.rework.by_loop[key] ?? 0) + 1;
      s.rework.by_loop[key] = n;
      const v = effectiveLimit(cat, l);
      if (v !== null) exceeded = isCountUnit(l.unit) ? n > v : (r.observed ?? 0) >= v;
    }
  }
  if (exceeded) {
    const then = lim.kind === 'limited' ? lim.then : null;
    exitEdge(s, cat, out, r.edge, then);
    return 'moved';
  }
  if (budgetExhausted(s, cat)) {
    // B28: straight to E4, counted toward ET14 (R3).
    s.rework.by_edge['B28'] = (s.rework.by_edge['B28'] ?? 0) + 1;
    countEt14(s, out, 'rework_budget');
    openHandoff(s, cat, out, { code: 'E4', trigger: 'B28', step: null });
    return 'moved';
  }
  return 'loop';
}

/** A limit was hit: where the catalogue sends the item (`then`); no exit named is E4, a person decides. */
function exitEdge(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  edge: BackEdgeId,
  then: string | null,
): void {
  switch (then) {
    case 'D1':
    case 'D2':
    case 'D3':
      openHandoff(s, cat, out, { code: then, trigger: edge, step: null });
      return;
    case 'ET8': {
      // "agent gave up": the ET table says which handoff (D1).
      const eff = cat.triggers.ET8.effects.find((e) => e.kind === 'handoff');
      openHandoff(s, cat, out, {
        code: eff?.kind === 'handoff' ? eff.handoff : 'E4',
        trigger: 'ET8',
        step: null,
      } as HandoffOpen);
      return;
    }
    case 'human_writes_plan':
      if (!s.human_plan) {
        s.human_plan = true;
        dropInFlight(s, out, 'human_plan');
        s.waiting = { kind: 'human', what: 'plan' };
        return;
      }
      break;
    default:
      break;
  }
  openHandoff(s, cat, out, { code: 'E4', trigger: edge, step: null });
}

// ---------------------------------------------------------------- Handoffs (D1-D3, E4)

type HandoffOpen = {
  readonly code: HandoffCode;
  readonly trigger: string;
  readonly step: StepId | null;
};

const handoffUuid = (itemId: string, n: number) =>
  deterministicId<'Handoff'>(`aisdlc.handoff:${itemId}:${n}`);

const openHandoffOf = (s: ItemState): Handoff | undefined =>
  s.handoffs.find((h) => h.status === 'open');

/** The choices open to the owner now: the ones whose target the item has (fail closed: none is not an answer). */
function validChoices(s: ItemState, cat: CatalogueData): string[] {
  const route = routeOf(s, cat);
  const h = openHandoffOf(s);
  const has = (step: StepId) => stationOfStep(route, step) >= 0;
  const out: string[] = [];
  const ran64 = (s.attempts['s:6.4'] ?? 0) > 0;
  if (ran64 && has('6.4')) out.push('resume');
  const ext = extensionRules(cat);
  if (
    h !== undefined &&
    h.code !== 'E4' &&
    ran64 &&
    has('6.4') &&
    ext.max_extensions !== null &&
    s.extensions < ext.max_extensions
  )
    out.push('extend');
  if (has('5.1')) out.push('replan');
  if (has('3.2')) out.push('respec');
  const l8 = cat.lanes.L8;
  if (l8 !== undefined) out.push('takeover');
  out.push('hand_over_close', 'abandon');
  return out;
}

/**
 * Hands the item off (D1 from S6, D2 from S7, D3 from G4, or E4 directly): the agent lease ends (the
 * session is killed, tokens revoked: M13), in-flight work is dropped, the Handoff entity is made with
 * ONE id and a Pack reference, and E4 opens. `false`, with the item stuck, when its phase has no
 * Handoff edge (a hold or Parked item: the budget flag waits for it to leave).
 */
function openHandoff(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  o: HandoffOpen,
): boolean {
  if (!phaseReachable(s, 'Handoff')) {
    stuck(s, `handoff_unreachable:${s.underlying}`);
    return false;
  }
  const origin_phase = s.underlying;
  dropInFlight(s, out, `handoff:${o.trigger}`);
  const n = s.handoffs.length + 1;
  const handoff_id = handoffUuid(s.item_id, n);
  const pack = {
    pack_id: `handoff-pack:${handoff_id}`,
    content_sha256: hashCanonical({
      item_id: s.item_id,
      n,
      code: o.code,
      trigger: o.trigger,
      origin_phase,
      rework: s.rework,
      outputs: s.outputs,
    }) as never,
  };
  const h: Handoff = {
    handoff_id: handoff_id as never,
    item_id: s.item_id as never,
    n,
    code: o.code,
    trigger: o.trigger,
    origin_phase,
    origin_step: o.step,
    pack,
    e4_gate_instance_id: null,
    e4_decided: false,
    status: 'open',
    choice: null,
    chosen_by: null,
    extension: null,
    opened_at: s.at,
    chosen_at: null,
  };
  s.handoffs.push(h);
  setUnderlying(s, 'Handoff');
  s.lease = null;
  const station = `handoff:${n}`;
  s.waiting = { kind: 'handoff', handoff_id, station, stage: 'e4' };
  openGates(s, cat, out, {
    stationKey: station,
    gates: ['E4'],
    step: null,
    extra: {
      handoff: { handoff_id, code: o.code, trigger: o.trigger, origin_phase, pack },
      valid_choices: validChoices(s, cat),
    },
  });
  return true;
}

/** B28's age limit passed while the item could not be handed off (a hold, Parked): it is, as soon as it can be. */
function ageHandoff(s: ItemState, cat: CatalogueData, out: ItemCommand[]): boolean {
  if (s.waiting?.kind === 'handoff') {
    s.clock.age_pending = false;
    return false;
  }
  if (!phaseReachable(s, 'Handoff')) return false;
  s.clock.age_pending = false;
  s.rework.by_edge['B28'] = (s.rework.by_edge['B28'] ?? 0) + 1;
  countEt14(s, out, 'rework_budget');
  return openHandoff(s, cat, out, { code: 'E4', trigger: 'B28', step: null });
}

const newLease = (s: ItemState): void => {
  s.lease_seq += 1;
  s.lease = { epoch: s.lease_seq };
};

/** E4 "answer and resume": 6.4 again, in a new session (the lease epoch is the next one). */
function resumeBuild(s: ItemState, cat: CatalogueData, out: ItemCommand[], tag: string): void {
  if (!jumpTo(s, cat, out, { step: '6.4' }, tag)) {
    stuck(s, `${tag}:no_6.4`);
    return;
  }
  newLease(s);
  advance(s, cat, out);
}

function chooseHandoff(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  p: ItemEventPayload<'item.handoff_chosen'>,
): string | null {
  const w = s.waiting;
  const h = openHandoffOf(s);
  if (w?.kind !== 'handoff' || h === undefined || h.handoff_id !== p.handoff_id)
    return 'not_waiting';
  // The owner chooses once E4 itself is decided in the ledger; never before.
  if (w.stage !== 'choice' || !h.e4_decided) return 'e4_not_decided';
  if (!validChoices(s, cat).includes(p.choice)) return `choice_not_open:${p.choice}`;
  const close = () => {
    h.status = 'chosen';
    h.choice = p.choice;
    h.chosen_by = p.by;
    h.chosen_at = s.at;
  };
  switch (p.choice) {
    case 'resume':
      close();
      resumeBuild(s, cat, out, 'e4_resume');
      return null;
    case 'extend': {
      const rules = extensionRules(cat);
      const percent = p.extension_percent;
      if (percent === undefined || rules.max_percent === null || percent > rules.max_percent)
        return 'extension_over_limit';
      const via = p.via ?? (cat.envelope_extension.via as 'E3' | 'E5');
      h.extension = { percent, via, approved: null };
      const station = `handoff:${h.n}:${via}`;
      s.waiting = { kind: 'handoff', handoff_id: h.handoff_id, station, stage: 'e3' };
      openGates(s, cat, out, {
        stationKey: station,
        gates: [via],
        step: null,
        extra: { handoff: { handoff_id: h.handoff_id, code: h.code }, extension_percent: percent },
      });
      return null;
    }
    case 'replan':
      if (!jumpTo(s, cat, out, { step: '5.1' }, 'e4_replan')) return 'no_5.1';
      close();
      advance(s, cat, out);
      return null;
    case 'respec':
      if (!jumpTo(s, cat, out, { step: '3.2' }, 'e4_respec')) return 'no_3.2';
      close();
      advance(s, cat, out);
      return null;
    case 'takeover': {
      // Lane L8, a new lease epoch (a lane attribute, not a phase: M1). D5 completes, D4 hands back.
      const lane_before: Lane = s.lane ?? s.proposed_lane;
      s.lane = 'L8';
      const i = routeOf(s, cat).findIndex((x) => x.kind === 'human_led');
      if (i < 0) {
        s.lane = lane_before;
        return 'no_human_led_station';
      }
      close();
      dropInFlight(s, out, 'e4_takeover');
      // D4 is once per item: a second takeover does not give the developer another hand-back.
      s.takeover = { lane_before, hand_backs: s.takeover?.hand_backs ?? 0 };
      s.cursor = i;
      setUnderlying(s, 'S6');
      newLease(s);
      s.waiting = { kind: 'human', what: 'human_led' };
      countEt14(s, out, 'E4_takeover', lane_before);
      return null;
    }
    case 'hand_over_close':
      close();
      terminate(s, 'HandedOverClosed', CAUSE_E4_HANDED_OVER, s.seq, out);
      countEt14(s, out, 'E4_takeover');
      return null;
    case 'abandon':
      close();
      terminate(s, 'Abandoned', p.cause ?? CAUSE_E4_ABANDON, s.seq, out);
      countEt14(s, out, 'E4_abandon');
      return null;
  }
}

/** The E4 gate and the E3/E5 gate of a handoff: read from decisions, never approved by waiting. */
function evaluateHandoffGates(s: ItemState, cat: CatalogueData, out: ItemCommand[]): void {
  const w = s.waiting;
  const h = openHandoffOf(s);
  if (w?.kind !== 'handoff' || h === undefined || w.stage === 'choice') return;
  const inst = [...s.gates].reverse().find((g) => g.station === w.station && g.consumed !== true);
  if (inst === undefined || inst.status !== 'decided') return;
  const reopen = () => {
    const pending = s.outstanding.some(
      (c) => c.type === 'open_gates' && c.key.startsWith(cmdKey(s, w.station, 'open', '')),
    );
    if (!pending) {
      consumeStation(s, w.station);
      openGates(s, cat, out, {
        stationKey: w.station,
        gates: [inst.gate],
        step: null,
        extra: { handoff: { handoff_id: h.handoff_id, code: h.code } },
      });
    }
  };
  if (w.stage === 'e4') {
    if (inst.outcome === 'approve') {
      h.e4_decided = true;
      consumeStation(s, w.station);
      s.waiting = { ...w, stage: 'choice' };
    } else reopen(); // expiry, close, a rejection: the owner still has to choose
    return;
  }
  // e3: the extension
  if (inst.outcome === 'approve' && h.extension !== null) {
    h.extension = { ...h.extension, approved: true };
    s.extensions += 1;
    s.approved['6.4'] = [...new Set([...(s.approved['6.4'] ?? []), inst.gate])];
    consumeStation(s, w.station);
    h.status = 'chosen';
    h.choice = 'extend';
    h.chosen_by = h.chosen_by ?? null;
    h.chosen_at = s.at;
    resumeBuild(s, cat, out, 'e4_extend');
  } else if (inst.outcome === 'reject' || inst.outcome === 'request_changes') {
    if (h.extension !== null) h.extension = { ...h.extension, approved: false };
    consumeStation(s, w.station);
    s.waiting = {
      kind: 'handoff',
      handoff_id: h.handoff_id,
      station: `handoff:${h.n}`,
      stage: 'choice',
    };
  } else reopen();
}

// ---------------------------------------------------------------- Denied conditional gates

/** Where a denied conditional gate leaves the item (FL FIX 1, FIX 8, B12). */
function onDenied(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  gate: RaisableGate,
  step: StepId,
  station: string,
): void {
  const key = `${gate}@${step}`;
  s.denials[key] = (s.denials[key] ?? 0) + 1;
  const n = s.denials[key] as number;
  consumeStation(s, station);
  s.waiting = null;
  const handoff = (code: HandoffCode) => {
    openHandoff(s, cat, out, { code, trigger: gate, step });
  };
  switch (key) {
    case 'X1@6.4':
      return handoff('D1');
    case 'X2@7.4':
    case 'G3o@7.2':
    case 'E6@7.2':
      return handoff('D2');
    case 'X3@6.4':
    case 'G3o@6.3': {
      // "denied: find alternative, 1x, else D1": the step runs again, told which gate was denied.
      const limit = alternativeLimit(cat);
      if (limit !== null && n <= limit) {
        s.denied[step] = [...new Set([...(s.denied[step] ?? []), gate])];
        advance(s, cat, out);
        return;
      }
      return handoff('D1');
    }
    case 'E1@2.3':
    case 'E1@4.6': {
      // R2 refused: the work stays in its lane, and the step the downshift interrupted goes on.
      const rp = s.relane_pending;
      s.relane_pending = null;
      if (rp?.resume != null) {
        s.waiting = rp.resume;
        evaluateGates(s, cat, s.seq, out);
        return;
      }
      afterStepDone(s, cat);
      advance(s, cat, out);
      return;
    }
    case 'E2@4.5': {
      // B25: redesign 1x, else E4.
      if (countEdge(s, cat, out, { edge: 'B25' }) === 'loop')
        takeEdgeTo(s, cat, out, { step: '4.1' }, 'B25');
      return;
    }
    case 'E2@7.5': {
      // "runtime exception denied: fix in S6": counted, bounded by the rework budget.
      if (countEdge(s, cat, out, { edge: 'B25', unbounded: true }) === 'loop')
        takeEdgeTo(s, cat, out, { step: '6.4' }, 'B25');
      return;
    }
    default:
      stuck(s, `${gate}:denied`, step, gate);
  }
}

/** The edge was counted and is taken: the item goes to its target and runs on. */
function takeEdgeTo(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  t: JumpTarget,
  edge: string,
): void {
  if (!jumpTo(s, cat, out, t, edge)) {
    stuck(s, `${edge}:no_target`);
    return;
  }
  advance(s, cat, out);
}

// ---------------------------------------------------------------- Spawns and assumptions

function requestSpawn(
  s: ItemState,
  out: ItemCommand[],
  edge: SpawnEdge,
  kind: SpawnKind,
  lane: Lane,
  index: number,
  seq: number,
): void {
  issue(
    s,
    {
      type: 'spawn_item',
      key: cmdKey(s, 'spawn', seq, index),
      edge,
      kind,
      lane,
      index,
      origin_seq: seq,
    },
    out,
  );
}

/** One id for one assumption, whichever of the four sources raised it. */
export const assumptionIdOf = (
  itemId: string,
  a: { origin: string; kind: string; origin_run: string | null; text_hash: string },
): string =>
  sha256Hex([itemId, a.origin, a.kind, a.origin_run ?? '', a.text_hash].join('|')).slice(0, 32);

function raiseAssumption(
  s: ItemState,
  a: {
    origin: 'thread' | 'event' | 'agent_output' | 'open_question';
    kind: 'engine' | 'intent' | 'plan' | 'spec' | 'design';
    origin_run: string | null;
    text_hash: string;
  },
): void {
  const assumption_id = assumptionIdOf(s.item_id, a);
  if (s.assumptions.some((x) => x.assumption_id === assumption_id)) return;
  s.assumptions.push({
    assumption_id,
    item_id: s.item_id as never,
    origin: a.origin,
    kind: a.kind,
    origin_run: a.origin_run,
    text_hash: a.text_hash as never,
    state: 'open',
    overridden_by: null,
    raised_at: s.at,
  });
}

// ---------------------------------------------------------------- Advance

/**
 * Runs the item forward until it needs something it does not have: a result, a decision or a person.
 * Under a hold it does not run at all: results and decisions are folded (the facts are true), the
 * cursor moves, but no new stage work starts and the item does not end; the release runs it.
 */
function advance(s: ItemState, cat: CatalogueData, out: ItemCommand[]): void {
  for (let guard = 0; guard < 200; guard++) {
    if (s.terminal !== null || held(s)) return;
    if (s.clock.age_pending && ageHandoff(s, cat, out)) return;
    if (s.waiting !== null) return;
    const route = routeOf(s, cat);
    const st = route[s.cursor];
    if (st === undefined) {
      terminate(s, 'Done', null, s.seq, out);
      return;
    }
    // G0 is absent (the profile turned it off): the Ready decision (1.6) was the human step that bound
    // the lane, so the lane is bound as soon as the item leaves S1.
    if (s.lane === null && st.phase !== 'S1') bindLane(s, 'ready_decision');
    setUnderlying(s, st.phase);
    // "Done stays done": a re-lane passes the stations of S2-S5 it found already done, and forgets them
    // once the item is past the planning stages.
    if (s.skip.length > 0) {
      if (st.phase !== 'S1' && !SKIPPABLE_PHASES.includes(st.phase)) s.skip = [];
      else if (s.skip.includes(st.key)) {
        s.cursor += 1;
        continue;
      }
    }
    switch (st.kind) {
      case 'marker':
        s.cursor += 1;
        continue;
      case 'step': {
        const attempt = bump(s, st.key);
        const key = cmdKey(s, st.key, attempt);
        if (st.step === '1.4') {
          issue(s, { type: 'check_eligibility', key, lane: s.proposed_lane }, out);
        } else {
          issue(
            s,
            {
              type: 'run_stage',
              key,
              port: portOfStep(st.step),
              step: st.step,
              attempt,
              lane: s.lane ?? s.proposed_lane,
              approved_gates: [...(s.approved[st.step] ?? [])],
              denied_gates: [...(s.denied[st.step] ?? [])],
            },
            out,
          );
        }
        s.waiting = { kind: 'command', key };
        return;
      }
      case 'human':
        // `attempts[key]` counts the visits: a re-lane or a back-edge brings the item here again
        bump(s, st.key);
        s.waiting = { kind: 'human', what: st.what };
        return;
      case 'human_led':
        s.waiting = { kind: 'human', what: 'human_led' };
        return;
      case 'gates':
        s.waiting = { kind: 'gates', station: st.key, gates: st.gates, conditional: null };
        openGates(s, cat, out, { stationKey: st.key, gates: st.gates, step: null });
        return;
    }
  }
  throw new Error('advance did not settle');
}

function bindLane(s: ItemState, by: string): void {
  if (s.lane !== null) return;
  s.lane = s.proposed_lane;
  s.lane_bound_by = by;
}

/**
 * R4: a hotfix whose release is done (it leaves S8b) auto-creates its follow-up item, the lane the
 * catalogue names for it (L1). The overdue clock and what it blocks are core's, from the SpawnLink.
 */
function hotfixFollowUp(s: ItemState, cat: CatalogueData, out: ItemCommand[], left: Station): void {
  const lane = s.lane ?? s.proposed_lane;
  const f = cat.lanes[lane].follow_up;
  if (f === null || left.phase !== 'S8b') return;
  if (
    s.spawns.some((x) => x.edge === 'R4') ||
    s.outstanding.some((c) => c.type === 'spawn_item' && c.edge === 'R4')
  )
    return;
  requestSpawn(s, out, 'R4', SPAWN_RULES.R4.kind, f.lane, 0, s.seq);
}

/** After a step completes: the agent lease ends when the item leaves S6. */
function afterStepDone(s: ItemState, cat: CatalogueData, out?: ItemCommand[]): void {
  const left = routeOf(s, cat)[s.cursor];
  s.cursor += 1;
  const next = routeOf(s, cat)[s.cursor];
  if (out !== undefined && left !== undefined && next?.phase !== 'S8b')
    hotfixFollowUp(s, cat, out, left);
  if (
    s.lease !== null &&
    next !== undefined &&
    next.phase !== 'S6' &&
    next.phase !== 'Scheduling'
  ) {
    s.lease = null;
  }
}

// ---------------------------------------------------------------- Gates

/** The edge a refused station gate takes (FL B5, B13, B18, B22-B24, B26). */
function onRefused(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  w: Extract<NonNullable<ItemState['waiting']>, { kind: 'gates' }>,
  refused: ItemState['gates'][number],
  seq: number,
): void {
  const station = w.station;
  const edgeTo = (edge: BackEdgeId, t: JumpTarget) => {
    // the target is checked before anything is counted: an edge the lane has no station for does not exist
    if (stationFor(s, cat, t) < 0)
      return stuck(s, `${refused.gate}:${refused.outcome}`, null, refused.gate);
    consumeStation(s, station);
    if (countEdge(s, cat, out, { edge }) === 'loop') takeEdgeTo(s, cat, out, t, edge);
  };
  switch (refused.gate) {
    case 'G0':
      if (refused.outcome === 'reject') {
        // B22: ineligible or unsuitable.
        terminate(s, 'Declined', CAUSE_B22_DECLINED, seq, out);
        return;
      }
      break;
    case 'G2':
      return edgeTo('B23', { step: '3.2' });
    case 'G3d':
      return edgeTo('B24', { step: '4.1' });
    case 'G3':
    case 'G3s':
      return edgeTo('B5', { step: '5.1' });
    case 'G4':
      return edgeTo('B13', { step: '6.4' });
    case 'G5': {
      // B26: release denied. Merged, not deployed: RELEASE HELD until a re-request or a NEW linked item.
      consumeStation(s, station);
      dropInFlight(s, out, 'B26');
      if (countEdge(s, cat, out, { edge: 'B26' }) === 'loop') {
        s.waiting = { kind: 'release_held', since: s.at };
      }
      return;
    }
    case 'G6': {
      // B18: the requester rejects. The item is closed and a NEW linked item carries the rework.
      s.rework.total += 1;
      s.rework.by_edge['B18'] = (s.rework.by_edge['B18'] ?? 0) + 1;
      terminate(s, 'Done', CAUSE_B18_REJECTED, seq, out);
      requestSpawn(s, out, 'B18', SPAWN_RULES.B18.kind, s.lane ?? s.proposed_lane, 0, seq);
      return;
    }
    default:
      break;
  }
  stuck(s, `${refused.gate}:${refused.outcome}`, null, refused.gate);
}

function evaluateGates(s: ItemState, cat: CatalogueData, seq: number, out: ItemCommand[]): void {
  const w = s.waiting;
  if (w?.kind !== 'gates') return;
  const station =
    w.conditional === null ? w.station : `${w.conditional.step}!${w.conditional.gate}`;
  const latest = new Map<GateId, (typeof s.gates)[number]>();
  for (const g of s.gates) if (g.station === station && g.consumed !== true) latest.set(g.gate, g);
  if (w.gates.some((g) => !latest.has(g))) return; // gates_opened has not told us the instances yet
  const mine = w.gates.map((g) => latest.get(g) as (typeof s.gates)[number]);

  const refused = mine.find((i) => i.outcome === 'reject' || i.outcome === 'request_changes');
  if (refused) {
    if (w.conditional !== null) {
      onDenied(s, cat, out, refused.gate as RaisableGate, w.conditional.step, station);
      return;
    }
    onRefused(s, cat, out, { ...w, station }, refused, seq);
    return;
  }
  // Expiry never approves: an instance that ended without a decision is opened again.
  const again = mine.filter(
    (i) => i.status === 'decided' && ['expired', 'closed', 'superseded'].includes(i.outcome ?? ''),
  );
  if (again.length > 0) {
    const reopening = s.outstanding.some(
      (c) => c.type === 'open_gates' && c.key.startsWith(cmdKey(s, station, 'open', '')),
    );
    if (!reopening) {
      openGates(s, cat, out, {
        stationKey: station,
        gates: again.map((i) => i.gate),
        step: w.conditional?.step ?? null,
      });
    }
    return;
  }
  if (!mine.every((i) => i.status === 'decided' && i.outcome === 'approve')) return;

  // Every gate of the station approved: they decide this visit of the station and no later one.
  consumeStation(s, station);
  s.waiting = null;
  if (w.conditional !== null) {
    const { step, gate } = w.conditional;
    s.approved[step] = [...new Set([...(s.approved[step] ?? []), gate])];
    const act = approveOf(gate as RaisableGate, step);
    if (act === 'continue') afterStepDone(s, cat);
    else if (act === 'resume') {
      // the cursor stays, and `advance` runs the step again with the gate approved
    } else if ('relane' in act) {
      commitR2(s, cat, out);
      return;
    } else if ('chain' in act) {
      const next = `${step}!${act.chain}`;
      s.waiting = {
        kind: 'gates',
        station: next,
        gates: [act.chain],
        conditional: { step, gate: act.chain },
      };
      openGates(s, cat, out, { stationKey: next, gates: [act.chain], step });
      return;
    } else if (!jumpTo(s, cat, out, { step: act.jump }, `${gate}@${step}`)) {
      stuck(s, `${gate}@${step}:no_${act.jump}`, step, gate);
      return;
    }
  } else {
    if (w.gates.includes('G0'))
      bindLane(s, `G0:${mine.find((i) => i.gate === 'G0')?.gate_instance_id}`);
    afterStepDone(s, cat);
  }
  advance(s, cat, out);
}

// ---------------------------------------------------------------- The interpreter

const ignore = (s: ItemState, why: string): void => {
  s.ignored = [...s.ignored, why].slice(-MAX_IGNORED);
};

function takeOutstanding(s: ItemState, key: string): ItemCommand | null {
  const i = s.outstanding.findIndex((c) => c.key === key);
  if (i === -1) return null;
  const [c] = s.outstanding.splice(i, 1);
  return c ?? null;
}

const pinOk = (a: PrrGatingProfile, b: PrrGatingProfile): boolean =>
  hashCanonical(a) === hashCanonical(b);

export function interpret(
  prior: ItemState | null,
  event: ItemEvent,
  catalogue: CatalogueData,
  pinnedProfile: PrrGatingProfile,
): InterpretResult {
  const out: ItemCommand[] = [];

  if (event.type === ITEM_EVENT.created) {
    if (prior !== null) throw new Error('item.created on an item that exists');
    const p = event.payload;
    if (!pinOk(p.gating_profile, pinnedProfile)) throw new ProfilePinMismatch(p.item_id);
    const state: ItemState = {
      item_id: p.item_id,
      project_id: p.project_id,
      request_id: p.request_id,
      repo: p.repo,
      requester: p.requester,
      channel: p.channel,
      catalogue_ref: p.catalogue_ref,
      profile: p.gating_profile,
      tier: p.tier,
      intake: p.intake,
      origin: p.origin,
      phase: 'Draft',
      underlying: 'Draft',
      proposed_lane: p.proposed_lane,
      lane: null,
      lane_bound_by: null,
      cursor: 0,
      waiting: null,
      attempts: {},
      approved: {},
      outstanding: [],
      holds: [],
      gates: [],
      questions: [],
      rounds: 0,
      lease: null,
      spawns: [],
      rework: { total: 0, by_edge: {}, by_loop: {} },
      et14: {},
      relanes: [],
      relane_pending: null,
      skip: [],
      clock: { frozen_ms: 0, frozen_since: null, age_exceeded: false, age_pending: false },
      park: null,
      clarify: null,
      handoffs: [],
      lease_seq: 0,
      review_mode: null,
      takeover: null,
      denials: {},
      denied: {},
      extensions: 0,
      human_plan: false,
      outputs: {},
      assumptions: [],
      terminal: null,
      terminal_cause: null,
      ignored: [],
      created_at: event.at,
      trail: ['Draft'],
      seq: event.seq,
      at: event.at,
    };
    return { state, commands: [] };
  }
  if (prior === null)
    throw new Error(`the first event of an item is item.created, not ${event.type}`);
  if (!pinOk(prior.profile, pinnedProfile)) throw new ProfilePinMismatch(prior.item_id);

  const s: ItemState = structuredClone(prior);
  s.seq = event.seq;
  s.at = event.at;
  s.trail = [];
  const done = (): InterpretResult => ({ state: s, commands: out });

  // A finished item takes nothing more, except the bookkeeping of what is still in flight, and the
  // NEW linked items its release and audit can still cause (B17 an escape found post-merge, B19 an
  // audit miss: both are found after the item is Done).
  if (s.terminal !== null) {
    if (event.type === ITEM_EVENT.command_done) takeOutstanding(s, event.payload.command_key);
    else if (event.type === ITEM_EVENT.gates_opened) {
      // A gate opened by a command that was already running when the item ended: close it.
      takeOutstanding(s, event.payload.command_key);
      const w: ItemCommand = {
        type: 'withdraw_gates',
        key: cmdKey(s, 'withdraw', event.seq),
        gate_instance_ids: event.payload.gates.map((g) => g.gate_instance_id),
        reason: `item ${s.terminal.toLowerCase()}`,
      };
      s.outstanding.push(w);
      out.push(w);
    } else if (event.type === ITEM_EVENT.spawned) {
      if (takeOutstanding(s, event.payload.command_key) !== null) s.spawns.push(event.payload.link);
      else ignore(s, 'spawned:stale');
    } else if (
      event.type === ITEM_EVENT.spawn_requested &&
      (event.payload.edge === 'B17' || event.payload.edge === 'B19')
    ) {
      const why = acceptSpawn(s, out, event.payload, event.seq);
      if (why !== null) ignore(s, `spawn_requested:${event.payload.edge}:${why}`);
    } else ignore(s, `${event.type}:terminal`);
    return done();
  }

  switch (event.type) {
    case ITEM_EVENT.submitted: {
      if (s.underlying !== 'Draft') {
        ignore(s, 'submitted:not_draft');
        break;
      }
      setUnderlying(s, 'S1');
      s.cursor = firstStationAfterIntake(routeOf(s, catalogue));
      advance(s, catalogue, out);
      break;
    }

    case ITEM_EVENT.stage_completed: {
      const p = event.payload;
      const c = takeOutstanding(s, p.command_key);
      if (c === null || c.type !== 'run_stage' || c.step !== p.step) {
        if (c !== null) s.outstanding.push(c);
        ignore(s, `stage_completed:${p.step}:stale`);
        break;
      }
      s.waiting = null;
      s.outputs[p.step] = p.output_hash;
      if (p.step === '1.3' && p.lane !== undefined && s.lane === null) s.proposed_lane = p.lane;
      if (p.step === '6.0' && p.lease_epoch !== undefined) {
        s.lease = { epoch: p.lease_epoch };
        s.lease_seq = Math.max(s.lease_seq, p.lease_epoch);
      }
      for (const a of p.assumptions ?? []) {
        raiseAssumption(s, {
          origin: 'agent_output',
          kind: a.kind,
          origin_run: p.command_key,
          text_hash: a.text_hash,
        });
      }
      afterStepDone(s, catalogue, out);
      advance(s, catalogue, out);
      break;
    }

    case ITEM_EVENT.stage_failed: {
      const p = event.payload;
      const c = takeOutstanding(s, p.command_key);
      if (c === null) {
        ignore(s, `stage_failed:${p.step}:stale`);
        break;
      }
      // A failure is not an edge of the flow: the item stops where it is. Nothing is retried,
      // skipped or approved on its own (a stage that wants a loop says so with `rework`).
      s.waiting = { kind: 'stuck', reason: `stage_failed:${p.code}`, step: p.step, gate: null };
      break;
    }

    case ITEM_EVENT.stage_held: {
      // 6.0 admission refused: HELD (H1 approver pool, H2 capacity, H3 env, WIP). The release loop frees
      // the hold in FIFO order by priority, and the item then asks for admission again (the next attempt).
      const p = event.payload;
      const c = takeOutstanding(s, p.command_key);
      if (c === null || c.type !== 'run_stage' || c.step !== p.step) {
        if (c !== null) s.outstanding.push(c);
        ignore(s, `stage_held:${p.step}:stale`);
        break;
      }
      s.waiting = null;
      placeHold(
        s,
        { hold_id: `${ADMISSION_HOLD_PREFIX}${p.command_key}`, reason: p.reason, origin: null },
        event.at,
      );
      break;
    }

    case ITEM_EVENT.stage_gate_needed: {
      const p = event.payload;
      const c = takeOutstanding(s, p.command_key);
      if (c === null || c.type !== 'run_stage') {
        if (c !== null) s.outstanding.push(c);
        ignore(s, `stage_gate_needed:${p.step}:stale`);
        break;
      }
      // E1 is R2's: it opens only through a relane request, which carries the lane it would go to.
      if (p.gate === 'E1' || !CONDITIONAL_GATES[p.gate].steps.includes(p.step)) {
        s.waiting = {
          kind: 'stuck',
          reason: `gate_not_raisable:${p.gate}@${p.step}`,
          step: p.step,
          gate: p.gate,
        };
        break;
      }
      if (p.gate === 'E6') {
        // B12: a locked test must change. 1x, then D2; it counts toward the rework budget.
        s.waiting = null;
        if (countEdge(s, catalogue, out, { edge: 'B12' }) === 'loop') {
          openConditional(s, catalogue, out, p.step, 'E6');
        }
        break;
      }
      openConditional(s, catalogue, out, p.step, p.gate);
      break;
    }

    case ITEM_EVENT.rework_requested: {
      const why = applyRework(s, catalogue, out, event.payload, event.seq);
      if (why !== null) ignore(s, `rework_requested:${event.payload.edge}:${why}`);
      break;
    }

    case ITEM_EVENT.relane_requested: {
      const why = applyRelane(s, catalogue, out, event.payload, event.seq);
      if (why !== null) ignore(s, `relane_requested:${event.payload.edge}:${why}`);
      break;
    }

    case ITEM_EVENT.trigger_fired: {
      const p = event.payload;
      // D1 from S6, D2 from S7, D3 from G4: the trigger's effects (the ET table) must name the handoff.
      let code = ({ S6: 'D1', S7: 'D2', G4: 'D3' } as Record<string, HandoffCode>)[s.underlying];
      // ET8 "agent gave up" (M12: a planning step whose output stayed invalid through its automatic
      // attempts, B3) is the same D1 from any planning stage, as B3's own exit to ET8 is.
      if (
        code === undefined &&
        p.trigger === 'ET8' &&
        AGENT_PLANNING_PHASES.includes(s.underlying)
      ) {
        code = 'D1';
      }
      const effect = catalogue.triggers[p.trigger as TriggerId].effects.some(
        (e) => e.kind === 'handoff' && e.handoff === code,
      );
      if (code === undefined || !effect) {
        ignore(s, `trigger_fired:${p.trigger}:not_a_handoff_from_${s.underlying}`);
        break;
      }
      if (p.command_key !== undefined && takeOutstanding(s, p.command_key) === null) {
        ignore(s, `trigger_fired:${p.trigger}:stale`);
        break;
      }
      s.waiting = null;
      openHandoff(s, catalogue, out, { code, trigger: p.trigger, step: p.step });
      break;
    }

    case ITEM_EVENT.eligibility_checked: {
      const p = event.payload;
      const c = takeOutstanding(s, p.command_key);
      if (c === null || c.type !== 'check_eligibility') {
        if (c !== null) s.outstanding.push(c);
        ignore(s, 'eligibility_checked:stale');
        break;
      }
      s.waiting = null;
      const rp = s.relane_pending;
      if (rp !== null && rp.check_key === p.command_key) {
        // R1's target lane was asked about: a lane this project may run is taken, any other is not.
        s.relane_pending = null;
        if (p.route === 'normal' && p.eligible) commitR1(s, catalogue, out, rp);
        else openHandoff(s, catalogue, out, { code: 'E4', trigger: 'R1', step: rp.step });
        break;
      }
      if (p.route === 'n8_hold') {
        // N8: no active PRR. The item waits where it is; the M4 that activates one releases the hold.
        placeHold(s, { hold_id: `n8:${p.command_key}`, reason: 'N8', origin: null }, event.at);
        break;
      }
      if (p.route === 'l8' && s.lane === null) s.proposed_lane = 'L8';
      afterStepDone(s, catalogue);
      advance(s, catalogue, out);
      break;
    }

    case ITEM_EVENT.questions_raised: {
      const p = event.payload;
      const c = takeOutstanding(s, p.command_key);
      if (c === null || c.type !== 'run_stage') {
        if (c !== null) s.outstanding.push(c);
        ignore(s, 'questions_raised:stale');
        break;
      }
      s.waiting = null;
      s.rounds += 1;
      for (const q of p.questions) {
        s.questions.push({
          question_id: q.question_id,
          item_id: s.item_id as never,
          stage: 'S1',
          step: p.step,
          round: s.rounds,
          material: q.material,
          text: q.text,
          state: 'open',
          asked_at: event.at,
          answer: null,
          answered_at: null,
        });
        // A question that does not block is proceeded on: the intent block carries it as an assumption.
        if (q.material === 'non_blocking') {
          raiseAssumption(s, {
            origin: 'open_question',
            kind: 'intent',
            origin_run: p.command_key,
            text_hash: sha256Hex(q.text),
          });
        }
      }
      const round = s.questions.filter((q) => q.round === s.rounds);
      const blocking = round.filter((q) => q.material === 'blocking');
      if (s.rounds > clarifyRounds(catalogue)) {
        // B1: at most two rounds, then PARK. Its exits: the answers arrive (back to 1.5), or the
        // 5 bd timeout ends it (Abandoned).
        setUnderlying(s, 'Parked');
        s.park = { since: event.at, frozen_base: s.clock.frozen_ms };
        s.waiting = {
          kind: 'parked',
          cause: 'b1_round_limit',
          ids: (blocking.length > 0 ? blocking : round).map((q) => q.question_id),
        };
        break;
      }
      if (blocking.length === 0) {
        afterStepDone(s, catalogue);
        advance(s, catalogue, out);
        break;
      }
      setUnderlying(s, 'Clarifying');
      s.clarify = { since: event.at, frozen_base: s.clock.frozen_ms };
      s.waiting = { kind: 'questions', ids: blocking.map((q) => q.question_id) };
      break;
    }

    case ITEM_EVENT.question_answered: {
      const p = event.payload;
      const q = s.questions.find((x) => x.question_id === p.question_id);
      if (!q || q.state !== 'open') {
        ignore(s, 'question_answered:stale');
        break;
      }
      q.state = 'answered';
      q.answer = p.answer;
      q.answered_at = event.at;
      const w = s.waiting;
      if (w?.kind === 'questions' || w?.kind === 'parked') {
        const open = w.ids.some(
          (id) => s.questions.find((x) => x.question_id === id)?.state === 'open',
        );
        if (!open) {
          // Answered: back to S1, and 1.5 runs again to write the intent block from the answers.
          s.waiting = null;
          s.clarify = null;
          s.park = null;
          setUnderlying(s, 'S1');
          advance(s, catalogue, out);
        }
      }
      break;
    }

    case ITEM_EVENT.ready_decided:
    case ITEM_EVENT.scheduled:
    case ITEM_EVENT.merge_observed:
    case ITEM_EVENT.human_work_done: {
      const want: Record<string, string[]> = {
        [ITEM_EVENT.ready_decided]: ['ready'],
        [ITEM_EVENT.scheduled]: ['schedule'],
        [ITEM_EVENT.merge_observed]: ['merge'],
        [ITEM_EVENT.human_work_done]: ['human_led', 'plan'],
      };
      if (s.waiting?.kind !== 'human' || !(want[event.type] ?? []).includes(s.waiting.what)) {
        ignore(s, `${event.type}:not_waiting`);
        break;
      }
      if (s.waiting.what === 'plan') {
        // B5: a human wrote the plan; G3 approves it (the rejections have been spent).
        s.waiting = null;
        if (!jumpTo(s, catalogue, out, { gate: 'G3' }, 'human_plan')) stuck(s, 'human_plan:no_G3');
        else advance(s, catalogue, out);
        break;
      }
      s.waiting = null;
      afterStepDone(s, catalogue);
      advance(s, catalogue, out);
      break;
    }

    case ITEM_EVENT.hand_back: {
      // D4: the developer hands the item back, once. New envelope; G3 again if the plan changed.
      const t = s.takeover;
      const limit = handBackLimit(catalogue);
      if (
        s.waiting?.kind !== 'human' ||
        s.waiting.what !== 'human_led' ||
        t === null ||
        limit === null ||
        t.hand_backs >= limit
      ) {
        ignore(s, 'hand_back:not_open');
        break;
      }
      const reentry = catalogue.lanes[t.lane_before].reentry?.D4 ?? '6.4';
      const target: JumpTarget = event.payload.plan_changed ? { gate: 'G3' } : { step: reentry };
      const laneNow = s.lane;
      s.lane = t.lane_before;
      if (stationFor(s, catalogue, target) < 0) {
        s.lane = laneNow;
        ignore(s, 'hand_back:no_target');
        break;
      }
      s.takeover = { lane_before: t.lane_before, hand_backs: t.hand_backs + 1 };
      s.lease = null;
      jumpTo(s, catalogue, out, target, 'D4');
      if (!event.payload.plan_changed) newLease(s);
      advance(s, catalogue, out);
      break;
    }

    case ITEM_EVENT.env_fixed: {
      if (s.waiting?.kind !== 'blocked') {
        ignore(s, 'env_fixed:not_blocked');
        break;
      }
      // BLOCKED -> "env fixed" -> 6.1 (provision again).
      if (!jumpTo(s, catalogue, out, { step: '6.1' }, 'env_fixed')) {
        stuck(s, 'env_fixed:no_6.1');
        break;
      }
      advance(s, catalogue, out);
      break;
    }

    case ITEM_EVENT.release_re_requested: {
      if (s.waiting?.kind !== 'release_held') {
        ignore(s, 'release_re_requested:not_held');
        break;
      }
      // RELHOLD -> "re-request after fix window" -> G5 again, on a new instance.
      if (!jumpTo(s, catalogue, out, { gate: 'G5' }, 'relhold')) {
        stuck(s, 'release_re_requested:no_G5');
        break;
      }
      advance(s, catalogue, out);
      break;
    }

    case ITEM_EVENT.handoff_chosen: {
      const why = chooseHandoff(s, catalogue, out, event.payload);
      if (why !== null) ignore(s, `handoff_chosen:${why}`);
      break;
    }

    case ITEM_EVENT.timer_fired: {
      const p = event.payload;
      // Time spent under MM-2 does not count: a frozen item fires nothing, and the facts the timer
      // was computed from must be the ones the item's own stream holds now.
      if (s.clock.frozen_since !== null) {
        ignore(s, `timer_fired:${p.timer}:frozen`);
        break;
      }
      if (Date.parse(event.at) < Date.parse(p.due_at)) {
        ignore(s, `timer_fired:${p.timer}:early`);
        break;
      }
      if (p.timer === 'park') {
        if (
          s.underlying !== 'Parked' ||
          s.park === null ||
          s.park.since !== p.since ||
          p.frozen_ms !== s.clock.frozen_ms - s.park.frozen_base
        ) {
          ignore(s, 'timer_fired:park:stale');
          break;
        }
        // PARK -> "5 bd timeout" -> ABANDONED with a cause code.
        terminate(s, 'Abandoned', CAUSE_PARK_TIMEOUT, event.seq, out);
      } else if (p.timer === 'clarify_silence') {
        if (
          s.underlying !== 'Clarifying' ||
          s.clarify === null ||
          s.clarify.since !== p.since ||
          p.frozen_ms !== s.clock.frozen_ms - s.clarify.frozen_base
        ) {
          ignore(s, 'timer_fired:clarify_silence:stale');
          break;
        }
        // Clarifying -> Parked: the requester is silent. It keeps the open questions; answers end it.
        const ids = s.questions.filter((q) => q.state === 'open').map((q) => q.question_id);
        setUnderlying(s, 'Parked');
        s.clarify = null;
        s.park = { since: event.at, frozen_base: s.clock.frozen_ms };
        s.waiting = { kind: 'parked', cause: 'clarify.silence', ids };
      } else {
        if (s.clock.age_exceeded || p.since !== s.created_at || p.frozen_ms !== s.clock.frozen_ms) {
          ignore(s, 'timer_fired:item_age:stale');
          break;
        }
        // B28: the item is older than its age limit: straight to E4, as soon as it can be handed off.
        s.clock.age_exceeded = true;
        s.clock.age_pending = true;
        advance(s, catalogue, out);
      }
      break;
    }

    case ITEM_EVENT.gates_opened: {
      const p = event.payload;
      const c = takeOutstanding(s, p.command_key);
      if (c === null) {
        // The command was dropped (the item moved on) while it was being carried out: close what it opened.
        const w: ItemCommand = {
          type: 'withdraw_gates',
          key: cmdKey(s, 'withdraw', event.seq, 'stale'),
          gate_instance_ids: p.gates.map((g) => g.gate_instance_id),
          reason: 'opened for a station the item left',
        };
        s.outstanding.push(w);
        out.push(w);
        ignore(s, 'gates_opened:stale');
        break;
      }
      if (c.type !== 'open_gates') {
        s.outstanding.push(c);
        ignore(s, 'gates_opened:stale');
        break;
      }
      const w = s.waiting;
      const station =
        w?.kind === 'gates'
          ? w.conditional === null
            ? w.station
            : `${w.conditional.step}!${w.conditional.gate}`
          : w?.kind === 'handoff'
            ? w.station
            : null;
      if (station === null) {
        ignore(s, 'gates_opened:not_waiting_for_gates');
        break;
      }
      for (const g of p.gates) {
        s.gates.push({
          gate: g.gate,
          gate_instance_id: g.gate_instance_id,
          status: 'pending',
          outcome: null,
          station,
        });
        const h = openHandoffOf(s);
        if (w?.kind === 'handoff' && w.stage === 'e4' && h !== undefined && g.gate === 'E4') {
          h.e4_gate_instance_id = g.gate_instance_id;
        }
      }
      // A decision may have been recorded before the opening was acknowledged (a replay): look again.
      if (w?.kind === 'handoff') evaluateHandoffGates(s, catalogue, out);
      else evaluateGates(s, catalogue, event.seq, out);
      break;
    }

    case ITEM_EVENT.gate_decided: {
      const p = event.payload;
      const g = s.gates.find((x) => x.gate_instance_id === p.gate_instance_id);
      if (!g || g.status === 'decided') {
        ignore(s, `gate_decided:${p.gate}:unknown_or_repeat`);
        break;
      }
      const i = s.gates.indexOf(g);
      s.gates[i] = { ...g, status: 'decided', outcome: p.outcome };
      if (s.waiting?.kind === 'handoff') evaluateHandoffGates(s, catalogue, out);
      else evaluateGates(s, catalogue, event.seq, out);
      break;
    }

    case ITEM_EVENT.hold_placed: {
      placeHold(s, event.payload, event.at);
      break;
    }

    case ITEM_EVENT.hold_released: {
      const i = s.holds.findIndex((h) => h.hold_id === event.payload.hold_id);
      if (i === -1) {
        ignore(s, 'hold_released:unknown');
        break;
      }
      s.holds.splice(i, 1);
      // MM-2 ends: the time the item spent frozen is added up, so no timer counts it.
      if (s.clock.frozen_since !== null && !s.holds.some((h) => h.reason === 'maintenance')) {
        s.clock.frozen_ms += Math.max(0, Date.parse(event.at) - Date.parse(s.clock.frozen_since));
        s.clock.frozen_since = null;
      }
      if (!held(s)) {
        // The last hold is gone: the item resumes the phase it was in, and goes on from where it was.
        s.phase = s.underlying;
        advance(s, catalogue, out);
      }
      break;
    }

    case ITEM_EVENT.abandoned: {
      // Abandoned is entered from Held, Handoff, Quarantined and Parked (the phase table): an owner
      // holds the item first, or an E4 / PARK / quarantine outcome sends it there.
      const from: WorkItemPhase = held(s) ? 'Held' : s.underlying;
      if (!canTransitionWorkItem(from, 'Abandoned')) {
        ignore(s, `abandoned:from_${from}`);
        break;
      }
      terminate(s, 'Abandoned', event.payload.cause, event.seq, out);
      break;
    }

    case ITEM_EVENT.withdrawn: {
      if (s.underlying !== 'Draft') {
        ignore(s, 'withdrawn:not_draft');
        break;
      }
      terminate(s, 'Withdrawn', null, event.seq, out);
      break;
    }

    case ITEM_EVENT.spawn_requested: {
      const why = acceptSpawn(s, out, event.payload, event.seq);
      if (why !== null) ignore(s, `spawn_requested:${event.payload.edge}:${why}`);
      break;
    }

    case ITEM_EVENT.spawned: {
      const p = event.payload;
      if (takeOutstanding(s, p.command_key) === null) {
        ignore(s, 'spawned:stale');
        break;
      }
      s.spawns.push(p.link);
      break;
    }

    case ITEM_EVENT.command_done: {
      if (takeOutstanding(s, event.payload.command_key) === null) ignore(s, 'command_done:stale');
      break;
    }

    case ITEM_EVENT.assumption_raised: {
      raiseAssumption(s, event.payload);
      break;
    }

    case ITEM_EVENT.assumption_decided: {
      const a = s.assumptions.find((x) => x.assumption_id === event.payload.assumption_id);
      if (!a || a.state !== 'open') {
        ignore(s, 'assumption_decided:unknown_or_decided');
        break;
      }
      a.state = event.payload.state;
      a.overridden_by = event.payload.state === 'overridden' ? event.payload.by : null;
      break;
    }

    default: {
      const never: never = event;
      throw new Error(`unhandled event ${JSON.stringify(never)}`);
    }
  }
  return done();
}

// ---------------------------------------------------------------- Edges asked for by an event

/** The edges a stage raises, and the ones a person or a monitor reports (FL `from` of each). */
const STAGE_EDGES: readonly BackEdgeId[] = [
  'B2',
  'B3',
  'B6',
  'B7',
  'B8',
  'B9',
  'B10',
  'B11',
  'B12',
];
const OBSERVED_EDGES: readonly BackEdgeId[] = ['B4', 'B14', 'B15', 'B20'];
/** B20 "any active stage": the phases that have an edge to S3 (or are S3). */
const AMEND_PHASES: readonly WorkItemPhase[] = [
  'S2',
  'S3',
  'S4',
  'S5',
  'Scheduling',
  'S6',
  'S7',
  'G4',
];

/** Phases whose stations a re-lane may find already done. */
const SKIPPABLE_PHASES: readonly WorkItemPhase[] = ['S2', 'S3', 'S4', 'S5'];
const PLANNING_STAGES: readonly string[] = ['S2', 'S3', 'S4'];
/** The stages whose steps a planning agent runs (S1 to S5): where ET8 "agent gave up" is a D1. */
const AGENT_PLANNING_PHASES: readonly string[] = ['S1', 'S2', 'S3', 'S4', 'S5'];

/**
 * How much planning a lane carries: its stations in S2-S5 under the item's profile. R1 only goes to a
 * lane with more, R2 only to a lane with less; nothing here names a lane (L7 and L8 are not part of
 * the ladder: a spike and a human-led item are neither up nor down from the others).
 */
function planningDepth(s: ItemState, cat: CatalogueData, lane: Lane): number {
  const route = buildRoute(cat.lanes[lane], effectiveProfile(s.profile, s.tier));
  return route.filter((st) => st.kind !== 'marker' && SKIPPABLE_PHASES.includes(st.phase)).length;
}

const LADDER_EXCLUDED: readonly Lane[] = ['L7', 'L8'];

/** Stations of `route` (S2-S5) already done: a step with an output, a station whose gates were approved. */
function doneStations(s: ItemState, route: readonly Station[]): Set<string> {
  const done = new Set<string>();
  for (const st of route) {
    if (!SKIPPABLE_PHASES.includes(st.phase)) continue;
    if (st.kind === 'step' && s.outputs[st.step] !== undefined) done.add(st.key);
    if (st.kind === 'gates') {
      const latest = new Map<GateId, string | null>();
      for (const g of s.gates) if (g.station === st.key) latest.set(g.gate, g.outcome);
      if (st.gates.every((g) => latest.get(g) === 'approve')) done.add(st.key);
    }
  }
  return done;
}

/**
 * R1 and R2 asked for. Returns why it was not taken (nothing changed), or `null`. R1 comes from a stage
 * (6.5, 7.3, 7.4 for X2) against its own command; R2 from a stage at 2.3 or observed at 4.6 while the
 * design review is open. `RELANE_SOURCES` says which steps may say which trigger.
 */
function applyRelane(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  p: ItemEventPayload<'item.relane_requested'>,
  seq: number,
): string | null {
  const sources = RELANE_SOURCES[p.edge] as Readonly<Record<string, readonly string[]>>;
  if (!(sources[p.step] ?? []).includes(p.trigger)) return `not_raisable_at_${p.step}`;
  if (s.relane_pending !== null) return 'relane_pending';
  const from = s.lane ?? s.proposed_lane;
  if (LADDER_EXCLUDED.includes(from) || LADDER_EXCLUDED.includes(p.to_lane))
    return 'not_on_the_ladder';
  if (p.to_lane === from) return 'same_lane';
  const up = planningDepth(s, cat, p.to_lane) > planningDepth(s, cat, from);
  const down = planningDepth(s, cat, p.to_lane) < planningDepth(s, cat, from);
  if (p.edge === 'R1' && !up) return 'not_an_upshift';
  if (p.edge === 'R2' && !down) return 'not_a_downshift';

  const pending = {
    edge: p.edge,
    trigger: p.trigger,
    from_lane: from,
    to_lane: p.to_lane,
    step: p.step,
    asked_seq: seq,
  } as const;

  if (p.edge === 'R1') {
    const c =
      p.command_key === undefined ? undefined : s.outstanding.find((x) => x.key === p.command_key);
    if (c === undefined || c.type !== 'run_stage') return 'stale';
    if (c.step !== p.step) return `wrong_step:${c.step}`;
    takeOutstanding(s, c.key);
    s.waiting = null;
    // The target lane must be one the project may run (1.4 again): R1 is free, not a way round it.
    const key = cmdKey(s, 'relane', seq, 'eligibility');
    s.relane_pending = { ...pending, check_key: key, resume: null };
    issue(s, { type: 'check_eligibility', key, lane: p.to_lane }, out);
    s.waiting = { kind: 'command', key };
    return null;
  }

  // R2: needs E1. At 2.3 the stage raised it; at 4.6 it is observed while G3d is open.
  if (p.step === '2.3') {
    const c =
      p.command_key === undefined ? undefined : s.outstanding.find((x) => x.key === p.command_key);
    if (c === undefined || c.type !== 'run_stage') return 'stale';
    if (c.step !== p.step) return `wrong_step:${c.step}`;
    takeOutstanding(s, c.key);
    s.waiting = null;
    s.relane_pending = { ...pending, check_key: null, resume: null };
    openConditional(s, cat, out, '2.3', 'E1');
    return null;
  }
  const w = s.waiting;
  if (w?.kind !== 'gates' || w.conditional !== null || !w.gates.includes('G3d'))
    return 'not_at_4.6';
  s.relane_pending = { ...pending, check_key: null, resume: w };
  openConditional(s, cat, out, '4.6', 'E1');
  return null;
}

/**
 * R1 takes effect: the lane changes (free, logged), and the item goes to the FIRST stage of S2, S3 or
 * S4 that the new lane has and the item has not done. What it did stays done: the stations after the
 * inserted one that are done are passed. With nothing missing the item goes on where it was.
 */
function commitR1(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  rp: NonNullable<ItemState['relane_pending']>,
): void {
  const origin = s.underlying;
  s.lane = rp.to_lane;
  s.proposed_lane = rp.to_lane;
  s.lane_bound_by = `R1:${s.seq}`;
  const route = routeOf(s, cat);
  const done = doneStations(s, route);
  const first = route.findIndex(
    (st) =>
      st.kind !== 'marker' &&
      PLANNING_STAGES.includes(st.phase) &&
      st.phase !== 'S5' &&
      !done.has(st.key),
  );
  const target = first < 0 ? undefined : route[first];
  const step: StepId =
    target === undefined
      ? rp.step
      : target.kind === 'step' || target.kind === 'human'
        ? target.step
        : target.kind === 'gates'
          ? target.after
          : rp.step;
  s.relanes.push({
    edge: 'R1',
    trigger: rp.trigger,
    from_lane: rp.from_lane,
    to_lane: rp.to_lane,
    step: rp.step,
    target: step,
    asked_seq: rp.asked_seq,
    applied_seq: s.seq,
  });
  if (target === undefined) {
    // nothing to insert: the item goes on in the new lane from where it was
    const here = stationOfStep(route, rp.step);
    if (here < 0) return stuck(s, `R1:no_station_for_${rp.step}`);
    s.cursor = here;
    advance(s, cat, out);
    return;
  }
  dropInFlight(s, out, 'R1');
  s.waiting = null;
  s.lease = null;
  s.cursor = first;
  if (!phaseReachable(s, target.phase)) return stuck(s, `R1:${origin}_to_${target.phase}`);
  setUnderlying(s, target.phase);
  s.skip = [...done].filter((k) => route.findIndex((x) => x.key === k) > first);
  advance(s, cat, out);
}

/** R2 takes effect (E1 approved): back to 1.3 in the new lane, G0 again; what is done stays done. */
function commitR2(s: ItemState, cat: CatalogueData, out: ItemCommand[]): void {
  const rp = s.relane_pending;
  if (rp === null) return stuck(s, 'R2:not_pending');
  s.relane_pending = null;
  const before = { lane: s.lane, proposed: s.proposed_lane, by: s.lane_bound_by };
  s.proposed_lane = rp.to_lane;
  s.lane = null;
  s.lane_bound_by = null;
  if (!jumpTo(s, cat, out, { step: '1.3' }, 'R2')) {
    s.proposed_lane = before.proposed;
    s.lane = before.lane;
    s.lane_bound_by = before.by;
    return stuck(s, 'R2:no_1.3');
  }
  s.lease = null;
  s.relanes.push({
    edge: 'R2',
    trigger: rp.trigger,
    from_lane: rp.from_lane,
    to_lane: rp.to_lane,
    step: rp.step,
    target: '1.3',
    asked_seq: rp.asked_seq,
    applied_seq: s.seq,
  });
  s.skip = [...doneStations(s, routeOf(s, cat))];
  advance(s, cat, out);
}

function openConditional(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  step: StepId,
  gate: RaisableGate,
): void {
  const stationKey = `${step}!${gate}`;
  s.waiting = { kind: 'gates', station: stationKey, gates: [gate], conditional: { step, gate } };
  openGates(s, cat, out, { stationKey, gates: [gate], step });
}

/**
 * One back-edge asked for. Returns why it was not taken (and nothing was changed), or `null`. A stage
 * raises its edge against its own command; the observed ones (B4 the design reviewer, B14 the unsure
 * approver, B15 the merge, B20 the requester) are checked against what the item waits for.
 */
function applyRework(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  p: ItemEventPayload<'item.rework_requested'>,
  seq: number,
): string | null {
  const edge = p.edge;
  const from = BACK_EDGES[edge].from;
  const to = BACK_EDGES[edge].to;
  const stepTarget = (i: number): JumpTarget | null => {
    const t = to[i];
    return t === undefined || t === 'REQ' ? null : { step: t as StepId };
  };

  if (p.command_key !== undefined) {
    if (!STAGE_EDGES.includes(edge)) return 'not_raised_by_a_stage';
    const c = s.outstanding.find((x) => x.key === p.command_key);
    if (c === undefined || c.type !== 'run_stage') return 'stale';
    // B3 "validator/critic fail": the validator is 3.3; the critic (the clean-context review) is 3.5
    if (c.step !== from && !(edge === 'B3' && c.step === '3.5')) return `wrong_step:${c.step}`;
    if (edge === 'B6') {
      takeOutstanding(s, c.key);
      s.waiting = null;
      return blockBaseline(s, cat, out, p.reason_code, seq);
    }
    if (edge === 'B12') {
      takeOutstanding(s, c.key);
      s.waiting = null;
      if (countEdge(s, cat, out, { edge }) === 'loop') openConditional(s, cat, out, '7.2', 'E6');
      return null;
    }
    const t = stepTarget(0);
    if (t === null || stationFor(s, cat, t) < 0) return 'no_target';
    takeOutstanding(s, c.key);
    s.waiting = null;
    if (countEdge(s, cat, out, { edge, loop: p.loop, observed: p.observed }) === 'loop') {
      takeEdgeTo(s, cat, out, t, edge);
    }
    return null;
  }

  if (!OBSERVED_EDGES.includes(edge)) return 'not_observable';
  const w = s.waiting;
  switch (edge) {
    case 'B4': {
      // The design reviewer found a gap in the spec (4.6 -> 3.2): while the design review is open.
      if (w?.kind !== 'gates' || w.conditional !== null || !w.gates.includes('G3d'))
        return 'not_at_4.6';
      const t = stepTarget(0);
      if (t === null || stationFor(s, cat, t) < 0) return 'no_target';
      if (countEdge(s, cat, out, { edge }) === 'loop') takeEdgeTo(s, cat, out, t, edge);
      return null;
    }
    case 'B14': {
      // Mode-E approver unsure: the same review (8.1), now by a codeowner (mode C). Once.
      if (w?.kind !== 'gates' || w.conditional !== null || !w.gates.includes('G4'))
        return 'not_at_8.1';
      if (s.review_mode === 'C') return 'already_mode_c';
      const t: JumpTarget = { gate: 'G4' };
      if (stationFor(s, cat, t) < 0) return 'no_target';
      if (countEdge(s, cat, out, { edge }) === 'loop') {
        s.review_mode = 'C';
        takeEdgeTo(s, cat, out, t, edge);
      }
      return null;
    }
    case 'B15': {
      // The human merge (8.2): the base moved (a): rebase cleanly and run S7 again, 2x; or a conflict
      // (b): resolve it in S6, then S7. Only the factory's observation, never its own merge.
      if (w?.kind !== 'human' || w.what !== 'merge') return 'not_at_8.2';
      const b = p.variant === 'b';
      const t = stepTarget(b ? 1 : 0);
      if (t === null || stationFor(s, cat, t) < 0) return 'no_target';
      const v = countEdge(s, cat, out, { edge, ...(b ? { unbounded: true } : { loop: p.loop }) });
      if (v === 'loop') {
        if (b) newLease(s);
        takeEdgeTo(s, cat, out, t, edge);
      }
      return null;
    }
    case 'B20': {
      // The requester amends the scope, in any active stage, once: the spec is drafted again (3.2).
      if (!AMEND_PHASES.includes(s.underlying) || w?.kind === 'handoff')
        return `not_active:${s.underlying}`;
      const t = stepTarget(0);
      if (t === null || stationFor(s, cat, t) < 0) return 'no_target';
      if (countEdge(s, cat, out, { edge }) === 'loop') takeEdgeTo(s, cat, out, t, edge);
      return null;
    }
    default:
      return 'not_observable';
  }
}

/** B6: red baseline or a broken environment. BLOCKED for the platform owner, and an L2 remediation item. */
function blockBaseline(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  cause: string,
  seq: number,
): string | null {
  if (countEdge(s, cat, out, { edge: 'B6' }) === 'moved') return null;
  s.waiting = { kind: 'blocked', cause, owner: 'platform_owner' };
  requestSpawn(s, out, 'B6', SPAWN_RULES.B6.kind, 'L2', 0, seq);
  return null;
}

/** A NEW linked item (B6, B16-B19, B26, R4): the kind and lane the flow names, counted against the origin. */
function acceptSpawn(
  s: ItemState,
  out: ItemCommand[],
  p: ItemEventPayload<'item.spawn_requested'>,
  seq: number,
): string | null {
  const rule = SPAWN_RULES[p.edge];
  if (rule.kind !== p.kind) return `kind_must_be_${rule.kind}`;
  if (rule.lanes !== null && !rule.lanes.includes(p.lane))
    return `lane_must_be_${rule.lanes.join('_or_')}`;
  if (p.edge === 'B26' && s.waiting?.kind !== 'release_held') return 'not_release_held';
  if (p.edge === 'B16' || p.edge === 'B17' || p.edge === 'B18' || p.edge === 'B19') {
    s.rework.total += 1;
    s.rework.by_edge[p.edge] = (s.rework.by_edge[p.edge] ?? 0) + 1;
  }
  requestSpawn(s, out, p.edge, p.kind, p.lane, p.index, seq);
  return null;
}

function placeHold(s: ItemState, p: ItemEventPayload<'item.hold_placed'>, at: string): void {
  if (s.underlying === 'Draft') return; // Draft has no hold edge: the hold is asked again once submitted
  if (s.holds.some((h) => h.hold_id === p.hold_id)) return;
  const first = !held(s);
  s.holds.push({ hold_id: p.hold_id, reason: p.reason, origin: p.origin, placed_at: at });
  if (p.reason === 'maintenance' && s.clock.frozen_since === null) s.clock.frozen_since = at;
  if (first) {
    if (!canTransitionWorkItem(s.underlying, 'Held')) {
      throw new IllegalPhaseTransition(`${s.underlying} -> Held`);
    }
    s.phase = 'Held';
  }
}

export type { Lane };
