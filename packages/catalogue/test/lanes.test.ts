import { describe, expect, it } from 'vitest';
import {
  GATES,
  GateIdValues,
  LaneValues,
  STEPS,
  StageIdValues,
  type Lane,
} from '@aisdlc/contracts';
import { CATALOGUE, LANES } from '../src/index.js';

const lane = (id: Lane) => LANES[id];
const gatesOf = (id: Lane) => lane(id).gates.map((g) => g.gate);
const stageOf = (id: Lane, s: string) => lane(id).stages.find((x) => x.stage === s);

describe('lanes lint', () => {
  it('has a lane for every Lane id, in the catalogue', () => {
    expect(Object.keys(LANES).sort()).toEqual([...LaneValues].sort());
    expect(Object.keys(CATALOGUE.lanes).sort()).toEqual([...LaneValues].sort());
  });

  it('every gate a lane references exists', () => {
    for (const id of LaneValues) {
      for (const g of lane(id).gates) {
        expect(GateIdValues, `${id} ${g.gate}`).toContain(g.gate);
        expect(GATES[g.gate]).toBeDefined();
      }
      for (const g of lane(id).profile.mandatory_gates) expect(GATES[g]).toBeDefined();
    }
  });

  it('every gate position hangs off a real step that the lane runs', () => {
    for (const id of LaneValues) {
      for (const g of lane(id).gates) {
        expect(STEPS[g.step], `${id} ${g.gate}@${g.step}`).toBeDefined();
        const st = stageOf(id, STEPS[g.step].stage);
        expect(st, `${id} ${g.gate} stage`).toBeDefined();
        expect(st?.mode, `${id} ${g.gate} in a skipped stage`).not.toBe('skipped');
      }
    }
  });

  it('a gate is by_profile exactly when the gate can be toggled', () => {
    for (const id of LaneValues) {
      for (const g of lane(id).gates) {
        expect(g.presence === 'by_profile', `${id} ${g.gate}`).toBe(
          GATES[g.gate].projectToggle !== null,
        );
        if (g.presence === 'conditional') expect(g.condition).not.toBeNull();
        if (g.presence !== 'conditional') expect(g.condition).toBeNull();
      }
    }
  });

  it('lists every stage with a consistent mode and step subset', () => {
    for (const id of LaneValues) {
      const l = lane(id);
      const withSteps = StageIdValues.filter((s) => s !== 'S0' && s !== 'S8a');
      expect(l.stages.map((s) => s.stage).sort()).toEqual([...withSteps].sort());
      for (const s of l.stages) {
        const all = Object.keys(STEPS).filter(
          (k) => STEPS[k as keyof typeof STEPS].stage === s.stage,
        );
        for (const step of s.steps ?? []) expect(all).toContain(step);
        if (s.mode === 'full') expect(s.steps).toEqual(all);
        if (s.mode === 'skipped') expect(s.steps).toEqual([]);
        if (s.mode === 'unspecified') expect(s.steps).toBeNull();
        if (s.mode === 'partial' && s.steps !== null)
          expect(s.steps.length).toBeLessThan(all.length);
      }
    }
  });

  it('7.1-7.6 and G4 are mandatory in every lane that makes a PR; L7 is the one documented exemption', () => {
    for (const id of LaneValues) {
      const p = lane(id).profile;
      if (id === 'L7') {
        expect(p.mandatory_exemption).toMatch(/G4/);
        expect(p.mandatory_steps).toEqual([]);
        expect(gatesOf(id)).not.toContain('G4');
        continue;
      }
      expect(p.mandatory_exemption, id).toBeNull();
      expect(p.mandatory_steps, id).toEqual(['7.1', '7.2', '7.3', '7.4', '7.5', '7.6']);
      expect(p.mandatory_gates, id).toEqual(['G4']);
      expect(gatesOf(id), id).toContain('G4');
      expect(stageOf(id, 'S7')?.mode, id).toBe('full');
      expect(GATES.G4.alwaysRequired).toBe(true);
    }
  });
});

describe('lanes as drawn in the flow', () => {
  it('L0 hotfix goes to SCHED with a repro oracle, skipping S2-S5', () => {
    const l = lane('L0');
    expect(l.label).toBe('hotfix');
    expect(l.enter_at).toBe('SCHED');
    expect(l.profile.oracle_source).toBe('repro_test');
    for (const s of ['S2', 'S3', 'S4', 'S5']) expect(stageOf('L0', s)?.mode).toBe('skipped');
    expect(stageOf('L0', 'S6')?.mode).toBe('full');
    expect(l.follow_up).toMatchObject({ lane: 'L1', effect: 'block_new_agent_items' });
    expect(l.follow_up?.overdue.value).toBe(5);
  });

  it.each(['L1', 'L2', 'L3'] as const)(
    '%s skips S2 and S4, partial S3 and S5, enters at 3.1',
    (id) => {
      expect(lane(id).enter_at).toBe('3.1');
      expect(stageOf(id, 'S2')?.mode).toBe('skipped');
      expect(stageOf(id, 'S4')?.mode).toBe('skipped');
      expect(stageOf(id, 'S3')).toMatchObject({ mode: 'partial', steps: null });
      expect(stageOf(id, 'S5')).toMatchObject({ mode: 'partial', steps: null });
      expect(gatesOf(id)).toContain('G2');
      expect(gatesOf(id)).not.toContain('G3d');
    },
  );

  it.each(['L4', 'L5'] as const)('%s runs the full path without 2.4-2.5', (id) => {
    expect(stageOf(id, 'S2')?.steps).toEqual(['2.1', '2.1b', '2.2', '2.3']);
    for (const s of ['S3', 'S4', 'S5', 'S6', 'S7']) expect(stageOf(id, s)?.mode).toBe('full');
    expect(gatesOf(id)).not.toContain('G1f');
    expect(gatesOf(id)).toEqual(expect.arrayContaining(['G2', 'G3d', 'G3', 'G3s', 'G4']));
    expect(lane(id).profile.oracle_source).toBe('g2_oracle_specs');
  });

  it('L6 runs the full path including 2.4-2.5 and G1f', () => {
    expect(stageOf('L6', 'S2')?.mode).toBe('full');
    expect(stageOf('L6', 'S2')?.steps).toContain('2.5');
    expect(gatesOf('L6')).toContain('G1f');
  });

  it('G1f only on L6; G3d only where S4 runs', () => {
    for (const id of LaneValues) {
      expect(gatesOf(id).includes('G1f'), id).toBe(id === 'L6');
      expect(gatesOf(id).includes('G3d'), id).toBe(['L4', 'L5', 'L6'].includes(id));
    }
  });

  it('L7 spike: S2, then a throwaway S6 without the Push Broker PR, then the report to 9.3', () => {
    const l = lane('L7');
    expect(l.exit).toBe('spike_report');
    expect(stageOf('L7', 'S2')?.mode).toBe('partial');
    expect(stageOf('L7', 'S6')?.steps).not.toContain('6.6');
    expect(stageOf('L7', 'S6')?.steps).toContain('6.5');
    for (const s of ['S7', 'S8', 'S8b']) expect(stageOf('L7', s)?.mode).toBe('skipped');
    expect(stageOf('L7', 'S9')?.steps).toEqual(['9.3']);
    expect(gatesOf('L7')).toEqual(expect.arrayContaining(['G0', 'G1']));
    for (const g of ['G2', 'G3', 'G4', 'G5', 'G6']) expect(gatesOf('L7')).not.toContain(g);
  });

  it('L8 human-led re-enters at 6.4 (D4) and 7.1 (D5)', () => {
    expect(lane('L8').enter_at).toBeNull();
    expect(lane('L8').reentry).toEqual({ D4: '6.4', D5: '7.1' });
    expect(gatesOf('L8')).toContain('G4');
  });

  it('every lane has G0 and G1 after 1.6 and an unspecified default envelope', () => {
    for (const id of LaneValues) {
      expect(
        lane(id)
          .gates.filter((g) => g.step === '1.6')
          .map((g) => g.gate),
      ).toEqual(['G0', 'G1']);
      expect(lane(id).profile.default_envelope.budget_cents).toBeNull();
      expect(lane(id).unspecified.join(' ')).toMatch(/envelope/);
    }
  });
});
