import { type CatalogueData } from '@aisdlc/catalogue';
import {
  CAUSE_B22_DECLINED,
  ITEM_EVENT,
  canTransitionWorkItem,
  type GateId,
  type ItemCommand,
  type ItemEvent,
  type ItemEventPayload,
  type Lane,
  type PrrGatingProfile,
  type StepId,
  type TerminalState,
  type WorkItemPhase,
} from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import {
  CONDITIONAL_GATES,
  buildRoute,
  effectiveProfile,
  firstStationAfterIntake,
  gateSetOf,
  portOfStep,
  type Station,
} from './route.js';
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
function gateFacts(s: ItemState, cat: CatalogueData, gates: readonly GateId[], stationKey: string) {
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
  };
  return { facts, lane_profile_sha256 };
}

function openGates(
  s: ItemState,
  cat: CatalogueData,
  out: ItemCommand[],
  o: { stationKey: string; gates: readonly GateId[]; step: StepId | null },
): void {
  const attempt = bump(s, `open:${o.stationKey}`);
  const { facts, lane_profile_sha256 } = gateFacts(s, cat, o.gates, o.stationKey);
  const subject_hash = hashCanonical({
    item_id: s.item_id,
    station: o.stationKey,
    gates: [...o.gates],
    lane: s.proposed_lane,
    lane_profile_sha256,
    text_sha256: s.intake.text_sha256,
    // A conditional gate binds what was approved before it, so a resume cannot reuse an old approval.
    approved: o.step === null ? [] : (s.approved[o.step] ?? []),
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
  const from: WorkItemPhase = held(s) ? 'Held' : s.underlying;
  if (!canTransitionWorkItem(from, to)) throw new IllegalPhaseTransition(`${from} -> ${to}`);
  s.phase = to;
  s.underlying = to;
  s.trail.push(to);
  s.terminal = to;
  s.terminal_cause = cause;
  s.waiting = null;
  s.outstanding = [];
  s.lease = null;
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

// ---------------------------------------------------------------- Advance

/**
 * Runs the item forward until it needs something it does not have: a result, a decision or a person.
 * Under a hold it does not run at all: results and decisions are folded (the facts are true), the
 * cursor moves, but no new stage work starts and the item does not end; the release runs it.
 */
function advance(s: ItemState, cat: CatalogueData, out: ItemCommand[]): void {
  for (let guard = 0; guard < 200; guard++) {
    if (s.terminal !== null || s.waiting !== null || held(s)) return;
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
            },
            out,
          );
        }
        s.waiting = { kind: 'command', key };
        return;
      }
      case 'human':
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

/** After a step completes: the agent lease ends when the item leaves S6. */
function afterStepDone(s: ItemState, cat: CatalogueData): void {
  s.cursor += 1;
  const next = routeOf(s, cat)[s.cursor];
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

function evaluateGates(s: ItemState, cat: CatalogueData, seq: number, out: ItemCommand[]): void {
  const w = s.waiting;
  if (w?.kind !== 'gates') return;
  const station =
    w.conditional === null ? w.station : `${w.conditional.step}!${w.conditional.gate}`;
  const latest = new Map<GateId, (typeof s.gates)[number]>();
  for (const g of s.gates) if (g.station === station) latest.set(g.gate, g);
  if (w.gates.some((g) => !latest.has(g))) return; // gates_opened has not told us the instances yet
  const mine = w.gates.map((g) => latest.get(g) as (typeof s.gates)[number]);

  const refused = mine.find((i) => i.outcome === 'reject' || i.outcome === 'request_changes');
  if (refused) {
    if (refused.gate === 'G0' && refused.outcome === 'reject') {
      // B22: ineligible or unsuitable. The only rejection edge of the gates that are in a route today.
      terminate(s, 'Declined', CAUSE_B22_DECLINED, seq, out);
      return;
    }
    s.waiting = {
      kind: 'stuck',
      reason: `${refused.gate}:${refused.outcome}`,
      step: w.conditional?.step ?? null,
      gate: refused.gate,
    };
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

  // Every gate of the station approved.
  s.waiting = null;
  if (w.conditional !== null) {
    const { step, gate } = w.conditional;
    s.approved[step] = [...new Set([...(s.approved[step] ?? []), gate])];
    if (CONDITIONAL_GATES[gate as keyof typeof CONDITIONAL_GATES].on_approve === 'continue') {
      afterStepDone(s, cat);
    }
    // `resume`: the cursor stays, and `advance` runs the step again with the gate approved.
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
      rework: { total: 0, by_edge: {} },
      terminal: null,
      terminal_cause: null,
      ignored: [],
      created_at: event.at,
      trail: ['Draft'],
      seq: event.seq,
    };
    return { state, commands: [] };
  }
  if (prior === null)
    throw new Error(`the first event of an item is item.created, not ${event.type}`);
  if (!pinOk(prior.profile, pinnedProfile)) throw new ProfilePinMismatch(prior.item_id);

  const s: ItemState = structuredClone(prior);
  s.seq = event.seq;
  s.trail = [];
  const done = (): InterpretResult => ({ state: s, commands: out });

  // A finished item takes nothing more, except the bookkeeping of what is still in flight.
  if (s.terminal !== null) {
    if (event.type === ITEM_EVENT.command_done) takeOutstanding(s, event.payload.command_key);
    else if (event.type === ITEM_EVENT.gates_opened) {
      // A gate opened by a command that was already running when the item ended: close it.
      takeOutstanding(s, event.payload.command_key);
      const ids = event.payload.gates.map((g) => g.gate_instance_id);
      const c: ItemCommand = {
        type: 'withdraw_gates',
        key: cmdKey(s, 'withdraw', event.seq),
        gate_instance_ids: ids,
        reason: `item ${s.terminal.toLowerCase()}`,
      };
      s.outstanding.push(c);
      out.push(c);
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
      if (p.step === '1.3' && p.lane !== undefined && s.lane === null) s.proposed_lane = p.lane;
      if (p.step === '6.0' && p.lease_epoch !== undefined) s.lease = { epoch: p.lease_epoch };
      afterStepDone(s, catalogue);
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
      // The retry and back-edge rules (B3, B7, B9...) are M9.4: until then a failure stops the item
      // where it is. Nothing is retried, skipped or approved on its own.
      s.waiting = { kind: 'stuck', reason: `stage_failed:${p.code}`, step: p.step, gate: null };
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
      if (!CONDITIONAL_GATES[p.gate].steps.includes(p.step)) {
        s.waiting = {
          kind: 'stuck',
          reason: `gate_not_raisable:${p.gate}@${p.step}`,
          step: p.step,
          gate: p.gate,
        };
        break;
      }
      const stationKey = `${p.step}!${p.gate}`;
      s.waiting = {
        kind: 'gates',
        station: stationKey,
        gates: [p.gate],
        conditional: { step: p.step, gate: p.gate },
      };
      openGates(s, catalogue, out, { stationKey, gates: [p.gate], step: p.step });
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
      if (s.rounds > clarifyRounds(catalogue)) {
        // B1: at most two rounds, then PARK (its 5 bd timer and exits are M9.3).
        setUnderlying(s, 'Parked');
        s.waiting = { kind: 'parked', cause: 'b1_round_limit' };
        break;
      }
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
      }
      const blocking = s.questions.filter((q) => q.round === s.rounds && q.material === 'blocking');
      if (blocking.length === 0) {
        afterStepDone(s, catalogue);
        advance(s, catalogue, out);
        break;
      }
      setUnderlying(s, 'Clarifying');
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
      if (s.waiting?.kind === 'questions') {
        const open = s.waiting.ids.some(
          (id) => s.questions.find((x) => x.question_id === id)?.state === 'open',
        );
        if (!open) {
          // Answered: back to S1, and 1.5 runs again to write the intent block from the answers.
          s.waiting = null;
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
      const want: Record<string, string> = {
        [ITEM_EVENT.ready_decided]: 'ready',
        [ITEM_EVENT.scheduled]: 'schedule',
        [ITEM_EVENT.merge_observed]: 'merge',
        [ITEM_EVENT.human_work_done]: 'human_led',
      };
      if (s.waiting?.kind !== 'human' || s.waiting.what !== want[event.type]) {
        ignore(s, `${event.type}:not_waiting`);
        break;
      }
      s.waiting = null;
      afterStepDone(s, catalogue);
      advance(s, catalogue, out);
      break;
    }

    case ITEM_EVENT.gates_opened: {
      const p = event.payload;
      const c = takeOutstanding(s, p.command_key);
      if (c === null || c.type !== 'open_gates') {
        if (c !== null) s.outstanding.push(c);
        ignore(s, 'gates_opened:stale');
        break;
      }
      const w = s.waiting;
      const station =
        w?.kind === 'gates'
          ? w.conditional === null
            ? w.station
            : `${w.conditional.step}!${w.conditional.gate}`
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
      }
      // A decision may have been recorded before the opening was acknowledged (a replay): look again.
      evaluateGates(s, catalogue, event.seq, out);
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
      evaluateGates(s, catalogue, event.seq, out);
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
      const p = event.payload;
      issue(
        s,
        {
          type: 'spawn_item',
          key: cmdKey(s, 'spawn', event.seq, p.index),
          edge: p.edge,
          kind: p.kind,
          lane: p.lane,
          index: p.index,
          origin_seq: event.seq,
        },
        out,
      );
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

    default: {
      const never: never = event;
      throw new Error(`unhandled event ${JSON.stringify(never)}`);
    }
  }
  return done();
}

function placeHold(s: ItemState, p: ItemEventPayload<'item.hold_placed'>, at: string): void {
  if (s.underlying === 'Draft') return; // Draft has no hold edge: the hold is asked again once submitted
  if (s.holds.some((h) => h.hold_id === p.hold_id)) return;
  const first = !held(s);
  s.holds.push({ hold_id: p.hold_id, reason: p.reason, origin: p.origin, placed_at: at });
  if (first) {
    if (!canTransitionWorkItem(s.underlying, 'Held')) {
      throw new IllegalPhaseTransition(`${s.underlying} -> Held`);
    }
    s.phase = 'Held';
  }
}

export type { Lane };
