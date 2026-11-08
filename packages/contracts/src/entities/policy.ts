import { hashCanonical } from '@aisdlc/kernel';
import { z } from 'zod';
import { GATES, GateId } from '../flow.js';
import { FLEET_REF, type Scope } from '../values.js';
import { ViewLevel, type RoleDef } from './access.js';
import { GATE_POLICIES } from './gate-lifecycle.js';
import { IsoDateTime, PrincipalId, RoleId, Sha256Hex } from './ids.js';
import { RoleSlot } from './projects.js';

// Policy (PLAN M4.3, DM §3.1 `PolicyAction`, `PdpDecision`; DM §7: every action on the floor is a
// button that calls a route, and the PDP decides). One action catalogue, the resources an action
// applies to, the rule that says which roles hold it, the policy bundle that carries the generated
// Cedar policies, and the decision shape. The generator and the evaluator are `@aisdlc/pdp`.

// ---------------------------------------------------------------- Resources

/** The Cedar entity types a request's resource can have; `Fleet` is the whole factory. */
export const PdpResourceType = z.enum(['Fleet', 'Project', 'Lane', 'Repo', 'Item', 'Gate', 'Card']);
export type PdpResourceType = z.infer<typeof PdpResourceType>;
export const PdpResourceTypeValues: readonly PdpResourceType[] = PdpResourceType.options;

/**
 * What an action is asked about. `project` is the project it lives under (`null` for the fleet and
 * for a project itself, whose `id` is the project). `lane` and `item` are the containers on the way
 * up; `gate_id` is the gate of a `Gate` resource, from which the policies read the deciding slot.
 */
export const PdpResource = z
  .strictObject({
    type: PdpResourceType,
    id: z.string().min(1),
    project: z.string().min(1).nullable(),
    lane: z.string().min(1).nullable(),
    item: z.string().min(1).nullable(),
    gate_id: GateId.nullable(),
  })
  .superRefine((r, ctx) => {
    const bad = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (r.type === 'Fleet' || r.type === 'Project') {
      if (r.type === 'Fleet' && r.id !== FLEET_REF) bad('id', `the fleet's id is ${FLEET_REF}`);
      if (r.project !== null) bad('project', `${r.type} has no parent project`);
    } else if (r.project === null) bad('project', `${r.type} needs its project`);
    if (r.type === 'Gate' && r.gate_id === null) bad('gate_id', 'a Gate resource needs gate_id');
    if (r.type !== 'Gate' && r.gate_id !== null) bad('gate_id', 'only a Gate has gate_id');
  });
export type PdpResource = z.infer<typeof PdpResource>;

const res = (
  type: PdpResourceType,
  id: string,
  o: Partial<Omit<PdpResource, 'type' | 'id'>> = {},
): PdpResource => ({ type, id, project: null, lane: null, item: null, gate_id: null, ...o });

/** Constructors, so a caller never spells the shape out. */
export const pdpResource = {
  fleet: (): PdpResource => res('Fleet', FLEET_REF),
  project: (project: string): PdpResource => res('Project', project),
  lane: (project: string, lane: string): PdpResource =>
    res('Lane', `${project}/${lane}`, { project, lane }),
  repo: (project: string, repo: string): PdpResource =>
    res('Repo', `${project}/${repo}`, { project }),
  item: (project: string, item: string, lane: string | null = null): PdpResource =>
    res('Item', `${project}/${item}`, { project, item, lane }),
  gate: (
    project: string,
    gateInstanceId: string,
    gate: GateId,
    o: { item?: string | null; lane?: string | null } = {},
  ): PdpResource =>
    res('Gate', gateInstanceId, {
      project,
      gate_id: gate,
      item: o.item ?? null,
      lane: o.lane ?? null,
    }),
  card: (project: string, cardId: string): PdpResource => res('Card', cardId, { project }),
};

const laneScope = (project: string, lane: string): Scope => ({
  kind: 'lane',
  ref: `${project}/${lane}`,
});

/**
 * The scopes a resource lives in, innermost first, always ending with the fleet. A binding grants
 * access to the resource when it covers any of them (`scopeCovers`), so a lane-scoped kill holder
 * reaches the items of that lane and a project-scoped role reaches everything under the project.
 */
export function resourceScopes(r: PdpResource): Scope[] {
  const fleet: Scope = { kind: 'fleet', ref: FLEET_REF };
  if (r.type === 'Fleet') return [fleet];
  const project = r.type === 'Project' ? r.id : (r.project as string);
  const out: Scope[] = [];
  if (r.type === 'Repo') out.push({ kind: 'repo', ref: r.id });
  if (r.item !== null || r.type === 'Item') {
    out.push({ kind: 'item', ref: r.type === 'Item' ? r.id : `${project}/${r.item}` });
  }
  if (r.lane !== null) out.push(laneScope(project, r.lane));
  if (r.type === 'Lane') out.push({ kind: 'lane', ref: r.id });
  out.push({ kind: 'project', ref: project }, fleet);
  return out.filter((s, i) => out.findIndex((t) => t.kind === s.kind && t.ref === s.ref) === i);
}

/** `Type::"id"` pairs of a resource's parents in the Cedar hierarchy (Fleet <- Project <- ...). */
export function resourceParents(r: PdpResource): Array<{ type: PdpResourceType; id: string }> {
  if (r.type === 'Fleet') return [];
  if (r.type === 'Project') return [{ type: 'Fleet', id: FLEET_REF }];
  const project = r.project as string;
  const lane = r.lane === null ? null : `${project}/${r.lane}`;
  const item = r.item === null ? null : `${project}/${r.item}`;
  const parents: Array<{ type: PdpResourceType; id: string }> = [{ type: 'Project', id: project }];
  if (r.type === 'Item' && lane !== null) parents.unshift({ type: 'Lane', id: lane });
  if (r.type === 'Gate' || r.type === 'Card') {
    if (item !== null) parents.unshift({ type: 'Item', id: item });
    else if (lane !== null) parents.unshift({ type: 'Lane', id: lane });
  }
  return parents;
}

// ---------------------------------------------------------------- Action catalogue

/** What kind of act an action is; the decision log keys off `log_allow`, not off the class. */
export const ActionClass = z.enum(['read', 'write', 'decide', 'kill', 'config']);
export type ActionClass = z.infer<typeof ActionClass>;

/**
 * Which roles hold an action, as a rule over the role catalogue (never a list of role ids that
 * could drift from it):
 *  - `view_level`: every role whose `view_level` is at least `min`;
 *  - `slots`: the roles generated for these project slots;
 *  - `gate_slot`: a role with a gate-deciding slot, for gates whose policy names that slot;
 *  - `decides_gates`: a role whose slot decides at least one gate;
 *  - `roles`: these roles by id (for the roles no slot maps to).
 */
export const GrantRule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('view_level'), min: ViewLevel }),
  z.strictObject({ kind: z.literal('slots'), slots: z.array(RoleSlot).min(1) }),
  z.strictObject({ kind: z.literal('gate_slot') }),
  z.strictObject({ kind: z.literal('decides_gates') }),
  z.strictObject({ kind: z.literal('roles'), roles: z.array(RoleId).min(1) }),
]);
export type GrantRule = z.infer<typeof GrantRule>;

export const ActionDef = z.strictObject({
  action_id: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/, 'dotted lowercase action id'),
  description: z.string().min(1),
  class: ActionClass,
  resource_types: z.array(PdpResourceType).min(1),
  grants: z.array(GrantRule).min(1),
  /** Log every allow as a `pdp.decision` record event (every deny is always logged). */
  log_allow: z.boolean(),
});
export type ActionDef = z.infer<typeof ActionDef>;

const ADMINS = ['factory.admin'] as const;

/**
 * The action catalogue (DM `PolicyAction`). Names taken from the specs: `project.onboard` (OB §6.1),
 * `item.view_floor` and `floor.read` (DM §7), `kill.release` (DM `PreparedDecision`), the decision
 * of gates and cards (`gate.approve` in DM, `gate.decide` here because a decision is approve,
 * reject or request changes). Added here: `project.view`, `project.settings.edit`, `gate.view`,
 * `card.decide`, `kill.request`, `config.propose`, `audit.read`, `access.explain`.
 */
export const ACTION_CATALOGUE = {
  'project.onboard': {
    action_id: 'project.onboard',
    description: 'Request that a repository is onboarded as a project (S0, DEC-2)',
    class: 'write',
    resource_types: ['Fleet'],
    grants: [{ kind: 'roles', roles: [...ADMINS] }],
    log_allow: true,
  },
  'project.view': {
    action_id: 'project.view',
    description: 'See a project and its settings',
    class: 'read',
    resource_types: ['Project'],
    grants: [{ kind: 'view_level', min: 'V1' }],
    log_allow: false,
  },
  'project.settings.edit': {
    action_id: 'project.settings.edit',
    description: 'Change a project: role map, two-person rule, gating profile, kill delegations',
    class: 'config',
    resource_types: ['Project'],
    grants: [
      { kind: 'slots', slots: ['admin'] },
      { kind: 'roles', roles: [...ADMINS] },
    ],
    log_allow: true,
  },
  'floor.read': {
    action_id: 'floor.read',
    description: 'Open the floor of a project, or the fleet floor',
    class: 'read',
    resource_types: ['Fleet', 'Project'],
    grants: [{ kind: 'view_level', min: 'V1' }],
    log_allow: false,
  },
  'item.view_floor': {
    action_id: 'item.view_floor',
    description: 'See an item on the floor',
    class: 'read',
    resource_types: ['Item'],
    grants: [{ kind: 'view_level', min: 'V1' }],
    log_allow: false,
  },
  'gate.view': {
    action_id: 'gate.view',
    description: 'See a gate instance and its evidence',
    class: 'read',
    resource_types: ['Gate'],
    grants: [{ kind: 'view_level', min: 'V1' }],
    log_allow: false,
  },
  'gate.decide': {
    action_id: 'gate.decide',
    description: 'Decide a gate (approve, reject, request changes); only the gate policy slot',
    class: 'decide',
    resource_types: ['Gate'],
    grants: [{ kind: 'gate_slot' }],
    log_allow: true,
  },
  'card.decide': {
    action_id: 'card.decide',
    description: 'Decide an inbox card (a decision on each gate the card carries)',
    class: 'decide',
    resource_types: ['Card'],
    grants: [{ kind: 'decides_gates' }],
    log_allow: true,
  },
  'kill.request': {
    action_id: 'kill.request',
    description:
      'Request a kill of a project or lane; the fleet kill is factory.admin only (DEC-29)',
    class: 'kill',
    resource_types: ['Fleet', 'Project', 'Lane'],
    grants: [
      { kind: 'slots', slots: ['kill', 'admin'] },
      { kind: 'roles', roles: [...ADMINS] },
    ],
    log_allow: true,
  },
  'kill.release': {
    action_id: 'kill.release',
    description: "Release a kill (the two-person rule is the decision kernel's)",
    class: 'kill',
    resource_types: ['Fleet', 'Project', 'Lane'],
    grants: [
      { kind: 'slots', slots: ['kill', 'admin'] },
      { kind: 'roles', roles: [...ADMINS] },
    ],
    log_allow: true,
  },
  'config.propose': {
    action_id: 'config.propose',
    description: 'Propose a configuration revision (publishing needs an M1 gate)',
    class: 'config',
    resource_types: ['Fleet', 'Project'],
    grants: [
      { kind: 'slots', slots: ['admin'] },
      { kind: 'roles', roles: [...ADMINS] },
    ],
    log_allow: true,
  },
  'audit.read': {
    action_id: 'audit.read',
    description: 'Read the audit views of a project or of the whole factory',
    class: 'read',
    resource_types: ['Fleet', 'Project'],
    grants: [{ kind: 'view_level', min: 'V3' }],
    log_allow: false,
  },
  'access.explain': {
    action_id: 'access.explain',
    description: 'Ask who can decide what on a project (effective access)',
    class: 'read',
    resource_types: ['Fleet', 'Project'],
    grants: [{ kind: 'view_level', min: 'V3' }],
    log_allow: false,
  },
} as const satisfies Record<string, z.input<typeof ActionDef>>;

export type ActionId = keyof typeof ACTION_CATALOGUE;
export const ACTION_IDS = Object.keys(ACTION_CATALOGUE) as ActionId[];
export const ActionId = z.enum(ACTION_IDS as [ActionId, ...ActionId[]]);

export const actionDef = (id: ActionId): ActionDef => ACTION_CATALOGUE[id] as unknown as ActionDef;

/** Actions whose allow is always logged (decide, kill, config and the onboarding request). */
export const LOGGED_ALLOW_ACTIONS: readonly ActionId[] = ACTION_IDS.filter(
  (a) => actionDef(a).log_allow,
);

/** Bump with any change to the actions, their grants, the entity model or the cross-cutting rules. */
export const PDP_POLICY_VERSION = '1.0.0';

const VIEW_RANK: Readonly<Record<ViewLevel, number>> = { V1: 1, V2: 2, V3: 3 };

/** The slots whose role decides some gate (derived from the gate policies, not listed again). */
export const GATE_DECIDING_SLOTS: readonly RoleSlot[] = [
  ...new Set(Object.values(GATE_POLICIES).map((p) => p.slot)),
].sort();

/** One role's hold on one action. `gate_slot` is set when it is held only for gates of that slot. */
export interface RoleGrant {
  readonly action: ActionId;
  readonly gate_slot: RoleSlot | null;
}

/**
 * The actions a role holds, in catalogue order. Pure and deterministic; the policy generator and
 * the tests both read this and nothing else.
 */
export function roleGrants(
  role: RoleDef,
  actions: Readonly<Record<string, ActionDef>> = ACTION_CATALOGUE as unknown as Record<
    string,
    ActionDef
  >,
): RoleGrant[] {
  const out: RoleGrant[] = [];
  for (const id of Object.keys(actions) as ActionId[]) {
    let plain = false;
    let gateSlot: RoleSlot | null = null;
    for (const g of (actions[id] as ActionDef).grants) {
      switch (g.kind) {
        case 'view_level':
          plain ||= VIEW_RANK[role.view_level] >= VIEW_RANK[g.min];
          break;
        case 'slots':
          plain ||= role.slot !== null && g.slots.includes(role.slot);
          break;
        case 'decides_gates':
          plain ||= role.slot !== null && GATE_DECIDING_SLOTS.includes(role.slot);
          break;
        case 'roles':
          plain ||= g.roles.includes(role.role_id);
          break;
        case 'gate_slot':
          if (role.slot !== null && GATE_DECIDING_SLOTS.includes(role.slot)) gateSlot = role.slot;
          break;
      }
    }
    if (plain) out.push({ action: id, gate_slot: null });
    else if (gateSlot !== null) out.push({ action: id, gate_slot: gateSlot });
  }
  return out;
}

/** Does the role hold the action for this resource, as the generated policies decide it? */
export function roleHolds(role: RoleDef, action: ActionId, resource: PdpResource): boolean {
  if (!(actionDef(action).resource_types as readonly string[]).includes(resource.type))
    return false;
  const g = roleGrants(role).find((x) => x.action === action);
  if (!g) return false;
  if (g.gate_slot === null) return true;
  return resource.gate_id !== null && GATE_POLICIES[resource.gate_id].slot === g.gate_slot;
}

/** The Cedar attributes of a Gate resource, from the gate's policy and family. */
export const gateAttributes = (
  gate: GateId,
): { gate_id: string; slot: string; family: string } => ({
  gate_id: gate,
  slot: GATE_POLICIES[gate].slot,
  family: GATES[gate].family,
});

/** Roles that can hold a binding at a scope kind (the catalogue's `scope_kinds`). */
export const roleMayBindAt = (role: RoleDef, kind: Scope['kind']): boolean =>
  role.scope_kinds.includes(kind);

// ---------------------------------------------------------------- Policy bundle

/** The config key a published bundle lives under (factory layer; a project cannot set it). */
export const PDP_CONFIG_KEY = 'pdp.bundle';

/**
 * A policy bundle: the Cedar schema, the Cedar policies by policy id, a version and a hash over
 * the other three. The evaluator recomputes the hash on load and refuses a bundle that differs.
 */
export const PolicyBundle = z.strictObject({
  schema: z.string().min(1),
  policies: z.record(z.string().min(1), z.string().min(1)),
  bundle_version: z.string().min(1),
  bundle_hash: Sha256Hex,
});
export type PolicyBundle = z.infer<typeof PolicyBundle>;

/** sha256 of the canonical JSON of `{schema, policies, bundle_version}`. */
export const policyBundleHash = (
  b: Pick<PolicyBundle, 'schema' | 'policies' | 'bundle_version'>,
): string =>
  hashCanonical({ schema: b.schema, policies: b.policies, bundle_version: b.bundle_version });

// ---------------------------------------------------------------- Decision

/** The answer of the PDP to every request (DM `PdpDecision`). Nothing but `allow` permits. */
export const PdpDecision = z.strictObject({
  decision: z.enum(['allow', 'deny']),
  /** The policy ids that decided, or why there was no decision to make (`no_bundle`, ...). */
  reasons: z.array(z.string().min(1)),
  /** `null` when no bundle was loaded. */
  bundle_version: z.string().min(1).nullable(),
  bundle_hash: Sha256Hex.nullable(),
});
export type PdpDecision = z.infer<typeof PdpDecision>;

export const PDP_EVENT = { decision: 'pdp.decision' } as const;
export const pdpDecisionStream = (decisionId: string): string => `pdp_decision:${decisionId}`;

/** The body of a `pdp.decision` record event (DM `PdpDecision`: decision log). */
export const PdpDecisionRecord = z.strictObject({
  decision_id: z.string().min(1),
  principal: PrincipalId,
  action: z.string().min(1),
  resource: PdpResource,
  decision: z.enum(['allow', 'deny']),
  reasons: z.array(z.string().min(1)),
  bundle_version: z.string().min(1).nullable(),
  bundle_hash: Sha256Hex.nullable(),
  at: IsoDateTime,
  /** Why the caller asked (a card decision's note, a kill reason); never trusted by a policy. */
  justification: z.string().min(1).nullable(),
  /** `always` (a deny, or an action in `LOGGED_ALLOW_ACTIONS`) or `sampled`. */
  logged_because: z.enum(['deny', 'action', 'sampled']),
});
export type PdpDecisionRecord = z.infer<typeof PdpDecisionRecord>;
