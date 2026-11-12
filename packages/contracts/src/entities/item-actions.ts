import { z } from 'zod';
import { AbandonCause } from '../flow.js';
import { Lane } from '../values.js';
import { IsoDateTime, PrincipalId, ProjectId, WorkItemId } from './ids.js';
import {
  Handoff,
  HandoffChoice,
  HandoffUuid,
  HumanWorkReference,
  ItemView,
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
