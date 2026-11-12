import {
  AUDIT_ACTION,
  AuditExportList,
  AuditExportRequest,
  AuditExportView,
  ErasureApproveInput,
  ErasureList,
  ErasureRejectInput,
  ErasureRequestInput,
  ErasureView,
  LegalHoldList,
  LegalHoldView,
  PlaceHoldRequest,
  ProjectId,
  ReleaseHoldRequest,
  RetentionView,
  SignedExportBytes,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import type { Pdp } from '@aisdlc/pdp';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';

// Govern › Audit (PLAN M19; docs/specs/audit-api.md), in front of the audit service:
//
//   GET  /api/audit/exports[?project=]        the signed exports (audit.read on the project, or on the fleet)
//   POST /api/audit/exports                   write one {scope, from, to, reason}            (audit.read on the scope)
//   GET  /api/audit/exports/:id               one export                                       (audit.read on its scope)
//   GET  /api/audit/exports/:id/signed        the signed bytes for `aisdlc verify-export`, re-hashed to their key here
//   GET  /api/audit/holds                     legal holds                                      (audit.read, fleet)
//   POST /api/audit/holds                     place one {scope, matter_ref, reason}          (identity.admin, fleet)
//   POST /api/audit/holds/:id/release         release one {reason}: never by the person who placed it
//   GET  /api/audit/erasures                  erasure requests                                 (audit.read, fleet)
//   POST /api/audit/erasures                  request one {subject, reason}                  (identity.admin, fleet)
//   POST /api/audit/erasures/:id/approve      the legal approval {matter_ref, reason}: never the requester
//   POST /api/audit/erasures/:id/reject       {reason}
//   GET  /api/audit/retention                 the retention classes in force and the last sweeps (audit.read, fleet)
//
// The person is ALWAYS the session's (`on_behalf_of` is added here, never taken from the body). The PDP decides here
// first and again in the audit service. Erasure and legal hold are `identity.admin` on the fleet (`AUDIT_ACTION.govern`,
// factory admins only; PLAN §7a, 2026-11-12). Without the audit service these routes answer 503 and nothing else in the portal is affected.

export interface AuditRouteDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp;
  readonly audit: CoreClient | undefined;
  readonly principalOf: (req: FastifyRequest) => string;
}

const ListQuery = z.strictObject({ project: ProjectId.optional() });
const Id = z.uuid();

export function registerAuditRoutes(d: AuditRouteDeps): void {
  const { app } = d;

  async function allowed(
    reply: FastifyReply,
    principal: string,
    action: ActionId,
    resource: PdpResource,
  ): Promise<boolean> {
    try {
      if ((await d.pdp.decide({ principal, action, resource })).decision === 'allow') return true;
    } catch {
      /* an error is a refusal */
    }
    sendError(reply, 403, 'forbidden', `${action} is needed`);
    return false;
  }

  const audit = (reply: FastifyReply): CoreClient | null => {
    if (d.audit) return d.audit;
    sendError(reply, 503, 'audit_not_configured', 'the audit service is not configured');
    return null;
  };

  async function upstream<T>(
    reply: FastifyReply,
    c: CoreClient,
    method: 'GET' | 'POST',
    path: string,
    parse: (v: unknown) => T,
    body?: unknown,
  ): Promise<T | null> {
    const r = await c.call(method, path, body);
    if (!r.reached || r.status >= 500) {
      const e = (r.reached ? (r.json as { error?: { message?: unknown } } | null) : null)?.error;
      sendError(
        reply,
        502,
        'audit_unavailable',
        typeof e?.message === 'string'
          ? e.message.slice(0, 200)
          : 'the audit service could not answer',
      );
      return null;
    }
    if (r.status < 200 || r.status >= 300) {
      const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      sendError(
        reply,
        r.status === 401 ? 502 : r.status,
        typeof e?.code === 'string' ? e.code : 'refused',
        typeof e?.message === 'string' ? e.message : 'the request was refused',
      );
      return null;
    }
    try {
      return parse(r.json);
    } catch {
      sendError(reply, 502, 'audit_error', 'the audit service sent something unexpected');
      return null;
    }
  }

  const who = (req: FastifyRequest) => d.principalOf(req);
  const q = (req: FastifyRequest, extra: Record<string, string> = {}) =>
    new URLSearchParams({ on_behalf_of: who(req), ...extra }).toString();
  const idOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const p = Id.safeParse((req.params as { id?: string }).id);
    if (p.success) return p.data;
    sendError(reply, 400, 'invalid_input', 'bad id');
    return null;
  };
  const fleet = pdpResource.fleet();

  // ------------------------------------------------------------ exports

  app.get('/api/audit/exports', async (req, reply) => {
    const c = audit(reply);
    if (!c) return;
    const p = ListQuery.safeParse(req.query);
    if (!p.success) return sendError(reply, 400, 'invalid_input', 'project is a project id');
    const res = p.data.project ? pdpResource.project(p.data.project) : fleet;
    if (!(await allowed(reply, who(req), AUDIT_ACTION.read, res))) return;
    return upstream(
      reply,
      c,
      'GET',
      `/v1/exports?${q(req, p.data.project ? { project: p.data.project } : {})}`,
      (v) => AuditExportList.parse(v),
    );
  });

  app.post('/api/audit/exports', async (req, reply) => {
    const c = audit(reply);
    if (!c) return;
    const b = AuditExportRequest.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message.slice(0, 300));
    const res =
      b.data.scope.kind === 'fleet' ? fleet : pdpResource.project(b.data.scope.project_id);
    if (!(await allowed(reply, who(req), AUDIT_ACTION.export, res))) return;
    const r = await upstream(reply, c, 'POST', '/v1/exports', (v) => AuditExportView.parse(v), {
      ...b.data,
      on_behalf_of: who(req),
    });
    return r && reply.code(201).send(r);
  });

  app.get('/api/audit/exports/:id', async (req, reply) => {
    const c = audit(reply);
    const id = c ? idOf(req, reply) : null;
    if (!c || !id) return;
    return upstream(reply, c, 'GET', `/v1/exports/${id}?${q(req)}`, (v) =>
      AuditExportView.parse(v),
    );
  });

  /** The exact signed bytes, checked against their object key before a byte is sent. */
  app.get('/api/audit/exports/:id/signed', async (req, reply) => {
    const c = audit(reply);
    const id = c ? idOf(req, reply) : null;
    if (!c || !id) return;
    const got = await upstream(reply, c, 'GET', `/v1/exports/${id}/signed?${q(req)}`, (v) =>
      SignedExportBytes.parse(v),
    );
    if (!got) return;
    const bytes = Buffer.from(got.bytes_b64, 'base64');
    if (sha256Hex(bytes) !== got.object_key) {
      return sendError(
        reply,
        502,
        'audit_error',
        'the signed export does not hash to its object key',
      );
    }
    return reply
      .type('application/json')
      .header('content-disposition', `attachment; filename="audit-export-${got.object_key}.json"`)
      .send(bytes);
  });

  // ------------------------------------------------------------ legal holds

  app.get('/api/audit/holds', async (req, reply) => {
    const c = audit(reply);
    if (!c) return;
    if (!(await allowed(reply, who(req), AUDIT_ACTION.read, fleet))) return;
    return upstream(reply, c, 'GET', `/v1/holds?${q(req)}`, (v) => LegalHoldList.parse(v));
  });

  app.post('/api/audit/holds', async (req, reply) => {
    const c = audit(reply);
    if (!c) return;
    const b = PlaceHoldRequest.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message.slice(0, 300));
    if (!(await allowed(reply, who(req), AUDIT_ACTION.govern, fleet))) return;
    const r = await upstream(reply, c, 'POST', '/v1/holds', (v) => LegalHoldView.parse(v), {
      ...b.data,
      on_behalf_of: who(req),
    });
    return r && reply.code(201).send(r);
  });

  app.post('/api/audit/holds/:id/release', async (req, reply) => {
    const c = audit(reply);
    const id = c ? idOf(req, reply) : null;
    if (!c || !id) return;
    const b = ReleaseHoldRequest.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message.slice(0, 300));
    if (!(await allowed(reply, who(req), AUDIT_ACTION.govern, fleet))) return;
    return upstream(reply, c, 'POST', `/v1/holds/${id}/release`, (v) => LegalHoldView.parse(v), {
      ...b.data,
      on_behalf_of: who(req),
    });
  });

  // ------------------------------------------------------------ erasure

  app.get('/api/audit/erasures', async (req, reply) => {
    const c = audit(reply);
    if (!c) return;
    if (!(await allowed(reply, who(req), AUDIT_ACTION.read, fleet))) return;
    return upstream(reply, c, 'GET', `/v1/erasures?${q(req)}`, (v) => ErasureList.parse(v));
  });

  app.post('/api/audit/erasures', async (req, reply) => {
    const c = audit(reply);
    if (!c) return;
    const b = ErasureRequestInput.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message.slice(0, 300));
    if (!(await allowed(reply, who(req), AUDIT_ACTION.govern, fleet))) return;
    const r = await upstream(reply, c, 'POST', '/v1/erasures', (v) => ErasureView.parse(v), {
      ...b.data,
      on_behalf_of: who(req),
    });
    return r && reply.code(201).send(r);
  });

  for (const verb of ['approve', 'reject'] as const) {
    app.post(`/api/audit/erasures/:id/${verb}`, async (req, reply) => {
      const c = audit(reply);
      const id = c ? idOf(req, reply) : null;
      if (!c || !id) return;
      const b = (verb === 'approve' ? ErasureApproveInput : ErasureRejectInput).safeParse(
        req.body ?? {},
      );
      if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message.slice(0, 300));
      if (!(await allowed(reply, who(req), AUDIT_ACTION.govern, fleet))) return;
      return upstream(reply, c, 'POST', `/v1/erasures/${id}/${verb}`, (v) => ErasureView.parse(v), {
        ...b.data,
        on_behalf_of: who(req),
      });
    });
  }

  // ------------------------------------------------------------ retention

  app.get('/api/audit/retention', async (req, reply) => {
    const c = audit(reply);
    if (!c) return;
    if (!(await allowed(reply, who(req), AUDIT_ACTION.read, fleet))) return;
    return upstream(reply, c, 'GET', `/v1/retention?${q(req)}`, (v) => RetentionView.parse(v));
  });
}
