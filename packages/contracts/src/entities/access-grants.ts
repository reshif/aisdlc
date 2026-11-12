import { z } from 'zod';
import { GateStatus, LedgerDecision } from '../states/gate-instance.js';
import { FLEET_REF, Scope } from '../values.js';
import { ROLE_CATALOGUE, type RoleDef } from './access.js';
import {
  BindingId,
  GateInstanceId,
  GroupId,
  IsoDateTime,
  LedgerEntryId,
  PrincipalId,
  ProjectId,
  RoleId,
  Sha256Hex,
  TeamId,
} from './ids.js';
import { FACTORY_PROJECT_ID } from './config.js';
import { pdpResource, type PdpResource } from './policy.js';

// Granting and revoking role bindings from the portal (portal-review P1-6, portal-config gap 6, portal-coverage §5
// item 6 `access.manage`). A grant or a revoke is a PROPOSAL recorded on `access_grant:<id>` and decided by an M1 gate
// (subject kind `access`): at the project's admin slot for a project scope, at the factory pseudo-project's admin slot
// (`factory.m1_policy`) for the fleet. The proposer, and the person a grant names, never decide it (the gate's
// deciders exclude them, so no single-holder waiver applies either). Only an approved M1 makes core ask identity to
// write the binding (identity scope `grant`, the decision's ledger entry as `m_gate_ref`); core then records
// `access_grant.applied` and an `access.grant_applied` ledger entry. An access request is the same proposal made by
// the person for themselves (`origin: request`).
//
// What is grantable is derived from the role catalogue, never listed: the roles no project slot maps to (a slot role
// at a project is generated from the role map, card 4 / Project settings) and that are not service-only, at the
// fleet or a project.

/** The scope kinds a grant may name: the fleet or one project. */
export const GrantScopeKind = z.enum(['fleet', 'project']);
export type GrantScopeKind = z.infer<typeof GrantScopeKind>;

/** The roles this screen grants: no slot (the role map owns slot roles), not service-only, bindable at fleet or project. */
export const GRANTABLE_ROLES: readonly RoleDef[] = ROLE_CATALOGUE.filter(
  (r) =>
    r.slot === null &&
    !r.service_only &&
    r.scope_kinds.some((k) => (GrantScopeKind.options as readonly string[]).includes(k)),
);
export const isGrantableRole = (role: string, scope: GrantScopeKind): boolean =>
  GRANTABLE_ROLES.some((r) => r.role_id === role && r.scope_kinds.includes(scope));

/** A grant's scope: the fleet or a project. */
export const GrantScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fleet'), ref: z.literal(FLEET_REF) }),
  z.strictObject({ kind: z.literal('project'), ref: ProjectId }),
]);
export type GrantScope = z.infer<typeof GrantScope>;

/** Who a grant is for: one person, or a team (bound through the team's IdP group). */
export const GrantTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('principal'), principal_id: PrincipalId }),
  z.strictObject({ kind: z.literal('team'), team_id: TeamId }),
]);
export type GrantTarget = z.infer<typeof GrantTarget>;

/** What a proposal changes. A revoke names the binding and repeats what it is, so the decider sees it. */
export const AccessChange = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('grant'),
    target: GrantTarget,
    role_id: RoleId,
    scope: GrantScope,
    /** When the binding ends; `null` for no end date. */
    expiry: IsoDateTime.nullable(),
  }),
  z.strictObject({
    op: z.literal('revoke'),
    binding_id: BindingId,
    group_id: GroupId,
    role_id: RoleId,
    scope: Scope,
  }),
]);
export type AccessChange = z.infer<typeof AccessChange>;

/** `admin`: proposed by someone holding `access.manage`; `request`: a person asked for it for themselves. */
export const AccessOrigin = z.enum(['admin', 'request']);
export type AccessOrigin = z.infer<typeof AccessOrigin>;

/** Where a change is decided: the scope's project, or the factory pseudo-project for the fleet. */
export const accessProjectOf = (scope: Scope): ProjectId =>
  scope.kind === 'project' ? ProjectId.parse(scope.ref) : FACTORY_PROJECT_ID;

/** The resource the PDP's `access.manage` is asked on: the project, or the fleet for anything else. */
export const accessResourceOf = (scope: Scope): PdpResource =>
  scope.kind === 'project' ? pdpResource.project(scope.ref) : pdpResource.fleet();

/** The group a principal's grants are bound through (identity creates it on the first grant; only `grant` writes it). */
export const GRANT_GROUP_PREFIX = 'grant.';
export const isGrantGroup = (id: string): boolean => id.startsWith(GRANT_GROUP_PREFIX);
export const grantGroupId = (principal: string): GroupId =>
  GroupId.parse(`${GRANT_GROUP_PREFIX}${principal}`);
/** `Binding.constraints.origin` of a binding written by the decided grant path. */
export const ACCESS_GRANT_ORIGIN = 'access_grant';

// ---------------------------------------------------------------- record

export const accessGrantStream = (id: string): string => `access_grant:${id}`;
export const ACCESS_GRANT_STREAM_PREFIX = 'access_grant:';
export const ACCESS_GRANT_EVENT = {
  proposed: 'access_grant.proposed',
  applied: 'access_grant.applied',
} as const;
/** The ledger entry core writes once identity has written what an approved M1 decided. */
export const ACCESS_GRANT_APPLIED_ENTRY = 'access.grant_applied';

/** `access_grant.proposed`: the change, who proposed it and the M1 gate that decides it. */
export const AccessGrantProposedPayload = z.strictObject({
  grant_id: z.uuid(),
  change: AccessChange,
  origin: AccessOrigin,
  reason: z.string().min(1).max(2000),
  proposed_by: PrincipalId,
  /** The canonical hash of `{change, origin, reason, proposed_by, grant_id}`: the M1 gate's subject hash. */
  subject_hash: Sha256Hex,
  gate_instance_id: GateInstanceId,
  project_id: ProjectId,
  at: IsoDateTime,
});
export type AccessGrantProposedPayload = z.infer<typeof AccessGrantProposedPayload>;

/** `access_grant.applied`: identity wrote it, under the decision named. */
export const AccessGrantAppliedPayload = z.strictObject({
  grant_id: z.uuid(),
  gate_instance_id: GateInstanceId,
  /** The approving decision's ledger entry (identity's `m_gate_ref`). */
  decision_entry_id: LedgerEntryId,
  binding_id: BindingId,
  group_id: GroupId,
  /** False when identity already held exactly that (a retry after a crash). */
  changed: z.boolean(),
  at: IsoDateTime,
});
export type AccessGrantAppliedPayload = z.infer<typeof AccessGrantAppliedPayload>;

// ---------------------------------------------------------------- identity's `grant` scope

/** `POST /v1/grants` on identity (scope `grant`, core only): write the binding an approved M1 decided. */
export const IdentityGrantRequest = z.strictObject({
  grant_id: z.uuid(),
  target: GrantTarget,
  role_id: RoleId,
  scope: GrantScope,
  expiry: IsoDateTime.nullable(),
  m_gate_ref: LedgerEntryId,
  on_behalf_of: PrincipalId,
});
export type IdentityGrantRequest = z.infer<typeof IdentityGrantRequest>;

/** `POST /v1/grants/revoke` on identity (scope `grant`, core only). */
export const IdentityRevokeRequest = z.strictObject({
  grant_id: z.uuid(),
  binding_id: BindingId,
  m_gate_ref: LedgerEntryId,
  reason: z.string().min(1),
  on_behalf_of: PrincipalId,
});
export type IdentityRevokeRequest = z.infer<typeof IdentityRevokeRequest>;

export const IdentityGrantResult = z.strictObject({
  binding_id: BindingId,
  group_id: GroupId,
  changed: z.boolean(),
});
export type IdentityGrantResult = z.infer<typeof IdentityGrantResult>;

// ---------------------------------------------------------------- core's API

/** `POST /v1/access/grants` (scope portal, PDP `access.manage` on the scope). */
export const AccessProposeRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  change: AccessChange,
  reason: z.string().trim().min(1).max(2000),
});
export type AccessProposeRequest = z.infer<typeof AccessProposeRequest>;

/** `POST /v1/access/requests` (scope portal): the person asks for a role for themselves. */
export const AccessRequestCreate = z.strictObject({
  on_behalf_of: PrincipalId,
  role_id: RoleId,
  scope: GrantScope,
  expiry: IsoDateTime.nullable(),
  reason: z.string().trim().min(1).max(2000),
});
export type AccessRequestCreate = z.infer<typeof AccessRequestCreate>;

/** Where a proposal is: from its gate on the ledger, and whether identity has written it. */
export const AccessGrantStatus = z.enum(['pending', 'approved', 'applied', 'rejected', 'ended']);
export type AccessGrantStatus = z.infer<typeof AccessGrantStatus>;

export const AccessGrantView = z.strictObject({
  grant_id: z.uuid(),
  change: AccessChange,
  origin: AccessOrigin,
  reason: z.string(),
  proposed_by: PrincipalId,
  project_id: ProjectId,
  gate_instance_id: GateInstanceId,
  subject_hash: Sha256Hex,
  gate_status: GateStatus,
  outcome: LedgerDecision.nullable(),
  status: AccessGrantStatus,
  /** Who may decide it now: the slot's holders less the proposer and the person granted. */
  deciders: z.array(PrincipalId),
  quorum: z.number().int().min(1),
  proposed_at: IsoDateTime,
  applied: AccessGrantAppliedPayload.nullable(),
});
export type AccessGrantView = z.infer<typeof AccessGrantView>;

export const AccessGrantList = z.strictObject({ grants: z.array(AccessGrantView) });
export type AccessGrantList = z.infer<typeof AccessGrantList>;

export const AccessProposeResult = z.strictObject({
  grant_id: z.uuid(),
  gate_instance_id: GateInstanceId,
  deciders: z.array(PrincipalId),
});
export type AccessProposeResult = z.infer<typeof AccessProposeResult>;

export const AccessDecideResult = z.strictObject({
  outcome: LedgerDecision.nullable(),
  status: AccessGrantStatus,
  applied: z.boolean(),
  apply_error: z.string().nullable(),
});
export type AccessDecideResult = z.infer<typeof AccessDecideResult>;

/** A binding in force or not, as the People screen lists it (from identity's read model). */
export const AccessBindingRow = z.strictObject({
  binding_id: BindingId,
  group_id: GroupId,
  role_id: RoleId,
  scope: Scope,
  expiry: IsoDateTime.nullable(),
  /** `role_map` (change it in Project settings), `access_grant`, or `other` (the seed, identity's own writes). */
  origin: z.enum(['role_map', 'access_grant', 'other']),
  members: z.array(PrincipalId),
});
export type AccessBindingRow = z.infer<typeof AccessBindingRow>;

export const AccessBindingList = z.strictObject({ bindings: z.array(AccessBindingRow) });
export type AccessBindingList = z.infer<typeof AccessBindingList>;
