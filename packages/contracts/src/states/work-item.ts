import { z } from 'zod';
import { TerminalState } from '../flow.js';
import { defineMachine, type TransitionTable } from './machine.js';

/**
 * WorkItem phase (DM §6.1): the engine phase union. `S1..S9`, `S8a`, `S8b` are stage phases (the
 * values of `StageId` apart from S0 and S8); `G4`, `G5`, `G6` are the phases where an item waits on
 * that gate; the terminals are exactly `TerminalState`, so they are listed there only.
 *
 * Choices where DM is ambiguous:
 *  - `SchedulingL0` in the DM diagram is the same phase as `Scheduling` for lane L0. A lane is an
 *    attribute of the item, not a phase, so there is one `Scheduling`; `S1 -> Scheduling` is the
 *    L0 hotfix edge (the engine, not this table, checks the lane).
 *  - `Held` and `Waiting` are overlays: the item keeps its stage. The DM edge is `Held -> S1`, the note
 *    says the engine resumes the prior phase, so `Held` may return to any phase that can enter it.
 *  - `Parked -> Abandoned` (5 bd timeout) and `Clarifying -> Parked` (B1 is drawn from 1.5) come from
 *    the flow (FIX 3), not the DM diagram.
 *  - The table is the union of DM §6.1 and every stage-changing edge of flow-corrected.mmd (the flow
 *    is the authority for edges): back-edges, R1/R2 re-laning, handoffs and E4 choices, quarantine.
 *    Edges inside one stage (B3, B5, B7, B14, B23, B24, B27) are not phase changes.
 *  - L8 human-led is a lane on the item, not a phase. A developer takeover (E4 -> L8), a confirmed
 *    SECT (-> L8), D4 (hand back) and D5 (dev completes -> 7.1) therefore keep the phase at
 *    Handoff/Quarantined -> S6 -> S7 with lane = L8. `HandedOverClosed` stays for DM's takeover that
 *    closes the item.
 *  - B20 (requester amends scope in any active stage) is Active phase -> S3. R2 downshift is S2/S4 -> S1.
 *  - Held is reachable from every non-terminal phase but Draft, and resumes to any of them.
 *  - Blocked, ReleaseHeld and SpikeReport (`WaitState`) are not WorkItem phases: DM draws them as
 *    named waits on a stage, not as phases.
 *  - Superseded and Deferred are terminals with no incoming edge: DM §6.1 says they are "not drawn".
 *    No edge is invented; a later append-only change adds them when the catalogue defines the cause.
 */
export const WorkItemPhase = z.enum([
  'Draft',
  'Clarifying',
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'Scheduling',
  'S6',
  'S7',
  'G4',
  'S8a',
  'S8b',
  'G5',
  'S9',
  'G6',
  'Held',
  'Handoff',
  'Quarantined',
  'Parked',
  ...TerminalState.options,
]);
export type WorkItemPhase = z.infer<typeof WorkItemPhase>;
export const WorkItemPhaseValues: readonly WorkItemPhase[] = WorkItemPhase.options;

/** Phases a hold (kill, maintenance, quota, H1-H3, WIP) can interrupt, and so resume to. */
const HOLDABLE = [
  'Clarifying',
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'Scheduling',
  'S6',
  'S7',
  'G4',
  'S8a',
  'S8b',
  'G5',
  'S9',
  'G6',
  'Handoff',
  'Quarantined',
  'Parked',
] as const satisfies readonly WorkItemPhase[];

export const WORK_ITEM_TRANSITIONS: TransitionTable<WorkItemPhase> = {
  Draft: ['S1', 'Withdrawn'],
  Clarifying: ['S1', 'Parked', 'Held'],
  // S1 -> S2/S3/Scheduling are the lane entries; Held is any hold.
  S1: ['S2', 'S3', 'Scheduling', 'Declined', 'Clarifying', 'Quarantined', 'Held', 'Parked'],
  // S2 -> S1: B2 (2.1 -> 1.5) and R2 downshift (re-run G0). S2 -> S3: B20 amend.
  S2: ['S1', 'S3', 'Scheduling', 'Held'],
  // S3 -> S4/S5: lane shortcuts. B20 amend is S3 -> S3 (no change).
  S3: ['S4', 'S5', 'Held'],
  // S4 -> S3: B4 (4.6 -> 3.2), B20. S4 -> S1: R2 downshift from 4.6. S4 -> S2: R1 insert.
  S4: ['S5', 'S3', 'S1', 'Held'],
  // S5 -> S3/S4: B5 re-plan, B20. No S5 -> S2: the flow draws R1 only from 6.5, 7.3 and X2.
  S5: ['Scheduling', 'S3', 'S4', 'Held'],
  Scheduling: ['S6', 'Held', 'S3'],
  // S6 -> S5: B8, B11 style re-plan. S6 -> S2/S3/S4: R1 upshift inserts the first missing stage.
  // S6 -> Quarantined: ET10. S6 -> Handoff: D1. S6 -> S3: B20.
  S6: ['S7', 'Handoff', 'S9', 'Held', 'Quarantined', 'S5', 'S4', 'S3', 'S2'],
  // S7 -> S6: B9, E2 runtime denial, E6 -> G3o. S7 -> S5/S3: B11, B10. S7 -> Handoff: D2, X2 deny.
  // S7 -> Quarantined: 7.2 stub probe. S7 -> S2/S4: R1 upshift.
  S7: ['S6', 'S8a', 'G4', 'Handoff', 'Quarantined', 'S5', 'S4', 'S3', 'S2', 'Held'],
  // G4 -> S6: B13. G4 -> Handoff: D3 (ET7). G4 -> S3: B20.
  G4: ['S8a', 'S6', 'Handoff', 'S3', 'Held'],
  // S8a -> S7: B15a clean rebase. S8a -> S6: B15b conflict.
  S8a: ['S8b', 'S6', 'S7', 'Held'],
  S8b: ['G5', 'Held'],
  G5: ['S9', 'S8b', 'Held'],
  S9: ['G6', 'Held'],
  G6: ['Done', 'Held'],
  Held: [...HOLDABLE, 'Abandoned'],
  // Handoff -> S6: E4 resume / hand back (D4); -> S5 re-plan; -> S3 re-spec; Held.
  // HandedOverClosed is the DM edge for a takeover that closes the item.
  Handoff: ['S6', 'S5', 'S3', 'HandedOverClosed', 'Abandoned', 'Held'],
  // Quarantined -> S6: SECT false positive (6.1) or confirmed with lane L8.
  Quarantined: ['S1', 'S6', 'Abandoned', 'Held'],
  Parked: ['S1', 'Abandoned', 'Held'],
  Done: [],
  Declined: [],
  Abandoned: [],
  Withdrawn: [],
  HandedOverClosed: [],
  Superseded: [],
  Deferred: [],
};

export const WorkItemMachine = defineMachine('WorkItem', WORK_ITEM_TRANSITIONS);
export const canTransitionWorkItem = WorkItemMachine.canTransition;
export const assertTransitionWorkItem = WorkItemMachine.assertTransition;
