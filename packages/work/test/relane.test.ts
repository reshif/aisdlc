import { CATALOGUE } from '@aisdlc/catalogue';
import { ITEM_EVENT, RELANE_SOURCES, SPAWN_RULES } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { PROFILE_ALL_ON, type Sim } from './sim.js';
import { choose, forStep, newSim, openHandoff, relane, repeat, rework } from './scen.js';

// M9.5: re-laning. R1 upshift (free, logged, inserts the first missing stage of S2/S3/S4, done stays
// done), R2 downshift (needs E1, re-runs G0), the inputs of the R3 breaker and R4's hotfix follow-up.

const stationsRun = (s: Sim) => s.stepsOnly().map((x) => `s:${x}`);
const count = (s: Sim, key: string) => stationsRun(s).filter((v) => v === key).length;
const trigger8 = { outcome: 'trigger', trigger: 'ET8', reason_code: 'x' } as never;

describe('R1 upshift', () => {
  // the first missing stage of the new lane: L3 -> L4 lacks S2, L0 -> L1 lacks S3 only
  const cases: Array<{
    from: 'L3' | 'L0';
    to: 'L4' | 'L1';
    step: '6.5' | '7.3' | '7.4';
    trig: string;
    target: string;
  }> = [
    { from: 'L3', to: 'L4', step: '6.5', trig: 'diff_over_lane_budget', target: '2.1' },
    { from: 'L3', to: 'L4', step: '7.3', trig: 'contract_change', target: '2.1' },
    { from: 'L3', to: 'L4', step: '7.4', trig: 'x2_sensitive_path', target: '2.1' },
    { from: 'L0', to: 'L1', step: '6.5', trig: 'new_dependency', target: '3.1' },
    { from: 'L0', to: 'L1', step: '7.3', trig: 'cross_repo', target: '3.1' },
    { from: 'L0', to: 'L1', step: '7.4', trig: 'x2_sensitive_path', target: '3.1' },
  ];
  for (const c of cases) {
    it(`${c.from} -> ${c.to} at ${c.step} (${c.trig}) goes to ${c.target}, free and logged`, () => {
      const s = newSim(`r1-${c.from}-${c.step}`, { lane: c.from });
      s.run({ script: forStep(c.step, [relane('R1', c.trig, c.to), undefined]) });
      expect(s.state.terminal).toBe('Done');
      const r = s.state.relanes[0];
      expect(r).toMatchObject({
        edge: 'R1',
        trigger: c.trig,
        from_lane: c.from,
        to_lane: c.to,
        step: c.step,
        target: c.target,
      });
      expect(r?.asked_seq).toBeLessThan(r?.applied_seq ?? 0);
      expect(s.state.lane).toBe(c.to);
      // free: no gate was opened for the re-lane itself, only the gates of the stages it inserted
      expect(s.gateLog.every((g) => !g.gates.includes('E1'))).toBe(true);
      // the inserted stage ran, after the step that asked and before the build ran again
      const order = stationsRun(s);
      const at = order.indexOf(`s:${c.target}`);
      expect(at).toBeGreaterThan(order.indexOf(`s:${c.step}`));
      expect(order.indexOf('s:6.0', at)).toBeGreaterThan(at);
    });
  }

  it('done stays done: the stages the item completed are not run again', () => {
    const s = newSim('r1-done', { lane: 'L3' });
    s.run({ script: forStep('6.5', [relane('R1', 'diff_over_lane_budget', 'L4'), undefined]) });
    expect(s.state.terminal).toBe('Done');
    // L3 ran 3.1 (S3) and 5.1 (S5) once; L4 added S2 and S4, and S3 and S5 were passed over
    expect(count(s, 's:3.1')).toBe(1);
    expect(count(s, 's:5.1')).toBe(1);
    expect(count(s, 's:2.1')).toBe(1);
    expect(count(s, 's:4.1')).toBe(1);
    // the build is not "done": the new spec needs it again
    expect(count(s, 's:6.1')).toBe(2);
    expect(s.state.skip).toEqual([]);
  });

  it('inserts the FIRST missing stage when S2 and S3 are done and S4 is not (from S6 and from S7)', () => {
    for (const step of ['6.5', '7.3'] as const) {
      const s = newSim(`r1-s4-${step}`, { lane: 'L4' });
      // L4 reaches the design review; the reviewer finds it smaller than the lane (R2) and E1 approves it
      s.run({ decide: (g) => (g === 'G3d' ? 'pending' : 'approve') });
      expect(s.state.phase).toBe('S4');
      s.apply(ITEM_EVENT.relane_requested, {
        edge: 'R2',
        trigger: 'smaller_than_lane',
        to_lane: 'L3',
        step: '4.6',
        reason_code: 'test',
      });
      s.run({ script: forStep(step, [relane('R1', 'diff_over_lane_budget', 'L4'), undefined]) });
      expect(s.state.terminal).toBe('Done');
      const [down, up] = s.state.relanes;
      expect(down).toMatchObject({ edge: 'R2', to_lane: 'L3', target: '1.3' });
      // S2 and S3 were done in the L4 pass: S4 is the first missing stage (its design review)
      expect(up).toMatchObject({ edge: 'R1', from_lane: 'L3', to_lane: 'L4', step });
      expect(s.phases.join('>')).toContain(step === '6.5' ? 'S6>S4' : 'S7>S4');
      expect(count(s, 's:2.1')).toBe(1);
      expect(count(s, 's:3.1')).toBe(1);
    }
  });

  it('is refused (and nothing changes) where the flow does not draw it, or for a trigger not said there', () => {
    const wrongStep = newSim('r1-wrong-step', { lane: 'L3' });
    wrongStep.run({
      script: forStep('6.4', [relane('R1', 'diff_over_lane_budget', 'L4'), undefined]),
    });
    expect(wrongStep.state.relanes).toEqual([]);
    expect(
      wrongStep.state.ignored.some((i) => i.includes('relane_requested:R1:not_raisable_at_6.4')),
    ).toBe(true);

    const wrongTrigger = newSim('r1-wrong-trigger', { lane: 'L3' });
    wrongTrigger.run({ script: forStep('6.5', [relane('R1', 'contract_change', 'L4')]) });
    // contract_change is found at 7.3, not 6.5
    expect(wrongTrigger.state.relanes).toEqual([]);
    expect(
      wrongTrigger.state.ignored.some((i) => i.includes('relane_requested:R1:not_raisable_at_6.5')),
    ).toBe(true);
    expect(wrongTrigger.state.lane).toBe('L3');
  });

  it('is only ever up: a lane with as much or less planning is not an upshift, L7 and L8 are off the ladder', () => {
    for (const to of ['L3', 'L2', 'L0', 'L7', 'L8']) {
      const s = newSim(`r1-not-up-${to}`, { lane: 'L3' });
      s.run({ script: forStep('6.5', [relane('R1', 'diff_over_lane_budget', to)]) });
      expect(s.state.relanes, to).toEqual([]);
      expect(s.state.lane).toBe('L3');
    }
  });

  it('goes to E4, never up on its own, when the project may not run the lane it needs', () => {
    const s = newSim('r1-ineligible', { lane: 'L3' });
    s.run({
      script: forStep('6.5', [relane('R1', 'sensitive_path', 'L4')]),
      eligibility: (lane) => (lane === 'L4' ? 'l8' : 'normal'),
    });
    expect(s.state.relanes).toEqual([]);
    expect(s.state.lane).toBe('L3');
    expect(openHandoff(s)).toMatchObject({ code: 'E4', trigger: 'R1' });
  });

  it('every trigger of the flow is sayable somewhere', () => {
    const said = new Set<string>(Object.values(RELANE_SOURCES.R1).flat());
    for (const t of [
      'diff_over_lane_budget',
      'sensitive_path',
      'contract_change',
      'new_dependency',
      'cross_repo',
      'irreversible_migration',
      'x2_sensitive_path',
    ]) {
      expect(said.has(t), t).toBe(true);
    }
  });

  it('replays: the same events give the same state and the same commands', () => {
    const run = () => {
      const s = newSim('r1-replay', { lane: 'L3' });
      s.run({ script: forStep('6.5', [relane('R1', 'cross_repo', 'L4'), undefined]) });
      return JSON.stringify([s.state, s.steps.map((x) => x.commands)]);
    };
    expect(run()).toBe(run());
  });
});

describe('R2 downshift', () => {
  it('at 2.3: needs E1; approved goes to 1.3 and G0 runs again on the new lane', () => {
    const s = newSim('r2-23', { lane: 'L4' });
    s.run({ script: forStep('2.3', [relane('R2', 'smaller_than_lane', 'L3'), undefined]) });
    expect(s.state.terminal).toBe('Done');
    expect(s.state.relanes[0]).toMatchObject({
      edge: 'R2',
      from_lane: 'L4',
      to_lane: 'L3',
      step: '2.3',
      target: '1.3',
    });
    const opened = s.gateLog.map((g) => g.gates.join('+'));
    expect(opened).toContain('E1');
    expect(opened.filter((g) => g.includes('G0')).length).toBe(2);
    expect(opened.indexOf('E1')).toBeLessThan(opened.lastIndexOf('G0+G1'));
    expect(s.state.lane).toBe('L3');
    expect(count(s, 's:1.3')).toBe(2);
    expect(s.phases.join('>')).toContain('S2>S1');
  });

  it('at 4.6: observed while the design review is open; approved goes to 1.3, the review is withdrawn', () => {
    const s = newSim('r2-46', { lane: 'L4' });
    s.run({ decide: (g) => (g === 'G3d' ? 'pending' : 'approve') });
    expect(s.state.waiting).toMatchObject({ kind: 'gates' });
    s.apply(ITEM_EVENT.relane_requested, {
      edge: 'R2',
      trigger: 'smaller_than_lane',
      to_lane: 'L3',
      step: '4.6',
      reason_code: 'test',
    });
    expect(s.state.outstanding.some((c) => c.type === 'open_gates' && c.gates.includes('E1'))).toBe(
      true,
    );
    s.run();
    expect(s.state.terminal).toBe('Done');
    expect(s.state.relanes[0]).toMatchObject({ edge: 'R2', step: '4.6', target: '1.3' });
    expect(s.phases.join('>')).toContain('S4>S1');
    expect(s.state.lane).toBe('L3');
  });

  it('E1 denied at 2.3: the item stays in its lane and the step goes on', () => {
    const s = newSim('r2-23-denied', { lane: 'L4' });
    s.run({
      script: forStep('2.3', [relane('R2', 'smaller_than_lane', 'L3'), undefined]),
      decide: (g) => (g === 'E1' ? 'reject' : 'approve'),
    });
    expect(s.state.terminal).toBe('Done');
    expect(s.state.relanes).toEqual([]);
    expect(s.state.lane).toBe('L4');
    expect(count(s, 's:1.3')).toBe(1);
  });

  it('E1 denied at 4.6: the item goes back to waiting for the design review it had', () => {
    const s = newSim('r2-46-denied', { lane: 'L4' });
    s.run({ decide: (g) => (g === 'G3d' ? 'pending' : 'approve') });
    s.apply(ITEM_EVENT.relane_requested, {
      edge: 'R2',
      trigger: 'smaller_than_lane',
      to_lane: 'L3',
      step: '4.6',
      reason_code: 'test',
    });
    s.run({ decide: (g) => (g === 'E1' ? 'reject' : g === 'G3d' ? 'pending' : 'approve') });
    expect(s.state.relanes).toEqual([]);
    expect(s.state.waiting).toMatchObject({ kind: 'gates', conditional: null });
    expect(s.state.lane).toBe('L4');
    s.run();
    expect(s.state.terminal).toBe('Done');
  });

  it('is only ever down, and only where it is drawn', () => {
    const up = newSim('r2-up', { lane: 'L3' });
    up.run({ script: forStep('2.3', [relane('R2', 'smaller_than_lane', 'L4')]) });
    expect(up.state.relanes).toEqual([]);
    const wrong = newSim('r2-wrong', { lane: 'L4' });
    wrong.run({ script: forStep('3.2', [relane('R2', 'smaller_than_lane', 'L3')]) });
    expect(wrong.state.relanes).toEqual([]);
    expect(wrong.state.lane).toBe('L4');
  });

  it('is not a gate a stage may raise by name (it carries the lane)', () => {
    const s = newSim('r2-e1-by-name', { lane: 'L4' });
    s.run({ script: forStep('2.3', [{ outcome: 'gate_needed', gate: 'E1', reason_code: 'x' }]) });
    expect(s.state.waiting).toMatchObject({ kind: 'stuck' });
  });
});

describe('R3 inputs: what counts toward the circuit breaker', () => {
  const signals = (s: Sim) =>
    s.steps.flatMap((x) => x.commands).filter((c) => c.type === 'breaker_signal');

  it('the catalogue says what counts', () => {
    expect(CATALOGUE.triggers.ET14.counts_from).toEqual([
      'Q1',
      'E4_abandon',
      'E4_takeover',
      'rework_budget',
    ]);
  });

  it('E4 abandon counts, for the lane the item was in', () => {
    const s = newSim('r3-abandon', { lane: 'L3' });
    s.run({ script: forStep('6.4', [trigger8]) });
    choose(s, 'abandon');
    expect(signals(s)).toMatchObject([{ source: 'E4_abandon', lane: 'L3' }]);
    expect(s.state.terminal).toBe('Abandoned');
    expect(s.state.et14).toEqual({ E4_abandon: 1 });
  });

  it('E4 takeover counts for the lane the item left, not for L8', () => {
    const s = newSim('r3-takeover', { lane: 'L3' });
    s.run({ script: forStep('6.4', [trigger8]) });
    choose(s, 'takeover');
    expect(signals(s)).toMatchObject([{ source: 'E4_takeover', lane: 'L3' }]);
    expect(s.state.lane).toBe('L8');
  });

  it('the rework budget counts when it is exhausted', () => {
    const s = newSim('r3-rework', { lane: 'L3' });
    s.run({ script: repeat('7.6', rework('B9', { loop: 'et4_limit' })) });
    expect(signals(s)).toMatchObject([{ source: 'rework_budget', lane: 'L3' }]);
    expect(s.state.et14).toEqual({ rework_budget: 1 });
  });

  it('a signal key is a function of the item and its count, so a replay makes the same keys', () => {
    const keys = () => {
      const s = newSim('r3-keys', { lane: 'L3' });
      s.run({ script: forStep('6.4', [trigger8]) });
      choose(s, 'abandon');
      return signals(s).map((c) => c.key);
    };
    expect(keys()).toEqual(keys());
    expect(new Set(keys()).size).toBe(keys().length);
  });
});

describe('R4 hotfix follow-up', () => {
  const follow = (s: Sim) =>
    s.steps.flatMap((x) => x.commands).filter((c) => c.type === 'spawn_item' && c.edge === 'R4');

  it('an L0 item that completes S8b creates an L1 follow-up, once', () => {
    const s = newSim('r4-l0', { lane: 'L0' });
    s.run();
    expect(s.state.terminal).toBe('Done');
    expect(follow(s)).toHaveLength(1);
    expect(follow(s)[0]).toMatchObject({
      type: 'spawn_item',
      edge: 'R4',
      kind: SPAWN_RULES.R4.kind,
      lane: CATALOGUE.lanes.L0.follow_up?.lane,
    });
    expect(s.state.spawns).toMatchObject([{ edge: 'R4', kind: 'hotfix_follow_up', lane: 'L1' }]);
  });

  it('with G5 on, it is made when the release step is done (after G5), not before', () => {
    const s = newSim('r4-l0-g5', {
      lane: 'L0',
      profile: { ...PROFILE_ALL_ON, project_deploys: true },
    });
    s.run({ decide: (g) => (g === 'G5' ? 'pending' : 'approve') });
    expect(s.state.phase).toBe('G5');
    expect(follow(s)).toHaveLength(0);
    s.run();
    expect(s.state.terminal).toBe('Done');
    expect(follow(s)).toHaveLength(1);
  });

  it('no other lane creates one', () => {
    for (const lane of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] as const) {
      const s = newSim(`r4-${lane}`, { lane });
      s.run();
      expect(follow(s), lane).toHaveLength(0);
    }
  });

  it('an L0 item that never completes S8b creates none', () => {
    const s = newSim('r4-unfinished', { lane: 'L0' });
    s.run({ decide: (g) => (g === 'G4' ? 'pending' : 'approve') });
    expect(follow(s)).toHaveLength(0);
  });
});
