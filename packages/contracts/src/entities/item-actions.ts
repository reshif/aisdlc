import { z } from 'zod';
import { Lane } from '../values.js';
import { PrincipalId } from './ids.js';
import { ItemView } from './work-lifecycle.js';

// The portal's actions on a work item during planning (PLAN M12.5): the Ready decision (1.6), the answers to
// S1's clarification questions, the observed signals during G3d (B4 "the design reveals a gap in the spec",
// R2 "smaller than the lane") and the human-written plan (B5). Each body names who acts as `on_behalf_of`; the
// bff sets it from the session, so a browser body that names one is refused (the portal's bodies omit it).

/** A retry key: the same key is the same signal. */
const Key = z.string().min(1).max(64);

export const ItemReadyRequest = z.strictObject({ on_behalf_of: PrincipalId });
export type ItemReadyRequest = z.infer<typeof ItemReadyRequest>;

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
