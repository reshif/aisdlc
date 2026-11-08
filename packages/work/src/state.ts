import {
  type GateId,
  type ItemCommand,
  type ItemCreatedPayload,
  type ItemHold,
  type Lane,
  type PrrGatingProfile,
  type Question,
  type SpawnLink,
  type TerminalState,
  type Tier,
  type WorkItemPhase,
  type CatalogueRef,
  type ItemIntake,
  type SpawnOrigin,
  type StepId,
} from '@aisdlc/contracts';

// The state of one work item: a fold of its event stream through `interpret` (PLAN M9.2). Plain data
// (no classes, no functions, no clock), so it serialises, compares and replays exactly.

export interface GateInstanceState {
  readonly gate: GateId;
  readonly gate_instance_id: string;
  readonly status: 'pending' | 'decided';
  readonly outcome: string | null;
  /** The station (or conditional step) the gate belongs to. */
  readonly station: string;
}

export type Waiting =
  /** An outstanding stage, eligibility, spawn or withdraw command. */
  | { readonly kind: 'command'; readonly key: string }
  /** Gates opened (or being opened) for one station; the item waits for every one of them. */
  | {
      readonly kind: 'gates';
      readonly station: string;
      readonly gates: readonly GateId[];
      /** Set when a stage raised the gate mid-step. */
      readonly conditional: { readonly step: StepId; readonly gate: GateId } | null;
    }
  | { readonly kind: 'human'; readonly what: 'ready' | 'schedule' | 'merge' | 'human_led' }
  | { readonly kind: 'questions'; readonly ids: readonly string[] }
  /** B1's round limit: PARKED (its exits are M9.3). */
  | { readonly kind: 'parked'; readonly cause: string }
  /** An outcome whose edge belongs to M9.3-M9.5: the item does not move (fail closed). */
  | {
      readonly kind: 'stuck';
      readonly reason: string;
      readonly step: StepId | null;
      readonly gate: GateId | null;
    };

export interface ItemState {
  readonly item_id: string;
  readonly project_id: string;
  readonly request_id: string;
  readonly repo: string;
  readonly requester: string;
  readonly channel: string;
  readonly catalogue_ref: CatalogueRef;
  /** The profile the item started with: the engine never reads a newer one. */
  readonly profile: PrrGatingProfile;
  readonly tier: Tier;
  readonly intake: ItemIntake;
  readonly origin: SpawnOrigin | null;
  /** The phase with holds applied: `Held` while any hold is on. */
  phase: WorkItemPhase;
  /** The phase the item is in under the holds: what it resumes to. */
  underlying: WorkItemPhase;
  proposed_lane: Lane;
  /** Bound at G0 (or by the Ready decision when G0 is off): FIX 7. `null` until then. */
  lane: Lane | null;
  /** How the lane was bound: the gate decision's key, or `ready_decision`. */
  lane_bound_by: string | null;
  /** Index of the current station in the route of `lane ?? proposed_lane`. */
  cursor: number;
  waiting: Waiting | null;
  attempts: Record<string, number>;
  /** Gates approved at a step (a resume after X1 or X3 carries them). */
  approved: Record<string, GateId[]>;
  /** Issued and not yet answered: what the driver must see executed. Re-derivable from the record. */
  outstanding: ItemCommand[];
  holds: ItemHold[];
  gates: GateInstanceState[];
  questions: Question[];
  /** Clarifying rounds so far (B1: at most two, then PARK). */
  rounds: number;
  /** The agent lease (M13 owns it): set when 6.0 admits, cleared when S6 ends. */
  lease: { readonly epoch: number } | null;
  spawns: SpawnLink[];
  /** Back-edge counters and the item's rework budget (M9.4 fills them; they survive re-lane and handoff). */
  rework: { total: number; by_edge: Record<string, number> };
  terminal: TerminalState | null;
  terminal_cause: string | null;
  /** The last event types the interpreter did not act on, and why (bounded). */
  ignored: string[];
  created_at: string;
  /** The phases the last event moved the item through, in order (a bridge shows its hops). */
  trail: WorkItemPhase[];
  /** The seq of the last event folded. */
  seq: number;
}

export type { ItemCreatedPayload };
