import {
  GateIdValues,
  gatePolicy,
  roleForSlot,
  type GateId,
  type ProjectId,
  type Scope,
} from '@aisdlc/contracts';
import { planQuorum, type PolicyContext } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import { IdentityEligibility, freshReadModel, slotGrants, type ReadDeps } from './eligibility.js';
import { identityError, type IdentityError } from './errors.js';
import type { Grant } from './queries.js';

// Effective-access explain (PLAN M4.4): which principals can decide a gate on a project, and why.
// "Why" is the path: the slot the gate names, the role the slot maps to, and for each principal
// the group and binding that give it the role, with the membership's source. The same planner the
// decision kernel uses (`planQuorum`) says how many approvals the gate needs, whether the
// two-person rule is in force, and whether deciding rests on a `sod_waiver`.

export type OwnRequest = 'allowed' | 'sod_waiver' | 'blocked';

export interface ExplainedPath {
  readonly slot: string;
  readonly role_id: string;
  readonly binding_id: string;
  readonly scope: Scope;
  readonly group_id: string;
  readonly group_display: string;
  readonly membership_source: string;
  readonly generated: boolean;
  readonly constraints: Record<string, unknown>;
}

export interface ExplainedPrincipal {
  readonly principal_id: string;
  readonly display_handle: string;
  readonly display_name: string;
  readonly paths: readonly ExplainedPath[];
  /** What happens if this principal is also the requester of the work (the gate's own-request rule). */
  readonly own_request: OwnRequest;
}

export interface BlockedPrincipal {
  readonly principal_id: string;
  readonly display_handle: string;
  readonly blockers: readonly string[];
  readonly paths: readonly ExplainedPath[];
}

export type ExplainedQuorum =
  | {
      readonly feasible: true;
      readonly required: number;
      readonly basis: string;
      /** Deciding under this plan is stamped `sod_waiver` (single holder, or two-person off; never T2). */
      readonly sod_waiver: boolean;
    }
  | { readonly feasible: false; readonly code: string; readonly message: string };

export interface GateExplanation {
  readonly project_id: string;
  readonly gate_id: GateId;
  readonly slot: string;
  readonly role_id: string;
  readonly step_up: boolean;
  readonly policy: {
    readonly tier: string | null;
    readonly t2: boolean;
    readonly two_person_enabled: boolean;
    readonly two_person_locked_on: boolean;
    /** The gate is one a two-person rule covers (X1, X2, E2, M4, kill release; DEC-28). */
    readonly gate_is_two_person: boolean;
    /** The rule is in force: the gate is covered and the project setting is on (always on for T2). */
    readonly two_person_in_force: boolean;
    readonly own_request_rule: 'blocked' | 'allowed';
  };
  readonly quorum: ExplainedQuorum;
  /** Principals who can decide it now. */
  readonly deciders: readonly ExplainedPrincipal[];
  /** Members of a bound group who cannot decide it now, and why. */
  readonly blocked: readonly BlockedPrincipal[];
}

const pathOf = (g: Grant, slot: string): ExplainedPath => ({
  slot,
  role_id: g.role_id,
  binding_id: g.binding_id,
  scope: g.scope,
  group_id: g.group_id,
  group_display: g.group_display,
  membership_source: g.membership.source,
  generated: g.constraints['origin'] === 'role_map',
  constraints: g.constraints,
});

/** `explain(project, gateId)`: who can decide the gate, and why. */
export async function explainGate(
  deps: ReadDeps,
  project: ProjectId,
  gate: GateId,
): Promise<Result<GateExplanation, IdentityError>> {
  const fresh = await freshReadModel(deps.pool);
  if (!fresh.ok) return err(identityError('unavailable', fresh.error.message));
  const ctxR = await new IdentityEligibility(deps).policy(project);
  if (!ctxR.ok) return err(identityError('unavailable', ctxR.error.message));
  const ctx: PolicyContext = ctxR.value;
  const policy = gatePolicy(gate);
  const slot = policy.slot;
  const grants = await slotGrants(deps, project, slot);

  const byPrincipal = new Map<string, Grant[]>();
  for (const g of grants) {
    byPrincipal.set(g.principal.principal_id, [
      ...(byPrincipal.get(g.principal.principal_id) ?? []),
      g,
    ]);
  }
  const inForce = [...byPrincipal.entries()].filter(([, gs]) =>
    gs.some((g) => g.blockers.length === 0),
  );
  const holders = inForce.map(([id]) => id).sort() as never[];

  const t2 = ctx.tier === 'T2' || ctx.two_person.locked_on;
  const plan = planQuorum(gate, ctx, holders, null);
  const quorum: ExplainedQuorum = plan.ok
    ? {
        feasible: true,
        required: plan.value.required,
        basis: plan.value.basis,
        sod_waiver: plan.value.waiver,
      }
    : { feasible: false, code: plan.error.code, message: plan.error.message };

  const ownRequest = (id: string): OwnRequest => {
    if (policy.own_request === 'allowed') return 'allowed';
    const p = planQuorum(gate, ctx, holders, id as never);
    return p.ok && p.value.basis === 'own_item' ? 'sod_waiver' : 'blocked';
  };

  const deciders: ExplainedPrincipal[] = [];
  const blocked: BlockedPrincipal[] = [];
  for (const [id, gs] of [...byPrincipal.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = gs[0] as Grant;
    const live = gs.filter((g) => g.blockers.length === 0);
    if (live.length > 0) {
      deciders.push({
        principal_id: id,
        display_handle: first.principal.display_handle,
        display_name: first.principal.display_name,
        paths: live.map((g) => pathOf(g, slot)),
        own_request: ownRequest(id),
      });
    } else {
      blocked.push({
        principal_id: id,
        display_handle: first.principal.display_handle,
        blockers: [...new Set(gs.flatMap((g) => g.blockers))].sort(),
        paths: gs.map((g) => pathOf(g, slot)),
      });
    }
  }
  const covered = policy.two_person === 'project';
  return ok({
    project_id: project,
    gate_id: gate,
    slot,
    role_id: roleForSlot(slot, deps.catalogue),
    step_up: policy.step_up,
    policy: {
      tier: ctx.tier,
      t2,
      two_person_enabled: ctx.two_person.enabled,
      two_person_locked_on: ctx.two_person.locked_on,
      gate_is_two_person: covered,
      two_person_in_force: covered && ctx.two_person.enabled,
      own_request_rule: policy.own_request,
    },
    quorum,
    deciders,
    blocked,
  });
}

/** Every gate of the flow, explained for one project (the wizard's "who can do what" screen). */
export async function explainProject(
  deps: ReadDeps,
  project: ProjectId,
): Promise<Result<GateExplanation[], IdentityError>> {
  const out: GateExplanation[] = [];
  for (const gate of GateIdValues) {
    const r = await explainGate(deps, project, gate);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}
