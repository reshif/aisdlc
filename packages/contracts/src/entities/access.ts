import { deterministicId, err, hashCanonical, ok, taggedError, type Result } from '@aisdlc/kernel';
import type { TaggedError } from '@aisdlc/kernel';
import { z } from 'zod';
import { DataClass, ScopeKind, scopeKey, type Scope } from '../values.js';
import { GATE_POLICIES, KILL_RELEASE_POLICY } from './gate-lifecycle.js';
import {
  GroupId,
  IsoDateTime,
  JsonObject,
  PrincipalId,
  RecordEventId,
  RoleId,
  type BindingId,
  type ProjectId,
} from './ids.js';
import {
  Binding,
  Group,
  Membership,
  Principal,
  PrincipalKind,
  PrincipalStatus,
  Qualification,
  Team,
} from './identity.js';
import { RoleSlot, RoleSlotValues, type ProjectSettings } from './projects.js';

// Access: the identity journal (record events on principal, group, binding, team and link
// streams), the access ledger entries made from it, the role catalogue and the generation of
// bindings from a project's role map (PLAN M4.1, M4.2, M4.4; DM §3.1, §8 gaps 3 and 10).
// Everything here is vocabulary or a pure function of it; the writer is `services/identity`.

// ---------------------------------------------------------------- IdentityLink

/**
 * What an external identity is: `idp_subject` is the IdP's stable subject (with its issuer), the
 * other two are DM's `github_login` and `email`.
 */
export const IdentityLinkKind = z.enum(['idp_subject', 'github_login', 'email']);
export type IdentityLinkKind = z.infer<typeof IdentityLinkKind>;
export const IdentityLinkKindValues: readonly IdentityLinkKind[] = IdentityLinkKind.options;

/** External IdP subject (or login, or address) <-> principal (DM `IdentityLink`). */
export const IdentityLink = z
  .strictObject({
    principal_id: PrincipalId,
    kind: IdentityLinkKind,
    /** The IdP issuer; required for `idp_subject`, `null` for the other kinds. */
    issuer: z.string().min(1).nullable(),
    value: z.string().min(1),
  })
  .refine((l) => (l.kind === 'idp_subject') === (l.issuer !== null), {
    message: 'issuer is required for idp_subject and absent for the other kinds',
    path: ['issuer'],
  });
export type IdentityLink = z.infer<typeof IdentityLink>;

/** Logins and addresses compare case-insensitively; an IdP subject is opaque and compared exactly. */
export const normalizeLinkValue = (kind: IdentityLinkKind, value: string): string =>
  kind === 'idp_subject' ? value : value.toLowerCase();

/** One external identity has one key, so it can be linked to at most one principal at a time. */
export const identityLinkKey = (l: {
  readonly kind: IdentityLinkKind;
  readonly issuer: string | null;
  readonly value: string;
}): string =>
  hashCanonical({ kind: l.kind, issuer: l.issuer, value: normalizeLinkValue(l.kind, l.value) });

// ---------------------------------------------------------------- Streams and events

export const principalStream = (id: string): string => `principal:${id}`;
export const groupStream = (id: string): string => `group:${id}`;
export const bindingStream = (id: string): string => `binding:${id}`;
export const teamStream = (id: string): string => `team:${id}`;
export const identityLinkStream = (l: Parameters<typeof identityLinkKey>[0]): string =>
  `link:${identityLinkKey(l)}`;

/** Stream prefixes of the identity journal; a projection of it folds exactly these. */
export const IDENTITY_STREAM_PREFIXES = [
  'principal:',
  'group:',
  'binding:',
  'team:',
  'link:',
] as const;

export const IDENTITY_EVENT = {
  principal_created: 'principal.created',
  principal_updated: 'principal.updated',
  principal_status_changed: 'principal.status_changed',
  qualification_granted: 'principal.qualification_granted',
  qualification_revoked: 'principal.qualification_revoked',
  group_created: 'group.created',
  group_updated: 'group.updated',
  member_added: 'group.member_added',
  member_removed: 'group.member_removed',
  binding_created: 'binding.created',
  binding_updated: 'binding.updated',
  binding_revoked: 'binding.revoked',
  team_created: 'team.created',
  team_updated: 'team.updated',
  link_linked: 'identity_link.linked',
  link_unlinked: 'identity_link.unlinked',
} as const;
export const IdentityEventType = z.enum(Object.values(IDENTITY_EVENT) as [string, ...string[]]);
export type IdentityEventType = z.infer<typeof IdentityEventType>;

const hasKey = (o: object): boolean => Object.keys(o).length > 0;

/** `principal.created`: the whole principal (its `status_changed_at` is the creation time). */
export const PrincipalCreatedPayload = Principal;

/** `principal.updated`: the mutable attributes that changed. Status has its own event. */
export const PrincipalUpdatedPayload = z
  .strictObject({
    entra_oid: z.string().min(1).nullable().optional(),
    upn: z.string().min(1).nullable().optional(),
    logins: z.array(z.string().min(1)).optional(),
    machine_actions: z.array(z.string().min(1)).optional(),
    breakglass: z.boolean().optional(),
    display_handle: z.string().min(1).optional(),
    display_name: z.string().min(1).optional(),
    role_label: z.string().min(1).nullable().optional(),
  })
  .refine(hasKey, { message: 'an update changes at least one attribute' });
export type PrincipalUpdatedPayload = z.infer<typeof PrincipalUpdatedPayload>;

export const PrincipalStatusChangedPayload = z.strictObject({
  status: PrincipalStatus,
  reason: z.string().min(1),
});
export type PrincipalStatusChangedPayload = z.infer<typeof PrincipalStatusChangedPayload>;

export const QualificationGrantedPayload = Qualification;
export const QualificationRevokedPayload = z.strictObject({
  qual_type: z.string().min(1),
  reason: z.string().min(1),
});
export type QualificationRevokedPayload = z.infer<typeof QualificationRevokedPayload>;

export const GroupCreatedPayload = Group;
export const GroupUpdatedPayload = z
  .strictObject({
    display: z.string().min(1).optional(),
    pim_managed: z.boolean().optional(),
  })
  .refine(hasKey, { message: 'an update changes at least one attribute' });
export type GroupUpdatedPayload = z.infer<typeof GroupUpdatedPayload>;

export const MemberAddedPayload = Membership;
export const MemberRemovedPayload = z.strictObject({
  principal_id: PrincipalId,
  reason: z.string().min(1),
});
export type MemberRemovedPayload = z.infer<typeof MemberRemovedPayload>;

export const BindingCreatedPayload = Binding;
export const BindingUpdatedPayload = z.strictObject({
  constraints: JsonObject,
  config_rev: z.string().min(1).nullable(),
});
export type BindingUpdatedPayload = z.infer<typeof BindingUpdatedPayload>;
export const BindingRevokedPayload = z.strictObject({ reason: z.string().min(1) });
export type BindingRevokedPayload = z.infer<typeof BindingRevokedPayload>;

export const TeamCreatedPayload = Team;
export const TeamUpdatedPayload = z
  .strictObject({
    name: z.string().min(1).optional(),
    classification: Team.shape.classification.optional(),
    idp_group: GroupId.nullable().optional(),
  })
  .refine(hasKey, { message: 'an update changes at least one attribute' });
export type TeamUpdatedPayload = z.infer<typeof TeamUpdatedPayload>;

export const LinkLinkedPayload = IdentityLink;
export const LinkUnlinkedPayload = z.strictObject({
  principal_id: PrincipalId,
  reason: z.string().min(1),
});
export type LinkUnlinkedPayload = z.infer<typeof LinkUnlinkedPayload>;

// ---------------------------------------------------------------- Access ledger entries

/**
 * The identity events that are access changes, and the ledger `entry_type` each one gets. Every
 * membership and binding change is here; so are a principal's status (disabling ends all access)
 * and qualifications (they gate roles). The writer never writes these entries itself: the
 * access-sync loop in `services/identity` makes one per event, within the SLO below.
 */
export const ACCESS_LEDGERED: Readonly<Record<string, string>> = {
  [IDENTITY_EVENT.member_added]: 'access.membership_added',
  [IDENTITY_EVENT.member_removed]: 'access.membership_removed',
  [IDENTITY_EVENT.binding_created]: 'access.binding_created',
  [IDENTITY_EVENT.binding_updated]: 'access.binding_updated',
  [IDENTITY_EVENT.binding_revoked]: 'access.binding_revoked',
  [IDENTITY_EVENT.principal_status_changed]: 'access.principal_status',
  [IDENTITY_EVENT.qualification_granted]: 'access.qualification_granted',
  [IDENTITY_EVENT.qualification_revoked]: 'access.qualification_revoked',
};
export const ACCESS_EVENT_TYPES: readonly string[] = Object.keys(ACCESS_LEDGERED);
export const ACCESS_ENTRY_TYPES: readonly string[] = Object.values(ACCESS_LEDGERED);

/** An access change must be on the ledger within this long (PLAN M4.1, RV §3.1). */
export const ACCESS_SYNC_SLO_SECONDS = 60;

/** The `body` of an `access.*` ledger entry: which journal event it makes permanent. */
export const AccessLedgerBody = z.strictObject({
  /** The record event this entry stands for; the sync loop is idempotent on it. */
  access_event_id: RecordEventId,
  stream: z.string().min(1),
  stream_seq: z.number().int().min(1),
  global_seq: z.number().int().min(1),
  event_type: z.string().min(1),
  occurred_at: IsoDateTime,
  /** The event payload (access facts only, never a credential). */
  change: JsonObject,
});
export type AccessLedgerBody = z.infer<typeof AccessLedgerBody>;

// ---------------------------------------------------------------- Directory (core read model)

/** What a picker or a name lookup needs of a principal (DM §8 gap 10). */
export const PrincipalSummary = z.strictObject({
  principal_id: PrincipalId,
  display_handle: z.string().min(1),
  display_name: z.string().min(1),
  kind: PrincipalKind,
  status: PrincipalStatus,
});
export type PrincipalSummary = z.infer<typeof PrincipalSummary>;

// ---------------------------------------------------------------- Role catalogue

export const ViewLevel = z.enum(['V1', 'V2', 'V3']);
export type ViewLevel = z.infer<typeof ViewLevel>;

/** DM `Role` (the parts the PDP and the role map need; `relationship_bound` is the PDP's, M4.3). */
export const RoleDef = z.strictObject({
  role_id: RoleId,
  description: z.string().min(1),
  /** The scope kinds a binding of this role may have. */
  scope_kinds: z.array(ScopeKind).min(1),
  /** The project role slot this role is generated for, `null` for a role no slot maps to. */
  slot: RoleSlot.nullable(),
  approval_capable: z.boolean(),
  privileged: z.boolean(),
  service_only: z.boolean(),
  implicit_grant: z.boolean(),
  /** A qualification (`Qualification.qual_type`) the holder must have valid, or `null`. */
  requires_qualification: z.string().min(1).nullable(),
  view_level: ViewLevel,
  data_class_default: DataClass,
});
export type RoleDef = z.infer<typeof RoleDef>;

/** Bump with any change to `ROLE_CATALOGUE`; ledger entries and PDP bundles name it. */
export const ROLES_VERSION = '1.1.0';
/** The `policy_bundle_version` the access ledger entries carry. */
export const ACCESS_POLICY_BUNDLE_VERSION = `roles-${ROLES_VERSION}`;

const slotRole = (
  slot: RoleSlot,
  role: string,
  description: string,
  o: Partial<RoleDef> = {},
): RoleDef =>
  RoleDef.parse({
    role_id: role,
    description,
    scope_kinds: ['project'],
    slot,
    approval_capable: false,
    privileged: false,
    service_only: false,
    implicit_grant: false,
    requires_qualification: null,
    view_level: 'V2',
    data_class_default: 'D1',
    ...o,
  });

/**
 * The role catalogue as data: one role per project role slot (OB §1B, DM §3.2), plus the roles no
 * slot maps to. The PDP (M4.3) generates its policies from this list and nothing else; it lives in
 * the contracts, not in the identity service, because the PDP, the identity service, the explain
 * query and the wizard all read it and it must exist once (PLAN principle 4).
 */
export const ROLE_CATALOGUE: readonly RoleDef[] = [
  slotRole('admin', 'project.admin', 'Project administrator: role map, settings, project gates', {
    approval_capable: true,
    privileged: true,
    view_level: 'V3',
  }),
  slotRole('requesters', 'project.requester', 'May request work; decides G6 acceptance', {
    view_level: 'V2',
  }),
  slotRole('intent', 'project.intent_approver', 'Approves intent and spec (G0, G1, G2)', {
    approval_capable: true,
  }),
  slotRole('design', 'project.design_approver', 'Approves design and plan (G3d, G3, G3s)', {
    approval_capable: true,
  }),
  slotRole('g4', 'project.code_owner', 'Merge review (G4): the code owners on GitHub', {
    approval_capable: true,
  }),
  slotRole('g5', 'project.release_approver', 'Approves release (G5), step-up kept', {
    approval_capable: true,
    privileged: true,
  }),
  slotRole('x', 'project.exception_approver', 'Decides exception gates (X1, X2, E1-E6)', {
    approval_capable: true,
    privileged: true,
  }),
  slotRole('sec', 'project.security_approver', 'Security gates (Q1, SECT)', {
    approval_capable: true,
    privileged: true,
    data_class_default: 'D2',
  }),
  slotRole('m4', 'project.onboarding_signer', 'Signs onboarding (M4), step-up required', {
    approval_capable: true,
    privileged: true,
  }),
  slotRole('kill', 'project.kill_holder', 'Requests a project or lane kill; releases it', {
    scope_kinds: ['project', 'lane'],
    privileged: true,
  }),
  RoleDef.parse({
    role_id: 'project.viewer',
    description: 'Read access to a project',
    scope_kinds: ['project'],
    slot: null,
    approval_capable: false,
    privileged: false,
    service_only: false,
    implicit_grant: false,
    requires_qualification: null,
    view_level: 'V1',
    data_class_default: 'D0',
  }),
  RoleDef.parse({
    role_id: 'factory.admin',
    description:
      'Factory administrator: every administrative action (onboard, settings, kill, config, audit, access explain, floor) and the fleet kill (DEC-29); no gate or card decision unless it holds the slot through a project role map',
    scope_kinds: ['fleet'],
    slot: null,
    approval_capable: true,
    privileged: true,
    service_only: false,
    implicit_grant: false,
    requires_qualification: null,
    view_level: 'V3',
    data_class_default: 'D2',
  }),
  // M9.0 (user decision): who may start an onboarding is a grant, not a property of being an admin.
  // At team scope the role reaches only onboarding requests that name that team (`Team` resource);
  // team-to-project containment is not assumed, so only a fleet binding sees projects (V1 reads).
  RoleDef.parse({
    role_id: 'factory.onboarder',
    description: 'May request an onboarding (project.onboard); decides no gate and no card',
    scope_kinds: ['fleet', 'team'],
    slot: null,
    approval_capable: false,
    privileged: false,
    service_only: false,
    implicit_grant: false,
    requires_qualification: null,
    view_level: 'V1',
    data_class_default: 'D1',
  }),
  RoleDef.parse({
    role_id: 'factory.auditor',
    description: 'Reads the whole factory record; decides nothing',
    scope_kinds: ['fleet'],
    slot: null,
    approval_capable: false,
    privileged: false,
    service_only: false,
    implicit_grant: false,
    requires_qualification: null,
    view_level: 'V3',
    data_class_default: 'D2',
  }),
];

export const ROLE_IDS: readonly RoleId[] = ROLE_CATALOGUE.map((r) => r.role_id);

export function roleDef(
  id: string,
  catalogue: readonly RoleDef[] = ROLE_CATALOGUE,
): RoleDef | null {
  return catalogue.find((r) => r.role_id === id) ?? null;
}

/** The role generated for a slot. The catalogue lists exactly one per slot (a test holds it). */
export function roleForSlot(
  slot: RoleSlot,
  catalogue: readonly RoleDef[] = ROLE_CATALOGUE,
): RoleId {
  const r = catalogue.find((d) => d.slot === slot);
  if (!r) throw new Error(`role catalogue has no role for slot ${slot}`);
  return r.role_id;
}

/** The slot a role is generated for, or `null`. */
export const slotOfRole = (
  role: string,
  catalogue: readonly RoleDef[] = ROLE_CATALOGUE,
): RoleSlot | null => roleDef(role, catalogue)?.slot ?? null;

/**
 * The slots some two-person rule applies to (DEC-28), derived from the gate policies and the kill
 * release rather than listed again.
 */
export const TWO_PERSON_SLOTS: readonly RoleSlot[] = RoleSlotValues.filter(
  (s) =>
    Object.values(GATE_POLICIES).some((p) => p.two_person === 'project' && p.slot === s) ||
    (KILL_RELEASE_POLICY.two_person === 'project' && KILL_RELEASE_POLICY.slot === s),
);

// ---------------------------------------------------------------- Scope coverage

/**
 * Does a binding at `held` grant access at `target`? `fleet` covers every scope; an equal scope
 * covers itself; a `project` covers what lives under it, whose ref is `<project>/<rest>` (lanes,
 * repos, items). Team and org containment need the project -> team mapping of M7 and are not
 * assumed: an unknown relation is no coverage (fail closed).
 */
export function scopeCovers(held: Scope, target: Scope): boolean {
  if (held.kind === 'fleet') return true;
  if (held.kind === target.kind && held.ref === target.ref) return true;
  return (
    held.kind === 'project' && target.kind !== 'fleet' && target.ref.startsWith(`${held.ref}/`)
  );
}

// ---------------------------------------------------------------- Role map -> bindings (M4.4)

/** Generated groups and bindings are marked with this origin (`Binding.constraints.origin`). */
export const ROLE_MAP_ORIGIN = 'role_map';
export const ROLE_MAP_GROUP_PREFIX = 'rm.';
export const isRoleMapGroup = (id: string): boolean => id.startsWith(ROLE_MAP_GROUP_PREFIX);

/** The group of a project's slot: `rm.<project>.<slot>`. */
export const roleMapGroupId = (project: ProjectId, slot: RoleSlot): GroupId =>
  GroupId.parse(`${ROLE_MAP_GROUP_PREFIX}${project}.${slot}`);

/** The group of the g4 slot of any project (`rm.<project>.g4`): the one generated group whose members come from CODEOWNERS. */
export const isCodeownersGroup = (id: string): boolean =>
  isRoleMapGroup(id) && id.endsWith('.g4') && id.length > `${ROLE_MAP_GROUP_PREFIX}.g4`.length;

/** The stable id of a binding; the same (group, role, scope) is always the same binding. */
export const bindingIdFor = (group: string, role: string, scope: Scope): BindingId =>
  deterministicId<'Binding'>(`aisdlc.binding:${group}|${role}|${scopeKey(scope)}`) as BindingId;

/** A binding a role map implies, with the generated group and the members it should have. */
export interface BindingSpec {
  readonly binding_id: BindingId;
  readonly group_id: GroupId;
  readonly group_display: string;
  readonly role_id: RoleId;
  readonly scope: Scope;
  readonly slot: RoleSlot;
  /** The principals the group should hold; `null` = membership is not generated (g4 code owners). */
  readonly members: readonly PrincipalId[] | null;
  /** `origin`, `project_id`, `slot`, `delegated`, and `two_person` for slots a two-person rule covers. */
  readonly constraints: JsonObject;
}

export const RoleMapError = taggedError('RoleMapError');
export type RoleMapError = TaggedError<'RoleMapError', { violations: string[] }>;

const sha8 = (s: string): string => hashCanonical(s).slice(0, 8);

/**
 * The bindings a project's settings imply: one per slot (role, `project:<id>`, generated group
 * `rm.<project>.<slot>` holding the slot's principals), the kill slot's group also holding the
 * delegates of an active project-scope delegation, and one more binding per lane a delegation
 * covers. `two_person` is stamped on the bindings of the slots a two-person rule covers. A
 * delegation whose scope is not this project or a lane under it is refused, never narrowed.
 * Pure and deterministic: the same settings give the same specs in the same order.
 */
export function impliedBindings(
  settings: ProjectSettings,
  catalogue: readonly RoleDef[] = ROLE_CATALOGUE,
): Result<BindingSpec[], RoleMapError> {
  const project = settings.project_id;
  const projectScope: Scope = { kind: 'project', ref: project };
  const violations: string[] = [];
  const twoPerson = settings.two_person.enabled;
  const stamp = (slot: RoleSlot, delegated: boolean): JsonObject => ({
    origin: ROLE_MAP_ORIGIN,
    project_id: project,
    slot,
    delegated,
    ...(TWO_PERSON_SLOTS.includes(slot) ? { two_person: twoPerson } : {}),
  });

  const active = settings.kill_delegations.filter((d) => d.revoked_at === null);
  const projectDelegates: PrincipalId[] = [];
  const laneDelegates = new Map<string, { scope: Scope; members: PrincipalId[] }>();
  for (const d of active) {
    if (d.scope.kind === 'project') {
      if (d.scope.ref !== project) {
        violations.push(`kill delegation to ${d.delegate} is scoped to project ${d.scope.ref}`);
      } else projectDelegates.push(d.delegate);
    } else if (!d.scope.ref.startsWith(`${project}/`)) {
      violations.push(`kill delegation to ${d.delegate} is scoped to ${scopeKey(d.scope)}`);
    } else {
      const k = scopeKey(d.scope);
      const cur = laneDelegates.get(k) ?? { scope: d.scope, members: [] };
      cur.members.push(d.delegate);
      laneDelegates.set(k, cur);
    }
  }
  if (violations.length > 0) return err(RoleMapError({ violations }));

  const uniq = (xs: readonly PrincipalId[]): PrincipalId[] => [...new Set(xs)].sort();
  const specs: BindingSpec[] = [];
  for (const slot of RoleSlotValues) {
    const value = settings.role_map[slot];
    const role = roleForSlot(slot, catalogue);
    const group = roleMapGroupId(project, slot);
    const base = value.kind === 'principals' ? value.principals : null;
    const members =
      base === null ? null : uniq(slot === 'kill' ? [...base, ...projectDelegates] : base);
    specs.push({
      binding_id: bindingIdFor(group, role, projectScope),
      group_id: group,
      group_display: `${project}: ${slot}`,
      role_id: role,
      scope: projectScope,
      slot,
      members,
      constraints: stamp(slot, false),
    });
  }
  const killRole = roleForSlot('kill', catalogue);
  for (const [key, l] of [...laneDelegates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const group = GroupId.parse(
      `${ROLE_MAP_GROUP_PREFIX}${project}.kill.${l.scope.kind}-${sha8(key)}`,
    );
    specs.push({
      binding_id: bindingIdFor(group, killRole, l.scope),
      group_id: group,
      group_display: `${project}: kill (${key})`,
      role_id: killRole,
      scope: l.scope,
      slot: 'kill',
      members: uniq(l.members),
      constraints: stamp('kill', true),
    });
  }
  return ok(specs);
}
