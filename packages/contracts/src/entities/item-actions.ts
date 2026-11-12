import { z } from 'zod';
import { AbandonCause, GateId } from '../flow.js';
import { Lane, Level } from '../values.js';
import { LaneEligibility } from './core-events.js';
import { IsoDateTime, PrincipalId, ProjectId, WorkItemId, WorkRequestId } from './ids.js';
import { RoleSlot } from './projects.js';
import {
  Handoff,
  HandoffChoice,
  HandoffUuid,
  HumanWorkReference,
  InjectionReport,
  ItemView,
  SubmitRequestBody,
  TaintedText,
} from './work-lifecycle.js';

// The portal's actions on a work item during planning (PLAN M12.5): the Ready decision (1.6), the answers to
// S1's clarification questions, the observed signals during G3d (B4 "the design reveals a gap in the spec",
// R2 "smaller than the lane") and the human-written plan (B5). Each body names who acts as `on_behalf_of`; the
// bff sets it from the session, so a browser body that names one is refused (the portal's bodies omit it).

/** A retry key: the same key is the same signal. */
const Key = z.string().min(1).max(64);

export const ItemReadyRequest = z.strictObject({ on_behalf_of: PrincipalId });
export type ItemReadyRequest = z.infer<typeof ItemReadyRequest>;

/** M15.3: RELHOLD's re-request after the fix window (`key`: the caller's idempotency key). */
export const ItemReleaseRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  key: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
});
export type ItemReleaseRequest = z.infer<typeof ItemReleaseRequest>;

export const ItemAnswerRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  question_id: z.string().min(1).max(128),
  text: z.string().min(1).max(20_000),
});
export type ItemAnswerRequest = z.infer<typeof ItemAnswerRequest>;

/** The reason codes the portal offers for an observed signal (a code, never free text: it enters the record). */
export const ObservedReason = z.enum(['spec_gap', 'spec_ambiguous', 'smaller_than_lane']);
export type ObservedReason = z.infer<typeof ObservedReason>;

export const ItemObserveRequest = z.discriminatedUnion('edge', [
  z.strictObject({
    edge: z.literal('B4'),
    on_behalf_of: PrincipalId,
    reason_code: ObservedReason,
    key: Key,
  }),
  z.strictObject({
    edge: z.literal('R2'),
    on_behalf_of: PrincipalId,
    to_lane: Lane,
    reason_code: ObservedReason,
    key: Key,
  }),
]);
export type ItemObserveRequest = z.infer<typeof ItemObserveRequest>;

/**
 * B5: the four parts of a plan in the planner's own shapes (the schema, the DAG, the sequence, the tasks and
 * the oracle binding are checked by the same code as the agent's plan), and the capacity input if the person
 * has one. The human never pushes code: this writes the plan, and G3 decides it.
 */
const Part = z.record(z.string(), z.unknown());
export const ItemPlanRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  split: Part,
  sequence: Part,
  tasks: Part,
  verification: Part,
  capacity: Part.optional(),
  key: Key,
});
export type ItemPlanRequest = z.infer<typeof ItemPlanRequest>;

/**
 * D5 (M14.6): the developer says the human-led work of an L8 item is done; the item goes on to 7.1. `key` is the
 * retry key of this one signal (a second round of human-led work, after SECT confirmed, is a new key).
 */
export const ItemHumanDoneRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  key: Key,
  /** The pull request or commit that holds the work (P1-4): recorded with the signal, as data. */
  reference: HumanWorkReference.optional(),
});
export type ItemHumanDoneRequest = z.infer<typeof ItemHumanDoneRequest>;

/**
 * D4: the developer who took the item over hands it back, once. `plan_changed` sends it through G3 again; otherwise
 * it resumes at the lane's D4 re-entry (6.4) in a new envelope.
 */
export const ItemHandBackRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  plan_changed: z.boolean(),
  key: Key,
});
export type ItemHandBackRequest = z.infer<typeof ItemHandBackRequest>;

/**
 * E4: the owner of record's choice, once E4 itself is decided approve in the ledger by the same person. `extend`
 * names the percent (at most the catalogue's limit); `abandon` may name a cause code.
 */
export const ItemHandoffChooseRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  handoff_id: HandoffUuid,
  choice: HandoffChoice,
  extension_percent: z.number().positive().max(1000).optional(),
  cause: AbandonCause.optional(),
});
export type ItemHandoffChooseRequest = z.infer<typeof ItemHandoffChooseRequest>;

/**
 * An item's handoff as the owner of record and the developer see it (P1-4): the handoff (the open one, else the
 * newest), its E4 gate with the card that decides it, the choices the flow allows now, and, while a developer has the
 * work (L8), how many hand-backs (D4) are left and the D5 signals so far. Core: `GET /v1/items/:id/handoff`.
 */
export const ItemHandoffView = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  lane: Lane.nullable(),
  phase: z.string().min(1),
  waiting: z.string().nullable(),
  handoff: Handoff.nullable(),
  e4: z
    .strictObject({
      gate_instance_id: z.string().min(1),
      card_id: z.string().min(1).nullable(),
      status: z.enum(['pending', 'decided']),
      outcome: z.string().nullable(),
      /** Who approved it in the ledger: only they may record the choice. */
      approvers: z.array(PrincipalId),
    })
    .nullable(),
  /** The choices the flow allows now (empty until E4 is approved, and once one is chosen). */
  choices: z.array(HandoffChoice),
  /** `extend`: the most one extension may add, in percent (the pinned catalogue's; `null`: none allowed). */
  extension_max_percent: z.number().positive().nullable(),
  /** A developer has the work (L8): `null` otherwise. */
  human_led: z
    .strictObject({
      /** The item came to L8 by an E4 takeover (only then is there a lane to hand back to). */
      taken_over: z.boolean(),
      lane_before: Lane.nullable(),
      hand_backs_left: z.number().int().min(0),
    })
    .nullable(),
  /** The D5 signals recorded on the item, newest first. */
  done: z.array(
    z.strictObject({
      by: PrincipalId,
      at: IsoDateTime,
      reference: HumanWorkReference.nullable(),
    }),
  ),
});
export type ItemHandoffView = z.infer<typeof ItemHandoffView>;

/** The handoff view with what the signed-in person may do now (the PDP's yes AND where the item is). */
export const PortalItemHandoffView = ItemHandoffView.extend({
  may: z.strictObject({
    decide_e4: z.boolean(),
    choose: z.boolean(),
    hand_back: z.boolean(),
    human_done: z.boolean(),
  }),
});
export type PortalItemHandoffView = z.infer<typeof PortalItemHandoffView>;

/** What an action answers: the item as it stands, and whether the same signal had been recorded already. */
export const ItemActionResult = z.strictObject({
  item: ItemView,
  duplicate: z.boolean(),
});
export type ItemActionResult = z.infer<typeof ItemActionResult>;

export const ItemPlanResult = z.strictObject({
  item: ItemView,
  units: z.number().int().min(1),
  base_sha: z.string(),
  outputs: z.record(z.string(), z.string()),
});
export type ItemPlanResult = z.infer<typeof ItemPlanResult>;

/**
 * An item as the portal shows it: the view and what the signed-in person may do with it now (the PDP's yes,
 * for the item, together with where the item waits). A button is shown only when its flag is true.
 */
export const PortalItemView = ItemView.extend({
  may: z.strictObject({
    ready: z.boolean(),
    answer: z.boolean(),
    observe: z.boolean(),
    plan: z.boolean(),
  }),
});
export type PortalItemView = z.infer<typeof PortalItemView>;

// ---------------------------------------------------------------- the request receipt (portal Ask, P1-1)

/**
 * Where a request stands once intake ran (1.1 to 1.4): `requested` (recorded, nothing decided yet), `held` (N8: no
 * readiness record lets the lane run), `admitted` (the asked lane runs), `routed_l8` (the repo's level routes it to
 * L8, human-led), `released` and `l8_offered` (an N8 hold released into the lane, or offered as L8).
 */
export const WorkIntakeState = z.enum([
  'requested',
  'held',
  'admitted',
  'routed_l8',
  'released',
  'l8_offered',
]);
export type WorkIntakeState = z.infer<typeof WorkIntakeState>;

/**
 * The lane a portal request with no lane hint proposes: L2 (remediation, the small agent lane). It is only a
 * proposal: 1.4 checks it against the repo's level, 1.3 classifies the request and the catalogue derives the
 * lane, and G0 binds it.
 */
export const ASK_LANE_WITHOUT_HINT: Lane = 'L2';

/**
 * Portal Ask (`POST /api/requests`): what the browser sends. The channel is the portal's (N1) and `on_behalf_of` the
 * session's, neither is a field; the lane is an optional hint (`ASK_LANE_WITHOUT_HINT` without one).
 */
export const PortalAskRequest = SubmitRequestBody.omit({
  on_behalf_of: true,
  channel: true,
}).extend({
  lane: Lane.optional(),
});
export type PortalAskRequest = z.infer<typeof PortalAskRequest>;

/** Who decides one of the first gates (G0, G1) of the item: the slot and its holders now. */
export const RequestGateDeciders = z.strictObject({
  gate: GateId,
  slot: RoleSlot,
  /** `null`: who holds the slot could not be read (unknown, never "anyone"). Empty: nobody holds it yet. */
  holders: z.array(PrincipalId).nullable(),
  /** Why `holders` is `null`. */
  reason: z.string().nullable(),
});
export type RequestGateDeciders = z.infer<typeof RequestGateDeciders>;

/**
 * `POST /v1/requests`' answer: what intake did with the request. The text as the factory keeps it (normalised,
 * taint-marked with its provenance and the injection flags) is echoed to the person who sent it; it stays DATA.
 */
export const SubmitRequestReceipt = z.strictObject({
  request_id: WorkRequestId,
  /** `null` while the request is held (N8): no item exists yet. */
  item_id: WorkItemId.nullable(),
  state: WorkIntakeState,
  /** 1.4's verdict for the asked lane: eligible or not, the route and the reason, the readiness record it read. */
  verdict: LaneEligibility,
  /** The same request (its retry key) was made before: this is that request. */
  duplicate: z.boolean(),
  /** 1.2: earlier items with the same normalised text on the repo. */
  dedupe_links: z.array(WorkItemId),
  /** B27: the injection scan (the G0 card carries it). */
  injection: InjectionReport,
  /** The lane the requester asked for. */
  asked_lane: Lane,
  /** The lane the item runs as until 1.3 classifies it and G0 binds it (L8 when the verdict routes it there). */
  proposed_lane: Lane,
  /** The lowest level whose catalogue row opens the asked lane (`null`: none does); tier and floor rules can add to it. */
  lane_opens_at: Level.nullable(),
  /** 1.1: the text as kept (normalised), its taint mark, provenance and flags. */
  request_text: TaintedText,
  /** Who decides G0 and G1 on the project, once the item reaches them (empty while no item exists). */
  deciders: z.array(RequestGateDeciders),
});
export type SubmitRequestReceipt = z.infer<typeof SubmitRequestReceipt>;

/** The bff's receipt: core's, with the display name of each decider. */
export const PortalRequestReceipt = SubmitRequestReceipt.extend({
  principal_names: z.record(z.string(), z.string()),
});
export type PortalRequestReceipt = z.infer<typeof PortalRequestReceipt>;
