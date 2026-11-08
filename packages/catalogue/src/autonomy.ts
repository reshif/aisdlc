import { AutonomyValues, type Autonomy, type Level, type Tier } from '@aisdlc/contracts';
import type { AutonomyCatalogue, Posture, ReadinessLevel } from './schema.js';

// Autonomy caps (OB §2.3): effective = min(tier cap, level cap, readiness cap, posture cap,
// probation cap, earned). Automatic changes only tighten; loosening always needs a human.

export const AUTONOMY: AutonomyCatalogue = {
  tier: { T0: 'A3', T1: 'A3', T2: 'A2' },
  level: { census: 'A0', light: null, full: null },
  readiness: { RL0: null, RL1: 'A0', RL2: 'A1', RL3: 'A2', RL4: 'A3' },
  posture: {
    red: { cap: 'A0', census_lanes_only: true, g4_mode_c: false },
    amber: { cap: 'A1', census_lanes_only: false, g4_mode_c: true },
    green: { cap: null, census_lanes_only: false, g4_mode_c: false },
  },
  probation: {
    cap: 'A1',
    min_weeks: { key: 'min_weeks', value: 4, unit: 'weeks', tune: false },
    ends_by: 'governance_earn_rule',
  },
  automatic_changes: 'tighten_only',
  loosening: 'human_only',
};

/** Cap of a composite readiness level 0-4 (RL4 stands for "RL4+"). `null` is not stated (RL0). */
export function readinessCap(level: number): Autonomy | null {
  const key = `RL${Math.min(Math.max(Math.trunc(level), 0), 4)}` as ReadinessLevel;
  return AUTONOMY.readiness[key];
}

export type CapInputs = {
  readonly tier: Tier;
  readonly level: Level;
  /** Composite readiness level (the min of the pillar levels). */
  readonly readiness: number;
  readonly posture: Posture;
  /** True while inside the probation window after M4. */
  readonly onProbation: boolean;
  /** The level reached through the governance earn rule (M5), when there is one. */
  readonly earned?: Autonomy;
};

const rank = (a: Autonomy): number => AutonomyValues.indexOf(a);

/**
 * The min over every cap that applies. Fail closed: a readiness level the catalogue does not state
 * (RL0) caps at the lowest autonomy rather than leaving it unconstrained.
 */
export function effectiveAutonomy(inputs: CapInputs): Autonomy {
  const lowest = AutonomyValues[0] as Autonomy;
  const caps: Autonomy[] = [AUTONOMY.tier[inputs.tier]];
  const levelCap = AUTONOMY.level[inputs.level];
  if (levelCap !== null) caps.push(levelCap);
  caps.push(readinessCap(inputs.readiness) ?? lowest);
  const posture = AUTONOMY.posture[inputs.posture].cap;
  if (posture !== null) caps.push(posture);
  if (inputs.onProbation) caps.push(AUTONOMY.probation.cap);
  if (inputs.earned !== undefined) caps.push(inputs.earned);
  return caps.reduce((a, b) => (rank(b) < rank(a) ? b : a));
}
