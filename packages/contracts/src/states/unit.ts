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
 *
 * The B11 re-plan of a pushed Unit (owner decision 2026-11-13, PLAN §7a): when 7.6 finds the approach wrong after the
 * Unit's branch and draft PR exist, the Unit goes from `Pushed` (or `Verifying`, `InReview`: any state with a branch and
 * an open PR before the merge) back to `Planned` on the `replanned` grant release, KEEPING its branch, head and PR
 * (`core.unit.head_sha`, `pr_ref`, the `core.pull_request` link), its lease and so its epoch; 6.0 admits it again at a
 * higher epoch and S6 builds on the branch head, fast-forward, on the same PR. `Merged` never goes back.
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
  Pushed: ['Verifying', 'Planned'],
  Verifying: ['Building', 'InReview', 'Planned'],
  InReview: ['Merged', 'Building', 'Planned'],
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
