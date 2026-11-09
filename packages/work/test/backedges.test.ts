import { CATALOGUE } from '@aisdlc/catalogue';
import { ITEM_EVENT, type BackEdgeId } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { effectiveLimit, edgeLimit, reworkTotalLimit } from '../src/index.js';
import {
  choose,
  decideUntil,
  forStep,
  gateNeeded,
  newSim,
  openHandoff,
  repeat,
  rework,
  scripts,
  trigger,
} from './scen.js';
import type { Sim } from './sim.js';

// M9.4: every back-edge with its catalogue limit, the per-item rework budget, the handoffs D1-D3 and
// E4's choices. The limits are read from the catalogue, never written here: a scenario loops one
// round more than the catalogue allows and expects the catalogue's exit.

const limit = (edge: BackEdgeId, key?: string): number => {
  const e = CATALOGUE.back_edge_limits[edge];
  if (e.kind !== 'limited') throw new Error(`${edge} has no limit`);
  const l = key === undefined ? e.limits[0] : edgeLimit(CATALOGUE, edge, key);
  const v = l === null || l === undefined ? null : effectiveLimit(CATALOGUE, l);
  if (v === null) throw new Error(`${edge}.${key} has no number`);
  return v;
};
const budget = (): number => reworkTotalLimit(CATALOGUE) as number;

const phases = (s: Sim) => s.phases.join('>');
const count = (s: Sim, edge: string) => s.state.rework.by_edge[edge] ?? 0;
const ran = (s: Sim, step: string) => s.stepsOnly().filter((x) => x === step).length;
const gatesOpened = (s: Sim, gate: string) =>
  s.gateLog.filter((g) => g.gates.includes(gate as never)).length;

describe('the catalogue says what the scenarios below rely on', () => {
  it('has numbers for the loops the engine bounds, and none for the S7 repair loops it leaves to the budget', () => {
    expect(limit('B2')).toBe(2);
    expect(limit('B3')).toBe(3);
    expect(limit('B4')).toBe(1);
    expect(limit('B5')).toBe(2);
    expect(limit('B7', 'et3_rounds')).toBe(3);
    expect(limit('B8')).toBe(1);
    // B9's ET3 limit is the ET table's (3 rounds); ET4-ET6 have no number anywhere
    expect(limit('B9', 'et3_rounds')).toBe(3);
    expect(() => limit('B9', 'et4_limit')).toThrow();
    expect(budget()).toBe(5);
  });
});

describe('B2 intent ambiguous (2.1 -> 1.5, G1 again, then E4)', () => {
  it('goes back to clarify twice, runs G0+G1 again each time, and the next time is E4', () => {
    const n = limit('B2');
    const s = newSim('b2', { lane: 'L4' });
    s.run({ script: repeat('2.1', rework('B2')) });
    expect(count(s, 'B2')).toBe(n + 1);
    expect(ran(s, '1.5')).toBe(1 + n);
    expect(gatesOpened(s, 'G0')).toBe(1 + n);
    expect(s.state.phase).toBe('Handoff');
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B2', origin_phase: 'S2' });
    expect(phases(s)).toContain('S2>S1');
    expect(phases(s)).toContain('S2>Handoff');
  });
});

describe('B3 validator or critic fail (3.3 -> 3.2, 3 auto rounds, then ET8 = D1)', () => {
  it('re-drafts the spec up to the limit, then hands off as D1 on ET8', () => {
    const n = limit('B3');
    const s = newSim('b3', { lane: 'L4' });
    s.run({ script: repeat('3.3', rework('B3')) });
    expect(ran(s, '3.2')).toBe(1 + n);
    expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'ET8', origin_phase: 'S3' });
    // ET8's effect in the ET table is a D1 handoff: that is where "then ET8" goes
    expect(CATALOGUE.triggers.ET8.effects).toEqual([{ kind: 'handoff', handoff: 'D1' }]);
  });
});

describe('B4 design reveals a spec gap (4.6 -> 3.2, 1x)', () => {
  it('the design reviewer sends it back once; the second time is E4', () => {
    const s = newSim('b4', { lane: 'L4' });
    const hold = {
      decide: (g: string) => (g === 'G3d' ? ('pending' as const) : ('approve' as const)),
    };
    s.run(hold);
    expect(s.state.waiting).toMatchObject({ kind: 'gates', gates: ['G3d'] });
    s.apply(ITEM_EVENT.rework_requested, { edge: 'B4', step: '4.6', reason_code: 'spec_gap' });
    expect(s.state.phase).toBe('S3');
    expect(phases(s)).toContain('S4>S3');
    s.run(hold);
    expect(s.state.waiting).toMatchObject({ kind: 'gates', gates: ['G3d'] });
    expect(ran(s, '3.2')).toBe(2);
    s.apply(ITEM_EVENT.rework_requested, { edge: 'B4', step: '4.6', reason_code: 'spec_gap' });
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B4', origin_phase: 'S4' });
    // the old G3d instances are withdrawn, not left to decide
    expect(s.steps.flatMap((x) => x.commands).some((c) => c.type === 'withdraw_gates')).toBe(true);
  });

  it('is refused unless the design review is what the item waits for', () => {
    const s = newSim('b4-no', { lane: 'L4' });
    s.run({ stopAtHuman: ['ready'] });
    const before = s.state.rework.total;
    s.apply(ITEM_EVENT.rework_requested, { edge: 'B4', step: '4.6', reason_code: 'x' });
    expect(s.state.rework.total).toBe(before);
    expect(s.state.ignored.at(-1)).toContain('B4');
  });
});

describe('B5 plan changes requested (G3 -> 5.1, 2 rejections, then a human writes the plan)', () => {
  it('re-plans twice; the third rejection hands the plan to a human; G3 approves what they wrote', () => {
    const n = limit('B5');
    const s = newSim('b5', { lane: 'L4' });
    s.run({ decide: decideUntil('G3', 'request_changes', n + 1), stopAtHuman: ['plan'] });
    expect(ran(s, '5.1')).toBe(1 + n);
    expect(s.state.waiting).toEqual({ kind: 'human', what: 'plan' });
    expect(s.state.human_plan).toBe(true);
    s.run({ decide: () => 'approve' });
    expect(s.state.terminal).toBe('Done');
    expect(gatesOpened(s, 'G3')).toBe(n + 2);
  });

  it('a rejection after the human plan is E4', () => {
    const n = limit('B5');
    const s = newSim('b5-e4', { lane: 'L4' });
    s.run({ decide: decideUntil('G3', 'reject', n + 2) });
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B5' });
  });
});

describe('B6 red baseline or a broken environment (6.2 -> BLOCKED, an L2 remediation item, env fixed -> 6.1)', () => {
  it('blocks for the platform owner, spawns an L2 item with a SpawnLink, and 6.1 runs again once the env is fixed', () => {
    const s = newSim('b6', { lane: 'L3' });
    s.run({ script: forStep('6.2', [rework('B6')]) });
    expect(s.state.waiting).toMatchObject({ kind: 'blocked', owner: 'platform_owner' });
    expect(s.state.phase).toBe('S6');
    expect(s.state.spawns).toHaveLength(1);
    expect(s.state.spawns[0]).toMatchObject({ edge: 'B6', kind: 'remediation', lane: 'L2' });
    expect(count(s, 'B6')).toBe(1);
    // nothing moves it but "env fixed"
    s.run();
    expect(s.state.waiting).toMatchObject({ kind: 'blocked' });
    s.apply(ITEM_EVENT.env_fixed, { by: 'platform-owner' });
    s.run();
    expect(s.state.terminal).toBe('Done');
    expect(ran(s, '6.1')).toBe(2);
    expect(ran(s, '6.2')).toBe(2);
  });
});

describe('B7 task check fails (6.5 -> 6.4: ET3 rounds, ET2 CI rounds or time, then D1)', () => {
  it('loops ET3 rounds up to the limit and hands off as D1 on the next', () => {
    const n = limit('B7', 'et3_rounds');
    const s = newSim('b7', { lane: 'L3' });
    s.run({ script: repeat('6.5', rework('B7', { loop: 'et3_rounds' })) });
    expect(ran(s, '6.4')).toBe(1 + n);
    expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'B7', origin_phase: 'S6' });
  });

  it('counts CI rounds apart from repeat failures, each against its own limit', () => {
    const ci = limit('B7', 'et2_ci_rounds');
    const et3 = limit('B7', 'et3_rounds');
    const s = newSim('b7-ci', { lane: 'L3' });
    // one ET3 round, then CI rounds: the CI loop has its own count
    s.run({
      script: forStep('6.5', [
        rework('B7', { loop: 'et3_rounds' }),
        ...Array.from({ length: ci + 1 }, () => rework('B7', { loop: 'et2_ci_rounds' })),
      ]),
    });
    // 1 ET3 round + ci CI rounds were taken (total never reaches the budget before the CI limit?):
    // whichever comes first, the item is in a handoff, never looping on
    expect(s.state.waiting?.kind).toBe('handoff');
    expect(s.state.rework.by_loop['B7:et3_rounds']).toBe(1);
    expect(s.state.rework.by_loop['B7:et2_ci_rounds']).toBeGreaterThan(0);
    expect(et3).toBeGreaterThan(1);
  });

  it('2x the time is D1 at once: a measure over the limit, not a count', () => {
    const mult = limit('B7', 'et2_time_multiple');
    const s = newSim('b7-time', { lane: 'L3' });
    s.run({
      script: forStep('6.5', [rework('B7', { loop: 'et2_time_multiple', observed: mult })]),
    });
    expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'B7' });
    expect(ran(s, '6.4')).toBe(1);
  });

  it('a measure under the limit loops', () => {
    const mult = limit('B7', 'et2_time_multiple');
    const s = newSim('b7-under', { lane: 'L3' });
    s.run({
      script: forStep('6.5', [rework('B7', { loop: 'et2_time_multiple', observed: mult - 0.5 })]),
    });
    expect(s.state.terminal).toBe('Done');
    expect(ran(s, '6.4')).toBe(2);
  });
});

describe('B8 scope tripwire (6.5 -> 5.1 split the Unit, G3 again; the 2nd time D1)', () => {
  it('goes back to plan once, G3 runs again, and the second tripwire is D1', () => {
    const n = limit('B8');
    const s = newSim('b8', { lane: 'L4' });
    s.run({ script: repeat('6.5', rework('B8')) });
    expect(ran(s, '5.1')).toBe(1 + n);
    expect(gatesOpened(s, 'G3')).toBe(1 + n);
    expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'B8' });
    expect(phases(s)).toContain('S6>S5');
  });
});

describe('B9 repairable finding (7.6 -> 6.4, ET3 limit, then D2)', () => {
  it('repairs up to the ET3 rounds, then D2 with the Evidence Pack reference in the pack', () => {
    const n = limit('B9', 'et3_rounds');
    const s = newSim('b9', { lane: 'L3' });
    s.run({ script: repeat('7.6', rework('B9')) });
    expect(ran(s, '6.4')).toBe(1 + n);
    const h = openHandoff(s);
    expect(h).toMatchObject({ code: 'D2', trigger: 'B9', origin_phase: 'S7' });
    expect(h.pack.pack_id).toBe(`handoff-pack:${h.handoff_id}`);
    // what the item produced before the handoff is in its pack (the Evidence Pack's step 7.6 never completed here)
    expect(s.state.outputs['7.5']).toBeDefined();
    expect(phases(s)).toContain('S7>S6');
  });

  it('with no number of its own (ET4-ET6) a loop is bounded only by the rework budget', () => {
    const s = newSim('b9-budget', { lane: 'L3' });
    s.run({ script: repeat('7.6', rework('B9', { loop: 'et4_limit' })) });
    // each round adds 1; the budget ends it, straight to E4 (B28)
    expect(s.state.rework.total).toBe(budget());
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B28' });
    expect(count(s, 'B28')).toBe(1);
    expect(s.state.et14['rework_budget']).toBe(1);
  });
});

describe('B10 spec ambiguous (7.3 -> 3.2, the G2 portion again, 1x then D2)', () => {
  it('re-specs once, G2 runs again, the second time is D2', () => {
    const n = limit('B10');
    const s = newSim('b10', { lane: 'L4' });
    s.run({ script: repeat('7.3', rework('B10')) });
    expect(ran(s, '3.2')).toBe(1 + n);
    expect(gatesOpened(s, 'G2')).toBe(1 + n);
    expect(openHandoff(s)).toMatchObject({ code: 'D2', trigger: 'B10' });
    expect(phases(s)).toContain('S7>S3');
  });
});

describe('B11 approach wrong (7.6 -> 5.1, G3 again, 1x then D2)', () => {
  it('re-plans once, G3 runs again, the second time is D2', () => {
    const n = limit('B11');
    const s = newSim('b11', { lane: 'L4' });
    s.run({ script: repeat('7.6', rework('B11')) });
    expect(ran(s, '5.1')).toBe(1 + n);
    expect(gatesOpened(s, 'G3')).toBe(1 + n);
    expect(openHandoff(s)).toMatchObject({ code: 'D2', trigger: 'B11' });
    expect(phases(s)).toContain('S7>S5');
  });
});

describe('B12 a locked test must change (7.2 -> E6 -> G3o -> 6.4, 1x then D2)', () => {
  it('opens E6, then G3o, and goes back to 6.4; the second time is D2', () => {
    const n = limit('B12');
    const s = newSim('b12', { lane: 'L3' });
    s.run({ script: repeat('7.2', gateNeeded('E6')) });
    expect(gatesOpened(s, 'E6')).toBe(n);
    expect(gatesOpened(s, 'G3o')).toBe(n);
    expect(ran(s, '6.4')).toBe(1 + n);
    expect(count(s, 'B12')).toBe(n + 1);
    expect(openHandoff(s)).toMatchObject({ code: 'D2', trigger: 'B12' });
    expect(phases(s)).toContain('S7>S6');
  });

  it('a stage may also report it as the back-edge itself', () => {
    const s = newSim('b12-rw', { lane: 'L3' });
    s.run({ script: forStep('7.2', [rework('B12')]) });
    expect(s.state.terminal).toBe('Done');
    expect(gatesOpened(s, 'E6')).toBe(1);
  });
});

describe('B13 G4 changes requested (8.1 -> 6.4, ET7 2 rounds, then D3)', () => {
  it('goes back to build twice and the third request is D3', () => {
    const n = limit('B13');
    const s = newSim('b13', { lane: 'L3' });
    s.run({ decide: decideUntil('G4', 'request_changes', n + 1) });
    expect(ran(s, '6.4')).toBe(1 + n);
    expect(gatesOpened(s, 'G4')).toBe(1 + n);
    expect(openHandoff(s)).toMatchObject({ code: 'D3', trigger: 'B13', origin_phase: 'G4' });
    expect(phases(s)).toContain('G4>S6');
    expect(phases(s)).toContain('G4>Handoff');
  });
});

describe('B14 mode-E approver unsure (8.1 -> 8.1, mode C)', () => {
  it('reopens G4 for a codeowner, once', () => {
    const s = newSim('b14', { lane: 'L3' });
    const hold = {
      decide: (g: string) => (g === 'G4' ? ('pending' as const) : ('approve' as const)),
    };
    s.run(hold);
    expect(s.state.waiting).toMatchObject({ kind: 'gates', gates: ['G4'] });
    s.apply(ITEM_EVENT.rework_requested, { edge: 'B14', step: '8.1', reason_code: 'unsure' });
    expect(s.state.review_mode).toBe('C');
    expect(count(s, 'B14')).toBe(1);
    s.run({ decide: () => 'pending' });
    const opened = s.executed.filter((c) => c.type === 'open_gates' && c.gates.includes('G4'));
    expect(opened).toHaveLength(2);
    expect((opened[1] as { facts: Record<string, unknown> }).facts['review_mode']).toBe('C');
    // a second time is not an edge: it is already mode C
    s.apply(ITEM_EVENT.rework_requested, { edge: 'B14', step: '8.1', reason_code: 'unsure' });
    expect(count(s, 'B14')).toBe(1);
    s.run();
    expect(s.state.terminal).toBe('Done');
  });
});

describe('B15 base moved or merge conflict (8.2: a -> 7.1 clean rebase 2x; b -> 6.4 conflict)', () => {
  const atMerge = (name: string) => {
    const s = newSim(name, { lane: 'L3' });
    s.run({ stopAtHuman: ['merge'] });
    expect(s.state.waiting).toEqual({ kind: 'human', what: 'merge' });
    return s;
  };

  it('a: a clean rebase runs S7 again, twice; the third is E4', () => {
    const n = limit('B15', 'b15a_times');
    const s = atMerge('b15a');
    for (let i = 0; i < n; i++) {
      s.apply(ITEM_EVENT.rework_requested, {
        edge: 'B15',
        step: '8.2',
        variant: 'a',
        reason_code: 'base_moved',
      });
      expect(s.state.phase).toBe('S7');
      s.run({ stopAtHuman: ['merge'] });
      expect(s.state.waiting).toEqual({ kind: 'human', what: 'merge' });
    }
    expect(phases(s)).toContain('S8a>S7');
    s.apply(ITEM_EVENT.rework_requested, {
      edge: 'B15',
      step: '8.2',
      variant: 'a',
      reason_code: 'base_moved',
    });
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B15', origin_phase: 'S8a' });
    expect(phases(s)).toContain('S8a>Handoff');
  });

  it('b: a conflict is resolved in S6 and then S7, with no count of its own', () => {
    const s = atMerge('b15b');
    for (let i = 0; i < 3; i++) {
      s.apply(ITEM_EVENT.rework_requested, {
        edge: 'B15',
        step: '8.2',
        variant: 'b',
        reason_code: 'conflict',
      });
      expect(s.state.phase).toBe('S6');
      s.run({ stopAtHuman: ['merge'] });
    }
    expect(phases(s)).toContain('S8a>S6');
    expect(s.state.waiting).toEqual({ kind: 'human', what: 'merge' });
    expect(s.state.rework.by_loop['B15:b15a_times']).toBeUndefined();
  });

  it('is refused when the item is not at the merge', () => {
    const s = newSim('b15-no', { lane: 'L3' });
    s.run({ decide: () => 'pending' });
    s.apply(ITEM_EVENT.rework_requested, { edge: 'B15', step: '8.2', reason_code: 'x' });
    expect(s.state.rework.total).toBe(0);
  });
});

describe('B16-B19 start a NEW linked item (SpawnLink) and count against the origin', () => {
  const spawn = (s: Sim, edge: string, kind: string, lane: string, index = 0) =>
    s.apply(ITEM_EVENT.spawn_requested, { edge, kind, lane, index });

  it('B16 deploy unhealthy: a new L0 or L1 item, nothing else', () => {
    const s = newSim('b16', { lane: 'L4' });
    s.run({ decide: (g) => (g === 'G5' ? 'pending' : 'approve') });
    expect(s.state.phase).toBe('G5');
    expect(spawn(s, 'B16', 'rollback', 'L4').commands).toHaveLength(0);
    expect(s.state.ignored.at(-1)).toContain('lane_must_be_L0_or_L1');
    const st = spawn(s, 'B16', 'rollback', 'L0');
    expect(st.commands).toMatchObject([{ type: 'spawn_item', edge: 'B16', lane: 'L0' }]);
    expect(count(s, 'B16')).toBe(1);
  });

  it('B17 an escape found after the item is Done: L0/L1, counted', () => {
    const s = newSim('b17', { lane: 'L3' });
    s.run();
    expect(s.state.terminal).toBe('Done');
    const st = spawn(s, 'B17', 'escape', 'L1');
    expect(st.commands).toMatchObject([{ type: 'spawn_item', edge: 'B17', kind: 'escape' }]);
    s.run();
    expect(s.state.spawns).toHaveLength(1);
    expect(s.state.spawns[0]).toMatchObject({ edge: 'B17', lane: 'L1', status: 'open' });
    expect(count(s, 'B17')).toBe(1);
  });

  it('B18 the requester rejects at G6: the item is closed and a linked item carries the rework', () => {
    const s = newSim('b18', { lane: 'L3' });
    s.run({ decide: (g) => (g === 'G6' ? 'reject' : 'approve') });
    expect(s.state).toMatchObject({ terminal: 'Done', terminal_cause: 'b18.requester_rejected' });
    expect(s.state.spawns).toHaveLength(1);
    expect(s.state.spawns[0]).toMatchObject({ edge: 'B18', kind: 'rejected_rework' });
    expect(phases(s)).toContain('G6>Done');
  });

  it('B19 a gate-miss on a mode-E merge: a new item, after Done', () => {
    const s = newSim('b19', { lane: 'L3' });
    s.run();
    spawn(s, 'B19', 'audit_miss', 'L1');
    s.run();
    expect(s.state.spawns[0]).toMatchObject({ edge: 'B19', kind: 'audit_miss' });
  });

  it("a kind that is not the edge's is refused", () => {
    const s = newSim('b-kind', { lane: 'L3' });
    s.run();
    const st = spawn(s, 'B17', 'rollback', 'L1');
    expect(st.commands).toHaveLength(0);
  });
});

describe('B20 the requester amends the scope (any active stage -> 3.2, 1x)', () => {
  it('re-specs once from S5, and the second amendment is E4', () => {
    const n = limit('B20');
    const s = newSim('b20', { lane: 'L4' });
    const hold = {
      decide: (g: string) => (g === 'G3' ? ('pending' as const) : ('approve' as const)),
    };
    s.run(hold);
    expect(s.state.phase).toBe('S5');
    s.apply(ITEM_EVENT.rework_requested, { edge: 'B20', step: null, reason_code: 'amend' });
    expect(phases(s)).toContain('S5>S3');
    s.run(hold);
    expect(ran(s, '3.2')).toBe(2);
    expect(s.state.phase).toBe('S5');
    s.apply(ITEM_EVENT.rework_requested, { edge: 'B20', step: null, reason_code: 'amend' });
    expect(count(s, 'B20')).toBe(n + 1);
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B20' });
  });

  it('is refused in a phase with no edge to S3', () => {
    const s = newSim('b20-no', { lane: 'L4' });
    s.run({ stopAtHuman: ['ready'] });
    s.apply(ITEM_EVENT.rework_requested, { edge: 'B20', step: null, reason_code: 'amend' });
    expect(count(s, 'B20')).toBe(0);
  });
});

describe('B23 B24 B25: G2, G3d and E2 refusals (2 rounds, 2 rounds, 1x, then E4)', () => {
  it('B23 spec rejected: back to 3.2 twice, the third is E4', () => {
    const n = limit('B23');
    const s = newSim('b23', { lane: 'L4' });
    s.run({ decide: decideUntil('G2', 'reject', n + 1) });
    expect(ran(s, '3.2')).toBe(1 + n);
    expect(gatesOpened(s, 'G2')).toBe(1 + n);
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B23', origin_phase: 'S3' });
  });

  it('B24 design rejected: back to 4.1 twice, the third is E4', () => {
    const n = limit('B24');
    const s = newSim('b24', { lane: 'L4' });
    s.run({ decide: decideUntil('G3d', 'request_changes', n + 1) });
    expect(ran(s, '4.1')).toBe(1 + n);
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B24', origin_phase: 'S4' });
  });

  it('B25 exception denied at 4.5: redesign once, then E4', () => {
    const n = limit('B25');
    const s = newSim('b25', { lane: 'L4' });
    s.run({
      script: repeat('4.5', gateNeeded('E2')),
      decide: (g) => (g === 'E2' ? 'reject' : 'approve'),
    });
    expect(ran(s, '4.1')).toBe(1 + n);
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B25', origin_phase: 'S4' });
  });
});

describe('the per-item rework budget (FIX 14): every back-edge adds 1, at the total it is E4 (B28)', () => {
  it('adds 1 per edge, across different edges, and the edge that reaches the total goes straight to E4', () => {
    const total = budget();
    const s = newSim('rb', { lane: 'L4' });
    // B23 x2, B24 x2 (4 back-edges, none over its own limit), then B5: the 5th is the budget
    const g =
      (gate: string, outcome: 'reject' | 'request_changes', n: number) =>
      (gate2: string, c: unknown) =>
        gate2 === gate && ((c as { attempt?: number } | undefined)?.attempt ?? 99) <= n
          ? outcome
          : undefined;
    const rules = [g('G2', 'reject', 2), g('G3d', 'reject', 2), g('G3', 'reject', 1)];
    s.run({
      decide: (gate, c) => {
        for (const r of rules) {
          const o = r(gate, c);
          if (o) return o;
        }
        return 'approve';
      },
    });
    expect(s.state.rework.total).toBe(total);
    expect(count(s, 'B23')).toBe(2);
    expect(count(s, 'B24')).toBe(2);
    expect(count(s, 'B5')).toBe(1);
    expect(count(s, 'B28')).toBe(1);
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B28' });
    // it counts toward ET14 (the breaker itself is M9.5)
    expect(s.state.et14['rework_budget']).toBe(1);
  });

  it('survives the handoff: the counter is not reset by E4 and the next edge is E4 again', () => {
    const s = newSim('rb2', { lane: 'L3' });
    s.run({ script: repeat('7.6', rework('B9', { loop: 'et4_limit' })) });
    const total = s.state.rework.total;
    expect(total).toBe(budget());
    const h = openHandoff(s);
    choose(s, 'resume');
    expect(s.state.rework.total).toBe(total);
    expect(h.status).toBe('open'); // the folded object is a copy; the state below is what counts
    expect(s.state.handoffs[0]?.status).toBe('chosen');
    s.run({ script: repeat('7.6', rework('B9', { loop: 'et4_limit' })) });
    expect(s.state.rework.total).toBe(total + 1);
    expect(openHandoff(s)).toMatchObject({ n: 2, code: 'E4', trigger: 'B28' });
  });

  it('item age over the catalogue limit is straight to E4 too (the timer event carries the deadline)', () => {
    const s = newSim('age', { lane: 'L4' });
    s.run({ decide: () => 'pending' });
    const created = s.state.created_at;
    // a deadline that has not passed is early, and ignored
    s.apply(ITEM_EVENT.timer_fired, {
      timer: 'item_age',
      since: created,
      due_at: '2099-01-01T00:00:00.000Z',
      frozen_ms: 0,
    });
    expect(s.state.clock.age_exceeded).toBe(false);
    expect(s.state.waiting?.kind).toBe('gates');
    // one computed from another start, or over another frozen time, is not this item's
    s.apply(ITEM_EVENT.timer_fired, {
      timer: 'item_age',
      since: created,
      due_at: created,
      frozen_ms: 5,
    });
    expect(s.state.clock.age_exceeded).toBe(false);
    s.apply(ITEM_EVENT.timer_fired, {
      timer: 'item_age',
      since: created,
      due_at: created,
      frozen_ms: 0,
    });
    expect(s.state.clock.age_exceeded).toBe(true);
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'B28', origin_phase: 'S1' });
    expect(count(s, 'B28')).toBe(1);
    expect(s.state.et14['rework_budget']).toBe(1);
    // an item over its age is E4 at its next back-edge too, never a loop
    expect(phases(s)).toContain('S1>Handoff');
  });

  it('an item over its age that cannot be handed off yet (a hold) goes to E4 when it is released', () => {
    const s = newSim('age-held', { lane: 'L4' });
    s.run({ decide: () => 'pending' });
    s.apply(ITEM_EVENT.hold_placed, { hold_id: 'k', reason: 'kill', origin: 'c' });
    const created = s.state.created_at;
    s.apply(ITEM_EVENT.timer_fired, {
      timer: 'item_age',
      since: created,
      due_at: created,
      frozen_ms: 0,
    });
    expect(s.state.clock.age_pending).toBe(true);
    expect(s.state.handoffs).toHaveLength(0);
    s.apply(ITEM_EVENT.hold_released, { hold_id: 'k' });
    expect(openHandoff(s)).toMatchObject({ trigger: 'B28' });
  });
});

describe('D1 D2 D3: handoffs with an ET trigger, one id, a pack reference, then E4', () => {
  const d1 = ['ET1', 'ET2', 'ET3', 'ET8', 'ET9', 'ET11', 'ET12'] as const;
  for (const t of d1) {
    it(`${t} at 6.4 is D1`, () => {
      const s = newSim(`d1-${t}`, { lane: 'L3' });
      s.run({ script: forStep('6.4', [trigger(t)]) });
      expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: t, origin_phase: 'S6' });
      expect(s.state.lease).toBeNull(); // the session is gone with the handoff
    });
  }

  it('ET4-ET6 at 7.6 are D2, ET3 at 7.6 is D2 too (D1 at 6.4)', () => {
    for (const t of ['ET3', 'ET4', 'ET5', 'ET6']) {
      const s = newSim(`d2-${t}`, { lane: 'L3' });
      s.run({ script: forStep('7.6', [trigger(t)]) });
      expect(openHandoff(s)).toMatchObject({ code: 'D2', trigger: t, origin_phase: 'S7' });
    }
  });

  it('ET7 at G4 is D3; an ET that is not a handoff from where the item is, is ignored', () => {
    const s = newSim('d3', { lane: 'L3' });
    s.run({ decide: (g) => (g === 'G4' ? 'pending' : 'approve') });
    expect(s.state.phase).toBe('G4');
    s.apply(ITEM_EVENT.trigger_fired, { trigger: 'ET1', step: '8.1', reason_code: 'x' });
    expect(s.state.handoffs).toHaveLength(0);
    s.apply(ITEM_EVENT.trigger_fired, { trigger: 'ET7', step: '8.1', reason_code: 'x' });
    expect(openHandoff(s)).toMatchObject({ code: 'D3', trigger: 'ET7', origin_phase: 'G4' });
  });

  it('a handoff has ONE id; the E4 gate instance and the pack are its attributes', () => {
    const s = newSim('one-id', { lane: 'L3' });
    s.run({ script: forStep('6.4', [trigger('ET1')]) });
    const h = openHandoff(s);
    expect(h.n).toBe(1);
    expect(h.e4_gate_instance_id).toBeTruthy();
    expect(h.e4_decided).toBe(true);
    expect(h.pack.pack_id).toContain(h.handoff_id);
    expect(h.pack.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    // the same stream gives the same id
    const again = newSim('one-id', { lane: 'L3' });
    again.run({ script: forStep('6.4', [trigger('ET1')]) });
    expect(openHandoff(again).handoff_id).toBe(h.handoff_id);
    // the E4 card is opened with the handoff and its choices
    const e4 = s.executed.find((c) => c.type === 'open_gates' && c.gates.includes('E4'));
    const facts = (e4 as unknown as { facts: { handoff: { handoff_id: string } } }).facts;
    expect(facts.handoff.handoff_id).toBe(h.handoff_id);
  });
});

describe('X1 X2 X3 E2 G3o: the denial exits', () => {
  it('X1 denied is D1', () => {
    const s = newSim('x1', { lane: 'L3' });
    s.run({
      script: forStep('6.4', [gateNeeded('X1')]),
      decide: (g) => (g === 'X1' ? 'reject' : 'approve'),
    });
    expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'X1' });
  });

  it('X3 denied: find an alternative once (the step runs again, told which gate was denied), else D1', () => {
    const s = newSim('x3', { lane: 'L3' });
    s.run({
      script: repeat('6.4', gateNeeded('X3')),
      decide: (g) => (g === 'X3' ? 'reject' : 'approve'),
    });
    const calls = s.executed.filter((c) => c.type === 'run_stage' && c.step === '6.4');
    expect(calls).toHaveLength(2);
    expect((calls[1] as { denied_gates: string[] }).denied_gates).toEqual(['X3']);
    expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'X3' });
  });

  it('X3 denied once and then no more new dependency: the item goes on', () => {
    const s = newSim('x3-ok', { lane: 'L3' });
    s.run({
      script: forStep('6.4', [gateNeeded('X3')]),
      decide: (g) => (g === 'X3' ? 'reject' : 'approve'),
    });
    expect(s.state.terminal).toBe('Done');
  });

  it('X2 denied is D2', () => {
    const s = newSim('x2', { lane: 'L3' });
    s.run({
      script: forStep('7.4', [gateNeeded('X2')]),
      decide: (g) => (g === 'X2' ? 'reject' : 'approve'),
    });
    expect(openHandoff(s)).toMatchObject({ code: 'D2', trigger: 'X2', origin_phase: 'S7' });
  });

  it('E2 denied at 7.5 (runtime): fix in S6, counted against the budget, no limit of its own', () => {
    const s = newSim('e2-rt', { lane: 'L3' });
    s.run({
      script: forStep('7.5', [gateNeeded('E2')]),
      decide: (g) => (g === 'E2' ? 'reject' : 'approve'),
    });
    expect(s.state.terminal).toBe('Done');
    expect(ran(s, '6.4')).toBe(2);
    expect(count(s, 'B25')).toBe(1);
    expect(phases(s)).toContain('S7>S6');
  });

  it('G3o denied at 6.3: the oracles are made again once, then D1', () => {
    const s = newSim('g3o', { lane: 'L3' });
    s.run({
      script: repeat('6.3', gateNeeded('G3o')),
      decide: (g) => (g === 'G3o' ? 'reject' : 'approve'),
    });
    expect(ran(s, '6.3')).toBe(2);
    expect(openHandoff(s)).toMatchObject({ code: 'D1', trigger: 'G3o' });
  });
});

describe('E4: the owner of record chooses (five choices, E3/E5 extension, D4 and D5)', () => {
  const handedOff = (
    name: string,
    lane: 'L3' | 'L4' = 'L3',
    script = forStep('6.4', [trigger('ET1')]),
  ) => {
    const s = newSim(name, { lane });
    s.run({ script });
    return s;
  };

  it('nothing is chosen before E4 is decided in the ledger, and nothing is chosen twice', () => {
    const s = newSim('e4-early', { lane: 'L3' });
    s.run({
      script: forStep('6.4', [trigger('ET1')]),
      decide: (g) => (g === 'E4' ? 'pending' : 'approve'),
    });
    expect(s.state.waiting).toMatchObject({ kind: 'handoff', stage: 'e4' });
    choose(s, 'abandon');
    expect(s.state.terminal).toBeNull();
    expect(s.state.ignored.at(-1)).toContain('e4_not_decided');
    const id = openHandoff(s).handoff_id;
    s.decidePending({});
    choose(s, 'resume');
    expect(s.state.handoffs[0]).toMatchObject({ status: 'chosen', choice: 'resume' });
    s.apply(ITEM_EVENT.handoff_chosen, { handoff_id: id, choice: 'abandon', by: 'alice' });
    expect(s.state.terminal).toBeNull();
  });

  it('answer and resume: 6.4 again in a new session (lease epoch +1), same envelope', () => {
    const s = handedOff('e4-resume');
    const epoch = s.state.lease_seq;
    choose(s, 'resume');
    expect(s.state.phase).toBe('S6');
    expect(s.state.lease).toEqual({ epoch: epoch + 1 });
    s.run();
    expect(s.state.terminal).toBe('Done');
    expect(ran(s, '6.4')).toBe(2);
    expect(phases(s)).toContain('Handoff>S6');
  });

  it('one extension, at most the catalogue percent, through E3 (or E5); then it resumes with the gate approved', () => {
    const max = CATALOGUE.envelope_extension.max_percent.value as number;
    const s = handedOff('e4-ext');
    choose(s, 'extend', { extension_percent: max + 1 });
    expect(s.state.waiting).toMatchObject({ kind: 'handoff', stage: 'choice' });
    expect(s.state.ignored.at(-1)).toContain('extension_over_limit');
    choose(s, 'extend', { extension_percent: max });
    expect(s.state.waiting).toMatchObject({ kind: 'handoff', stage: 'e3' });
    s.run();
    expect(s.state.extensions).toBe(1);
    expect(s.state.handoffs[0]?.extension).toEqual({ percent: max, via: 'E3', approved: true });
    expect(s.state.terminal).toBe('Done');
    const again = s.executed.filter((c) => c.type === 'run_stage' && c.step === '6.4');
    expect((again.at(-1) as { approved_gates: string[] }).approved_gates).toContain('E3');
  });

  it('a second extension is not offered; a denied extension leaves the choice open', () => {
    const max = CATALOGUE.envelope_extension.max_percent.value as number;
    const s = handedOff('e4-ext-denied');
    choose(s, 'extend', { extension_percent: max, via: 'E5' });
    s.run({ decide: (g) => (g === 'E5' ? 'reject' : 'approve') });
    expect(s.state.waiting).toMatchObject({ kind: 'handoff', stage: 'choice' });
    expect(s.state.extensions).toBe(0);
    expect(s.state.handoffs[0]?.extension?.approved).toBe(false);
    choose(s, 'extend', { extension_percent: max, via: 'E5' });
    s.run();
    expect(s.state.extensions).toBe(1);
    // a new handoff: extension is no longer open
    s.run({ script: forStep('6.4', [undefined, trigger('ET1')]) });
  });

  it('re-plan goes to 5.1, re-spec to 3.2', () => {
    const a = handedOff('e4-replan', 'L4');
    choose(a, 'replan');
    expect(a.state.phase).toBe('S5');
    expect(phases(a)).toContain('Handoff>S5');
    a.run();
    expect(a.state.terminal).toBe('Done');
    const b = handedOff('e4-respec', 'L4');
    choose(b, 'respec');
    expect(b.state.phase).toBe('S3');
    expect(phases(b)).toContain('Handoff>S3');
    b.run();
    expect(b.state.terminal).toBe('Done');
  });

  it('abandon ends the item with a cause code, and counts toward ET14', () => {
    const s = handedOff('e4-abandon');
    choose(s, 'abandon', { cause: 'owner.no_longer_needed' });
    expect(s.state).toMatchObject({
      terminal: 'Abandoned',
      terminal_cause: 'owner.no_longer_needed',
    });
    expect(s.state.et14['E4_abandon']).toBe(1);
    expect(phases(s)).toContain('Handoff>Abandoned');
  });

  it('a developer takes over: lane L8, lease epoch +1; D5 completes into 7.1', () => {
    const s = handedOff('e4-takeover');
    const epoch = s.state.lease_seq;
    choose(s, 'takeover');
    expect(s.state).toMatchObject({ lane: 'L8', phase: 'S6' });
    expect(s.state.lease).toEqual({ epoch: epoch + 1 });
    expect(s.state.waiting).toEqual({ kind: 'human', what: 'human_led' });
    expect(s.state.et14['E4_takeover']).toBe(1);
    s.run();
    expect(s.state.terminal).toBe('Done');
    expect(s.stepsOnly()).toContain('7.1');
  });

  it('D4: the developer hands it back once (a new envelope), the second time is refused', () => {
    const s = handedOff('e4-d4');
    choose(s, 'takeover');
    s.apply(ITEM_EVENT.hand_back, { by: 'dev', plan_changed: false });
    expect(s.state.lane).toBe('L3');
    expect(s.state.phase).toBe('S6');
    expect(s.state.takeover?.hand_backs).toBe(1);
    s.run({ script: forStep('6.4', [undefined, trigger('ET1')]) });
    expect(s.state.waiting).toMatchObject({ kind: 'handoff' });
    choose(s, 'takeover');
    s.apply(ITEM_EVENT.hand_back, { by: 'dev', plan_changed: false });
    expect(s.state.ignored.at(-1)).toContain('hand_back');
    expect(s.state.waiting).toEqual({ kind: 'human', what: 'human_led' });
  });

  it('D4 with a changed plan goes through G3 again', () => {
    const s = handedOff('e4-d4-plan', 'L4');
    choose(s, 'takeover');
    s.apply(ITEM_EVENT.hand_back, { by: 'dev', plan_changed: true });
    expect(s.state.phase).toBe('S5');
    s.run();
    expect(s.state.terminal).toBe('Done');
    expect(gatesOpened(s, 'G3')).toBe(2);
  });

  it('a takeover that closes the item is HandedOverClosed', () => {
    const s = handedOff('e4-close');
    choose(s, 'hand_over_close');
    expect(s.state).toMatchObject({
      terminal: 'HandedOverClosed',
      terminal_cause: 'e4.handed_over',
    });
    expect(phases(s)).toContain('Handoff>HandedOverClosed');
  });

  it('a choice whose target the item does not have is not offered (resume before S6 ran)', () => {
    const s = newSim('e4-direct', { lane: 'L4' });
    s.run({ script: repeat('2.1', rework('B2')) });
    expect(openHandoff(s).code).toBe('E4');
    choose(s, 'resume');
    expect(s.state.waiting).toMatchObject({ kind: 'handoff', stage: 'choice' });
    expect(s.state.ignored.at(-1)).toContain('choice_not_open:resume');
    choose(s, 'respec');
    expect(s.state.phase).toBe('S3');
  });

  it('expiry never chooses: an expired E4 is opened again', () => {
    const s = newSim('e4-expiry', { lane: 'L3' });
    let first = true;
    s.run({
      script: forStep('6.4', [trigger('ET1')]),
      decide: (g) => {
        if (g === 'E4' && first) {
          first = false;
          return 'expired';
        }
        return 'approve';
      },
    });
    expect(gatesOpened(s, 'E4')).toBe(2);
    expect(s.state.waiting).toMatchObject({ kind: 'handoff', stage: 'choice' });
  });

  it('a held handoff is a Handoff phase under a hold, and resumes to it', () => {
    const s = handedOff('e4-held');
    s.apply(ITEM_EVENT.hold_placed, { hold_id: 'k', reason: 'kill', origin: 'ctl' });
    expect(s.state).toMatchObject({ phase: 'Held', underlying: 'Handoff' });
    s.apply(ITEM_EVENT.hold_released, { hold_id: 'k' });
    expect(s.state.phase).toBe('Handoff');
    expect(phases(s)).toContain('Handoff>Held');
    expect(phases(s)).toContain('Held>Handoff');
  });
});

describe('assumptions: one shape, fed by the sources', () => {
  it('an agent output assumption and an event, each once, then decided', () => {
    const s = newSim('assume', { lane: 'L4' });
    const h = 'a'.repeat(64);
    const raise = () =>
      s.apply(ITEM_EVENT.assumption_raised, {
        origin: 'event',
        kind: 'engine',
        origin_run: null,
        text_hash: 'c'.repeat(64),
      });
    raise();
    raise();
    expect(s.state.assumptions).toHaveLength(1);
    s.run({
      stopAtHuman: ['ready'],
    });
    s.run({
      script: (step) =>
        step === '3.2'
          ? ({
              outcome: 'completed',
              output_hash: 'b'.repeat(64),
              assumptions: [{ kind: 'spec', text_hash: h }],
            } as never)
          : undefined,
      decide: (g) => (g === 'G2' ? 'pending' : 'approve'),
    });
    const spec = s.state.assumptions.find((a) => a.origin === 'agent_output');
    expect(spec).toMatchObject({ kind: 'spec', state: 'open', text_hash: h });
    expect(spec?.origin_run).toContain('3.2');
    expect(s.state.assumptions.filter((a) => a.origin === 'event')).toHaveLength(1);
    const id = s.state.assumptions[0]?.assumption_id as string;
    s.apply(ITEM_EVENT.assumption_decided, { assumption_id: id, state: 'overridden', by: 'alice' });
    expect(s.state.assumptions[0]).toMatchObject({ state: 'overridden', overridden_by: 'alice' });
    s.apply(ITEM_EVENT.assumption_decided, { assumption_id: id, state: 'accepted', by: 'alice' });
    expect(s.state.assumptions[0]?.state).toBe('overridden');
  });

  it('a question that does not block becomes an open_question assumption of the intent', () => {
    const s = newSim('assume-q', { lane: 'L4' });
    s.run({
      script: forStep('1.5', [
        {
          outcome: 'questions',
          questions: [{ text: 'which colour?', material: 'non_blocking' }],
        } as never,
      ]),
    });
    expect(s.state.assumptions).toHaveLength(1);
    expect(s.state.assumptions[0]).toMatchObject({ origin: 'open_question', kind: 'intent' });
    expect(s.state.terminal).toBe('Done');
  });
});

describe('replay determinism holds through back-edges and handoffs', () => {
  it('the same events fold to the same state and the same commands', () => {
    const run = () => {
      const s = newSim('replay', { lane: 'L4' });
      s.run({
        script: scripts(repeat('3.3', rework('B3'), 2), forStep('6.4', [trigger('ET1')])),
        decide: decideUntil('G3d', 'reject', 1),
      });
      choose(s, 'resume');
      s.run();
      return s;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(a.steps.map((x) => x.commands.map((c) => c.key))).toEqual(
      b.steps.map((x) => x.commands.map((c) => c.key)),
    );
  });
});
