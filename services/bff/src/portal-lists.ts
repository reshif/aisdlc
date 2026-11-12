import {
  AccessExplainView,
  AdmissionView,
  AgentRegistryView,
  AuditDecisionsView,
  CatalogueView,
  ControlKind,
  ControlScope,
  ControlsView,
  DataClass,
  IntegrationEvent,
  IntegrationHealthTiles,
  HealthView,
  DegradedView,
  ItemListView,
  KillsView,
  ProjectId,
  SandboxSlots,
  ViewLevel,
  pdpResource,
  roleDef,
  type ActionId,
  type DirectoryView,
  type ExplainHolder,
  type PdpResource,
  type RoleId,
  type Scope,
} from '@aisdlc/contracts';
import { directoryProjection, getPrincipals, listPrincipals, listTeams } from '@aisdlc/directory';
import { queryGrants } from '@aisdlc/identity/read';
import type { Pdp } from '@aisdlc/pdp';
import { runProjection } from '@aisdlc/record';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';
import { higher } from './levels.js';

// The portal's list and operate reads (2026-11-12): the screens whose backends were on main. Each route asks the
// PDP in this process for the signed-in person (fail closed), then calls core or the sandbox-controller with the
// bff's own token and the person as `on_behalf_of`; core asks the PDP again. Shapes: contracts `portal-lists.ts`.
//
//   GET  /api/items[?project=]           the items the person may see, theirs marked   (item.view_floor per row,
//                                        and project.view on its project here)
//   GET  /api/agents                     the agent registry (code) with prompt hashes   (audit.read, fleet)
//   GET  /api/catalogue                  every released catalogue and its pinned items  (signed in)
//   GET  /api/admission                  H1-H3, WIP holds, grants, HUMAN-WAIT           (audit.read, fleet)
//   GET  /api/slots                      the sandbox-controller's slots and caps        (audit.read, fleet; unreachable 502)
//   GET  /api/controls                   active controls and banners, every scope       (audit.read, fleet)
//   POST /api/controls/preview           a preview with its nonce                        (control.apply on the scope)
//   POST /api/controls                   apply the previewed control with that nonce     (control.apply on the scope)
//   POST /api/controls/:id/lift          lift one                                        (control.lift on its scope)
//   GET  /api/kills                      the kill switch's journal as core observed it   (audit.read, fleet)
//   GET  /api/audit/decisions            the PDP decision log                            (audit.read, fleet)
//   GET  /api/integrations               health tiles and the ledgered registry events   (audit.read, fleet)
//   GET  /api/health                     M19: the service and loop tiles (HealthSnapshot) (audit.read, fleet)
//   GET  /api/degraded?projects=         M19: kill verdicts, the Notary, stale read models  (signed in; only the
//                                        projects the person may view are asked about)
//   GET  /api/directory                  principals and teams                            (audit.read, fleet)
//   GET  /api/projects/:id/explain       who holds a role on the project, what the PDP allows them (access.explain)

export interface PortalListDeps {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly pdp: Pdp;
  readonly core: CoreClient | undefined;
  /** The sandbox-controller's read API (`GET /v1/slots`, scope `read`); without it `/api/slots` answers 503. */
  readonly sandboxController?: CoreClient;
  readonly now: () => Date;
  readonly principalOf: (req: FastifyRequest) => string;
}

const CONTROL_SCOPES = ['fleet', 'project', 'lane'] as const;

/** The PDP resource a control is authorised against (the same reading as core's); `null`: not a scope a control holds. */
export function resourceOfControlScope(scope: Scope): PdpResource | null {
  if (scope.kind === 'fleet') return pdpResource.fleet();
  if (scope.kind === 'project') return pdpResource.project(scope.ref);
  if (scope.kind === 'lane') {
    const [p, l] = scope.ref.split('/');
    return p && l ? pdpResource.lane(p, l) : null;
  }
  return null;
}

const PreviewBody = z.strictObject({ kind: ControlKind, scope: ControlScope });
const ApplyBody = z.strictObject({
  preview_id: z.uuid(),
  nonce: z.string().min(16).max(256),
  kind: ControlKind,
  scope: ControlScope,
  params: z.record(z.string(), z.unknown()).optional(),
  expires_at: z.iso.datetime().nullable().optional(),
  /** M19 (StepUpUse): a step-up proof bound to the preview's blast radius hash; core verifies and records it. */
  step_up: z.strictObject({ proof: z.string().min(1).max(8192) }).optional(),
});
const LiftBody = z.strictObject({ reason: z.string().min(1).max(500) });

export function registerPortalListRoutes(d: PortalListDeps): void {
  const { app } = d;

  async function allowed(principal: string, action: ActionId, resource: PdpResource) {
    try {
      return (await d.pdp.decide({ principal, action, resource })).decision === 'allow';
    } catch {
      return false;
    }
  }
  const deny = (reply: FastifyReply, action: ActionId) =>
    sendError(reply, 403, 'forbidden', `${action} denied`);

  function upstream<T>(reply: FastifyReply, r: CallResult, parse: (v: unknown) => T): T | null {
    if (!r.reached) {
      sendError(reply, 502, 'core_unavailable', 'the factory core could not be reached');
      return null;
    }
    if (r.status >= 500) {
      sendError(reply, 502, 'core_error', 'the factory core could not answer');
      return null;
    }
    if (r.status < 200 || r.status >= 300) {
      const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      sendError(
        reply,
        r.status,
        typeof e?.code === 'string' ? e.code : 'refused',
        typeof e?.message === 'string' ? e.message : 'the request was refused',
      );
      return null;
    }
    try {
      return parse(r.json);
    } catch {
      sendError(reply, 502, 'core_error', 'the factory core sent something unexpected');
      return null;
    }
  }

  const core = (reply: FastifyReply): CoreClient | null => {
    if (d.core) return d.core;
    sendError(reply, 503, 'core_not_configured', 'the bff has no core to call');
    return null;
  };
  const as = (req: FastifyRequest) => encodeURIComponent(d.principalOf(req));

  /** `audit.read` on the fleet here, then core with the person named. */
  async function fleetAudit(req: FastifyRequest, reply: FastifyReply): Promise<CoreClient | null> {
    const c = core(reply);
    if (!c) return null;
    if (!(await allowed(d.principalOf(req), 'audit.read', pdpResource.fleet()))) {
      deny(reply, 'audit.read');
      return null;
    }
    return c;
  }

  // ------------------------------------------------------------ items

  app.get('/api/items', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const q = z.strictObject({ project: ProjectId.optional() }).safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'bad project id');
    const who = d.principalOf(req);
    if (
      q.data.project &&
      !(await allowed(who, 'project.view', pdpResource.project(q.data.project)))
    ) {
      return deny(reply, 'project.view');
    }
    const path = `/v1/items?on_behalf_of=${as(req)}${q.data.project ? `&project=${q.data.project}` : ''}`;
    const got = upstream(reply, await c.call('GET', path), (v) => ItemListView.parse(v));
    if (!got) return;
    // core decided item.view_floor per row; the bff keeps only the projects it says the person may view
    const seen = new Map<string, boolean>();
    const items = [];
    for (const it of got.items) {
      let ok = seen.get(it.project_id);
      if (ok === undefined) {
        ok = await allowed(who, 'project.view', pdpResource.project(it.project_id));
        seen.set(it.project_id, ok);
      }
      if (ok) items.push(it);
    }
    return { items };
  });

  // ------------------------------------------------------------ quality and govern reads

  app.get('/api/agents', async (req, reply) => {
    const c = await fleetAudit(req, reply);
    if (!c) return;
    return upstream(reply, await c.call('GET', `/v1/agents?on_behalf_of=${as(req)}`), (v) =>
      AgentRegistryView.parse(v),
    );
  });

  app.get('/api/catalogue', async (_req, reply) => {
    const c = core(reply);
    if (!c) return;
    return upstream(reply, await c.call('GET', '/v1/catalogue'), (v) => CatalogueView.parse(v));
  });

  app.get('/api/audit/decisions', async (req, reply) => {
    const q = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(500).optional(),
        action: z
          .string()
          .regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/)
          .optional(),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'bad query');
    const c = await fleetAudit(req, reply);
    if (!c) return;
    const qs = new URLSearchParams({ on_behalf_of: d.principalOf(req) });
    if (q.data.limit) qs.set('limit', String(q.data.limit));
    if (q.data.action) qs.set('action', q.data.action);
    return upstream(reply, await c.call('GET', `/v1/audit/decisions?${qs}`), (v) =>
      AuditDecisionsView.parse(v),
    );
  });

  app.get('/api/integrations', async (req, reply) => {
    const c = await fleetAudit(req, reply);
    if (!c) return;
    const health = upstream(reply, await c.call('GET', '/v1/integrations/health'), (v) =>
      IntegrationHealthTiles.parse(v),
    );
    if (!health) return;
    const events = upstream(reply, await c.call('GET', '/v1/integrations/events'), (v) =>
      z.array(IntegrationEvent).parse(v),
    );
    if (!events) return;
    return { health, events };
  });

  app.get('/api/degraded', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const raw = (req.query as { projects?: unknown }).projects;
    const asked = (typeof raw === 'string' ? raw.split(',') : [])
      .map((p) => p.trim())
      .filter((p) => ProjectId.safeParse(p).success);
    if (asked.length > 50) return sendError(reply, 400, 'invalid_input', 'at most 50 projects');
    const who = d.principalOf(req);
    // a project the person may not view is not asked about (and not named back)
    const projects: string[] = [];
    for (const p of [...new Set(asked)]) {
      if (await allowed(who, 'project.view', pdpResource.project(p))) projects.push(p);
    }
    const qs = new URLSearchParams({ projects: projects.join(',') });
    return upstream(reply, await c.call('GET', `/v1/degraded?${qs}`), (v) => DegradedView.parse(v));
  });

  app.get('/api/health', async (req, reply) => {
    const c = await fleetAudit(req, reply);
    if (!c) return;
    return upstream(reply, await c.call('GET', '/v1/health'), (v) => HealthView.parse(v));
  });

  // ------------------------------------------------------------ operate

  app.get('/api/admission', async (req, reply) => {
    const c = await fleetAudit(req, reply);
    if (!c) return;
    return upstream(reply, await c.call('GET', `/v1/admission?on_behalf_of=${as(req)}`), (v) =>
      AdmissionView.parse(v),
    );
  });

  app.get('/api/slots', async (req, reply) => {
    if (!(await allowed(d.principalOf(req), 'audit.read', pdpResource.fleet()))) {
      return deny(reply, 'audit.read');
    }
    if (!d.sandboxController) {
      return sendError(
        reply,
        503,
        'sandbox_controller_not_configured',
        'the bff has no sandbox-controller to ask',
      );
    }
    const r = await d.sandboxController.call('GET', '/v1/slots');
    if (!r.reached || r.status !== 200) {
      return sendError(
        reply,
        502,
        'sandbox_controller_unavailable',
        'the sandbox-controller could not answer',
      );
    }
    const p = SandboxSlots.safeParse(r.json);
    if (!p.success) {
      return sendError(reply, 502, 'sandbox_controller_unavailable', 'unexpected answer');
    }
    return p.data;
  });

  app.get('/api/controls', async (req, reply) => {
    const c = await fleetAudit(req, reply);
    if (!c) return;
    return upstream(reply, await c.call('GET', `/v1/controls?on_behalf_of=${as(req)}`), (v) =>
      ControlsView.parse(v),
    );
  });

  /** `control.apply` on the scope's resource here, then core (which asks again and checks the nonce). */
  async function controlWrite<S extends z.ZodType<{ scope: Scope }>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    path: string,
  ) {
    const c = core(reply);
    if (!c) return;
    const b = schema.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
    if (!(CONTROL_SCOPES as readonly string[]).includes(b.data.scope.kind)) {
      return sendError(
        reply,
        400,
        'invalid_input',
        'a control is for the fleet, a project or a lane',
      );
    }
    const res = resourceOfControlScope(b.data.scope);
    if (!res) return sendError(reply, 400, 'invalid_input', 'bad scope');
    const who = d.principalOf(req);
    if (!(await allowed(who, 'control.apply', res))) return deny(reply, 'control.apply');
    const r = await c.call('POST', path, { ...b.data, on_behalf_of: who });
    const got = upstream(reply, r, (v) => v);
    if (got === null) return;
    return reply.code(r.reached && r.status === 201 ? 201 : 200).send(got);
  }

  app.post('/api/controls/preview', (req, reply) =>
    controlWrite(req, reply, PreviewBody, '/v1/controls/preview'),
  );
  app.post('/api/controls', (req, reply) => controlWrite(req, reply, ApplyBody, '/v1/controls'));

  app.post('/api/controls/:id/lift', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const id = (req.params as { id?: string }).id;
    if (!z.uuid().safeParse(id).success) return sendError(reply, 400, 'invalid_input', 'bad id');
    const b = LiftBody.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
    const who = d.principalOf(req);
    // the control's scope, from core's own list, read as this person (audit.read first)
    if (!(await allowed(who, 'audit.read', pdpResource.fleet()))) return deny(reply, 'audit.read');
    const list = upstream(reply, await c.call('GET', `/v1/controls?on_behalf_of=${as(req)}`), (v) =>
      ControlsView.parse(v),
    );
    if (!list) return;
    const cur = list.controls.find((x) => x.control_id === id);
    if (!cur) return sendError(reply, 404, 'not_found', 'no such control');
    const res = resourceOfControlScope(cur.scope);
    if (!res || !(await allowed(who, 'control.lift', res))) return deny(reply, 'control.lift');
    return upstream(
      reply,
      await c.call('POST', `/v1/controls/${id}/lift`, { ...b.data, on_behalf_of: who }),
      (v) => v,
    );
  });

  app.get('/api/kills', async (req, reply) => {
    const c = await fleetAudit(req, reply);
    if (!c) return;
    return upstream(reply, await c.call('GET', `/v1/kills?on_behalf_of=${as(req)}`), (v) =>
      KillsView.parse(v),
    );
  });

  // ------------------------------------------------------------ admin: the directory and who can do what

  app.get('/api/directory', async (req, reply) => {
    if (!(await allowed(d.principalOf(req), 'audit.read', pdpResource.fleet()))) {
      return deny(reply, 'audit.read');
    }
    const caught = await runProjection(d.pool, directoryProjection);
    if (!caught.ok)
      return sendError(reply, 503, 'directory_unavailable', 'directory needs a rebuild');
    const out: DirectoryView = {
      principals: await listPrincipals(d.pool, { limit: 200 }),
      teams: await listTeams(d.pool),
    };
    return out;
  });

  app.get('/api/projects/:id/explain', async (req, reply) => {
    const id = ProjectId.safeParse((req.params as { id: string }).id);
    if (!id.success) return sendError(reply, 400, 'invalid_input', 'bad project id');
    const who = d.principalOf(req);
    if (!(await allowed(who, 'access.explain', pdpResource.project(id.data)))) {
      return deny(reply, 'access.explain');
    }
    const now = d.now();
    const grants = await queryGrants(d.pool, {}, { kind: 'project', ref: id.data }, now);
    const by = new Map<
      string,
      { roles: RoleId[]; scopes: Scope[]; view: ViewLevel | null; data: DataClass | null }
    >();
    for (const g of grants) {
      if (g.blockers.length > 0) continue;
      const def = roleDef(g.role_id as RoleId);
      if (!def) continue;
      const h = by.get(g.principal.principal_id) ?? {
        roles: [],
        scopes: [],
        view: null,
        data: null,
      };
      if (!h.roles.includes(def.role_id)) h.roles.push(def.role_id);
      if (!h.scopes.some((s) => s.kind === g.scope.kind && s.ref === g.scope.ref)) {
        h.scopes.push(g.scope);
      }
      h.view = higher(ViewLevel.options, h.view, def.view_level);
      h.data = higher(DataClass.options, h.data, def.data_class_default);
      by.set(g.principal.principal_id, h);
    }
    await runProjection(d.pool, directoryProjection);
    const names = await getPrincipals(d.pool, [...by.keys()]);
    const holders: ExplainHolder[] = [];
    for (const [principal, h] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
      let actions: ActionId[];
      try {
        actions = await d.pdp.allowedActions(principal, pdpResource.project(id.data));
      } catch {
        actions = [];
      }
      holders.push({
        principal_id: principal as never,
        display_name: names.get(principal)?.display_name ?? principal,
        roles: h.roles,
        scopes: h.scopes,
        view_level: h.view,
        data_class: h.data,
        actions,
      });
    }
    return AccessExplainView.parse({ project_id: id.data, as_of: now.toISOString(), holders });
  });
}
