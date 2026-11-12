import { RepoFullName, WorkItemId } from '@aisdlc/contracts';
import type { LoopSupervisor } from '@aisdlc/loops';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { listMerges, listVerdicts } from './store.js';

/**
 * gate-check's HTTP surface (docs/specs/gate-check-api.md). It takes no command: nothing here writes, decides or
 * asks gate-check to pass anything. `GET /healthz` and `GET /metrics` are the loops' health (no credential, nothing
 * read from a repo); `GET /v1/verdicts` and `GET /v1/merges` (scope `read`: the bff, for the portal's gate-check run
 * status, M14.6) are the read models.
 */
export type GateCheckScope = 'read';

export interface GateCheckAppOptions {
  readonly supervisor: LoopSupervisor;
  readonly pool: Pick<pg.Pool, 'query'>;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly GateCheckScope[]>;
}

const VerdictsQuery = z.union([
  z.strictObject({ item: WorkItemId }),
  z.strictObject({ repo: RepoFullName, pr: z.coerce.number().int().min(1).optional() }),
]);
const MergesQuery = z.strictObject({ repo: RepoFullName });

export function createGateCheckApp(o: GateCheckAppOptions): FastifyInstance {
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
  app.get('/v1/verdicts', async (req, reply) => {
    const q = VerdictsQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'invalid_request', 'item, or repo (and pr)');
    const d = q.data;
    return {
      verdicts: await listVerdicts(
        o.pool,
        'item' in d
          ? { item: d.item }
          : d.pr === undefined
            ? { repo: d.repo }
            : { repo: d.repo, pr: d.pr },
      ),
    };
  });
  app.get('/v1/merges', async (req, reply) => {
    const q = MergesQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'invalid_request', 'repo is required');
    return { merges: await listMerges(o.pool, q.data.repo) };
  });
  return app;
}
