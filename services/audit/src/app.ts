import {
  AUDIT_ACTION,
  AuditExportRequest,
  ErasureApproveInput,
  ErasureRejectInput,
  ErasureRequestInput,
  PlaceHoldRequest,
  PrincipalId,
  ProjectId,
  ReleaseHoldRequest,
  pdpResource,
  type ActionId,
  type AuditExportView,
  type AuditScope,
  type PdpResource,
  type RetentionView,
} from '@aisdlc/contracts';
import type { LoopSupervisor } from '@aisdlc/loops';
import type { Pdp } from '@aisdlc/pdp';
import type { ObjectStorePort } from '@aisdlc/ports';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { readExportBytes, writeExport, type ExportDeps } from './exporter.js';
import {
  approveErasure,
  placeHold,
  rejectErasure,
  releaseHold,
  requestErasure,
  type GovernDeps,
  type RetentionRead,
} from './govern.js';
import {
  AUDIT_STATUS,
  lastSweeps,
  listErasures,
  listExports,
  listHolds,
  type AuditError,
} from './store.js';

/**
 * What a caller may do (docs/specs/audit-api.md): `read` the exports, holds, erasures and retention; `export` write a
 * signed export; `govern` place and release holds, request, approve and reject erasures. The bff is the only caller
 * and holds all three; every request names the signed-in person (`on_behalf_of`) and the PDP decides about them HERE
 * too (`audit.read` on the scope; `identity.admin` on the fleet for erasure and holds, see `AUDIT_ACTION`).
 */
export type AuditScopeName = 'read' | 'export' | 'govern';

export interface AuditAppOptions {
  readonly pool: pg.Pool;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly AuditScopeName[]>;
  readonly pdp: Pdp;
  readonly exporter: ExportDeps;
  readonly govern: GovernDeps;
  readonly objects: ObjectStorePort;
  readonly retention: () => RetentionRead;
  /** The loops: `/healthz` is 503 while one is unhealthy. */
  readonly supervisor?: LoopSupervisor;
  readonly log?: (line: string) => void;
}

const Who = z.object({ on_behalf_of: PrincipalId });
const ListExports = z.strictObject({ on_behalf_of: PrincipalId, project: ProjectId.optional() });
const Id = z.uuid();

/** The body without the person it is on behalf of (the contracts' request shapes are strict). */
const withoutWho = (raw: Record<string, unknown>): Record<string, unknown> => {
  const rest = { ...raw };
  delete rest['on_behalf_of'];
  return rest;
};

const resourceOf = (s: AuditScope): PdpResource =>
  s.kind === 'fleet' ? pdpResource.fleet() : pdpResource.project(s.project_id);

export function createAuditApp(o: AuditAppOptions): FastifyInstance {
  const app = newApp({ bodyLimit: 64 * 1024 });
  app.get('/healthz', async (_req, reply) => {
    if (!o.supervisor) return { ok: true };
    const report = o.supervisor.health();
    return reply.code(report.status === 'ok' ? 200 : 503).send(report);
  });
  app.get('/metrics', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4').send(o.supervisor?.prometheus() ?? ''),
  );

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null)
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    (req as unknown as { caller: string }).caller = caller;
  });
  const needs = (req: FastifyRequest, reply: FastifyReply, scope: AuditScopeName): boolean => {
    const caller = (req as unknown as { caller: string }).caller;
    if ((o.callers[caller] ?? []).includes(scope)) return true;
    sendError(reply, 403, 'forbidden', `caller may not use scope ${scope}`);
    return false;
  };
  /** The PDP decides about the person; any answer but `allow`, or an error, is a refusal. */
  const guard = async (
    reply: FastifyReply,
    principal: string,
    action: ActionId,
    resource: PdpResource,
  ): Promise<boolean> => {
    try {
      const d = await o.pdp.decide({ principal, action, resource });
      if (d.decision === 'allow') return true;
      sendError(reply, 403, 'forbidden', `${action} denied: ${d.reasons.join(', ').slice(0, 200)}`);
    } catch {
      sendError(reply, 403, 'forbidden', `${action} could not be decided`);
    }
    return false;
  };
  const fail = (reply: FastifyReply, e: AuditError) =>
    sendError(reply, AUDIT_STATUS[e.code], e.code, e.message);
  const bad = (reply: FastifyReply, e: z.ZodError) =>
    sendError(
      reply,
      400,
      'invalid_input',
      e.issues
        .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
        .join('; ')
        .slice(0, 500),
    );
  const idOf = (req: FastifyRequest): string | null => {
    const p = Id.safeParse((req.params as { id?: string }).id);
    return p.success ? p.data : null;
  };
  const guarded = async <T>(
    reply: FastifyReply,
    what: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      o.log?.(`${what}: ${e instanceof Error ? e.constructor.name : 'error'}`);
      sendError(reply, 503, 'unavailable', `${what} could not be read`);
      return undefined;
    }
  };

  // ------------------------------------------------------------ exports

  app.get('/v1/exports', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const q = ListExports.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    const res = q.data.project ? pdpResource.project(q.data.project) : pdpResource.fleet();
    if (!(await guard(reply, q.data.on_behalf_of, AUDIT_ACTION.read, res))) return;
    const rows = await guarded(reply, 'the exports', () =>
      listExports(o.pool, q.data.project ? { project_id: q.data.project } : {}),
    );
    return rows && { exports: rows };
  });

  /** The export, once the PDP allowed the person its scope; otherwise the answer is sent and `null` returned. */
  const exportFor = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuditExportView | null> => {
    const q = Who.safeParse(req.query);
    const id = idOf(req);
    if (!q.success || !id) {
      sendError(reply, 400, 'invalid_input', 'on_behalf_of and an export id');
      return null;
    }
    const view = (await listExports(o.pool, { export_id: id }))[0];
    if (!view) {
      sendError(reply, 404, 'not_found', 'no such export');
      return null;
    }
    if (!(await guard(reply, q.data.on_behalf_of, AUDIT_ACTION.read, resourceOf(view.scope))))
      return null;
    return view;
  };

  app.get('/v1/exports/:id', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const view = await exportFor(req, reply);
    return view ?? undefined;
  });

  app.get('/v1/exports/:id/signed', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const view = await exportFor(req, reply);
    if (!view) return;
    const r = await readExportBytes({ pool: o.pool, objects: o.objects }, view.export_id);
    if (!r.ok) return fail(reply, r.error);
    return {
      object_key: r.value.view.object_key,
      bytes_b64: Buffer.from(r.value.bytes).toString('base64'),
    };
  });

  app.post('/v1/exports', async (req, reply) => {
    if (!needs(req, reply, 'export')) return;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const who = Who.safeParse(raw);
    const rest = withoutWho(raw);
    const body = AuditExportRequest.safeParse(rest);
    if (!who.success) return bad(reply, who.error);
    if (!body.success) return bad(reply, body.error);
    if (
      !(await guard(reply, who.data.on_behalf_of, AUDIT_ACTION.export, resourceOf(body.data.scope)))
    )
      return;
    const r = await writeExport(o.exporter, body.data, who.data.on_behalf_of);
    if (!r.ok) return fail(reply, r.error);
    return reply.code(201).send(r.value);
  });

  // ------------------------------------------------------------ legal holds

  app.get('/v1/holds', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const q = Who.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    if (!(await guard(reply, q.data.on_behalf_of, AUDIT_ACTION.read, pdpResource.fleet()))) return;
    const rows = await guarded(reply, 'the holds', () => listHolds(o.pool));
    return rows && { holds: rows };
  });

  app.post('/v1/holds', async (req, reply) => {
    if (!needs(req, reply, 'govern')) return;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const who = Who.safeParse(raw);
    const rest = withoutWho(raw);
    const body = PlaceHoldRequest.safeParse(rest);
    if (!who.success) return bad(reply, who.error);
    if (!body.success) return bad(reply, body.error);
    if (!(await guard(reply, who.data.on_behalf_of, AUDIT_ACTION.govern, pdpResource.fleet())))
      return;
    const r = await placeHold(o.govern, body.data, who.data.on_behalf_of);
    if (!r.ok) return fail(reply, r.error);
    return reply.code(201).send(r.value);
  });

  app.post('/v1/holds/:id/release', async (req, reply) => {
    if (!needs(req, reply, 'govern')) return;
    const id = idOf(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const who = Who.safeParse(raw);
    const rest = withoutWho(raw);
    const body = ReleaseHoldRequest.safeParse(rest);
    if (!id) return sendError(reply, 400, 'invalid_input', 'a hold id');
    if (!who.success) return bad(reply, who.error);
    if (!body.success) return bad(reply, body.error);
    if (!(await guard(reply, who.data.on_behalf_of, AUDIT_ACTION.govern, pdpResource.fleet())))
      return;
    const r = await releaseHold(o.govern, id, body.data.reason, who.data.on_behalf_of);
    if (!r.ok) return fail(reply, r.error);
    return r.value;
  });

  // ------------------------------------------------------------ erasure

  app.get('/v1/erasures', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const q = Who.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    if (!(await guard(reply, q.data.on_behalf_of, AUDIT_ACTION.read, pdpResource.fleet()))) return;
    const rows = await guarded(reply, 'the erasures', () => listErasures(o.pool));
    return rows && { erasures: rows };
  });

  app.get('/v1/erasures/:id', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const q = Who.safeParse(req.query);
    const id = idOf(req);
    if (!q.success || !id)
      return sendError(reply, 400, 'invalid_input', 'on_behalf_of and an erasure id');
    if (!(await guard(reply, q.data.on_behalf_of, AUDIT_ACTION.read, pdpResource.fleet()))) return;
    const v = (await listErasures(o.pool, { erasure_id: id }))[0];
    return v ?? sendError(reply, 404, 'not_found', 'no such erasure');
  });

  app.post('/v1/erasures', async (req, reply) => {
    if (!needs(req, reply, 'govern')) return;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const who = Who.safeParse(raw);
    const rest = withoutWho(raw);
    const body = ErasureRequestInput.safeParse(rest);
    if (!who.success) return bad(reply, who.error);
    if (!body.success) return bad(reply, body.error);
    if (!(await guard(reply, who.data.on_behalf_of, AUDIT_ACTION.govern, pdpResource.fleet())))
      return;
    const r = await requestErasure(o.govern, body.data, who.data.on_behalf_of);
    if (!r.ok) return fail(reply, r.error);
    return reply.code(201).send(r.value);
  });

  for (const verb of ['approve', 'reject'] as const) {
    app.post(`/v1/erasures/:id/${verb}`, async (req, reply) => {
      if (!needs(req, reply, 'govern')) return;
      const id = idOf(req);
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const who = Who.safeParse(raw);
      const rest = withoutWho(raw);
      if (!id) return sendError(reply, 400, 'invalid_input', 'an erasure id');
      if (!who.success) return bad(reply, who.error);
      if (!(await guard(reply, who.data.on_behalf_of, AUDIT_ACTION.govern, pdpResource.fleet())))
        return;
      if (verb === 'approve') {
        const body = ErasureApproveInput.safeParse(rest);
        if (!body.success) return bad(reply, body.error);
        const r = await approveErasure(o.govern, id, body.data, who.data.on_behalf_of);
        return r.ok ? r.value : fail(reply, r.error);
      }
      const body = ErasureRejectInput.safeParse(rest);
      if (!body.success) return bad(reply, body.error);
      const r = await rejectErasure(o.govern, id, body.data.reason, who.data.on_behalf_of);
      return r.ok ? r.value : fail(reply, r.error);
    });
  }

  // ------------------------------------------------------------ retention

  app.get('/v1/retention', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const q = Who.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    if (!(await guard(reply, q.data.on_behalf_of, AUDIT_ACTION.read, pdpResource.fleet()))) return;
    const r = o.retention();
    const sweeps = await guarded(reply, 'the sweeps', () => lastSweeps(o.pool));
    if (!sweeps) return;
    const v: RetentionView = { config: r.config, rev_hash: r.rev_hash, last_sweeps: sweeps };
    return v;
  });

  return app;
}
