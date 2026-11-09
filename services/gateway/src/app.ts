import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayFailure, GatewayService } from './service.js';

// HTTP in front of the gateway. Two audiences, two kinds of credential, no overlap:
//
//   SANDBOX (and anything else that wants a model): `POST /v1/messages`, an Anthropic Messages
//     compatible endpoint. The credential is a VIRTUAL KEY (`aisk_...`), sent the way Anthropic's SDKs
//     send an API key (`x-api-key: <key>`, or `Authorization: Bearer <key>`). A virtual key opens
//     nothing else: not the admin API, not another key's budget.
//   ADMIN (the work engine in core): `/v1/admin/*` with a SERVICE TOKEN and a scope. `admin` mints and
//     revokes keys and creates budget groups; `read` reads them. A virtual key is not a service token.
//
// The exact contract is in docs/specs/gateway-api.md.

export type GatewayScope = 'admin' | 'read';

export interface GatewayAppOptions {
  service: GatewayService;
  auth: ServiceAuth;
  callers: Record<string, readonly GatewayScope[]>;
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const secretOf = (req: FastifyRequest): string => {
  const k = header(req, 'x-api-key');
  if (k) return k;
  return /^Bearer (\S+)$/.exec(header(req, 'authorization') ?? '')?.[1] ?? '';
};

export function createGatewayApp(o: GatewayAppOptions): FastifyInstance {
  const app = newApp();
  app.get('/healthz', async () => ({ ok: true }));

  // Never echo a request back (a body can hold what redaction exists for) and never reveal internals.
  app.setErrorHandler((e: { statusCode?: number }, _req, reply) => {
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(status).send({
      type: 'error',
      error: {
        type: status === 500 ? 'api_error' : 'invalid_request_error',
        code: status === 500 ? 'internal' : 'invalid_request',
        message: status === 500 ? 'internal error' : 'the request could not be read',
      },
    });
  });

  const messagesError = (reply: FastifyReply, f: GatewayFailure) =>
    reply
      .code(f.status)
      .send({ type: 'error', error: { type: f.type, code: f.code, message: f.message } });

  app.post('/v1/messages', async (req, reply) => {
    const r = await o.service.complete(secretOf(req), req.body, header(req, 'x-aisdlc-data-class'));
    return r.ok ? reply.send(r.value) : messagesError(reply, r.error);
  });

  // ------------------------------------------------------------ admin

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/admin/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null) {
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    }
    (req as unknown as { caller: string }).caller = caller;
  });
  const callerOf = (req: FastifyRequest) => (req as unknown as { caller: string }).caller;
  const needs = (req: FastifyRequest, reply: FastifyReply, scope: GatewayScope): boolean => {
    if ((o.callers[callerOf(req)] ?? []).includes(scope)) return true;
    sendError(reply, 403, 'forbidden', `caller may not use scope ${scope}`);
    return false;
  };
  const adminFail = (reply: FastifyReply, f: GatewayFailure) =>
    sendError(reply, f.status === 429 ? 409 : f.status, f.code, f.message);
  const id = (req: FastifyRequest) => (req.params as Record<string, string>)['id'] as string;

  app.post('/v1/admin/budget-groups', async (req, reply) => {
    if (!needs(req, reply, 'admin')) return;
    const r = await o.service.createBudgetGroup(req.body);
    if (!r.ok) return adminFail(reply, r.error);
    return reply.code(r.value.created ? 201 : 200).send(r.value.group);
  });

  app.get('/v1/admin/budget-groups/:id', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const g = await o.service.budgetGroup(id(req));
    return g ? reply.send(g) : sendError(reply, 404, 'not_found', 'no such budget group');
  });

  app.post('/v1/admin/vkeys', async (req, reply) => {
    if (!needs(req, reply, 'admin')) return;
    const r = await o.service.mintVKey(req.body, callerOf(req));
    if (!r.ok) return adminFail(reply, r.error);
    // The secret is in this one response and nowhere else.
    return reply.code(201).send(r.value);
  });

  app.get('/v1/admin/vkeys/:id', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const v = await o.service.vkey(id(req));
    return v ? reply.send(v) : sendError(reply, 404, 'not_found', 'no such key');
  });

  app.post('/v1/admin/vkeys/:id/revoke', async (req, reply) => {
    if (!needs(req, reply, 'admin')) return;
    const v = await o.service.revoke(id(req), callerOf(req));
    return v ? reply.send(v) : sendError(reply, 404, 'not_found', 'no such key');
  });

  return app;
}
