import { describe, expect, it } from 'vitest';
import type { ProjectToggleGroup } from '../src/index.js';
import {
  ABANDON_CAUSE_PATTERN,
  AbandonCause,
  BACK_EDGES,
  BackEdgeIdValues,
  GATES,
  GateIdValues,
  HOLD_DESCRIPTIONS,
  HoldReasonValues,
  STEPS,
  TRIGGER_DESCRIPTIONS,
  TerminalStateValues,
  TriggerIdValues,
  WaitStateValues,
} from '../src/index.js';

describe('gates', () => {
  it('has a row for every gate id', () => {
    expect(Object.keys(GATES).sort()).toEqual([...GateIdValues].sort());
  });

  it('keeps the always-required floor of OB 1C, plus SECT and X4', () => {
    const always = GateIdValues.filter((g) => GATES[g].alwaysRequired).sort();
    expect(always).toEqual(
      ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'G4', 'M4', 'Q1', 'SECT', 'X1', 'X2', 'X3', 'X4'].sort(),
    );
  });

  it('never lets an always-required gate be toggled', () => {
    for (const g of GateIdValues) {
      if (GATES[g].alwaysRequired) expect(GATES[g].projectToggle).toBeNull();
    }
  });

  it('toggles exactly the groups of OB 1C, with G0+G1 and G3+G3s together', () => {
    const groups = (id: ProjectToggleGroup) =>
      GateIdValues.filter((g) => GATES[g].projectToggle === id);
    expect(groups('g0g1')).toEqual(['G0', 'G1']);
    expect(groups('g2')).toEqual(['G2']);
    expect(groups('g3d')).toEqual(['G3d']);
    expect(groups('g3_g3s')).toEqual(['G3', 'G3s']);
    expect(groups('g5')).toEqual(['G5']);
    expect(groups('g6')).toEqual(['G6']);
  });

  it('assigns families', () => {
    expect(GATES.M4.family).toBe('onboarding');
    expect(GATES.M1.family).toBe('meta');
    expect(GATES.Q1.family).toBe('quarantine');
    expect(GATES.SECT.family).toBe('quarantine');
    expect(GATES.X4.family).toBe('action');
    expect(GATES.E6.family).toBe('exception');
    expect(GATES.G3o.family).toBe('stage');
  });
});

describe('ids', () => {
  it('has the sizes the flow gives', () => {
    expect(BackEdgeIdValues).toHaveLength(28);
    expect(TriggerIdValues).toHaveLength(14);
    expect(Object.keys(BACK_EDGES).sort()).toEqual([...BackEdgeIdValues].sort());
    expect(Object.keys(TRIGGER_DESCRIPTIONS).sort()).toEqual([...TriggerIdValues].sort());
    expect(Object.keys(HOLD_DESCRIPTIONS).sort()).toEqual([...HoldReasonValues].sort());
  });

  it('keeps wait states apart from terminals', () => {
    for (const w of WaitStateValues) expect(TerminalStateValues).not.toContain(w);
    expect(TerminalStateValues).toContain('Abandoned');
  });

  it('only points back-edges at known steps', () => {
    for (const edge of Object.values(BACK_EDGES)) {
      for (const t of edge.to) {
        if (/^\d|^S8b$/.test(t)) expect(STEPS).toHaveProperty([t]);
      }
    }
  });
});

describe('AbandonCause', () => {
  it('accepts code-like strings', () => {
    for (const ok of ['owner_abandoned', 'park.timeout', 'et14-breaker', 'x', 'a1.b2']) {
      expect(AbandonCause.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('refuses everything else', () => {
    for (const bad of ['', 'Owner', '1abc', 'a b', 'a..b', 'a_', '_a', 'a-', 'é', 'x'.repeat(65)]) {
      expect(AbandonCause.safeParse(bad).success, bad).toBe(false);
    }
    expect(ABANDON_CAUSE_PATTERN.test('ok_code')).toBe(true);
  });
});
