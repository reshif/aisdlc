import { z } from 'zod';
import { GateId } from '../flow.js';
import { IsoDateTime, PrincipalId } from './ids.js';
import { PdpResource, type PdpDecision } from './policy.js';

// The factory admin's override (owner decision 2026-11-13, docs/design/portal-v2-intent.md: "nothing applies to the
// factory admin"; docs/specs/deletion.md §8). The factory admin may perform every action on every resource and
// decide every gate and card alone. Recording never blocks it, and nothing is unrecorded: every override is an
// `admin.override` record event and a ledger entry (for a gate decision, the decision entry's `body.override`).

/** The id of the generated Cedar policy that permits the factory admin everything (`@aisdlc/pdp`). */
export const ADMIN_OVERRIDE_POLICY_ID = 'xcut/factory_admin_override';

/** The role the override belongs to. */
export const ADMIN_OVERRIDE_ROLE = 'factory.admin';

/**
 * The rules an override can bypass. Not here, on purpose (physical, not rules): the factory never merges; a gate past
 * its expiry or no longer pending; maintenance mode MM-2; the nonce and evidence-viewed binding; a disabled principal.
 */
export const AdminOverrideRule = z.enum([
  /** The PDP has no other policy that permits the action (only the override does). */
  'pdp_grant',
  /** The decider does not hold the gate's or the step's slot. */
  'slot',
  /** The decider is the requester or the author. */
  'own_request',
  /** The gate needs more approvers than this one approval. */
  'two_person',
  /** The gate could never be decided as configured (nobody holds the slot, T2). */
  'quorum_infeasible',
  /** The policy changed since the gate was opened. */
  'policy_changed',
  /** The decider already approved; this vote decides. */
  'already_voted',
  /** The gate needs a step-up proof. */
  'step_up',
  /** The live bootstrap grant of an onboarding. */
  'bootstrap',
  /** A settings change (M1) needs another approver. */
  'm1_second_approver',
  /** A kill release needs a second person. */
  'kill_two_person',
]);
export type AdminOverrideRule = z.infer<typeof AdminOverrideRule>;

/** A reason is required and never blank. */
export const AdminOverrideReason = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, 'an override needs a reason').max(2000));

/** What a caller sends with an act it does as the factory admin, outside a rule. */
export const AdminOverrideRequest = z.strictObject({ reason: AdminOverrideReason });
export type AdminOverrideRequest = z.infer<typeof AdminOverrideRequest>;

export const ADMIN_OVERRIDE_EVENT = 'admin.override' as const;
/** The ledger entry type of an override that is not itself a gate decision. */
export const ADMIN_OVERRIDE_ENTRY_TYPE = 'admin.override' as const;
export const adminOverrideStream = (overrideId: string): string => `admin_override:${overrideId}`;

/** The body of the `admin.override` record event and ledger entry. */
export const AdminOverrideBody = z.strictObject({
  override_id: z.uuid(),
  actor: PrincipalId,
  action: z.string().min(1),
  resource: PdpResource.nullable(),
  /** The gate instance and gate a decision override decided, or `null`. */
  gate: z.strictObject({ gate_instance_id: z.uuid(), gate_id: GateId }).nullable(),
  reason: z.string().min(1).max(2000),
  bypassed: z.array(AdminOverrideRule),
  /** The ledger entry the override is recorded in when it is a gate decision; `null` when it is its own entry. */
  decision_entry_id: z.uuid().nullable(),
  at: IsoDateTime,
});
export type AdminOverrideBody = z.infer<typeof AdminOverrideBody>;

/** What a gate decision entry carries when the factory admin decided it outside a rule (`body.override`). */
export const DecisionOverride = z.strictObject({
  override_id: z.uuid(),
  reason: z.string().min(1).max(2000),
  bypassed: z.array(AdminOverrideRule),
});
export type DecisionOverride = z.infer<typeof DecisionOverride>;

/** Is this allow the override, that is: did ONLY the factory admin's override policy permit it? */
export const isAdminOverride = (d: Pick<PdpDecision, 'decision' | 'reasons'>): boolean =>
  d.decision === 'allow' &&
  d.reasons.length > 0 &&
  d.reasons.every((r) => r === ADMIN_OVERRIDE_POLICY_ID);
