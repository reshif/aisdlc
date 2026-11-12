import {
  IssueTwinBatchRequest,
  IssueTwinBatchResult,
  IssueTwinLinkRequest,
  IssueTwinRequestRequest,
  IssueTwinRequestResult,
  IssueTwinView,
  PortalIssueTwinView,
  ProjectId,
  pdpResource,
  type ActionId,
} from '@aisdlc/contracts';
import type { Pdp } from '@aisdlc/pdp';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { CoreClient } from './core-client.js';

// The portal's issue twin (PLAN M16; OB §7; DEC-20(a)). Each route asks the PDP in this process for the signed-in
// principal (fail closed: no answer, an error or anything but `allow` is a 403), then calls core with the bff's service
// token and the principal from the session as `on_behalf_of` (a body that names one is refused). Core asks the PDP
// again for every call.
//
//   GET  /api/projects/:id/issue-twin              twins and their sync state, batches, candidates, `may`  (project.view)
//   POST /api/projects/:id/issue-twin/batches      approve a batch: the exact rows; the ledger binds them    (config.propose)
//   POST /api/projects/:id/issue-twin/links        link an issue already on GitHub as a gap's twin           (config.propose)
//   POST /api/projects/:id/issue-twin/requests     a twin's gap as a remediation request (N6, L2)            (work.request)

export interface IssueTwinRouteDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp;
  readonly core: CoreClient | undefined;
  readonly principalOf: (req: FastifyRequest) => string;
}

export const PortalIssueTwinBatchBody = IssueTwinBatchRequest.omit({ on_behalf_of: true });
export const PortalIssueTwinLinkBody = IssueTwinLinkRequest.omit({ on_behalf_of: true });
export const PortalIssueTwinRequestBody = IssueTwinRequestRequest.omit({ on_behalf_of: true });

export function registerIssueTwinRoutes(d: IssueTwinRouteDeps): void {
  const { app } = d;

  async function allowed(principal: string, action: ActionId, project: string): Promise<boolean> {
    try {
      const out = await d.pdp.decide({ principal, action, resource: pdpResource.project(project) });
      return out.decision === 'allow';
    } catch {
      return false;
    }
  }

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

  /** The project id, the core client and the PDP's yes; `null` once the reply is sent. */
  async function pre(
    req: FastifyRequest,
    reply: FastifyReply,
    action: ActionId,
  ): Promise<{ c: CoreClient; id: string; who: string } | null> {
    if (!d.core) {
      sendError(reply, 503, 'core_not_configured', 'the bff has no core to call');
      return null;
    }
    const id = ProjectId.safeParse((req.params as { id?: string }).id);
    if (!id.success) {
      sendError(reply, 400, 'invalid_input', 'bad project id');
      return null;
    }
    const who = d.principalOf(req);
    if (!(await allowed(who, action, id.data))) {
      sendError(reply, 403, 'forbidden', `${action} denied`);
      return null;
    }
    return { c: d.core, id: id.data, who };
  }

  app.get('/api/projects/:id/issue-twin', async (req, reply) => {
    const p = await pre(req, reply, 'project.view');
    if (!p) return;
    const v = upstream(
      reply,
      await p.c.call(
        'GET',
        `/v1/projects/${p.id}/issue-twin?on_behalf_of=${encodeURIComponent(p.who)}`,
      ),
      (x) => IssueTwinView.parse(x),
    );
    if (!v) return;
    return PortalIssueTwinView.parse({
      ...v,
      may: {
        propose: await allowed(p.who, 'config.propose', p.id),
        request: await allowed(p.who, 'work.request', p.id),
      },
    });
  });

  async function write<S extends z.ZodType<object>, T>(
    req: FastifyRequest,
    reply: FastifyReply,
    o: { schema: S; action: ActionId; path: string; parse: (v: unknown) => T },
  ) {
    const body = o.schema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const p = await pre(req, reply, o.action);
    if (!p) return;
    const r = await p.c.call('POST', `/v1/projects/${p.id}/issue-twin/${o.path}`, {
      ...body.data,
      on_behalf_of: p.who,
    });
    const v = upstream(reply, r, o.parse);
    if (v === null) return;
    return reply.code(r.reached && r.status === 201 ? 201 : 200).send(v);
  }

  app.post('/api/projects/:id/issue-twin/batches', (req, reply) =>
    write(req, reply, {
      schema: PortalIssueTwinBatchBody,
      action: 'config.propose',
      path: 'batches',
      parse: (v) => IssueTwinBatchResult.parse(v),
    }),
  );
  app.post('/api/projects/:id/issue-twin/links', (req, reply) =>
    write(req, reply, {
      schema: PortalIssueTwinLinkBody,
      action: 'config.propose',
      path: 'links',
      parse: (v) => v as { duplicate: boolean },
    }),
  );
  app.post('/api/projects/:id/issue-twin/requests', (req, reply) =>
    write(req, reply, {
      schema: PortalIssueTwinRequestBody,
      action: 'work.request',
      path: 'requests',
      parse: (v) => IssueTwinRequestResult.parse(v),
    }),
  );
}
