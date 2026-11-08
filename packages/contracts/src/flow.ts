import { z } from 'zod';
import type { StepId } from './values.js';

// Flow ids from docs/specs/flow-corrected.mmd (FL), plus the onboarding gating profile (OB §1C).
// Convention as in values.ts: a Zod enum, the TS type, a readonly `<Name>Values` array.

// ---------------------------------------------------------------- Gates

export const GateId = z.enum([
  'G0',
  'G1',
  'G1f',
  'G2',
  'G3',
  'G3d',
  'G3s',
  'G3o',
  'G4',
  'G5',
  'G6',
  'X1',
  'X2',
  'X3',
  'X4',
  'E1',
  'E2',
  'E3',
  'E4',
  'E5',
  'E6',
  'M1',
  'M2',
  'M3',
  'M4',
  'M5',
  'M6',
  'Q1',
  'SECT',
]);
export type GateId = z.infer<typeof GateId>;
export const GateIdValues: readonly GateId[] = GateId.options;

/**
 * stage: G-gates on the lifecycle path. action: X-gates on a single risky action. exception: E-gates.
 * meta: M1-M3, M5, M6 (config, variance, catalogue, autonomy promotion, approver grant).
 * quarantine: Q1 and the security triage SECT. onboarding: M4, the S0 sign-off.
 */
export const GateFamily = z.enum([
  'stage',
  'action',
  'exception',
  'meta',
  'quarantine',
  'onboarding',
]);
export type GateFamily = z.infer<typeof GateFamily>;
export const GateFamilyValues: readonly GateFamily[] = GateFamily.options;

/**
 * Gates a project may switch off at onboarding (OB §1C). Gates in one group switch together:
 * G0+G1 are one card, G3+G3s are one plan approval. "Off means absent, never auto-approved."
 */
export const ProjectToggleGroup = z.enum(['g0g1', 'g2', 'g3d', 'g3_g3s', 'g5', 'g6']);
export type ProjectToggleGroup = z.infer<typeof ProjectToggleGroup>;
export const ProjectToggleGroupValues: readonly ProjectToggleGroup[] = ProjectToggleGroup.options;

export type GateInfo = {
  readonly family: GateFamily;
  /** No project can turn this gate off. */
  readonly alwaysRequired: boolean;
  readonly projectToggle: ProjectToggleGroup | null;
  /** The flow's node text, shortened; `null` where the flow gives the gate no name. */
  readonly title: string | null;
};

/**
 * alwaysRequired follows OB §1C: G4, X1-X3, E1-E6, Q1, M4. Two more are set here because they are
 * security gates that no profile may remove, although OB §1C does not list them:
 *  - SECT: the security triage that must run BEFORE any handoff after a quarantine (flow: Q1 -> SECT).
 *    OB §1C's "Q1 security triage after quarantine" row describes this step, so SECT is the gate and Q1
 *    the quarantine it follows; both are always required.
 *  - X4: the post-hoc review of a break-glass action. A break-glass without a review would be an
 *    unreviewed bypass, which fails open.
 * G3o is not toggleable: it fires only when oracle code deviates from the G2-approved specs.
 */
export const GATES: Readonly<Record<GateId, GateInfo>> = {
  G0: { family: 'stage', alwaysRequired: false, projectToggle: 'g0g1', title: 'Triage' },
  G1: {
    family: 'stage',
    alwaysRequired: false,
    projectToggle: 'g0g1',
    title: 'Intent, provisional',
  },
  G1f: {
    family: 'stage',
    alwaysRequired: false,
    projectToggle: null,
    title: 'Intent acceptance, final (L6 only, step 2.5)',
  },
  G2: {
    family: 'stage',
    alwaysRequired: false,
    projectToggle: 'g2',
    title: 'Spec + oracle-spec approval',
  },
  G3: {
    family: 'stage',
    alwaysRequired: false,
    projectToggle: 'g3_g3s',
    title: 'Plan approval, SHA-bound',
  },
  G3d: {
    family: 'stage',
    alwaysRequired: false,
    projectToggle: 'g3d',
    title: 'Design / threat sign-off',
  },
  G3s: { family: 'stage', alwaysRequired: false, projectToggle: 'g3_g3s', title: 'Skeleton' },
  G3o: {
    family: 'stage',
    alwaysRequired: false,
    projectToggle: null,
    title: 'Oracle deviation approval',
  },
  G4: {
    family: 'stage',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Merge approval, never skipped',
  },
  G5: { family: 'stage', alwaysRequired: false, projectToggle: 'g5', title: 'Production release' },
  G6: {
    family: 'stage',
    alwaysRequired: false,
    projectToggle: 'g6',
    title: 'Requester acceptance',
  },
  X1: {
    family: 'action',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Destructive / irreversible',
  },
  X2: {
    family: 'action',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Protected-path change',
  },
  X3: { family: 'action', alwaysRequired: true, projectToggle: null, title: 'New dependency' },
  X4: {
    family: 'action',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Break-glass post-hoc review',
  },
  E1: {
    family: 'exception',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Downshift approval (R2)',
  },
  E2: {
    family: 'exception',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Constitution exception',
  },
  E3: {
    family: 'exception',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Envelope extension',
  },
  E4: {
    family: 'exception',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Owner-of-record chooses',
  },
  E5: {
    family: 'exception',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Escalation override',
  },
  E6: {
    family: 'exception',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Test Change Request on locked tests',
  },
  M1: { family: 'meta', alwaysRequired: false, projectToggle: null, title: 'Config' },
  M2: { family: 'meta', alwaysRequired: false, projectToggle: null, title: 'Variance' },
  M3: {
    family: 'meta',
    alwaysRequired: false,
    projectToggle: null,
    title: 'Catalogue / permission',
  },
  M4: {
    family: 'onboarding',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Onboarding sign-off',
  },
  M5: { family: 'meta', alwaysRequired: false, projectToggle: null, title: 'Autonomy promotion' },
  M6: { family: 'meta', alwaysRequired: false, projectToggle: null, title: 'Approver grant' },
  Q1: { family: 'quarantine', alwaysRequired: true, projectToggle: null, title: 'Quarantine' },
  SECT: {
    family: 'quarantine',
    alwaysRequired: true,
    projectToggle: null,
    title: 'Security triage before any handoff',
  },
};

// ---------------------------------------------------------------- Holds, handoffs, re-lane, terminals

export const HandoffId = z.enum(['D1', 'D2', 'D3', 'D4', 'D5']);
export type HandoffId = z.infer<typeof HandoffId>;
export const HandoffIdValues: readonly HandoffId[] = HandoffId.options;

export const HANDOFF_DESCRIPTIONS: Readonly<Record<HandoffId, string>> = {
  D1: 'HANDOFF from S6',
  D2: 'HANDOFF from S7',
  D3: 'HANDOFF from G4',
  D4: 'hand back once',
  D5: 'dev completes',
};

export const RelaneId = z.enum(['R1', 'R2', 'R3', 'R4']);
export type RelaneId = z.infer<typeof RelaneId>;
export const RelaneIdValues: readonly RelaneId[] = RelaneId.options;

export const RELANE_DESCRIPTIONS: Readonly<Record<RelaneId, string>> = {
  R1: 'UPSHIFT, free and logged',
  R2: 'DOWNSHIFT needs E1, re-run G0',
  R3: 'CIRCUIT BREAKER ET14',
  R4: 'Hotfix done',
};

export const HoldReason = z.enum(['H1', 'H2', 'H3', 'WIP', 'N8', 'kill', 'maintenance', 'quota']);
export type HoldReason = z.infer<typeof HoldReason>;
export const HoldReasonValues: readonly HoldReason[] = HoldReason.options;

/**
 * FL names H1 approver pool, H2 capacity, H3 env. DM §6.1 says "H1 capacity or H2 cost pool".
 * They disagree; this table follows FL (the flow is the lifecycle authority) and leaves the
 * reasons only DM, OB or PLAN name as the words those documents use.
 */
export const HOLD_DESCRIPTIONS: Readonly<Record<HoldReason, string | null>> = {
  H1: 'approver pool',
  H2: 'capacity',
  H3: 'env',
  WIP: 'WIP',
  N8: 'no active Project Readiness Record',
  kill: 'kill switch',
  maintenance: 'maintenance MM-2: timers frozen, decisions disabled, drafts kept',
  quota: 'quota',
};

/**
 * Terminal: the item ends and no flow edge leaves the state. Declined (B22), Abandoned (E4 or the
 * 5 bd park timeout), Withdrawn and HandedOverClosed (E4 takeover) come from DM §6.1; Done from G6/S9;
 * Superseded and Deferred are catalogue terminals (DM §6.1 notes) with no drawn incoming edge.
 */
export const TerminalState = z.enum([
  'Done',
  'Declined',
  'Abandoned',
  'Withdrawn',
  'HandedOverClosed',
  'Superseded',
  'Deferred',
]);
export type TerminalState = z.infer<typeof TerminalState>;
export const TerminalStateValues: readonly TerminalState[] = TerminalState.options;

/**
 * Named waits, not terminals: each has an exit edge in the flow.
 *  - Parked: answers arrive -> 1.5, or the 5 bd timeout -> Abandoned.
 *  - Blocked: env fixed -> 6.1.
 *  - ReleaseHeld (RELHOLD): re-request -> G5, or "needs change" -> NEW linked item.
 *  - SpikeReport (L7): drawn as `s65 -> SPIKE -> s93`, so it flows on to the close-out record 9.3.
 *    It is the L7 outcome but the item still closes through S9, so it is a waiting/intermediate
 *    state and not a terminal; Done is the terminal it reaches.
 */
export const WaitState = z.enum(['Parked', 'Blocked', 'ReleaseHeld', 'SpikeReport']);
export type WaitState = z.infer<typeof WaitState>;
export const WaitStateValues: readonly WaitState[] = WaitState.options;

/**
 * Why an item was abandoned. The specs say "ABANDONED with cause code" but never list the codes, so
 * this is a validated string: lowercase dotted/underscored/dashed tokens, 1 to 64 chars, e.g.
 * `owner_abandoned` or `park.timeout`. The catalogue (M1.5) may restrict it further.
 */
export const ABANDON_CAUSE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const AbandonCause = z
  .string()
  .max(64)
  .regex(ABANDON_CAUSE_PATTERN, 'cause code: lowercase tokens joined by . _ or -');
export type AbandonCause = z.infer<typeof AbandonCause>;

// ---------------------------------------------------------------- Back-edges

export const BackEdgeId = z.enum([
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B6',
  'B7',
  'B8',
  'B9',
  'B10',
  'B11',
  'B12',
  'B13',
  'B14',
  'B15',
  'B16',
  'B17',
  'B18',
  'B19',
  'B20',
  'B21',
  'B22',
  'B23',
  'B24',
  'B25',
  'B26',
  'B27',
  'B28',
]);
export type BackEdgeId = z.infer<typeof BackEdgeId>;
export const BackEdgeIdValues: readonly BackEdgeId[] = BackEdgeId.options;

/** `REQ` is the flow's "New request" entry node (a NEW linked item). */
export type EdgeEndpoint = StepId | GateId | WaitState | TerminalState | HandoffId | 'REQ';

export type BackEdgeInfo = {
  /** The flow's edge label without the `Bn ` prefix, `<br/>` read as a space. */
  readonly description: string;
  /** `null` where the flow draws no single source (a cross-cutting rule or a node of its own). */
  readonly from: EdgeEndpoint | null;
  /** Empty where the flow states no target; several where it states more than one. */
  readonly to: readonly EdgeEndpoint[];
};

/**
 * B15 is drawn as two edges, B15a (clean rebase -> 7.1) and B15b (conflict -> 6.4); both sit under
 * one id and the description holds both labels joined by ` | `. B8 also has a second-time edge to D1.
 * B20, B21 and B28 are drawn as nodes, not edges: B20 AMEND -> 3.2 has no source, B21 (SLA) and B28
 * (rework budget, target E4) have no source step.
 */
export const BACK_EDGES: Readonly<Record<BackEdgeId, BackEdgeInfo>> = {
  B1: { description: 'missing info: ≤2 rounds, park 5 bd', from: '1.5', to: ['Parked'] },
  B2: { description: 'intent ambiguous: G1 again, 2×, then E4', from: '2.1', to: ['1.5'] },
  B3: { description: 'validator/critic fail: 3 auto, then ET8', from: '3.3', to: ['3.2'] },
  B4: { description: 'design reveals spec gap: 1×', from: '4.6', to: ['3.2'] },
  B5: {
    description: 'plan changes requested: 2 rejections, then human writes plan',
    from: 'G3',
    to: ['5.1'],
  },
  B6: { description: 'red baseline / env broken', from: '6.2', to: ['Blocked'] },
  B7: {
    description: 'task check fails: ET3 3 rounds · ET2 5 CI rounds or 2× time',
    from: '6.5',
    to: ['6.4'],
  },
  B8: { description: 'scope tripwire, 1st: split Unit, G3 again', from: '6.5', to: ['5.1', 'D1'] },
  B9: { description: 'repairable finding: ET3/ET4/ET5/ET6 limits', from: '7.6', to: ['6.4'] },
  B10: { description: 'spec ambiguous: G2 portion again, 1×', from: '7.3', to: ['3.2'] },
  B11: { description: 'approach wrong: G3 again, 1×', from: '7.6', to: ['5.1'] },
  B12: { description: 'locked test must change, 1×', from: '7.2', to: ['E6'] },
  B13: { description: 'G4 changes requested: ET7 2 rounds', from: '8.1', to: ['6.4'] },
  B14: { description: 'mode-E approver unsure → mode C', from: '8.1', to: ['8.1'] },
  B15: {
    description:
      'B15a base moved, clean rebase: S7 re-run, 2× | B15b merge conflict: resolve in S6, then S7',
    from: '8.2',
    to: ['7.1', '6.4'],
  },
  B16: { description: 'deploy unhealthy: rollback, NEW L0/L1 item', from: 'S8b', to: ['REQ'] },
  B17: { description: 'escape found post-merge: NEW L0/L1, ET13', from: '9.3', to: ['REQ'] },
  B18: { description: 'requester rejects: NEW linked item', from: '9.2', to: ['REQ'] },
  B19: {
    description: 'gate-miss on mode-E merge: NEW item >10% over ≥20 sampled suspends mode E',
    from: '9.5',
    to: ['REQ'],
  },
  B20: { description: 'requester amends scope, any active stage, 1×', from: null, to: ['3.2'] },
  B21: {
    description: 'any gate > 1 bd SLA → backup approver / manager NEVER auto-approve',
    from: null,
    to: [],
  },
  B22: { description: 'ineligible / unsuitable', from: 'G0', to: ['Declined'] },
  B23: { description: 'spec rejected: 2 rounds, then E4', from: 'G2', to: ['3.2'] },
  B24: { description: 'design rejected: 2 rounds, then E4', from: 'G3d', to: ['4.1'] },
  B25: { description: 'exception denied: redesign 1×, else E4', from: 'E2', to: ['4.1'] },
  B26: { description: 'release denied', from: 'G5', to: ['ReleaseHeld'] },
  B27: {
    description: 'suspected injection in request: content fenced as data, flagged on G0 card',
    from: '1.1',
    to: ['G0'],
  },
  B28: { description: 'rework budget exhausted', from: null, to: ['E4'] },
};

// ---------------------------------------------------------------- ET triggers

export const TriggerId = z.enum([
  'ET1',
  'ET2',
  'ET3',
  'ET4',
  'ET5',
  'ET6',
  'ET7',
  'ET8',
  'ET9',
  'ET10',
  'ET11',
  'ET12',
  'ET13',
  'ET14',
]);
export type TriggerId = z.infer<typeof TriggerId>;
export const TriggerIdValues: readonly TriggerId[] = TriggerId.options;

/**
 * Words the flow attaches to each trigger. ET4, ET5 and ET6 appear only as "loop limits ET3-ET6" and
 * "ET3/ET4/ET5/ET6 limits", so they stay `null`; their effect is catalogue data (M1.5).
 * Parts are joined by ` | ` when the flow says it in two places.
 */
export const TRIGGER_DESCRIPTIONS: Readonly<Record<TriggerId, string | null>> = {
  ET1: 'budget 100%',
  ET2: 'time | 5 CI rounds or 2× time',
  ET3: 'repeat fail | 3 rounds',
  ET4: null,
  ET5: null,
  ET6: null,
  ET7: 'two rejection rounds',
  ET8: 'agent gave up',
  ET9: 'scope drift ×2',
  ET10: 'misbehaviour',
  ET11: 'oscillation',
  ET12: 'instability',
  ET13: 'escape found post-merge',
  ET14: 'circuit breaker | project × lane → new items go L8',
};

// ---------------------------------------------------------------- Other drawn edges

/** An edge of the flow that is not a back-edge: handoffs, E4 choices, re-laning, quarantine. */
export type FlowEdge<I extends string> = {
  readonly id: I;
  readonly from: EdgeEndpoint;
  readonly to: readonly EdgeEndpoint[];
};

/**
 * Handoffs D1-D3 and the E4 owner's choices, as drawn. `E4 -> L8` (developer takes over), `L8 -> 7.1`
 * (D5) and `L8 -> 6.4` (D4) are not listed: L8 human-led is a lane on the item, not a step or a
 * phase (see work-item.ts), so those edges are lane changes inside S6/S7. `E4 -> E3 -> 6.4` is
 * listed as the resume it ends in.
 */
export const HANDOFF_EDGES: readonly FlowEdge<HandoffId | 'E4'>[] = [
  { id: 'D1', from: '6.4', to: ['D1'] },
  { id: 'D1', from: '6.5', to: ['D1'] },
  { id: 'D1', from: 'X1', to: ['D1'] },
  { id: 'D2', from: '7.6', to: ['D2'] },
  { id: 'D2', from: 'X2', to: ['D2'] },
  { id: 'D3', from: '8.1', to: ['D3'] },
  { id: 'E4', from: 'E4', to: ['6.4', '5.1', '3.2', 'Abandoned'] },
];

/**
 * Re-laning edges. R1 inserts the first missing stage of S2/S3/S4 (the flow draws 2.1 and 3.1);
 * R2 goes back to 1.3 after E1. R3 only routes new items; R4 creates a new item (`REQ`).
 */
export const RELANE_EDGES: readonly FlowEdge<RelaneId>[] = [
  { id: 'R1', from: '6.5', to: ['2.1', '3.1'] },
  { id: 'R1', from: '7.3', to: ['2.1', '3.1'] },
  { id: 'R1', from: 'X2', to: ['2.1', '3.1'] },
  { id: 'R2', from: '2.3', to: ['1.3'] },
  { id: 'R2', from: '4.6', to: ['1.3'] },
  { id: 'R4', from: 'S8b', to: ['REQ'] },
];

/**
 * Quarantine: ET10 from 6.4 and the 7.2 stub probe go to Q1, then SECT. SECT false positive goes to
 * 6.1 (cold rebuild, new session). SECT confirmed goes to L8 human-led (a lane, not listed).
 */
export const QUARANTINE_EDGES: readonly FlowEdge<'Q1' | 'SECT'>[] = [
  { id: 'Q1', from: '6.4', to: ['Q1'] },
  { id: 'Q1', from: '7.2', to: ['Q1'] },
  { id: 'SECT', from: 'SECT', to: ['6.1'] },
];
