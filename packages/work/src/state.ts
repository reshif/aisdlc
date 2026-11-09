import {
  type Assumption,
  type GateId,
  type Handoff,
  type ItemRelane,
  type R1Trigger,
  type RelaneTrigger,
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
  /**
   * The station was left (approved, or an edge was taken): this instance never counts again. A back-edge
   * brings the item to the same station, and an old decision must not decide the new visit.
   */
  readonly consumed?: boolean;
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
  | {
      readonly kind: 'human';
      readonly what: 'ready' | 'schedule' | 'merge' | 'human_led' | 'plan';
    }
  | { readonly kind: 'questions'; readonly ids: readonly string[] }
  /** PARKED (B1's round limit, or silence while clarifying): answers arrive -> 1.5, 5 bd -> Abandoned. */
  | { readonly kind: 'parked'; readonly cause: string; readonly ids: readonly string[] }
  /** BLOCKED (B6): the platform owner fixes the environment; "env fixed" -> 6.1. */
  | {
      readonly kind: 'blocked';
      readonly cause: string;
      readonly owner: 'platform_owner';
    }
  /** RELEASE HELD (B26): merged, not deployed. Re-request -> G5, or a NEW linked item. */
  | { readonly kind: 'release_held'; readonly since: string }
  /**
   * A handoff is open (D1/D2/D3/E4): `e4` waits for the E4 gate, `choice` for the owner's choice, `e3`
   * for the envelope-extension gate the choice asked for.
   */
  | {
      readonly kind: 'handoff';
      readonly handoff_id: string;
      readonly station: string;
      readonly stage: 'e4' | 'choice' | 'e3';
    }
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
  /**
   * Back-edge counters and the item's rework budget (FIX 14): `total` counts every back-edge B2-B26 the
   * item has asked for, `by_edge` per edge, `by_loop` per catalogue limit (`B7:et3_rounds`). They survive
   * re-lane and handoff: nothing resets them.
   */
  rework: { total: number; by_edge: Record<string, number>; by_loop: Record<string, number> };
  /**
   * What this item contributed to the ET14 circuit breaker (R3): E4 abandon and takeover, the
   * rework budget. Each count is also a `breaker_signal` command; the breaker itself is core's
   * projection over them.
   */
  et14: Record<string, number>;
  /** R1 and R2 the item went through, oldest first: free, but logged. */
  relanes: ItemRelane[];
  /**
   * A re-lane that waits for something: R1 for the eligibility of its target lane (`check_key`), R2 for
   * its E1 decision. `resume` is what the item was waiting for when R2 was observed at 4.6 (G3d), which
   * an E1 denial returns it to.
   */
  relane_pending: {
    readonly edge: 'R1' | 'R2';
    readonly trigger: RelaneTrigger | R1Trigger;
    readonly from_lane: Lane;
    readonly to_lane: Lane;
    readonly step: StepId;
    readonly asked_seq: number;
    readonly check_key: string | null;
    readonly resume: Waiting | null;
  } | null;
  /**
   * "Done stays done": stations (of S2-S5) a re-lane found already done, which the item passes without
   * running them again. Cleared when the item reaches S6 or any back-edge sends it somewhere.
   */
  skip: string[];
  /** Timers: business-day timers run on `since`, and time frozen by MM-2 does not count. */
  clock: {
    /** Total ms the item spent under a maintenance hold. */
    frozen_ms: number;
    frozen_since: string | null;
    /** The item is older than the catalogue's `item_age` (B28), and E4 is not yet asked. */
    age_exceeded: boolean;
    age_pending: boolean;
  };
  /** Set while the item is PARKED or clarifying: when it started, and the frozen time before it. */
  park: { since: string; frozen_base: number } | null;
  clarify: { since: string; frozen_base: number } | null;
  /** Handoffs of the item, oldest first; the open one is the last with status `open`. */
  handoffs: Handoff[];
  /** Highest agent lease epoch granted so far: a new lease after a handoff is the next one. */
  lease_seq: number;
  /** G4 review mode: E (evidence approver) until B14 sends it to C (codeowner); `null` until known. */
  review_mode: 'E' | 'C' | null;
  /** The lane before a developer took over (E4 takeover): D4 hands back to it, once. */
  takeover: { lane_before: Lane; hand_backs: number } | null;
  /** Gate denials by `gate@step` (X3 "find an alternative, 1x"). */
  denials: Record<string, number>;
  /** Gates denied at a step: the stage is told, and must find another way. */
  denied: Record<string, GateId[]>;
  /** E3/E5 extensions approved on this item. */
  extensions: number;
  /** A human wrote the plan after B5's rejections. */
  human_plan: boolean;
  /** The last output hash of each step (the Handoff Pack's contents). */
  outputs: Record<string, string>;
  assumptions: Assumption[];
  terminal: TerminalState | null;
  terminal_cause: string | null;
  /** The last event types the interpreter did not act on, and why (bounded). */
  ignored: string[];
  created_at: string;
  /** The phases the last event moved the item through, in order (a bridge shows its hops). */
  trail: WorkItemPhase[];
  /** The seq of the last event folded. */
  seq: number;
  /** The instant of the last event folded (the stream's, not a clock). */
  at: string;
}

export type { ItemCreatedPayload };
