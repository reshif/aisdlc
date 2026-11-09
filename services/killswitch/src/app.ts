import { KillQuery, PrincipalId } from '@aisdlc/contracts';
import type { ServiceAuth } from '@aisdlc/service-kit';
import { newApp, sendError } from '@aisdlc/service-kit';
import type { Result } from '@aisdlc/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KILLSWITCH_STATUS, killswitchError, type KillswitchError } from './errors.js';
import type { KillService } from './service.js';

/**
 * What a caller may do. `act`: ask for a kill, a release approval or a delegation on behalf of a signed-in
 * human (the portal's BFF; the PDP decides about that human, with the kill switch's own facts). `read`:
 * the status enforcement points ask, the journal core observes, the lists. `sync`: push who holds what
 * for a project (core-worker). A caller with no entry may do nothing.
 */
export type KillswitchScope = 'act' | 'read' | 'sync';

export interface KillswitchAppOptions {
  service: KillService;
  auth: ServiceAuth;
  callers: Record<string, readonly KillswitchScope[]>;
}

const Who = { on_behalf_of: PrincipalId };
const KillBody = z.strictObject({ ...Who, scope: z.unknown(), reason: z.string().min(1).max(500) });
const ReleaseBody = z.strictObject({ ...Who });
const DelegateBody = z.strictObject({ ...Who, delegate: z.string().min(1), scope: z.unknown() });
const HoldersBody = z.strictObject({
  admins: z.array(z.string().min(1)),
  kill_holders: z.array(z.string().min(1)),
  tier: z.enum(['T0', 'T1', 'T2']).nullable(),
  two_person: z.boolean(),
});

/** HTTP in front of the `KillService`. Every route needs a service token. */
export function createKillswitchApp(o: KillswitchAppOptions): FastifyInstance {
  const app = newApp();
  app.get('/healthz', async () => ({ ok: true }));

  const fail = (reply: FastifyReply, e: KillswitchError) =>
    reply.code(KILLSWITCH_STATUS[e.code]).send({
      error: { code: e.code, message: e.message, ...(e.reasons ? { reasons: e.reasons } : {}) },
    });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null)
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    (req as unknown as { caller: string }).caller = caller;
  });

  const needs = (req: FastifyRequest, reply: FastifyReply, scope: KillswitchScope): boolean => {
    const caller = (req as unknown as { caller: string }).caller;
    if ((o.callers[caller] ?? []).includes(scope)) return true;
    fail(reply, killswitchError('forbidden', `caller may not use scope ${scope}`));
    return false;
  };
  const params = (req: FastifyRequest) => req.params as Record<string, string>;
  const query = (req: FastifyRequest) => req.query as Record<string, string | undefined>;

  async function run<T>(
    reply: FastifyReply,
    r: Promise<Result<T, KillswitchError>>,
    code = 200,
  ): Promise<unknown> {
    const v = await r;
    return v.ok ? reply.code(code).send(v.value) : fail(reply, v.error);
  }
  const body = <S extends z.ZodType>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
  ): z.infer<S> | null => {
    const p = schema.safeParse(req.body ?? {});
    if (p.success) return p.data;
    fail(reply, killswitchError('invalid_request', p.error.message));
    return null;
  };

  // ------------------------------------------------------------ what enforcement points read

  app.get('/v1/status', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const q = KillQuery.safeParse({
      project_id: query(req)['project_id'],
      ...(query(req)['lane'] ? { lane: query(req)['lane'] } : {}),
      ...(query(req)['session_id'] ? { session_id: query(req)['session_id'] } : {}),
    });
    if (!q.success) return fail(reply, killswitchError('invalid_request', q.error.message));
    return run(reply, o.service.status(q.data));
  });

  app.get('/v1/kills', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const project = query(req)['project_id'];
    return run(
      reply,
      o.service.listKills({
        active: query(req)['active'] === '1',
        ...(project ? { project_id: project } : {}),
      }),
    );
  });

  app.get('/v1/events', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const after = Number(query(req)['after'] ?? 0);
    const limit = Number(query(req)['limit'] ?? 200);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1) {
      return fail(reply, killswitchError('invalid_request', 'after and limit are integers'));
    }
    const events = await o.service.events(after, limit);
    if (!events.ok) return fail(reply, events.error);
    const key = await o.service.journalKey();
    return reply.send({ events: events.value, ...(key.ok ? { key: key.value } : {}) });
  });

  app.get('/v1/delegations', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const project = query(req)['project_id'];
    if (!project) return fail(reply, killswitchError('invalid_request', 'project_id is needed'));
    return run(reply, o.service.listDelegations(project));
  });

  /** What a human may do here (the portal shows the kill button only to a holder: the PDP decides). */
  app.get('/v1/capabilities', async (req, reply) => {
    if (!needs(req, reply, 'read')) return;
    const who = PrincipalId.safeParse(query(req)['on_behalf_of']);
    if (!who.success)
      return fail(reply, killswitchError('invalid_request', 'on_behalf_of is needed'));
    return run(
      reply,
      o.service.capabilities(who.data, { project_id: query(req)['project_id'] ?? null }),
    );
  });

  // ------------------------------------------------------------ what a human does

  app.post('/v1/kills', async (req, reply) => {
    if (!needs(req, reply, 'act')) return;
    const b = body(req, reply, KillBody);
    if (!b) return;
    return run(
      reply,
      o.service.requestKill(b.on_behalf_of, { scope: b.scope, reason: b.reason }),
      201,
    );
  });

  app.post('/v1/kills/:id/release', async (req, reply) => {
    if (!needs(req, reply, 'act')) return;
    const b = body(req, reply, ReleaseBody);
    if (!b) return;
    return run(reply, o.service.approveRelease(b.on_behalf_of, params(req)['id'] as string));
  });

  app.post('/v1/delegations', async (req, reply) => {
    if (!needs(req, reply, 'act')) return;
    const b = body(req, reply, DelegateBody);
    if (!b) return;
    return run(
      reply,
      o.service.grantDelegation(b.on_behalf_of, { delegate: b.delegate, scope: b.scope }),
      201,
    );
  });

  app.post('/v1/delegations/:id/revoke', async (req, reply) => {
    if (!needs(req, reply, 'act')) return;
    const b = body(req, reply, ReleaseBody);
    if (!b) return;
    return run(reply, o.service.revokeDelegation(b.on_behalf_of, params(req)['id'] as string));
  });

  // ------------------------------------------------------------ what core-worker pushes

  app.put('/v1/holders/:project', async (req, reply) => {
    if (!needs(req, reply, 'sync')) return;
    const b = body(req, reply, HoldersBody);
    if (!b) return;
    return run(reply, o.service.syncHolders(params(req)['project'] as string, b));
  });

  return app;
}
