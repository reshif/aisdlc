import { WorkItemId } from '@aisdlc/contracts';
import type { LoopSupervisor } from '@aisdlc/loops';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { releasesOf } from './store.js';

/**
 * gate-relay's HTTP surface (docs/specs/gate-relay-api.md). It takes no command: nothing here writes, decides, deploys
 * or asks gate-relay to release anything. `GET /healthz` and `GET /metrics` are the loops' health (no credential);
 * `GET /v1/releases?item=` (scope `read`: the bff, for the portal's release status) is the read model.
 */
export type GateRelayScope = 'read';

export interface GateRelayAppOptions {
  readonly supervisor: LoopSupervisor;
  readonly pool: Pick<pg.Pool, 'query'>;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly GateRelayScope[]>;
}

const ReleasesQuery = z.strictObject({ item: WorkItemId });

export function createGateRelayApp(o: GateRelayAppOptions): FastifyInstance {
  const app = newApp();
  app.get('/healthz', async (_req, reply) => {
    const report = o.supervisor.health();
    return reply.code(report.status === 'ok' ? 200 : 503).send(report);
  });
  app.get('/metrics', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4').send(o.supervisor.prometheus()),
  );
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null)
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    if (!(o.callers[caller] ?? []).includes('read'))
      return sendError(reply, 403, 'forbidden', 'caller may not use scope read');
  });
  app.get('/v1/releases', async (req, reply) => {
    const q = ReleasesQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'invalid_request', 'item is required');
    return releasesOf(o.pool, q.data.item);
  });
  return app;
}
