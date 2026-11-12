import { z } from 'zod';
import { DataClass, Scope } from '../values.js';
import { ViewLevel } from './access.js';
import { IsoDateTime, PrincipalId, RoleId } from './ids.js';
import { ActionId, PdpResource } from './policy.js';

// The signed-in person's access, as the portal reads it (portal-coverage §6 step 2). The bff builds
// both shapes from the identity read model and the PDP it already decides with; the browser uses
// them only to hide or lock what it shows. Every write is still decided on the server.
//
//   GET  /api/me/access      MyAccessView
//   POST /api/me/decisions   DecisionBatchRequest -> DecisionBatchView

/** One role binding the person reaches, with where it comes from and why it grants nothing, if so. */
export const MyBinding = z.strictObject({
  binding_id: z.string().min(1),
  role_id: RoleId,
  scope: Scope,
  /** The project the scope lies in (`null` for fleet and team scopes). */
  project_id: z.string().min(1).nullable(),
  group_id: z.string().min(1),
  group_display: z.string().min(1),
  /** The membership's source (an IdP group sync, a manual grant, ...). */
  source: z.string().min(1),
  expiry: IsoDateTime.nullable(),
  /** Empty: in force now. Otherwise why this path grants nothing (expired, qualification, ...). */
  blockers: z.array(z.string()),
});
export type MyBinding = z.infer<typeof MyBinding>;

/** What the person may see on one project: the highest view level and data class of the roles in force there. */
export const MyProjectAccess = z.strictObject({
  project_id: z.string().min(1),
  view_level: ViewLevel,
  data_class: DataClass,
  roles: z.array(RoleId),
  /** The catalogue actions the PDP allows on the project itself (a capability probe, not logged). */
  actions: z.array(ActionId),
});
export type MyProjectAccess = z.infer<typeof MyProjectAccess>;

export const MyAccessView = z.strictObject({
  principal: z.strictObject({ principal_id: PrincipalId, display_name: z.string().min(1) }),
  roles_version: z.string().min(1),
  bindings: z.array(MyBinding),
  /** Fleet-scoped roles: they reach every project the person may view. `null` levels: none held. */
  fleet: z.strictObject({
    view_level: ViewLevel.nullable(),
    data_class: DataClass.nullable(),
    roles: z.array(RoleId),
    actions: z.array(ActionId),
  }),
  projects: z.array(MyProjectAccess),
});
export type MyAccessView = z.infer<typeof MyAccessView>;

/** The most `{action, resource}` pairs one batch may ask about. */
export const DECISION_BATCH_MAX = 50;

export const DecisionQuery = z.strictObject({ action: ActionId, resource: PdpResource });
export type DecisionQuery = z.infer<typeof DecisionQuery>;

export const DecisionBatchRequest = z.strictObject({
  queries: z.array(DecisionQuery).min(1).max(DECISION_BATCH_MAX),
});
export type DecisionBatchRequest = z.infer<typeof DecisionBatchRequest>;

/**
 * A deny on a project the person may not view says only this, the same for a project that does not
 * exist: the answer never tells whether a confidential project is there.
 */
export const NOT_VISIBLE_REASON = 'not_visible';

export const DecisionAnswer = z.strictObject({
  action: ActionId,
  resource: PdpResource,
  allow: z.boolean(),
  /** The PDP's reasons: the permitting policy ids on an allow, the deny codes otherwise. */
  reasons: z.array(z.string()),
});
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

export const DecisionBatchView = z.strictObject({ decisions: z.array(DecisionAnswer) });
export type DecisionBatchView = z.infer<typeof DecisionBatchView>;
