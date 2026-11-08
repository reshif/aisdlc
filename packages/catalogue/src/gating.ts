import {
  GATES,
  GateIdValues,
  T2_GATING_FLOOR,
  type GateId,
  type GatingProfile,
  type Lane,
  type ProjectToggleGroup,
  effectiveSwitch,
} from '@aisdlc/contracts';
import type { GatingCatalogue } from './schema.js';

// The per-project gating profile (OB §1C, DEC-30): the fixed floor, the defaults, the T2 floor.

/** The safety floor: gates no project can turn off. Read from contracts' GATES, not re-listed. */
export const ALWAYS_REQUIRED_GATES: readonly GateId[] = GateIdValues.filter(
  (g) => GATES[g].alwaysRequired,
);

/**
 * Defaults of OB §1C. G2, G3d and G3 default on for L4-L6; G2 is off for L1-L3 (G3d and G3 give no
 * L1-L3 default, so none is stated). G5 is on if the project deploys. G6 is on, and off when the
 * requester is the operator. G0+G1 are on. 5.7 scheduling is automatic; human scheduling is opt-in.
 */
export const GATING: GatingCatalogue = {
  always_required: [...ALWAYS_REQUIRED_GATES],
  defaults: {
    g0g1: { kind: 'fixed', value: 'on', exceptions: [] },
    g2: {
      kind: 'by_lane',
      lanes: { L1: 'off', L2: 'off', L3: 'off', L4: 'on', L5: 'on', L6: 'on' },
    },
    g3d: { kind: 'by_lane', lanes: { L4: 'on', L5: 'on', L6: 'on' } },
    g3_g3s: { kind: 'by_lane', lanes: { L4: 'on', L5: 'on', L6: 'on' } },
    g5: { kind: 'by_deploys', deploys: 'on', otherwise: 'off' },
    g6: {
      kind: 'fixed',
      value: 'on',
      exceptions: [{ when: 'requester is the operator', value: 'off' }],
    },
  },
  schedule_default: 'auto',
  human_schedule: 'opt_in',
  t2_floor: {
    lanes: [...T2_GATING_FLOOR.lanes],
    groups: [...T2_GATING_FLOOR.groups],
    deploy_group: T2_GATING_FLOOR.deployGroup,
  },
};

/**
 * Gates a profile removes from a lane: every gate whose toggle group is off there. Off means absent,
 * never auto-approved. A gate that is not toggleable is never in the result.
 */
export function gatesOff(profile: GatingProfile, lane?: Lane): GateId[] {
  return GateIdValues.filter((g) => {
    const group: ProjectToggleGroup | null = GATES[g].projectToggle;
    return group !== null && effectiveSwitch(profile, group, lane) === 'off';
  });
}
