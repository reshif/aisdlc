import { GitSha, Sha256Hex, VerifyRunRequest, WorkItemId } from '@aisdlc/contracts';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { VerifyService } from './service.js';
import { resultByHash, resultsOf } from './store.js';

/**
 * What a caller may do (docs/specs/verify-api.md). `run`: run a step's check (core-worker's verify stage port). `read`:
 * the recorded results (core-worker's 7.6 guard; later the Evidence Pack and the portal). A caller with no entry may
 * do nothing.
 */
export type VerifyScope = 'run' | 'read';

export interface VerifyAppOptions {
  readonly service: VerifyService;
  readonly pool: pg.Pool;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly VerifyScope[]>;
  readonly bodyLimit?: number;
  readonly log?: (line: string) => void;
}

const ResultsQuery = z.strictObject({ item: WorkItemId, head: GitSha });

export function createVerifyApp(o: VerifyAppOptions): FastifyInstance {
  const app = newApp({ bodyLimit: o.bodyLimit ?? 4 * 1024 * 1024 });
  app.get('/healthz', async () => ({ ok: true }));

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null)
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    (req as unknown as { caller: string }).caller = caller;
  });
  const needs = (req: FastifyRequest, reply: FastifyReply, scope: VerifyScope): boolean => {
    const caller = (req as unknown as { caller: string }).caller;
    if ((o.callers[caller] ?? []).includes(scope)) return true;
    sendError(reply, 403, 'forbidden', `caller may not use scope ${scope}`);
    return false;
  };

  app.post('/v1/checks', async (req, reply) => {
    if (!needs(req, reply, 'run')) return;
    const body = VerifyRunRequest.safeParse(req.body ?? {});
    // the body may hold a gateway key: an invalid one is answered with field paths only, never its values
    if (!body.success) {
      return sendError(
        reply,
        400,
        'invalid_request',
        body.error.issues
          .map((i) => i.path.join('.') || '(body)')
          .join(', ')
          .slice(0, 500),
      );
    }
    try {
      const r = await o.service.run(body.data);
      if (!r.ok) return sendError(reply, 503, 'unavailable', r.error.message.slice(0, 300));
      return reply.send(r.value);
    } catch (e) {
      o.log?.(`checks: ${e instanceof Error ? e.constructor.name : 'error'}`);
      return sendError(reply, 503, 'unavailable', 'the check could not be recorded');
    }
  });

  app.get('/v1/results', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const q = ResultsQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'invalid_request', 'item and head are required');
    const rows = await resultsOf(o.pool, q.data.item, q.data.head);
    return { results: rows.map((r) => r.result) };
  });

  app.get('/v1/results/:sha', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const sha = Sha256Hex.safeParse((req.params as { sha?: string }).sha);
    if (!sha.success) return sendError(reply, 400, 'invalid_request', 'a sha256');
    const r = await resultByHash(o.pool, sha.data);
    if (!r) return sendError(reply, 404, 'not_found', 'no such result');
    return { result_sha256: r.result_sha256, result: r.result };
  });

  return app;
}
