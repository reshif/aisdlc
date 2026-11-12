import { DataClass, ViewLevel, roleDef, type RoleId, type Scope } from '@aisdlc/contracts';
import { queryGrants } from '@aisdlc/identity/read';
import type pg from 'pg';

// The view level and data class a person reaches on a project (portal-coverage §6 step 2): the highest of the roles
// in force there and on the fleet, from the identity read model the PDP decides with. `GET /api/me/access` shows
// them as hints; the S7 reads (M14.6) cut what they answer by them on the server. No binding in force: `null`.

/** The project a binding's scope lies in, or `null` for scopes above a project. */
export function projectOfScope(scope: Scope): string | null {
  if (scope.kind === 'project') return scope.ref;
  if (scope.kind === 'lane' || scope.kind === 'repo' || scope.kind === 'item') {
    return scope.ref.split('/')[0] ?? null;
  }
  return null;
}

export const higher = <T extends string>(order: readonly T[], a: T | null, b: T): T =>
  a === null || order.indexOf(b) > order.indexOf(a) ? b : a;

export interface Levels {
  readonly view_level: ViewLevel;
  readonly data_class: DataClass;
}

/** The person's levels on one project (fleet roles reach every project); `null` when no role is in force there. */
export async function levelsOn(
  pool: pg.Pool,
  principal: string,
  project: string,
  now: Date,
): Promise<Levels | null> {
  const grants = await queryGrants(pool, { principal }, null, now);
  let view: ViewLevel | null = null;
  let data: DataClass | null = null;
  for (const g of grants) {
    if (g.blockers.length > 0) continue;
    const def = roleDef(g.role_id as RoleId);
    if (!def) continue;
    if (g.scope.kind !== 'fleet' && projectOfScope(g.scope) !== project) continue;
    view = higher(ViewLevel.options, view, def.view_level);
    data = higher(DataClass.options, data, def.data_class_default);
  }
  return view === null || data === null ? null : { view_level: view, data_class: data };
}

/** Where the person holds a role in force: on the fleet, and the projects of their other bindings (M19: the fleet's cut). */
export interface RolesIn {
  readonly fleet: boolean;
  readonly projects: ReadonlySet<string>;
}

export async function rolesIn(pool: pg.Pool, principal: string, now: Date): Promise<RolesIn> {
  const grants = await queryGrants(pool, { principal }, null, now);
  let fleet = false;
  const projects = new Set<string>();
  for (const g of grants) {
    if (g.blockers.length > 0 || !roleDef(g.role_id as RoleId)) continue;
    if (g.scope.kind === 'fleet') fleet = true;
    const p = projectOfScope(g.scope);
    if (p !== null) projects.add(p);
  }
  return { fleet, projects };
}
