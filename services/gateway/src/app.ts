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
//     revokes keys and creates budget groups; `read` reads them; `operate` (the bff, for a person its PDP
//     admitted: P2-5) reloads the adapters, tests one provider and reads the adapter list, and nothing
//     else. A virtual key is not a service token.
//
// The exact contract is in docs/specs/gateway-api.md.

export type GatewayScope = 'admin' | 'read' | 'operate';

export interface ReloadResult {
  /** The factory config revision the adapters now follow (null: nothing published yet). */
  readonly revision: string | null;
  /** One entry per enabled model provider of the registry: built, or refused with a code. */
  readonly integrations: ReadonlyArray<{
    integration_id: string;
    adapter: string;
    state: 'built' | 'refused';
    detail: string;
  }>;
}

export interface GatewayAppOptions {
  service: GatewayService;
  auth: ServiceAuth;
  callers: Record<string, readonly GatewayScope[]>;
  /**
   * The reload path (PLAN M10.4): re-read the published config now and rebuild the adapters that changed
   * (all of them with `force`, which is how a rotated key file is picked up), without a restart.
   */
  reload?: (opts: { force: boolean }) => Promise<ReloadResult>;
  /** What the adapters are, as of the last sync. */
  integrations?: () => ReloadResult;
  /** The deployment's bounds on a registry row (`GATEWAY_SECRET_REFS`, `GATEWAY_EGRESS_HOSTS`): references and hosts only. */
  bounds?: { readonly secret_refs: readonly string[]; readonly egress_hosts: readonly string[] };
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
    if ((req.body as { stream?: unknown } | null)?.stream === true) {
      // Server-sent events. A refusal is still a JSON error (no byte of the stream has been written
      // yet); once it starts, a failure is an `error` event and the end of the stream.
      const r = await o.service.stream(secretOf(req), req.body, header(req, 'x-aisdlc-data-class'));
      if (!r.ok) return messagesError(reply, r.error);
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // The client went away before the stream ended: stop the vendor call; what was made is charged.
      raw.on('close', () => {
        if (!raw.writableEnded) r.value.abort();
      });
      try {
        for await (const frame of r.value.frames) {
          if (raw.destroyed) break;
          if (!raw.write(frame)) {
            await new Promise<void>((resolve) => {
              const done = () => {
                raw.off('drain', done);
                raw.off('close', done);
                resolve();
              };
              raw.once('drain', done);
              raw.once('close', done);
            });
          }
        }
      } finally {
        if (!raw.destroyed) raw.end();
      }
      return reply;
    }
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
  const needs = (
    req: FastifyRequest,
    reply: FastifyReply,
    scope: GatewayScope,
    ...or: GatewayScope[]
  ): boolean => {
    const held = o.callers[callerOf(req)] ?? [];
    if ([scope, ...or].some((s) => held.includes(s))) return true;
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

  app.post('/v1/admin/reload', async (req, reply) => {
    if (!needs(req, reply, 'admin', 'operate')) return;
    if (!o.reload) return sendError(reply, 404, 'not_found', 'this gateway has no registry reload');
    const force = (req.body as { force?: unknown } | null)?.force === true;
    return reply.send(await o.reload({ force }));
  });

  app.get('/v1/admin/integrations', async (req, reply) => {
    if (!needs(req, reply, 'read', 'operate')) return;
    if (!o.integrations) return sendError(reply, 404, 'not_found', 'this gateway has no registry');
    return reply.send({
      ...o.integrations(),
      bounds: {
        secret_refs: [...(o.bounds?.secret_refs ?? [])],
        egress_hosts: [...(o.bounds?.egress_hosts ?? [])],
      },
    });
  });

  // P2-5: one tiny metered call to one provider (the operator's connection test); never any text in or out
  app.post('/v1/admin/providers/:id/test', async (req, reply) => {
    if (!needs(req, reply, 'admin', 'operate')) return;
    const by = (req.body as { tested_by?: unknown } | null)?.tested_by;
    if (typeof by !== 'string' || by.length === 0 || by.length > 128) {
      return sendError(reply, 400, 'invalid_request', 'tested_by names who asked');
    }
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(id(req))) {
      return sendError(reply, 400, 'invalid_request', 'bad provider id');
    }
    return reply.send(await o.service.testProvider(id(req), by));
  });

  return app;
}
