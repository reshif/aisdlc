import {
  ROLE_CATALOGUE,
  roleForSlot,
  type PrincipalId,
  type ProjectId,
  type RoleDef,
  type RoleSlot,
  type Scope,
} from '@aisdlc/contracts';
import { PortError, type EligibilityPort, type PolicyContext } from '@aisdlc/decisions';
import { err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import type { ProjectSettingsPort } from '@aisdlc/ports';
import { runProjection } from '@aisdlc/record';
import type pg from 'pg';
import { identityProjection } from './projection.js';
import { queryGrants, type Grant } from './queries.js';

// The real `EligibilityPort` (PLAN M4.4): slot -> principals comes from the identity read model
// (the effective bindings of the slot's role at `project:<id>`), the tier and two-person setting
// from the project settings. It answers exactly what `FakeEligibility` answers, from the same
// shapes, so the decision kernel cannot tell them apart; the conformance test in this package
// runs both through the kernel and compares.

export interface ReadDeps {
  /**
   * The record database. Every read catches the read model up first, which takes its own
   * connection: give the adapter a pool of its own when it is called from inside a transaction
   * that holds a connection of the pool the decision kernel uses, or enough concurrent callers
   * could hold every connection while waiting for one more.
   */
  readonly pool: pg.Pool;
  readonly settings: ProjectSettingsPort;
  readonly clock?: Clock;
  readonly catalogue?: readonly RoleDef[];
}

const portError = (message: string): PortError => PortError({ message });

export const projectScope = (project: ProjectId | string): Scope => ({
  kind: 'project',
  ref: project,
});

/** Catches the read model up with the journal, so a write that has committed is visible. */
export async function freshReadModel(pool: pg.Pool): Promise<Result<void, PortError>> {
  try {
    const r = await runProjection(pool, identityProjection);
    return r.ok ? ok(undefined) : err(portError('identity read model needs a rebuild'));
  } catch (e) {
    return err(portError(`identity read model: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/** Does identity know this project? Only a role map reconcile gives a project its bindings. */
async function hasRoleMap(pool: pg.Pool, project: string): Promise<boolean> {
  const q = await pool.query(
    `SELECT 1 FROM identity.binding
      WHERE scope_kind = 'project' AND scope_ref = $1 AND constraints ->> 'origin' = 'role_map' LIMIT 1`,
    [project],
  );
  return q.rows.length > 0;
}

/** The principals in force for a slot, with every path that gives each one the slot. */
export async function slotGrants(
  deps: ReadDeps,
  project: ProjectId | string,
  slot: RoleSlot,
): Promise<Grant[]> {
  const catalogue = deps.catalogue ?? ROLE_CATALOGUE;
  return queryGrants(
    deps.pool,
    { role: roleForSlot(slot, catalogue) },
    projectScope(project),
    (deps.clock ?? systemClock).now(),
    catalogue,
  );
}

export class IdentityEligibility implements EligibilityPort {
  constructor(private readonly deps: ReadDeps) {}

  async holders(
    project: ProjectId,
    slot: RoleSlot,
  ): Promise<Result<readonly PrincipalId[], PortError>> {
    const fresh = await freshReadModel(this.deps.pool);
    if (!fresh.ok) return fresh;
    try {
      if (!(await hasRoleMap(this.deps.pool, project))) {
        return err(portError(`project ${project} has no role map bindings`));
      }
      const grants = await slotGrants(this.deps, project, slot);
      const ids = new Set(
        grants.filter((g) => g.blockers.length === 0).map((g) => g.principal.principal_id),
      );
      return ok([...ids].sort() as PrincipalId[]);
    } catch (e) {
      return err(portError(`identity: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  async policy(project: ProjectId): Promise<Result<PolicyContext, PortError>> {
    const view = await this.deps.settings.get(project);
    if (!view.ok) return err(portError(`project settings: ${view.error.message}`));
    const { settings, tier } = view.value;
    // As the fake does: a T2 project, or settings that locked two-person on, cannot have it off.
    const locked = tier === 'T2' || settings.two_person.locked_on;
    return ok({
      tier,
      two_person: {
        enabled: locked ? true : settings.two_person.enabled,
        default: 'on_if_2plus',
        locked_on: locked,
      },
    });
  }
}
