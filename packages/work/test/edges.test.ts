import { CATALOGUE } from '@aisdlc/catalogue';
import {
  BACK_EDGES,
  HANDOFF_EDGES,
  ITEM_EVENT,
  LaneValues,
  QUARANTINE_EDGES,
  RELANE_EDGES,
  WORK_ITEM_TRANSITIONS,
  type Lane,
  type StageOutcome,
  type WorkItemPhase,
} from '@aisdlc/contracts';
import { FakeStagePorts } from '@aisdlc/ports';
import { describe, expect, it } from 'vitest';
import { CONDITIONAL_GATES, buildRoute, effectiveProfile } from '../src/index.js';
import { PROFILE_ALL_OFF, PROFILE_ALL_ON, Sim } from './sim.js';
import {
  choose,
  relane,
  decideUntil,
  forStep,
  gateNeeded,
  openHandoff,
  repeat,
  rework,
  trigger,
} from './scen.js';

// EVERY FL EDGE HAS A TEST AGAINST THE FAKE STAGES, or is listed as pending with its reason (PLAN
// M9.2). The universe is generated, not written: the phase table of the contracts (WORK_ITEM_TRANSITIONS),
// the flow tables of the contracts (back-edges, handoffs, re-lanes, quarantine), the forward edges of
// every lane's route (catalogue and profile), and the exits of the conditional gates. A test below
// fails when an edge is neither covered nor pending, when one is both, and when the numbers move, so
// a later milestone cannot add an edge, or finish one, without this table saying so.

const fakes = () => new FakeStagePorts();
const sim = (name: string, o: ConstructorParameters<typeof Sim>[1] = {}) => {
  const s = new Sim(name, o);
  s.submit();
  return s;
};
const trail = (s: Sim) => s.phases.join('>');
const tookPhase = (s: Sim, from: string, to: string) => {
  const p = s.phases;
  for (let i = 1; i < p.length; i++) if (p[i - 1] === from && p[i] === to) return true;
  return false;
};

// ---------------------------------------------------------------- The universe

const universe: string[] = [];
for (const [from, tos] of Object.entries(WORK_ITEM_TRANSITIONS)) {
  for (const to of tos) universe.push(`phase:${from}>${to}`);
}
for (const [id, e] of Object.entries(BACK_EDGES)) {
  for (const to of e.to) universe.push(`${id}:${e.from}>${to}`);
  if (e.to.length === 0) universe.push(`${id}:${e.from}>-`);
}
for (const e of [...HANDOFF_EDGES, ...RELANE_EDGES, ...QUARANTINE_EDGES]) {
  for (const to of e.to) universe.push(`${e.id}:${e.from}>${to}`);
}
const routeOf = (lane: Lane, p = PROFILE_ALL_ON) =>
  buildRoute(CATALOGUE.lanes[lane], effectiveProfile(p, 'T1')).filter((s) => s.kind !== 'marker');
for (const lane of LaneValues) {
  const r = routeOf(lane);
  for (let i = 1; i < r.length; i++) universe.push(`lane:${lane}:${r[i - 1]?.key}>${r[i]?.key}`);
}
for (const [gate, c] of Object.entries(CONDITIONAL_GATES)) {
  for (const step of c.steps) {
    universe.push(`gate:${gate}@${step}:approved`);
    universe.push(`gate:${gate}@${step}:denied`);
  }
}

// ---------------------------------------------------------------- Scenarios that reach a phase

/** Raises a question at 1.5 on each of the first `rounds` runs. */
const asks = (_rounds: number): StageOutcome | undefined => ({
  outcome: 'questions',
  questions: [{ text: 'which table?', material: 'blocking' }],
});

const answerAll = (s: Sim) => {
  for (const q of s.state.questions.filter((x) => x.state === 'open')) {
    s.apply(ITEM_EVENT.question_answered, {
      question_id: q.question_id,
      answer: {
        text: 'orders',
        taint: 'untrusted',
        origin: 'answer',
        provenance: {
          channel: 'N1',
          source: 'portal_ask',
          received_at: '2026-11-09T08:00:00.000Z',
          submitted_by: 'alice',
          raw_sha256: 'a'.repeat(64),
          normalised_sha256: 'b'.repeat(64),
        },
        flags: [],
      },
      by: 'alice',
    });
  }
};

const LANE_FOR: Record<string, Lane> = {
  S2: 'L4',
  S3: 'L3',
  S4: 'L4',
  S5: 'L4',
  Scheduling: 'L3',
  S6: 'L3',
  S7: 'L3',
  G4: 'L3',
  S8a: 'L3',
  S8b: 'L3',
  G5: 'L3',
  S9: 'L3',
  G6: 'L3',
  S1: 'L4',
};

/** An item driven through the fake stages until it is in `phase`. */
async function reach(phase: WorkItemPhase): Promise<Sim> {
  const ports = fakes();
  // S9 is a phase an item rests in only when G6 is off (with G6 on it is passed on the way to G6).
  const profile =
    phase === 'S9'
      ? { ...PROFILE_ALL_ON, gates: { ...PROFILE_ALL_ON.gates, g6: 'off' as const } }
      : PROFILE_ALL_ON;
  const s = sim(`reach-${phase}`, { lane: LANE_FOR[phase] ?? 'L4', profile });
  if (phase === 'Clarifying') {
    await s.runP(
      ports,
      {},
      (st) =>
        st.phase === 'S1' && st.outstanding.some((c) => c.type === 'run_stage' && c.step === '1.5'),
    );
    // answer 1.5 with a blocking question by scripting the port for this item
    ports.planning.scriptStep('1.5', [asks(1) as StageOutcome]);
    await s.runP(ports, {}, (st) => st.phase === 'Clarifying');
    return s;
  }
  if (phase === 'Parked') {
    ports.planning.script((req) => (req.step === '1.5' ? asks(9) : undefined));
    for (let round = 0; round < 3; round++) {
      await s.runP(ports, {}, (st) => st.phase === 'Clarifying' || st.phase === 'Parked');
      if (s.state.phase === 'Parked') break;
      answerAll(s);
    }
    return s;
  }
  await s.runP(ports, {}, (st) => st.phase === phase);
  return s;
}

const HOLDABLE: WorkItemPhase[] = [
  'Clarifying',
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
  'Parked',
];

// ---------------------------------------------------------------- Covered

type Scenario = () => Promise<void>;
const COVERED: Record<string, Scenario> = {};
const cover = (key: string, fn: Scenario): void => {
  COVERED[key] = fn;
};

// -- the forward phase edges, each taken by a lane's run to Done
const forward = (from: WorkItemPhase, to: WorkItemPhase, lane: Lane, profile = PROFILE_ALL_ON) =>
  cover(`phase:${from}>${to}`, async () => {
    const s = sim(`fwd-${from}-${to}`, { lane, profile });
    await s.runP(fakes());
    expect(s.state.terminal).toBe('Done');
    expect(tookPhase(s, from, to), `${from}>${to} in ${trail(s)}`).toBe(true);
  });
forward('S1', 'S2', 'L4');
forward('S1', 'S3', 'L3');
forward('S1', 'Scheduling', 'L0');
forward('S2', 'S3', 'L4');
forward('S2', 'Scheduling', 'L7');
forward('S3', 'S4', 'L4');
forward('S3', 'S5', 'L3');
forward('S4', 'S5', 'L4');
forward('S5', 'Scheduling', 'L4');
forward('Scheduling', 'S6', 'L4');
forward('S6', 'S7', 'L4');
forward('S6', 'S9', 'L7'); // the spike: no PR, straight to the report
forward('S7', 'G4', 'L4');
forward('G4', 'S8a', 'L4');
forward('S8a', 'S8b', 'L4');
forward('S8b', 'G5', 'L4');
forward('S8b', 'S9', 'L4', PROFILE_ALL_OFF); // G5 off: absent, release goes on to close-out
forward('G5', 'S8b', 'L4'); // after G5 the release step runs
forward('S9', 'G6', 'L4');
forward('S9', 'Done', 'L4', PROFILE_ALL_OFF); // G6 off: close-out ends the item
forward('G6', 'Done', 'L4');

cover('phase:Draft>S1', async () => {
  const s = sim('draft-s1');
  expect(tookPhase(s, 'Draft', 'S1')).toBe(true);
});
cover('phase:Draft>Withdrawn', async () => {
  const s = new Sim('draft-withdrawn');
  s.apply(ITEM_EVENT.withdrawn, { by: 'alice' });
  expect(s.state.terminal).toBe('Withdrawn');
  expect(tookPhase(s, 'Draft', 'Withdrawn')).toBe(true);
});
cover('phase:S1>Declined', async () => {
  const s = sim('declined');
  await s.runP(fakes(), { decide: (g) => (g === 'G0' ? 'reject' : 'pending') });
  expect(s.state.terminal).toBe('Declined');
  expect(tookPhase(s, 'S1', 'Declined')).toBe(true);
});
cover('phase:S1>Clarifying', async () => {
  const s = await reach('Clarifying');
  expect(tookPhase(s, 'S1', 'Clarifying')).toBe(true);
});
cover('phase:Clarifying>S1', async () => {
  const ports = fakes();
  ports.planning.scriptStep('1.5', [asks(1) as StageOutcome]);
  const s = sim('clarify-back');
  await s.runP(ports, {}, (st) => st.phase === 'Clarifying');
  answerAll(s);
  expect(s.state.phase).toBe('S1');
  expect(tookPhase(s, 'Clarifying', 'S1')).toBe(true);
  await s.runP(ports);
  expect(s.state.terminal).toBe('Done');
});
cover('phase:S1>Parked', async () => {
  const s = await reach('Parked');
  expect(s.state.waiting).toMatchObject({ kind: 'parked' });
  expect(tookPhase(s, 'S1', 'Parked')).toBe(true);
});
cover('B1:1.5>Parked', async () => {
  const s = await reach('Parked');
  expect(s.state.rounds).toBe(3);
  expect(s.state.waiting).toMatchObject({ kind: 'parked', cause: 'b1_round_limit' });
});

// -- holds: every phase an item can be in can be held and resumes to the SAME phase
for (const p of HOLDABLE) {
  cover(`phase:${p}>Held`, async () => {
    const s = await reach(p);
    expect(s.state.phase, `reached ${p}`).toBe(p);
    s.apply(ITEM_EVENT.hold_placed, { hold_id: `h-${p}`, reason: 'kill', origin: 'ctl' });
    expect(s.state.phase).toBe('Held');
    expect(s.state.underlying).toBe(p);
    expect(tookPhase(s, p, 'Held')).toBe(true);
  });
  cover(`phase:Held>${p}`, async () => {
    const s = await reach(p);
    s.apply(ITEM_EVENT.hold_placed, { hold_id: `h-${p}`, reason: 'maintenance', origin: 'mm-2' });
    s.apply(ITEM_EVENT.hold_released, { hold_id: `h-${p}` });
    expect(s.state.phase).toBe(p);
    expect(tookPhase(s, 'Held', p)).toBe(true);
    if (p !== 'Parked' && p !== 'Clarifying') {
      await s.runP(fakes());
      expect(s.state.terminal, `resumed from ${p}: ${trail(s)}`).toBe('Done');
    }
  });
}
cover('phase:Held>Abandoned', async () => {
  const s = await reach('S3');
  s.apply(ITEM_EVENT.hold_placed, { hold_id: 'h', reason: 'kill', origin: null });
  s.apply(ITEM_EVENT.abandoned, { cause: 'owner_abandoned', by: 'alice' });
  expect(s.state.terminal).toBe('Abandoned');
  expect(tookPhase(s, 'Held', 'Abandoned')).toBe(true);
});

// -- the flow edges
cover('B22:G0>Declined', async () => {
  const s = sim('b22');
  await s.runP(fakes(), { decide: (g) => (g === 'G0' ? 'reject' : 'pending') });
  expect(s.state).toMatchObject({ terminal: 'Declined', terminal_cause: 'b22.g0_rejected' });
});
cover('B27:1.1>G0', async () => {
  const s = new Sim('b27', { lane: 'L4', injection: true });
  s.submit();
  await s.runP(fakes(), { decide: () => 'pending' });
  const open = s.executed.find((c) => c.type === 'open_gates');
  const facts = (open as { facts: Record<string, any> }).facts; // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(facts['gates']).toEqual(['G0', 'G1']);
  expect(facts['injection']).toMatchObject({ suspected: true });
  // flagged, not diverted: the lane and the route are the benign ones
  expect(s.state.proposed_lane).toBe('L4');
  expect(s.state.lane).toBeNull();
});

// -- every lane's forward edges, against the fake stages
for (const lane of LaneValues) {
  const r = routeOf(lane);
  const scenario: Scenario = async () => {
    const s = sim(`lane-${lane}`, { lane, profile: PROFILE_ALL_ON });
    await s.runP(fakes());
    expect(s.state.terminal, `${lane}: ${JSON.stringify(s.state.waiting)}`).toBe('Done');
    const v = s.visited;
    for (let i = 1; i < r.length; i++) {
      const a = v.indexOf(r[i - 1]?.key as string);
      expect(a, `${lane}: ${r[i - 1]?.key} was visited`).toBeGreaterThanOrEqual(0);
      expect(v[a + 1], `${lane}: ${r[i - 1]?.key} then ${r[i]?.key}`).toBe(r[i]?.key);
    }
  };
  for (let i = 1; i < r.length; i++) cover(`lane:${lane}:${r[i - 1]?.key}>${r[i]?.key}`, scenario);
}

// -- conditional gates: an approval takes the item on
for (const [gate, c] of Object.entries(CONDITIONAL_GATES)) {
  // E1 is R2's gate: it opens only through a relane request (scenarios below)
  if (gate === 'E1') continue;
  for (const step of c.steps) {
    const act = c.approve_at?.[step] ?? c.on_approve;
    cover(`gate:${gate}@${step}:approved`, async () => {
      const ports = fakes();
      ports.script((req) =>
        req.step === step && req.attempt === 1
          ? { outcome: 'gate_needed', gate: gate as never, reason_code: 'test' }
          : undefined,
      );
      const s = sim(`cond-${gate}-${step}`, { lane: 'L4' });
      await s.runP(ports);
      expect(s.state.terminal).toBe('Done');
      expect(s.gateLog.some((g) => g.gates.includes(gate as never))).toBe(true);
      const calls = ports[
        step.startsWith('7') ? 'verify' : step.startsWith('6') ? 'coding' : 'planning'
      ].calls.filter((x) => x.step === step);
      if (typeof act === 'string') {
        expect(calls.length).toBe(act === 'resume' ? 2 : 1);
        if (act === 'resume') expect(calls[1]?.approved_gates).toEqual([gate]);
      } else if ('relane' in act) {
        throw new Error('E1 has its own scenarios');
      } else if ('chain' in act) {
        // E6 -> G3o -> back to 6.4 (B12): the next gate of the same step opens, and S6 runs again
        expect(s.gateLog.some((g) => g.gates.includes(act.chain))).toBe(true);
        expect(tookPhase(s, 'S7', 'S6')).toBe(true);
      } else {
        expect(tookPhase(s, 'S7', 'S6')).toBe(true);
        expect(s.visited.filter((v) => v === `s:${act.jump}`).length).toBe(2);
      }
    });
  }
}

// ---------------------------------------------------------------- M9.3 and M9.4: holds, terminals, back-edges, handoffs

const created = (s: Sim) => s.state.created_at;
const ageOut = (s: Sim) =>
  s.apply(ITEM_EVENT.timer_fired, {
    timer: 'item_age',
    since: created(s),
    due_at: created(s),
    frozen_ms: 0,
  });
const apply = (s: Sim, edge: string, o: Record<string, unknown> = {}) =>
  s.apply(ITEM_EVENT.rework_requested, { edge, step: null, reason_code: 'test', ...o });

/** The scenarios an edge is reached by; several edges share one. */
const S = {
  b2: () => {
    const s = sim('e-b2', { lane: 'L4' });
    s.run({ script: repeat('2.1', rework('B2')) });
    return s;
  },
  b3: () => {
    const s = sim('e-b3', { lane: 'L4' });
    s.run({ script: repeat('3.3', rework('B3')) });
    return s;
  },
  b4: () => {
    const s = sim('e-b4', { lane: 'L4' });
    const hold = {
      decide: (g: string) => (g === 'G3d' ? ('pending' as const) : ('approve' as const)),
    };
    s.run(hold);
    apply(s, 'B4', { step: '4.6' });
    s.run(hold);
    apply(s, 'B4', { step: '4.6' });
    return s;
  },
  b5: () => {
    const s = sim('e-b5', { lane: 'L4' });
    s.run({ decide: decideUntil('G3', 'request_changes', 1) });
    return s;
  },
  b6: () => {
    const s = sim('e-b6', { lane: 'L3' });
    s.run({ script: forStep('6.2', [rework('B6')]) });
    return s;
  },
  b7: () => {
    const s = sim('e-b7', { lane: 'L3' });
    s.run({ script: repeat('6.5', rework('B7')) });
    return s;
  },
  b8: () => {
    const s = sim('e-b8', { lane: 'L4' });
    s.run({ script: repeat('6.5', rework('B8')) });
    return s;
  },
  b9: () => {
    const s = sim('e-b9', { lane: 'L3' });
    s.run({ script: repeat('7.6', rework('B9')) });
    return s;
  },
  b10: () => {
    const s = sim('e-b10', { lane: 'L4' });
    s.run({ script: repeat('7.3', rework('B10')) });
    return s;
  },
  b11: () => {
    const s = sim('e-b11', { lane: 'L4' });
    s.run({ script: repeat('7.6', rework('B11')) });
    return s;
  },
  b12: () => {
    const s = sim('e-b12', { lane: 'L3' });
    s.run({ script: repeat('7.2', gateNeeded('E6')) });
    return s;
  },
  b13: () => {
    const s = sim('e-b13', { lane: 'L3' });
    s.run({ decide: decideUntil('G4', 'request_changes', 9) });
    return s;
  },
  atMerge: (name: string) => {
    const s = sim(name, { lane: 'L3' });
    s.run({ stopAtHuman: ['merge'] });
    return s;
  },
  e4: (name: string, lane: Lane = 'L3') => {
    const s = sim(name, { lane });
    s.run({ script: forStep('6.4', [trigger('ET1')]) });
    return s;
  },
};

// -- PARK, BLOCKED, RELHOLD (M9.3)
cover('phase:Clarifying>Parked', async () => {
  const s = sim('c-park', { lane: 'L4' });
  s.run({ script: forStep('1.5', [asks(1) as StageOutcome]) });
  const since = (s.state.clarify as { since: string }).since;
  s.apply(ITEM_EVENT.timer_fired, { timer: 'clarify_silence', since, due_at: since, frozen_ms: 0 });
  expect(s.state.phase).toBe('Parked');
  expect(tookPhase(s, 'Clarifying', 'Parked')).toBe(true);
});
cover('phase:Parked>S1', async () => {
  const s = await reach('Parked');
  answerAll(s);
  expect(s.state.phase).toBe('S1');
  expect(tookPhase(s, 'Parked', 'S1')).toBe(true);
  await s.runP(fakes());
  expect(s.state.terminal).toBe('Done');
});
cover('phase:Parked>Abandoned', async () => {
  const s = await reach('Parked');
  const since = (s.state.park as { since: string }).since;
  s.apply(ITEM_EVENT.timer_fired, { timer: 'park', since, due_at: since, frozen_ms: 0 });
  expect(s.state).toMatchObject({ terminal: 'Abandoned', terminal_cause: 'park.timeout' });
  expect(tookPhase(s, 'Parked', 'Abandoned')).toBe(true);
});
cover('B6:6.2>Blocked', async () => {
  const s = S.b6();
  expect(s.state.waiting).toMatchObject({ kind: 'blocked' });
  expect(s.state.spawns[0]).toMatchObject({ edge: 'B6', kind: 'remediation', lane: 'L2' });
});
cover('B26:G5>ReleaseHeld', async () => {
  const s = sim('e-b26', { lane: 'L4' });
  s.run({ decide: (g) => (g === 'G5' ? 'reject' : 'approve') });
  expect(s.state.waiting).toMatchObject({ kind: 'release_held' });
  expect(s.state.phase).toBe('G5');
});

// -- back-edges (M9.4): each against the fake stages, to the edge's target and its catalogue exit
cover('B2:2.1>1.5', async () => {
  const s = S.b2();
  expect(tookPhase(s, 'S2', 'S1')).toBe(true);
  expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B2' });
});
cover('B3:3.3>3.2', async () => {
  const s = S.b3();
  expect(s.stepsOnly().filter((x) => x === '3.2').length).toBeGreaterThan(1);
  expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'ET8' });
});
cover('B4:4.6>3.2', async () => {
  const s = S.b4();
  expect(tookPhase(s, 'S4', 'S3')).toBe(true);
  expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B4' });
});
cover('B5:G3>5.1', async () => {
  const s = S.b5();
  expect(s.stepsOnly().filter((x) => x === '5.1').length).toBe(2);
  expect(s.state.terminal).toBe('Done');
});
cover('B7:6.5>6.4', async () => {
  const s = S.b7();
  expect(s.stepsOnly().filter((x) => x === '6.4').length).toBeGreaterThan(1);
});
cover('B8:6.5>5.1', async () => {
  const s = S.b8();
  expect(tookPhase(s, 'S6', 'S5')).toBe(true);
});
cover('B8:6.5>D1', async () => {
  const s = S.b8();
  expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'B8' });
});
cover('B9:7.6>6.4', async () => {
  const s = S.b9();
  expect(tookPhase(s, 'S7', 'S6')).toBe(true);
  expect(openHandoff(s)).toMatchObject({ code: 'D2', trigger: 'B9' });
});
cover('B10:7.3>3.2', async () => {
  const s = S.b10();
  expect(tookPhase(s, 'S7', 'S3')).toBe(true);
});
cover('B11:7.6>5.1', async () => {
  const s = S.b11();
  expect(tookPhase(s, 'S7', 'S5')).toBe(true);
});
cover('B12:7.2>E6', async () => {
  const s = S.b12();
  expect(s.gateLog.some((g) => g.gates.includes('E6'))).toBe(true);
  expect(openHandoff(s)).toMatchObject({ code: 'D2', trigger: 'B12' });
});
cover('B13:8.1>6.4', async () => {
  const s = S.b13();
  expect(tookPhase(s, 'G4', 'S6')).toBe(true);
});
cover('B14:8.1>8.1', async () => {
  const s = sim('e-b14', { lane: 'L3' });
  s.run({ decide: (g) => (g === 'G4' ? 'pending' : 'approve') });
  apply(s, 'B14', { step: '8.1' });
  expect(s.state.review_mode).toBe('C');
  expect(s.state.phase).toBe('G4');
});
cover('B15:8.2>7.1', async () => {
  const s = S.atMerge('e-b15a');
  apply(s, 'B15', { step: '8.2', variant: 'a' });
  expect(tookPhase(s, 'S8a', 'S7')).toBe(true);
});
cover('B15:8.2>6.4', async () => {
  const s = S.atMerge('e-b15b');
  apply(s, 'B15', { step: '8.2', variant: 'b' });
  expect(tookPhase(s, 'S8a', 'S6')).toBe(true);
});
const spawnAt = (edge: string, kind: string, lane: Lane) => async () => {
  const s = sim(`e-${edge}`, { lane: 'L4' });
  s.run({ decide: (g) => (g === 'G5' ? 'pending' : 'approve') });
  const st = s.apply(ITEM_EVENT.spawn_requested, { edge, kind, lane, index: 0 });
  expect(st.commands).toMatchObject([{ type: 'spawn_item', edge }]);
  s.run({ decide: () => 'pending' });
  expect(s.state.spawns[0]).toMatchObject({ edge, kind, lane });
};
cover('B16:S8b>REQ', spawnAt('B16', 'rollback', 'L0'));
cover('B17:9.3>REQ', spawnAt('B17', 'escape', 'L1'));
cover('B18:9.2>REQ', async () => {
  const s = sim('e-b18', { lane: 'L3' });
  s.run({ decide: (g) => (g === 'G6' ? 'reject' : 'approve') });
  expect(s.state.spawns[0]).toMatchObject({ edge: 'B18', kind: 'rejected_rework' });
  expect(s.state.terminal).toBe('Done');
});
cover('B19:9.5>REQ', async () => {
  const s = sim('e-b19', { lane: 'L3' });
  s.run();
  s.apply(ITEM_EVENT.spawn_requested, { edge: 'B19', kind: 'audit_miss', lane: 'L1', index: 0 });
  s.run();
  expect(s.state.spawns[0]).toMatchObject({ edge: 'B19' });
});
cover('B20:null>3.2', async () => {
  const s = sim('e-b20', { lane: 'L4' });
  s.run({ decide: (g) => (g === 'G3' ? 'pending' : 'approve') });
  apply(s, 'B20');
  expect(tookPhase(s, 'S5', 'S3')).toBe(true);
});
cover('B21:null>-', async () => {
  // B21 is the decision kernel's (the SLA sweep escalates a gate pending past 1 bd to the backup,
  // never approves: services/core/test/work-control.test.ts runs the real sweep over an item's gate).
  // For the engine it is an invariant: however long a gate stays pending, nothing but a decision moves the item.
  const s = sim('e-b21', { lane: 'L4' });
  s.run({ decide: () => 'pending' });
  const cursor = s.state.cursor;
  for (let i = 0; i < 5; i++) s.run({ decide: () => 'pending' });
  expect(s.state.cursor).toBe(cursor);
  expect(s.state.gates.every((g) => g.status === 'pending')).toBe(true);
  const b21 = CATALOGUE.back_edge_limits.B21;
  expect(b21).toMatchObject({ kind: 'limited', then: 'backup_approver' });
});
cover('B23:G2>3.2', async () => {
  const s = sim('e-b23', { lane: 'L4' });
  s.run({ decide: decideUntil('G2', 'reject', 9) });
  expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B23' });
});
cover('B24:G3d>4.1', async () => {
  const s = sim('e-b24', { lane: 'L4' });
  s.run({ decide: decideUntil('G3d', 'reject', 9) });
  expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B24' });
});
cover('B25:E2>4.1', async () => {
  const s = sim('e-b25', { lane: 'L4' });
  s.run({
    script: repeat('4.5', gateNeeded('E2')),
    decide: (g) => (g === 'E2' ? 'reject' : 'approve'),
  });
  expect(s.stepsOnly().filter((x) => x === '4.1').length).toBe(2);
  expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B25' });
});
cover('B28:null>E4', async () => {
  const s = sim('e-b28', { lane: 'L3' });
  s.run({ script: repeat('7.6', rework('B9', { loop: 'et4_limit' })) });
  expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B28' });
  expect(s.state.et14['rework_budget']).toBe(1);
});

// -- handoffs and E4's choices
cover('D1:6.4>D1', async () => {
  const s = S.e4('e-d1-64');
  expect(openHandoff(s)).toMatchObject({ code: 'D1', origin_phase: 'S6', origin_step: '6.4' });
});
cover('D1:6.5>D1', async () => {
  const s = sim('e-d1-65', { lane: 'L3' });
  s.run({ script: forStep('6.5', [trigger('ET9')]) });
  expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'ET9', origin_step: '6.5' });
});
cover('D1:X1>D1', async () => {
  const s = sim('e-x1', { lane: 'L3' });
  s.run({
    script: forStep('6.4', [gateNeeded('X1')]),
    decide: (g) => (g === 'X1' ? 'reject' : 'approve'),
  });
  expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'X1' });
});
cover('D2:7.6>D2', async () => {
  const s = sim('e-d2', { lane: 'L3' });
  s.run({ script: forStep('7.6', [trigger('ET4')]) });
  expect(openHandoff(s)).toMatchObject({ code: 'D2', trigger: 'ET4' });
});
cover('D2:X2>D2', async () => {
  const s = sim('e-x2', { lane: 'L3' });
  s.run({
    script: forStep('7.4', [gateNeeded('X2')]),
    decide: (g) => (g === 'X2' ? 'reject' : 'approve'),
  });
  expect(openHandoff(s)).toMatchObject({ code: 'D2', trigger: 'X2' });
});
cover('D3:8.1>D3', async () => {
  const s = sim('e-d3', { lane: 'L3' });
  s.run({ decide: (g) => (g === 'G4' ? 'pending' : 'approve') });
  s.apply(ITEM_EVENT.trigger_fired, { trigger: 'ET7', step: '8.1', reason_code: 'x' });
  expect(openHandoff(s)).toMatchObject({ code: 'D3', trigger: 'ET7' });
});
cover('E4:E4>6.4', async () => {
  const s = S.e4('e-e4-resume');
  choose(s, 'resume');
  expect(s.state.phase).toBe('S6');
  s.run();
  expect(s.state.terminal).toBe('Done');
});
cover('E4:E4>5.1', async () => {
  const s = S.e4('e-e4-replan', 'L4');
  choose(s, 'replan');
  expect(s.state.phase).toBe('S5');
});
cover('E4:E4>3.2', async () => {
  const s = S.e4('e-e4-respec', 'L4');
  choose(s, 'respec');
  expect(s.state.phase).toBe('S3');
});
cover('E4:E4>Abandoned', async () => {
  const s = S.e4('e-e4-abandon');
  choose(s, 'abandon');
  expect(s.state).toMatchObject({ terminal: 'Abandoned', terminal_cause: 'e4.abandon' });
});

// -- denied conditional gates
const denied = (gate: string, step: string, code: 'D1' | 'D2' | 'E4') => async () => {
  const s = sim(`e-den-${gate}-${step}`, { lane: 'L4' });
  s.run({
    script: repeat(step as never, gateNeeded(gate)),
    decide: (g) => (g === gate ? 'reject' : 'approve'),
  });
  expect(openHandoff(s)).toMatchObject({ code });
};
cover('gate:X1@6.4:denied', denied('X1', '6.4', 'D1'));
cover('gate:X3@6.4:denied', denied('X3', '6.4', 'D1'));
cover('gate:X2@7.4:denied', denied('X2', '7.4', 'D2'));
cover('gate:G3o@6.3:denied', denied('G3o', '6.3', 'D1'));
cover('gate:G3o@7.2:denied', denied('G3o', '7.2', 'D2'));
cover('gate:E6@7.2:denied', denied('E6', '7.2', 'D2'));
cover('gate:E2@4.5:denied', denied('E2', '4.5', 'E4'));
cover('gate:E2@7.5:denied', async () => {
  const s = sim('e-den-e2-75', { lane: 'L3' });
  s.run({
    script: forStep('7.5', [gateNeeded('E2')]),
    decide: (g) => (g === 'E2' ? 'reject' : 'approve'),
  });
  expect(s.state.terminal).toBe('Done');
  expect(tookPhase(s, 'S7', 'S6')).toBe(true);
});

// -- the phase edges only these reach
const phaseVia = (from: string, to: string, scenario: () => Promise<Sim> | Sim) =>
  cover(`phase:${from}>${to}`, async () => {
    const s = await scenario();
    expect(tookPhase(s, from, to), `${from}>${to} in ${trail(s)}`).toBe(true);
  });
phaseVia('G4', 'Handoff', () => {
  const s = sim('p-g4-ho', { lane: 'L3' });
  s.run({ decide: decideUntil('G4', 'request_changes', 9) });
  return s;
});
phaseVia('G4', 'S3', async () => {
  const s = await reach('G4');
  apply(s, 'B20');
  return s;
});
phaseVia('G4', 'S6', () => S.b13());
phaseVia('Handoff', 'Abandoned', () => {
  const s = S.e4('p-ho-ab');
  choose(s, 'abandon');
  return s;
});
phaseVia('Handoff', 'HandedOverClosed', () => {
  const s = S.e4('p-ho-close');
  choose(s, 'hand_over_close');
  expect(s.state.terminal).toBe('HandedOverClosed');
  return s;
});
phaseVia('Handoff', 'Held', () => {
  const s = S.e4('p-ho-held');
  s.apply(ITEM_EVENT.hold_placed, { hold_id: 'k', reason: 'kill', origin: 'c' });
  return s;
});
phaseVia('Held', 'Handoff', () => {
  const s = S.e4('p-held-ho');
  s.apply(ITEM_EVENT.hold_placed, { hold_id: 'k', reason: 'kill', origin: 'c' });
  s.apply(ITEM_EVENT.hold_released, { hold_id: 'k' });
  return s;
});
phaseVia('Handoff', 'S3', () => {
  const s = S.e4('p-ho-s3', 'L4');
  choose(s, 'respec');
  return s;
});
phaseVia('Handoff', 'S5', () => {
  const s = S.e4('p-ho-s5', 'L4');
  choose(s, 'replan');
  return s;
});
phaseVia('Handoff', 'S6', () => {
  const s = S.e4('p-ho-s6');
  choose(s, 'takeover');
  expect(s.state.lane).toBe('L8');
  return s;
});
phaseVia('S4', 'S3', () => S.b4());
phaseVia('S5', 'S3', async () => {
  const s = await reach('S5');
  apply(s, 'B20');
  return s;
});
phaseVia('Scheduling', 'S3', async () => {
  const s = await reach('Scheduling');
  apply(s, 'B20');
  return s;
});
phaseVia('S6', 'Handoff', () => S.e4('p-s6-ho'));
phaseVia('S6', 'S3', async () => {
  const s = await reach('S6');
  apply(s, 'B20');
  return s;
});
phaseVia('S6', 'S5', () => S.b8());
phaseVia('S7', 'Handoff', () => S.b9());
phaseVia('S7', 'S3', () => S.b10());
phaseVia('S7', 'S5', () => S.b11());
phaseVia('S7', 'S6', () => S.b9());
phaseVia('S8a', 'S6', () => {
  const s = S.atMerge('p-s8a-s6');
  apply(s, 'B15', { step: '8.2', variant: 'b' });
  return s;
});
phaseVia('S8a', 'S7', () => {
  const s = S.atMerge('p-s8a-s7');
  apply(s, 'B15', { step: '8.2', variant: 'a' });
  return s;
});
// B28's age limit reaches E4 from every active phase that has the edge
for (const p of [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'Scheduling',
  'S8a',
  'S8b',
  'G5',
  'S9',
  'G6',
] as const) {
  phaseVia(p, 'Handoff', async () => {
    const s = await reach(p);
    ageOut(s);
    expect(s.state.phase).toBe('Handoff');
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B28', origin_phase: p });
    return s;
  });
}

// ---------------------------------------------------------------- M9.5: re-laning (R1-R4)

const rec = (s: Sim, edge: 'R1' | 'R2') => s.state.relanes.find((r) => r.edge === edge);
const r1At = (name: string, from: Lane, to: Lane, step: '6.5' | '7.3' | '7.4', trig: string) => {
  const s = sim(name, { lane: from });
  s.run({ script: forStep(step, [relane('R1', trig, to), undefined]) });
  expect(s.state.terminal).toBe('Done');
  return s;
};
// R1 from 6.5, 7.3 and X2 (raised at 7.4) to the first missing stage: S2 (2.1) or S3 only (3.1)
for (const [edge, step, trig] of [
  ['6.5', '6.5', 'diff_over_lane_budget'],
  ['7.3', '7.3', 'contract_change'],
  ['X2', '7.4', 'x2_sensitive_path'],
] as const) {
  cover(`R1:${edge}>2.1`, async () => {
    const s = r1At(`e-r1-${edge}-21`, 'L3', 'L4', step, trig);
    expect(rec(s, 'R1')).toMatchObject({ step, target: '2.1', to_lane: 'L4' });
    expect(tookPhase(s, step === '6.5' ? 'S6' : 'S7', 'S2')).toBe(true);
  });
  cover(`R1:${edge}>3.1`, async () => {
    const s = r1At(`e-r1-${edge}-31`, 'L0', 'L1', step, trig);
    expect(rec(s, 'R1')).toMatchObject({ step, target: '3.1', to_lane: 'L1' });
    expect(tookPhase(s, step === '6.5' ? 'S6' : 'S7', 'S3')).toBe(true);
  });
}
// R2 from 2.3 (stage) and 4.6 (observed at the design review): E1, then 1.3 and G0 again
cover('R2:2.3>1.3', async () => {
  const s = sim('e-r2-23', { lane: 'L4' });
  s.run({ script: forStep('2.3', [relane('R2', 'smaller_than_lane', 'L3'), undefined]) });
  expect(s.state.terminal).toBe('Done');
  expect(rec(s, 'R2')).toMatchObject({ step: '2.3', target: '1.3', to_lane: 'L3' });
  expect(tookPhase(s, 'S2', 'S1')).toBe(true);
});
const atDesignReview = (name: string) => {
  const s = sim(name, { lane: 'L4' });
  s.run({ decide: (g) => (g === 'G3d' ? 'pending' : 'approve') });
  s.apply(ITEM_EVENT.relane_requested, {
    edge: 'R2',
    trigger: 'smaller_than_lane',
    to_lane: 'L3',
    step: '4.6',
    reason_code: 'test',
  });
  return s;
};
cover('R2:4.6>1.3', async () => {
  const s = atDesignReview('e-r2-46');
  s.run();
  expect(s.state.terminal).toBe('Done');
  expect(rec(s, 'R2')).toMatchObject({ step: '4.6', target: '1.3', to_lane: 'L3' });
  expect(tookPhase(s, 'S4', 'S1')).toBe(true);
});
cover('phase:S2>S1', COVERED['R2:2.3>1.3'] as Scenario);
cover('phase:S4>S1', COVERED['R2:4.6>1.3'] as Scenario);
// R1 sends S6 and S7 back to S2 (S2 is the first missing stage) ...
cover('phase:S6>S2', COVERED['R1:6.5>2.1'] as Scenario);
cover('phase:S7>S2', COVERED['R1:7.3>2.1'] as Scenario);
// ... and to S4 when S2 and S3 are done and S4 is the first missing one (after a downshift from 4.6)
for (const [from, step] of [
  ['S6', '6.5'],
  ['S7', '7.3'],
] as const) {
  cover(`phase:${from}>S4`, async () => {
    const s = atDesignReview(`e-r1-s4-${step}`);
    s.run({ script: forStep(step, [relane('R1', 'diff_over_lane_budget', 'L4'), undefined]) });
    expect(s.state.terminal).toBe('Done');
    expect(tookPhase(s, from, 'S4')).toBe(true);
    expect(s.state.relanes.map((r) => r.edge)).toEqual(['R2', 'R1']);
  });
}
// E1: approved goes to 1.3 (above); denied leaves the item where it was
cover('gate:E1@2.3:approved', COVERED['R2:2.3>1.3'] as Scenario);
cover('gate:E1@4.6:approved', COVERED['R2:4.6>1.3'] as Scenario);
cover('gate:E1@2.3:denied', async () => {
  const s = sim('e-r2-23-den', { lane: 'L4' });
  s.run({
    script: forStep('2.3', [relane('R2', 'smaller_than_lane', 'L3'), undefined]),
    decide: (g) => (g === 'E1' ? 'reject' : 'approve'),
  });
  expect(s.state.terminal).toBe('Done');
  expect(s.state.relanes).toEqual([]);
  expect(s.state.lane).toBe('L4');
});
cover('gate:E1@4.6:denied', async () => {
  const s = atDesignReview('e-r2-46-den');
  s.run({ decide: (g) => (g === 'E1' ? 'reject' : g === 'G3d' ? 'pending' : 'approve') });
  expect(s.state.relanes).toEqual([]);
  expect(s.state.waiting).toMatchObject({ kind: 'gates', conditional: null });
});
// R4: an L0 that completes S8b makes its L1 follow-up
cover('R4:S8b>REQ', async () => {
  const s = sim('e-r4', { lane: 'L0' });
  s.run();
  expect(s.state.terminal).toBe('Done');
  expect(s.state.spawns).toMatchObject([{ edge: 'R4', kind: 'hotfix_follow_up', lane: 'L1' }]);
});

// ---------------------------------------------------------------- Pending, with the reason

interface Rule {
  readonly milestone: string;
  readonly reason: string;
  readonly match: (key: string) => boolean;
}
const hasPhase = (key: string, ...ps: string[]) =>
  ps.some((p) => key.startsWith(`phase:${p}>`) || key.endsWith(`>${p}`));
const PENDING_RULES: Rule[] = [
  {
    milestone: 'M13.5',
    reason:
      'quarantine (Q1, ET10, SECT) is the sandbox milestone; the engine has no misbehaviour signal before it (FL B27 flags at G0, it does not quarantine)',
    match: (k) => /^(Q1|SECT):/.test(k) || hasPhase(k, 'Quarantined'),
  },
  {
    milestone: 'n/a',
    reason:
      'DM shortcuts with no flow edge behind them: G4 is never skipped (S7 -> G4 -> S8a, never S7 -> S8a), the release step S8b always follows G5 (G5 -> S8b -> S9, never G5 -> S9), and no back-edge returns from S5 to S4 (B5 re-plans inside S5; B24 and B25 go to 4.1 from S4 itself)',
    match: (k) => k === 'phase:S7>S8a' || k === 'phase:G5>S9' || k === 'phase:S5>S4',
  },
];

const pendingOf = (key: string): Rule[] => PENDING_RULES.filter((r) => r.match(key));

describe('every FL edge is covered or pending with a reason, exactly', () => {
  const keys = [...new Set(universe)].sort();
  const covered = keys.filter((k) => k in COVERED);
  const pending = keys.filter((k) => !(k in COVERED));

  it('generates the universe from the contracts and the catalogue', () => {
    expect(keys.length).toBeGreaterThan(200);
    expect(keys.filter((k) => k.startsWith('phase:')).length).toBe(
      Object.values(WORK_ITEM_TRANSITIONS).reduce((n, t) => n + t.length, 0),
    );
  });

  it('has a scenario for no edge that is not in the universe', () => {
    expect(Object.keys(COVERED).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it('every edge that is not covered is pending under exactly one rule', () => {
    const none = pending.filter((k) => pendingOf(k).length === 0);
    const many = pending.filter((k) => pendingOf(k).length > 1);
    expect(none, `neither covered nor pending: ${none.join(', ')}`).toEqual([]);
    expect(
      many.map(
        (k) =>
          `${k}: ${pendingOf(k)
            .map((r) => r.milestone)
            .join('+')}`,
      ),
    ).toEqual([]);
  });

  it('no covered edge is also listed as pending', () => {
    expect(covered.filter((k) => pendingOf(k).length > 0)).toEqual([]);
  });

  it('the table is exactly this (a change to it is a decision)', async () => {
    const by: Record<string, number> = {};
    for (const k of pending) {
      const m = pendingOf(k)[0]?.milestone as string;
      by[m] = (by[m] ?? 0) + 1;
    }
    if (process.env['LIST_PENDING'])
      (await import('node:fs')).writeFileSync(
        process.env['LIST_PENDING'],
        pending.map((k) => `${pendingOf(k)[0]?.milestone} ${k}`).join('\n'),
      );
    console.info(
      `FL edges: ${keys.length} in all, ${covered.length} covered, ${pending.length} pending ${JSON.stringify(by)}`,
    );
    expect({ covered: covered.length, pending: pending.length, by }).toEqual({
      covered: COVERED_COUNT,
      pending: PENDING_COUNT,
      by: PENDING_BY,
    });
  });

  describe('covered edges, each against the fake stages', () => {
    for (const k of covered) it(k, COVERED[k] as Scenario);
  });
});

// The exact numbers of the milestone. M9.3, M9.4 and M9.5 are done: what is left is the quarantine
// (M13.5) and three phase-table edges no flow edge draws.
const COVERED_COUNT = 498;
const PENDING_COUNT = 14;
const PENDING_BY: Record<string, number> = {
  'M13.5': 11,
  'n/a': 3,
};
