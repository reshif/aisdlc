import { SandboxSessionRequest, type SandboxErrorCode, type SandboxSlots } from '@aisdlc/contracts';
import { sandboxRunToWire, sandboxSpecFromWire } from '@aisdlc/ports';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SandboxController } from './controller.js';

/**
 * What a caller may do (docs/specs/sandbox-controller-api.md). `run`: start a session core granted (core-worker).
 * `read`: the slots (admission's H2). `admin`: reload the caps from the published config (an operator). A caller with
 * no entry may do nothing.
 */
export type ControllerScope = 'run' | 'read' | 'admin';

export interface ControllerAppOptions {
  readonly controller: SandboxController;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly ControllerScope[]>;
  /** Reads the caps again (`POST /v1/admin/reload`). */
  readonly reload: () => Promise<void>;
  /** The largest request body (a repo copy travels in it). Default 64 MiB. */
  readonly bodyLimit?: number;
}

/** The HTTP status of each refusal. */
export const CONTROLLER_STATUS: Readonly<Record<SandboxErrorCode, number>> = {
  invalid_spec: 400,
  exec_not_allowed: 403,
  b1_blocked: 403,
  refused: 403,
  busy: 409,
  unavailable: 503,
  driver_failure: 502,
};

export function createControllerApp(o: ControllerAppOptions): FastifyInstance {
  const app = newApp({ bodyLimit: o.bodyLimit ?? 64 * 1024 * 1024 });
  app.get('/healthz', async () => ({ ok: true }));

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null)
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    (req as unknown as { caller: string }).caller = caller;
  });
  const needs = (req: FastifyRequest, reply: FastifyReply, scope: ControllerScope): boolean => {
    const caller = (req as unknown as { caller: string }).caller;
    if ((o.callers[caller] ?? []).includes(scope)) return true;
    sendError(reply, 403, 'forbidden', `caller may not use scope ${scope}`);
    return false;
  };

  app.post('/v1/sessions', async (req, reply) => {
    if (!needs(req, reply, 'run')) return;
    const body = SandboxSessionRequest.safeParse(req.body ?? {});
    if (!body.success) {
      // a request with no grant reference is refused here: nothing starts that core did not grant
      const noGrant = typeof req.body === 'object' && req.body !== null && !('grant' in req.body);
      return noGrant
        ? sendError(
            reply,
            403,
            'refused',
            'no admission grant: nothing starts that core did not grant',
          )
        : sendError(reply, 400, 'invalid_spec', body.error.message.slice(0, 500));
    }
    const r = await o.controller.run(sandboxSpecFromWire(body.data));
    if (!r.ok)
      return sendError(reply, CONTROLLER_STATUS[r.error.code], r.error.code, r.error.message);
    return reply.send(sandboxRunToWire(r.value));
  });

  app.get('/v1/slots', async (req, reply): Promise<SandboxSlots | undefined> => {
    if (!needs(req, reply, 'read')) return;
    return o.controller.slots();
  });

  app.post('/v1/admin/reload', async (req, reply): Promise<SandboxSlots | undefined> => {
    if (!needs(req, reply, 'admin')) return;
    await o.reload();
    return o.controller.slots();
  });

  return app;
}
