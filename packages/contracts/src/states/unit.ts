import { z } from 'zod';
import { defineMachine, type TransitionTable } from './machine.js';

/**
 * Unit state (DM §6.4): what a Unit carries across AdmissionGrant, the lease and the PR.
 *
 * Choices: the diagram's `Released_grant` (from `Admitted`: handoff, item ends or G4 decided) is
 * named `GrantReleased`, a terminal. `Released` is the end of the happy path. `Quarantined` and
 * `Stopped` have no outgoing edge in the diagram, so they are terminal. The `idle`, `waiting_tool`,
 * `interrupted` states of `Building` belong to AgentSession, not here; `Building -> Building` is
 * kept as the drawn self-edge.
 */
export const UnitState = z.enum([
  'Planned',
  'Admitted',
  'Building',
  'Pushed',
  'Verifying',
  'InReview',
  'Merged',
  'Released',
  'HumanHeld',
  'Tainted',
  'Quarantined',
  'Stopped',
  'GrantReleased',
]);
export type UnitState = z.infer<typeof UnitState>;
export const UnitStateValues: readonly UnitState[] = UnitState.options;

export const UNIT_TRANSITIONS: TransitionTable<UnitState> = {
  Planned: ['Admitted'],
  Admitted: ['Building', 'GrantReleased'],
  Building: ['Building', 'Pushed', 'HumanHeld', 'Tainted', 'Stopped'],
  Pushed: ['Verifying'],
  Verifying: ['Building', 'InReview'],
  InReview: ['Merged', 'Building'],
  Merged: ['Released'],
  Released: [],
  HumanHeld: ['Building'],
  Tainted: ['Quarantined'],
  Quarantined: [],
  Stopped: [],
  GrantReleased: [],
};

export const UnitMachine = defineMachine('Unit', UNIT_TRANSITIONS);
export const canTransitionUnit = UnitMachine.canTransition;
export const assertTransitionUnit = UnitMachine.assertTransition;
