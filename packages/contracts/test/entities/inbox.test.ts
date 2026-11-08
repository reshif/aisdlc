import { describe, expect, it } from 'vitest';
import {
  GATE_POLICIES,
  GateIdValues,
  SOLO_CARDS,
  SoloCardIdValues,
  soloCardOf,
  type GateId,
} from '../../src/index.js';

describe('SOLO card groups (FL PROFILES)', () => {
  it('are card 1 G0+G1, 2 G2+oracles, 3 G3d+G3+G3s, 4 G4, 5 G5+G6', () => {
    expect(SOLO_CARDS.solo1.gates).toEqual(['G0', 'G1']);
    expect(SOLO_CARDS.solo2.gates).toEqual(['G2', 'G3o']);
    expect(SOLO_CARDS.solo3.gates).toEqual(['G3d', 'G3', 'G3s']);
    expect(SOLO_CARDS.solo4.gates).toEqual(['G4']);
    expect(SOLO_CARDS.solo5.gates).toEqual(['G5', 'G6']);
    expect(SOLO_CARDS.solo5.requester_is_operator).toBe(true);
  });

  it('a gate is in at most one group, and only consolidatable gates share one', () => {
    const seen = new Set<GateId>();
    for (const id of SoloCardIdValues) {
      for (const g of SOLO_CARDS[id].gates) {
        expect(seen.has(g), `${g} in two groups`).toBe(false);
        seen.add(g);
        if (SOLO_CARDS[id].gates.length > 1) expect(GATE_POLICIES[g].consolidatable).toBe(true);
      }
    }
  });

  it('every consolidatable gate is in a group; X, E, M, Q, SECT are in none', () => {
    for (const g of GateIdValues) {
      if (GATE_POLICIES[g].consolidatable) expect(soloCardOf(g), g).not.toBeNull();
      if (/^(X|E|M|Q|SECT)/.test(g)) expect(soloCardOf(g), g).toBeNull();
    }
    expect(soloCardOf('G4')).toBe('solo4');
    expect(soloCardOf('G1f')).toBeNull();
  });
});
