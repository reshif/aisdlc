import {
  WITNESS_STATUS,
  WitnessCosignRequest,
  type WitnessErrorCode,
  type WitnessPort,
} from '@aisdlc/ports';
import type { ServiceAuth } from '@aisdlc/service-kit';
import { newApp, sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface WitnessAppOptions {
  service: WitnessPort;
  auth: ServiceAuth;
  /** Callers that may ask for co-signatures (the checkpointer). */
  callers: readonly string[];
}

/** HTTP in front of a `WitnessPort`. Every route needs a service token of an allowed caller. */
export function createWitnessApp(opts: WitnessAppOptions): FastifyInstance {
  const app = newApp();
  app.get('/healthz', async () => ({ ok: true }));

  const fail = (reply: FastifyReply, code: WitnessErrorCode, message: string) =>
    sendError(reply, WITNESS_STATUS[code], code, message);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = opts.auth.authenticate(req.headers.authorization);
    if (caller === null) return fail(reply, 'unauthenticated', 'missing or unknown service token');
    if (!opts.callers.includes(caller))
      return fail(reply, 'forbidden', 'caller may not use the witness');
  });

  app.post('/v1/cosign', async (req, reply) => {
    const body = WitnessCosignRequest.safeParse(req.body);
    if (!body.success) return fail(reply, 'invalid_request', body.error.message);
    const r = await opts.service.cosign(body.data);
    if (!r.ok) return fail(reply, r.error.code, r.error.message);
    return { checkpoint: r.value };
  });

  app.get('/v1/last', async (_req, reply) => {
    const r = await opts.service.last();
    if (!r.ok) return fail(reply, r.error.code, r.error.message);
    return { checkpoint: r.value };
  });

  return app;
}
