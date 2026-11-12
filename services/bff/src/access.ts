import {
  DataClass,
  DecisionBatchRequest,
  NOT_VISIBLE_REASON,
  ROLES_VERSION,
  ViewLevel,
  pdpResource,
  roleDef,
  type ActionId,
  type DecisionAnswer,
  type DecisionBatchView,
  type MyAccessView,
  type MyBinding,
  type MyProjectAccess,
  type PdpResource,
  type PrincipalId,
  type RoleId,
} from '@aisdlc/contracts';
import { queryGrants } from '@aisdlc/identity/read';
import type { Clock } from '@aisdlc/kernel';
import type { Pdp } from '@aisdlc/pdp';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { higher, projectOfScope } from './levels.js';

// The person's own access, for the portal (portal-coverage §6 step 2). Both routes sit behind the
// session hook in app.ts (no session: 401) and answer only about the signed-in principal, never
// about someone the request names.
//
//   GET  /api/me/access      the person's bindings (in force or not, with the reason), and per
//                            project the highest view level and data class of the roles in force
//                            there plus what the PDP allows on the project. Only projects the
//                            person holds a binding on are listed: nothing here says that any
//                            other project exists.
//   POST /api/me/decisions   up to DECISION_BATCH_MAX `{action, resource}` pairs, each decided by
//                            the real PDP as a capability probe (`log: false`). A pair on a project
//                            the person may not view answers `not_visible` and nothing else, the
//                            same for a project that does not exist.
//
// These answers only hide or lock buttons. Every write route asks the PDP again on its own.

export interface AccessDeps {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly pdp: Pdp;
  readonly clock: Clock;
  readonly principalOf: (req: FastifyRequest) => string;
  readonly displayNameOf: (principal: string) => Promise<string | null>;
}

export { projectOfScope } from './levels.js';

/** The project a resource lives under, or `null` for the fleet and a team. */
const projectOfResource = (r: PdpResource): string | null =>
  r.type === 'Project' ? r.id : r.project;

/**
 * The highest data class of the roles in force for `principal` on `project` (a fleet role reaches every project), or
 * `null` when no role in force reaches it. The same reading `GET /api/me/access` shows the person.
 */
export async function dataClassOn(
  pool: pg.Pool,
  principal: string,
  project: string,
  now: Date,
): Promise<DataClass | null> {
  let best: DataClass | null = null;
  for (const g of await queryGrants(pool, { principal }, null, now)) {
    if (g.blockers.length > 0) continue;
    const def = roleDef(g.role_id as RoleId);
    if (!def) continue;
    if (g.scope.kind !== 'fleet' && projectOfScope(g.scope) !== project) continue;
    best = higher(DataClass.options, best, def.data_class_default);
  }
  return best;
}

export function registerAccessRoutes(d: AccessDeps): void {
  const { app } = d;

  async function allows(principal: string, action: ActionId, resource: PdpResource) {
    try {
      const out = await d.pdp.decide({ principal, action, resource }, { log: false });
      return { allow: out.decision === 'allow', reasons: out.reasons };
    } catch {
      return { allow: false, reasons: ['evaluator_error'] };
    }
  }

  async function allowedOn(principal: string, resource: PdpResource): Promise<ActionId[]> {
    try {
      return await d.pdp.allowedActions(principal, resource);
    } catch {
      return [];
    }
  }

  app.get('/api/me/access', async (req, reply) => {
    const principal = d.principalOf(req);
    const name = await d.displayNameOf(principal);
    if (name === null) {
      return sendError(
        reply,
        403,
        'unknown_principal',
        'the directory does not know this principal',
      );
    }
    const grants = await queryGrants(d.pool, { principal }, null, d.clock.now());
    const bindings: MyBinding[] = grants.map((g) => ({
      binding_id: g.binding_id,
      role_id: g.role_id as RoleId,
      scope: g.scope,
      project_id: projectOfScope(g.scope),
      group_id: g.group_id,
      group_display: g.group_display,
      source: g.membership.source,
      expiry: g.expiry,
      blockers: [...g.blockers],
    }));

    const fleet: MyAccessView['fleet'] = {
      view_level: null,
      data_class: null,
      roles: [],
      actions: await allowedOn(principal, pdpResource.fleet()),
    };
    const perProject = new Map<
      string,
      { view: ViewLevel | null; data: DataClass | null; roles: RoleId[] }
    >();
    for (const b of bindings) {
      if (b.blockers.length > 0) continue;
      const def = roleDef(b.role_id);
      if (!def) continue;
      if (b.scope.kind === 'fleet') {
        fleet.view_level = higher(ViewLevel.options, fleet.view_level, def.view_level);
        fleet.data_class = higher(DataClass.options, fleet.data_class, def.data_class_default);
        if (!fleet.roles.includes(b.role_id)) fleet.roles.push(b.role_id);
        continue;
      }
      if (b.project_id === null) continue;
      const p = perProject.get(b.project_id) ?? { view: null, data: null, roles: [] };
      p.view = higher(ViewLevel.options, p.view, def.view_level);
      p.data = higher(DataClass.options, p.data, def.data_class_default);
      if (!p.roles.includes(b.role_id)) p.roles.push(b.role_id);
      perProject.set(b.project_id, p);
    }

    const projects: MyProjectAccess[] = [];
    for (const [project_id, p] of [...perProject].sort(([a], [b]) => a.localeCompare(b))) {
      // A fleet role reaches the project too; the person sees the higher of the two.
      const view =
        fleet.view_level === null ? p.view : higher(ViewLevel.options, p.view, fleet.view_level);
      const data =
        fleet.data_class === null ? p.data : higher(DataClass.options, p.data, fleet.data_class);
      if (view === null || data === null) continue;
      projects.push({
        project_id,
        view_level: view,
        data_class: data,
        roles: [...p.roles, ...fleet.roles.filter((r) => !p.roles.includes(r))],
        actions: await allowedOn(principal, pdpResource.project(project_id)),
      });
    }

    const view: MyAccessView = {
      principal: { principal_id: principal as PrincipalId, display_name: name },
      roles_version: ROLES_VERSION,
      bindings,
      fleet,
      projects,
    };
    return view;
  });

  app.post('/api/me/decisions', async (req, reply) => {
    const body = DecisionBatchRequest.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const principal = d.principalOf(req);
    const visible = new Map<string, boolean>();
    const decisions: DecisionAnswer[] = [];
    for (const q of body.data.queries) {
      const project = projectOfResource(q.resource);
      if (project !== null) {
        let seen = visible.get(project);
        if (seen === undefined) {
          seen = (await allows(principal, 'project.view', pdpResource.project(project))).allow;
          visible.set(project, seen);
        }
        if (!seen) {
          decisions.push({ ...q, allow: false, reasons: [NOT_VISIBLE_REASON] });
          continue;
        }
      }
      const out = await allows(principal, q.action, q.resource);
      decisions.push({ ...q, allow: out.allow, reasons: out.reasons });
    }
    const view: DecisionBatchView = { decisions };
    return view;
  });
}
