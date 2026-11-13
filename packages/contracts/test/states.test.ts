import { describe, expect, it } from 'vitest';
import {
  AGENT_SESSION_TRANSITIONS,
  AgentSessionMachine,
  DECISION_TO_STATUS,
  GATE_TRANSITIONS,
  GateMachine,
  GateStatusValues,
  HEALTH_TRANSITIONS,
  HealthMachine,
  LedgerDecisionValues,
  ONBOARDING_TRANSITIONS,
  OnboardingMachine,
  READINESS_TRANSITIONS,
  ReadinessMachine,
  TerminalStateValues,
  UNIT_TRANSITIONS,
  UnitMachine,
  WORK_ITEM_TRANSITIONS,
  WorkItemMachine,
  assertTransitionReadinessBy,
  canTransitionReadinessBy,
  type Machine,
} from '../src/index.js';

/** Spec edges, written out from the DM diagrams ("A -> B" or "A -> B | C"), independent of the tables. */
function edges(spec: string): [string, string][] {
  return spec
    .trim()
    .split('\n')
    .flatMap((line) => {
      const [from, tos] = line.split('->').map((s) => s.trim());
      return (tos ?? '').split('|').map((to): [string, string] => [from ?? '', to.trim()]);
    });
}

type Case = {
  machine: Machine<string>;
  states: readonly string[];
  spec: string;
  /** Edges taken from the flow or from code notes, not from the diagram (see the comment in the source). */
  inferred: string;
  nonEdges: [string, string][];
  terminals: string[];
};

const cases: Record<string, Case> = {
  WorkItem: {
    machine: WorkItemMachine as Machine<string>,
    states: Object.keys(WORK_ITEM_TRANSITIONS),
    spec: `
      Draft -> S1 | Withdrawn
      S1 -> S2 | S3 | Scheduling | Declined | Clarifying | Quarantined | Held | Parked
      Clarifying -> S1
      S2 -> S3 | Scheduling | Held
      S3 -> S4 | S5 | Held
      S4 -> S5
      S5 -> Scheduling | S3 | S4
      Scheduling -> S6 | Held
      S6 -> S7 | Handoff | S9 | Held
      S7 -> S6 | S8a | G4
      G4 -> S8a | S6
      S8a -> S8b | S6
      S8b -> G5
      G5 -> S9 | S8b
      S9 -> G6
      G6 -> Done
      Held -> S1 | Abandoned
      Handoff -> S6 | HandedOverClosed | Abandoned
      Quarantined -> S1 | Abandoned
      Parked -> S1`,
    inferred: `
      Parked -> Abandoned | Held
      Clarifying -> Parked | Held
      S1 -> Handoff
      S2 -> S1 | S3 | Handoff
      S3 -> Held | Handoff
      S4 -> S3 | S1 | Held | Handoff
      S5 -> Held | Handoff
      Scheduling -> S3 | Handoff
      S6 -> Quarantined | S5 | S4 | S3 | S2
      S7 -> Handoff | Quarantined | S5 | S4 | S3 | S2 | Held
      G4 -> Handoff | S3 | Held
      S8a -> S7 | Held | Handoff
      S8b -> S9 | Held | Handoff
      G5 -> Held | Handoff
      S9 -> Done | Held | Handoff
      G6 -> Held | Handoff
      Held -> S2 | S3 | S4 | S5 | S6 | S7 | Scheduling | Clarifying | G4 | S8a | S8b | G5 | S9 | G6 | Handoff | Quarantined | Parked
      Handoff -> S5 | S3 | Held
      Quarantined -> S6 | Held`,
    nonEdges: [
      ['Draft', 'S2'],
      ['S1', 'S6'],
      ['S1', 'S7'],
      ['S4', 'S6'],
      ['S5', 'S6'],
      ['S6', 'S8a'],
      ['S7', 'S9'],
      ['S8a', 'S9'],
      ['G4', 'G5'],
      ['G6', 'Abandoned'],
      ['Done', 'S1'],
      ['Declined', 'S1'],
      ['Withdrawn', 'Draft'],
      ['Abandoned', 'S1'],
      ['Held', 'Done'],
      ['Quarantined', 'S7'],
      ['S1', 'S1'],
      ['Superseded', 'S1'],
      ['S3', 'Superseded'],
    ],
    terminals: [...TerminalStateValues],
  },
  GateInstance: {
    machine: GateMachine as Machine<string>,
    states: GateStatusValues,
    spec: `pending -> pending | decided | superseded | expired | closed`,
    inferred: '',
    nonEdges: [
      ['decided', 'pending'],
      ['decided', 'superseded'],
      ['expired', 'decided'],
      ['expired', 'pending'],
      ['superseded', 'decided'],
      ['closed', 'pending'],
      ['decided', 'decided'],
      ['closed', 'decided'],
    ],
    terminals: ['decided', 'superseded', 'expired', 'closed'],
  },
  OnboardingRecord: {
    machine: OnboardingMachine as Machine<string>,
    states: Object.keys(ONBOARDING_TRANSITIONS),
    spec: `
      app -> running | withdrawn
      running -> card | blocked | starter | parked | done | withdrawn | superseded
      card -> running | rejected | withdrawn
      blocked -> running | withdrawn
      starter -> running
      parked -> running | withdrawn
      rejected -> running | withdrawn`,
    inferred: `starter -> withdrawn`,
    nonEdges: [
      ['app', 'card'],
      ['app', 'done'],
      ['card', 'done'],
      ['blocked', 'done'],
      ['starter', 'done'],
      ['parked', 'done'],
      ['rejected', 'done'],
      ['done', 'running'],
      ['withdrawn', 'running'],
      ['superseded', 'running'],
      ['card', 'blocked'],
      ['done', 'withdrawn'],
      ['running', 'rejected'],
    ],
    terminals: ['done', 'superseded', 'withdrawn'],
  },
  ReadinessRecord: {
    machine: ReadinessMachine as Machine<string>,
    states: Object.keys(READINESS_TRANSITIONS),
    spec: `
      proposed -> active
      active -> stale | suspended | expired | superseded`,
    inferred: `
      stale -> suspended | expired | superseded
      suspended -> active | expired | superseded`,
    nonEdges: [
      ['proposed', 'stale'],
      ['proposed', 'suspended'],
      ['proposed', 'expired'],
      ['stale', 'active'],
      ['expired', 'active'],
      ['superseded', 'active'],
      ['active', 'proposed'],
      ['active', 'active'],
      ['expired', 'superseded'],
      ['suspended', 'stale'],
    ],
    terminals: ['expired', 'superseded'],
  },
  Unit: {
    machine: UnitMachine as Machine<string>,
    states: Object.keys(UNIT_TRANSITIONS),
    spec: `
      Planned -> Admitted
      Admitted -> Building | GrantReleased
      Building -> Building | Pushed | HumanHeld | Tainted | Stopped
      Pushed -> Verifying | Planned
      Verifying -> Building | InReview | Planned
      InReview -> Merged | Building | Planned
      Merged -> Released
      HumanHeld -> Building
      Tainted -> Quarantined`,
    inferred: '',
    nonEdges: [
      ['Planned', 'Building'],
      ['Admitted', 'Pushed'],
      ['Building', 'Verifying'],
      ['Building', 'Merged'],
      ['Pushed', 'InReview'],
      ['Verifying', 'Merged'],
      ['InReview', 'Released'],
      ['Merged', 'Building'],
      ['Released', 'Building'],
      ['Stopped', 'Building'],
      ['Quarantined', 'Building'],
      ['Tainted', 'Building'],
      ['HumanHeld', 'Pushed'],
      ['GrantReleased', 'Admitted'],
      ['Merged', 'Planned'],
      ['Released', 'Planned'],
      ['Building', 'Planned'],
    ],
    terminals: ['Released', 'Quarantined', 'Stopped', 'GrantReleased'],
  },
  AgentSession: {
    machine: AgentSessionMachine as Machine<string>,
    states: Object.keys(AGENT_SESSION_TRANSITIONS),
    spec: `
      starting -> running
      running -> idle | waiting_tool | interrupted
      idle -> ended | stopped | tainted
      waiting_tool -> ended | stopped | tainted
      interrupted -> ended | stopped | tainted
      running -> ended | stopped | tainted`,
    inferred: `
      idle -> running
      waiting_tool -> running
      interrupted -> running
      starting -> stopped | tainted`,
    nonEdges: [
      ['starting', 'idle'],
      ['starting', 'ended'],
      ['idle', 'waiting_tool'],
      ['idle', 'starting'],
      ['running', 'starting'],
      ['ended', 'running'],
      ['stopped', 'running'],
      ['tainted', 'running'],
      ['ended', 'stopped'],
      ['tainted', 'ended'],
      ['running', 'running'],
    ],
    terminals: ['ended', 'stopped', 'tainted'],
  },
  Health: {
    machine: HealthMachine as Machine<string>,
    states: Object.keys(HEALTH_TRANSITIONS),
    spec: `
      ok -> degraded | down | unknown
      degraded -> ok | down | unknown
      down -> ok | degraded | unknown
      unknown -> ok | degraded | down`,
    inferred: '',
    nonEdges: [
      ['ok', 'ok'],
      ['down', 'down'],
      ['unknown', 'unknown'],
      ['degraded', 'degraded'],
    ],
    terminals: [],
  },
};

describe.each(Object.entries(cases))('%s', (_name, c) => {
  const specEdges = [...edges(c.spec), ...edges(c.inferred === '' ? 'x -> x' : c.inferred)].filter(
    ([f, t]) => !(f === 'x' && t === 'x'),
  );

  it('has a row for every state and only known targets', () => {
    expect(Object.keys(c.machine.table).sort()).toEqual([...c.states].sort());
    for (const tos of Object.values(c.machine.table)) {
      for (const to of tos) expect(c.states).toContain(to);
    }
  });

  it('allows every spec edge', () => {
    for (const [from, to] of specEdges) {
      expect(c.machine.canTransition(from, to), `${from} -> ${to}`).toBe(true);
      expect(c.machine.assertTransition(from, to)).toEqual({ ok: true, value: to });
    }
  });

  it('has no edge beyond the spec edges', () => {
    const allowed = new Set(specEdges.map(([f, t]) => `${f}>${t}`));
    for (const [from, tos] of Object.entries(c.machine.table)) {
      for (const to of tos) expect(allowed.has(`${from}>${to}`), `${from} -> ${to}`).toBe(true);
    }
  });

  it('rejects sampled non-edges with a tagged error', () => {
    for (const [from, to] of c.nonEdges) {
      expect(c.machine.canTransition(from, to), `${from} -> ${to}`).toBe(false);
      const r = c.machine.assertTransition(from, to);
      expect(r).toEqual({
        ok: false,
        error: { _tag: 'InvalidTransition', machine: c.machine.name, from, to },
      });
    }
  });

  it('refuses unknown states', () => {
    expect(c.machine.canTransition('nope', c.states[0] ?? '')).toBe(false);
    expect(c.machine.canTransition(c.states[0] ?? '', 'nope')).toBe(false);
    expect(c.machine.canTransition('__proto__', 'constructor')).toBe(false);
  });

  it('has no outgoing edges from terminals, and only those', () => {
    expect([...c.machine.terminals].sort()).toEqual([...c.terminals].sort());
    for (const t of c.terminals) {
      for (const s of c.states) expect(c.machine.canTransition(t, s), `${t} -> ${s}`).toBe(false);
    }
  });
});

describe('WorkItem terminals', () => {
  it('are exactly TerminalState', () => {
    expect([...WorkItemMachine.terminals].sort()).toEqual([...TerminalStateValues].sort());
  });
});

describe('LedgerDecision to gate status', () => {
  it('maps every decision, and expire never approves', () => {
    expect(Object.keys(DECISION_TO_STATUS).sort()).toEqual([...LedgerDecisionValues].sort());
    expect(DECISION_TO_STATUS).toEqual({
      approve: 'decided',
      reject: 'decided',
      request_changes: 'decided',
      supersede: 'superseded',
      expire: 'expired',
      withdraw: 'closed',
    });
    for (const status of Object.values(DECISION_TO_STATUS)) {
      expect(GATE_TRANSITIONS.pending).toContain(status);
    }
  });
});

describe('ReadinessRecord actors', () => {
  it('lets only an M4 decision activate', () => {
    expect(canTransitionReadinessBy('m4_decision', 'proposed', 'active')).toBe(true);
    expect(canTransitionReadinessBy('mechanical', 'proposed', 'active')).toBe(false);
    const r = assertTransitionReadinessBy('mechanical', 'proposed', 'active');
    expect(r.ok).toBe(false);
  });

  it('lets mechanical checks only tighten', () => {
    for (const to of ['stale', 'suspended', 'expired'] as const) {
      expect(canTransitionReadinessBy('mechanical', 'active', to)).toBe(true);
    }
    expect(canTransitionReadinessBy('mechanical', 'stale', 'suspended')).toBe(true);
    expect(canTransitionReadinessBy('mechanical', 'active', 'superseded')).toBe(false);
    expect(canTransitionReadinessBy('mechanical', 'stale', 'active')).toBe(false);
    expect(canTransitionReadinessBy('m4_decision', 'active', 'superseded')).toBe(true);
    expect(canTransitionReadinessBy('m4_decision', 'expired', 'active')).toBe(false);
  });

  it('lets only a restore lift a suspension (DEC-21(b)), and a restore do nothing else', () => {
    expect(canTransitionReadinessBy('restore', 'suspended', 'active')).toBe(true);
    expect(canTransitionReadinessBy('mechanical', 'suspended', 'active')).toBe(false);
    expect(canTransitionReadinessBy('m4_decision', 'suspended', 'active')).toBe(false);
    for (const [from, to] of [
      ['expired', 'active'],
      ['stale', 'active'],
      ['proposed', 'active'],
      ['active', 'suspended'],
      ['suspended', 'expired'],
    ] as const) {
      expect(canTransitionReadinessBy('restore', from, to)).toBe(false);
    }
  });
});
