import { z } from 'zod';
import { Scope } from '../values.js';
import {
  BindingId,
  GroupId,
  IsoDateTime,
  JsonObject,
  LedgerEntryId,
  PrincipalId,
  RoleId,
  TeamId,
} from './ids.js';

// Identity and Access (DM §3.1). Access is group based: a principal holds roles only through group
// membership plus a binding of that group to a role at a scope.

/** DM §3.1: `active disabled deleted`. No state machine in DM §6, so no transition table. */
export const PrincipalStatus = z.enum(['active', 'disabled', 'deleted']);
export type PrincipalStatus = z.infer<typeof PrincipalStatus>;
export const PrincipalStatusValues: readonly PrincipalStatus[] = PrincipalStatus.options;

export const PrincipalKind = z.enum(['human', 'service']);
export type PrincipalKind = z.infer<typeof PrincipalKind>;
export const PrincipalKindValues: readonly PrincipalKind[] = PrincipalKind.options;

export const Principal = z
  .strictObject({
    principal_id: PrincipalId,
    kind: PrincipalKind,
    status: PrincipalStatus,
    /** Unique when set. Services have none. */
    entra_oid: z.string().min(1).nullable(),
    upn: z.string().min(1).nullable(),
    /** GitHub logins. */
    logins: z.array(z.string().min(1)),
    /** Services only: the machine actions the service may take. */
    machine_actions: z.array(z.string().min(1)),
    breakglass: z.boolean(),
    display_handle: z.string().min(1),
    display_name: z.string().min(1),
    /** A label, never an entitlement. */
    role_label: z.string().min(1).nullable(),
    status_changed_at: IsoDateTime,
  })
  .refine((p) => p.kind === 'service' || p.machine_actions.length === 0, {
    message: 'machine_actions are for services only',
    path: ['machine_actions'],
  })
  .refine((p) => p.kind === 'human' || p.entra_oid === null, {
    message: 'a service has no entra_oid',
    path: ['entra_oid'],
  });
export type Principal = z.infer<typeof Principal>;

export const Group = z.strictObject({
  group_id: GroupId,
  display: z.string().min(1),
  pim_managed: z.boolean(),
  protected: z.boolean(),
});
export type Group = z.infer<typeof Group>;

export const MembershipVia = z.enum(['direct', 'pim_activation']);
export type MembershipVia = z.infer<typeof MembershipVia>;
/**
 * `role_map`: generated from a project's role map (PLAN M4.4); only the reconcile writes it.
 * `codeowners`: the members of a project's g4 group when its slot is `codeowners` (PLAN M5.2); only
 * the "set code owner members" command writes it.
 */
export const MembershipSource = z.enum(['sync', 'oidc_token_dev', 'role_map', 'codeowners']);
export type MembershipSource = z.infer<typeof MembershipSource>;

export const Membership = z
  .strictObject({
    group_id: GroupId,
    principal_id: PrincipalId,
    active_from: IsoDateTime,
    active_until: IsoDateTime.nullable(),
    via: MembershipVia,
    source: MembershipSource,
  })
  .refine(
    (m) => m.active_until === null || Date.parse(m.active_until) > Date.parse(m.active_from),
    {
      message: 'active_until must be after active_from',
      path: ['active_until'],
    },
  );
export type Membership = z.infer<typeof Membership>;

/** `(group, role, Scope)`. The scope is the one `Scope{kind, ref}` value type. */
export const Binding = z.strictObject({
  binding_id: BindingId,
  group_id: GroupId,
  role_id: RoleId,
  scope: Scope,
  constraints: JsonObject,
  expiry: IsoDateTime.nullable(),
  /** The ledger entry of the M3 or M6 decision that made this binding. */
  m_gate_ref: LedgerEntryId.nullable(),
  config_rev: z.string().min(1).nullable(),
});
export type Binding = z.infer<typeof Binding>;

export const Qualification = z
  .strictObject({
    principal_id: PrincipalId,
    qual_type: z.string().min(1),
    valid_from: IsoDateTime,
    valid_until: IsoDateTime.nullable(),
    source: z.string().min(1),
    evidence_ref: z.string().min(1).nullable(),
  })
  .refine((q) => q.valid_until === null || Date.parse(q.valid_until) > Date.parse(q.valid_from), {
    message: 'valid_until must be after valid_from',
    path: ['valid_until'],
  });
export type Qualification = z.infer<typeof Qualification>;

export const SodRuleKind = z.enum(['static_pair', 'toxic_pair']);
export type SodRuleKind = z.infer<typeof SodRuleKind>;

export const SodRule = z
  .strictObject({
    rule_id: z.string().min(1),
    kind: SodRuleKind,
    role_a: RoleId,
    role_b: RoleId,
  })
  .refine((r) => r.role_a !== r.role_b, {
    message: 'a rule pairs two different roles',
    path: ['role_b'],
  });
export type SodRule = z.infer<typeof SodRule>;

/** DM §3.1 (Team is PROPOSED there) and ProjectMeta §3.2: `internal` or `confidential`. */
export const Classification = z.enum(['internal', 'confidential']);
export type Classification = z.infer<typeof Classification>;
export const ClassificationValues: readonly Classification[] = Classification.options;

/**
 * A Team is owned by the factory (PLAN §7, defaulted at M4: DM §9 Q1). `idp_group` optionally maps
 * it to a group the identity provider syncs; `null` is a team with no mapping.
 */
export const Team = z.strictObject({
  team_id: TeamId,
  name: z.string().min(1),
  classification: Classification,
  idp_group: GroupId.nullable(),
});
export type Team = z.infer<typeof Team>;
