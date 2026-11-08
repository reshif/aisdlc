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
  expect(s.state.waiting).toEqual({ kind: 'parked', cause: 'b1_round_limit' });
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
  for (const step of c.steps) {
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
      expect(calls.length).toBe(c.on_approve === 'resume' ? 2 : 1);
      if (c.on_approve === 'resume') expect(calls[1]?.approved_gates).toEqual([gate]);
    });
  }
}

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
    milestone: 'M9.3',
    reason:
      'PARK exits (answers arrive -> 1.5, the 5 bd timeout -> Abandoned), the Clarifying -> Parked silence edge, and BLOCKED (B6 -> L2 remediation) need timers and holds/terminals',
    match: (k) =>
      [
        'phase:Parked>S1',
        'phase:Parked>Abandoned',
        'phase:Clarifying>Parked',
        'B6:6.2>Blocked',
      ].includes(k),
  },
  {
    milestone: 'M9.3',
    reason:
      'RELHOLD (B26) and its two exits (re-request -> G5, needs change -> NEW linked item) belong to the holds and terminals task',
    match: (k) => k.startsWith('B26:'),
  },
  {
    milestone: 'M9.4',
    reason:
      'rework back-edges with limits and the per-item rework budget (B2-B5, B7-B15, B20, B21, B23-B25, B28)',
    match: (k) => /^B(2|3|4|5|7|8|9|10|11|12|13|14|15|20|21|23|24|25|28):/.test(k),
  },
  {
    milestone: 'M9.4',
    reason: 'handoffs D1-D3 -> E4 with its five choices, E3/E5, D4 hand-back and D5 complete',
    match: (k) => /^(D1|D2|D3|D4|D5|E4):/.test(k) || hasPhase(k, 'Handoff'),
  },
  {
    milestone: 'M9.4',
    reason:
      'the trigger of a NEW linked item (B16-B19) is a back-edge with a rework count; the SpawnLink mechanism itself is covered by the spawn tests',
    match: (k) => /^B(16|17|18|19):/.test(k),
  },
  {
    milestone: 'M9.4',
    reason:
      'a denied exception gate (X1/X3 -> D1, X2 -> D2, E2 -> B25, G3o) leaves through a handoff or a back-edge with limits',
    match: (k) => /^gate:.*:denied$/.test(k),
  },
  {
    milestone: 'M9.4',
    reason:
      'rework back-edges that return to an earlier stage (S2/S4/S5/S6 -> S3/S4/S5, S6/S7 -> earlier stages as re-spec, re-plan and amend): B4, B5, B8, B9-B13, B20',
    match: (k) =>
      [
        'phase:S4>S3',
        'phase:S5>S3',
        'phase:S5>S4',
        'phase:Scheduling>S3',
        'phase:S7>S6',
        'phase:S7>S5',
        'phase:S7>S4',
        'phase:S7>S3',
        'phase:G4>S6',
        'phase:G4>S3',
        'phase:S8a>S6',
        'phase:S8a>S7',
        'phase:S6>S5',
        'phase:S6>S4',
        'phase:S6>S3',
      ].includes(k),
  },
  {
    milestone: 'M9.5',
    reason:
      're-laning: R1 upshift (insert the first missing stage), R2 downshift with E1 re-running G0, R3 circuit breaker ET14, R4 hotfix follow-up',
    match: (k) =>
      /^R[1-4]:/.test(k) ||
      ['phase:S2>S1', 'phase:S4>S1', 'phase:S6>S2', 'phase:S7>S2'].includes(k),
  },
  {
    milestone: 'M13.5',
    reason:
      'quarantine (Q1, ET10, SECT) is the sandbox milestone; the engine has no misbehaviour signal before it (FL B27 flags at G0, it does not quarantine)',
    match: (k) => /^(Q1|SECT):/.test(k) || hasPhase(k, 'Quarantined'),
  },
  {
    milestone: 'n/a',
    reason:
      'DM shortcuts with no flow edge behind them: G4 is never skipped (S7 -> G4 -> S8a, never S7 -> S8a), and the release step S8b always follows G5 (G5 -> S8b -> S9, never G5 -> S9)',
    match: (k) => k === 'phase:S7>S8a' || k === 'phase:G5>S9',
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

  it('the table is exactly this (a change to it is a decision)', () => {
    const by: Record<string, number> = {};
    for (const k of pending) {
      const m = pendingOf(k)[0]?.milestone as string;
      by[m] = (by[m] ?? 0) + 1;
    }
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

// Filled in from the first run; they are the exact numbers of the milestone.
const COVERED_COUNT = 396;
const PENDING_COUNT = 97;
const PENDING_BY: Record<string, number> = {
  'M9.3': 5,
  'M9.4': 66,
  'M9.5': 13,
  'M13.5': 11,
  'n/a': 2,
};
