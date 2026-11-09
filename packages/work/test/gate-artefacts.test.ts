import {
  GATE_ARTEFACT_STEPS,
  STEP_ARTEFACT,
  type GateId,
  type Lane,
  type StepId,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { hash, type Sim } from './sim.js';
import { newSim, repeat, rework, scripts, type Script } from './scen.js';

// PLAN M12.1, M12.2: a gate decides the artefacts it binds. The engine puts the latest output hash of each
// bound step into the gate's card facts and into its subject hash, so a change to ANY of them is another
// subject (G2: the spec, the oracle specs and the review beside them; G1f: what S2 produced).

/** Every step answers `completed` with an output hash made from `variant[step]` (default `v1`). */
const withOutputs =
  (variant: Partial<Record<StepId, string>>): Script =>
  (step, _attempt, c) =>
    c.type === 'run_stage' && step !== '1.3' && step !== '6.0'
      ? ({
          outcome: 'completed',
          output_hash: hash(`${step}:${variant[step] ?? 'v1'}`),
        } as never)
      : undefined;

const opened = (s: Sim, gate: GateId) => {
  const c = s.executed.find((x) => x.type === 'open_gates' && x.gates.includes(gate));
  if (!c || c.type !== 'open_gates') throw new Error(`no ${gate} opened`);
  return c;
};

function g2Hash(variant: Partial<Record<StepId, string>>, lane: Lane = 'L4') {
  const s = newSim('m12-g2', { lane });
  s.run({ script: withOutputs(variant), decide: (g) => (g === 'G2' ? 'pending' : 'approve') });
  return opened(s, 'G2');
}

describe('G2 binds the spec and the oracle specs together', () => {
  it('names the artefacts, by hash, in the card facts: the spec, the oracle specs, the review', () => {
    const c = g2Hash({});
    expect((c.facts as { artefacts: unknown[] }).artefacts).toEqual([
      { step: '3.2', type: 'spec_delta', sha256: hash('3.2:v1') },
      { step: '3.4', type: 'oracle_specs', sha256: hash('3.4:v1') },
      { step: '3.5', type: 'spec_review', sha256: hash('3.5:v1') },
    ]);
    expect(GATE_ARTEFACT_STEPS['G2']?.map((x) => STEP_ARTEFACT[x])).toEqual([
      'spec_delta',
      'oracle_specs',
      'spec_review',
    ]);
  });

  it('the subject hash is the same for the same artefacts and changes if EITHER artefact changes', () => {
    const base = g2Hash({}).subject_hash;
    expect(g2Hash({}).subject_hash).toBe(base);
    expect(g2Hash({ '3.2': 'v2' }).subject_hash).not.toBe(base); // the spec changed
    expect(g2Hash({ '3.4': 'v2' }).subject_hash).not.toBe(base); // the oracle specs changed
    expect(g2Hash({ '3.5': 'v2' }).subject_hash).not.toBe(base); // the review beside them changed
    // an artefact the gate does not decide is not part of the subject
    expect(g2Hash({ '3.1': 'v2' }).subject_hash).toBe(base);
    expect(g2Hash({ '3.2': 'v2' }).subject_hash).not.toBe(g2Hash({ '3.4': 'v2' }).subject_hash);
  });

  it('a rejected spec comes back as a new subject: the redraft is another hash and the card says so', () => {
    const s = newSim('m12-b23', { lane: 'L4' });
    s.run({
      script: (step, attempt, c) =>
        c.type === 'run_stage' && step !== '1.3' && step !== '6.0'
          ? ({
              outcome: 'completed',
              output_hash: hash(`${step}:${step === '3.2' ? attempt : 1}`),
            } as never)
          : undefined,
      decide: (g, c) =>
        g === 'G2' && c.type === 'open_gates' && c.attempt === 1 ? 'request_changes' : 'approve',
    });
    const g2s = s.executed.filter((x) => x.type === 'open_gates' && x.gates.includes('G2'));
    expect(g2s).toHaveLength(2);
    const [a, b] = g2s;
    if (a?.type !== 'open_gates' || b?.type !== 'open_gates') throw new Error('unreachable');
    expect(a.subject_hash).not.toBe(b.subject_hash);
    expect((b.facts as { artefacts: Array<{ sha256: string }> }).artefacts[0]?.sha256).not.toBe(
      (a.facts as { artefacts: Array<{ sha256: string }> }).artefacts[0]?.sha256,
    );
  });
});

describe('G1f (L6) binds what S2 produced', () => {
  it('opens at 2.5 with the S2 artefacts bound, and a changed brief is another subject', () => {
    const at = (variant: Partial<Record<StepId, string>>) => {
      const s = newSim('m12-g1f', { lane: 'L6' });
      s.run({
        script: withOutputs(variant),
        decide: (g) => (g === 'G1f' ? 'pending' : 'approve'),
      });
      return opened(s, 'G1f');
    };
    const base = at({});
    const types = (base.facts as { artefacts: Array<{ type: string }> }).artefacts.map(
      (a) => a.type,
    );
    expect(types).toContain('context_brief');
    expect(types).toContain('decision_brief');
    expect(types).toContain('initiative');
    expect(at({}).subject_hash).toBe(base.subject_hash);
    expect(at({ '2.4': 'v2' }).subject_hash).not.toBe(base.subject_hash);
    expect(at({ '2.3': 'v2' }).subject_hash).not.toBe(base.subject_hash);
  });

  it('an L4 item has no 2.4 and no G1f; it goes from 2.3 to 3.1', () => {
    const s = newSim('m12-l4', { lane: 'L4' });
    s.run({ script: withOutputs({}), decide: () => 'approve' });
    const steps = s.executed.flatMap((c) => (c.type === 'run_stage' ? [c.step] : []));
    expect(steps).not.toContain('2.4');
    expect(s.executed.some((c) => c.type === 'open_gates' && c.gates.includes('G1f'))).toBe(false);
    expect(steps.indexOf('3.1')).toBeGreaterThan(steps.indexOf('2.3'));
  });
});

describe('B3 from the critic (3.5), as from the validator (3.3)', () => {
  it('three automatic rounds go back to 3.2; the fourth is ET8 (a D1 handoff)', () => {
    const s = newSim('m12-b3-critic', { lane: 'L4' });
    s.run({ script: scripts(repeat('3.5', rework('B3'))) });
    const back = s.executed.filter((c) => c.type === 'run_stage' && c.step === '3.2').length;
    expect(back).toBe(4); // the first draft and three redrafts
    expect(s.state.handoffs.at(-1)).toMatchObject({ status: 'open', trigger: 'ET8' });
    expect(s.state.rework.by_edge['B3']).toBe(4);
  });
});

describe('ET8 from a planning step (agent gave up)', () => {
  it('a trigger ET8 raised at 2.2 is a D1 handoff, like one from S6', () => {
    const s = newSim('m12-et8', { lane: 'L4' });
    s.run({
      script: (step, _a, c) =>
        c.type === 'run_stage' && step === '2.2'
          ? ({ outcome: 'trigger', trigger: 'ET8', reason_code: 'output_invalid' } as never)
          : undefined,
    });
    expect(s.state.handoffs.at(-1)).toMatchObject({ status: 'open', trigger: 'ET8' });
    expect(s.state.waiting).toMatchObject({ kind: 'handoff' });
  });
});
