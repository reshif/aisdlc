import {
  AccessProposeRequest,
  AccessRequestCreate,
  PrincipalId,
  RevisionDecideRequest,
  RevisionEvidenceRequest,
  RevisionPrepareRequest,
  Scope,
  accessResourceOf,
  parseScopeKey,
  type AccessChange,
  type AccessGrantProposedPayload,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { DecisionDeps } from '@aisdlc/decisions';
import type { Result } from '@aisdlc/kernel';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import {
  accessGrantView,
  applyAccess,
  decideAccess,
  listAccessGrants,
  listBindings,
  prepareAccess,
  proposeAccess,
  recordAccessEvidence,
  type AccessDeps,
} from './access-grants.js';
import type { AccessGrantWriterPort } from './clients.js';
import { CORE_STATUS, coreError, type CoreError } from './errors.js';

// P1-6's routes, for the bff acting for a signed-in person (`on_behalf_of`, scope portal). Each write asks the PDP for
// `access.manage` on the change's scope (the project, or the fleet) first; fail closed: no PDP, an error or anything
// but `allow` is a refusal. Then `access-grants.ts` checks the rest, and the M1 gate decides.
//
//   GET  /v1/access/grants?on_behalf_of=            the proposals the person may see: their own, the ones naming them,
//                                                    and those on a scope where they hold access.manage
//   GET  /v1/access/grants/:id?on_behalf_of=        one of those
//   POST /v1/access/grants                          propose a grant or a revoke               (access.manage)
//   POST /v1/access/requests                        ask for a role for oneself (no action: anyone signed in may ask;
//                                                    deciding it is the same M1 as any grant)
//   POST /v1/access/grants/:id/prepare|evidence|decide                                       (access.manage)
//   POST /v1/access/grants/:id/apply                retry writing an approved grant to identity (access.manage)
//   GET  /v1/access/bindings?on_behalf_of=&scope=   the bindings at the fleet or a project    (access.manage)

export interface AccessRouteDeps {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly decisions: DecisionDeps | undefined;
  readonly writer: AccessGrantWriterPort | undefined;
  readonly allowed: (req: FastifyRequest, scope: 'portal') => boolean;
  readonly guard: (
    reply: FastifyReply,
    principal: string,
    action: ActionId,
    resource: PdpResource,
  ) => Promise<boolean>;
  /** The PDP's answer without a reply (to filter a list). Anything but allow is false. */
  readonly may: (principal: string, action: ActionId, resource: PdpResource) => Promise<boolean>;
}

const Who = z.strictObject({ on_behalf_of: PrincipalId });
const BindingsQuery = z.strictObject({ on_behalf_of: PrincipalId, scope: z.string().min(1) });

const granteeOf = (c: AccessChange): string | null =>
  c.op === 'grant' && c.target.kind === 'principal' ? c.target.principal_id : null;

export function registerAccessRoutes(r: AccessRouteDeps): void {
  const { app } = r;
  const fail = (reply: FastifyReply, e: CoreError) =>
    sendError(reply, CORE_STATUS[e.code], e.code, e.message);
  const send = (reply: FastifyReply, x: Result<unknown, CoreError>, code = 200) =>
    x.ok ? reply.code(code).send(x.value) : fail(reply, x.error);
  const parse = <S extends z.ZodType>(reply: FastifyReply, s: S, v: unknown): z.infer<S> | null => {
    const p = s.safeParse(v ?? {});
    if (p.success) return p.data;
    fail(reply, coreError('invalid_input', p.error.message));
    return null;
  };
  /** The scope check and the kernel, or the refusal sent. */
  const ready = (req: FastifyRequest, reply: FastifyReply): AccessDeps | null => {
    if (!r.allowed(req, 'portal')) {
      sendError(reply, 403, 'forbidden', 'scope portal is needed');
      return null;
    }
    if (!r.decisions) {
      fail(reply, coreError('unavailable', 'no decision kernel is configured'));
      return null;
    }
    return { pool: r.pool, decisions: r.decisions, writer: r.writer };
  };
  const grantId = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const id = (req.params as { id?: string }).id;
    if (z.uuid().safeParse(id).success) return id as string;
    fail(reply, coreError('invalid_input', 'bad id'));
    return null;
  };
  /** Who may see a proposal: its proposer, the person it names, and an access.manage holder on its scope. */
  const sees = async (who: string, p: Pick<AccessGrantProposedPayload, 'proposed_by' | 'change'>) =>
    p.proposed_by === who ||
    granteeOf(p.change) === who ||
    (await r.may(who, 'access.manage', accessResourceOf(p.change.scope)));

  app.get('/v1/access/grants', async (req, reply) => {
    const d = ready(req, reply);
    const q = d ? parse(reply, Who, req.query) : null;
    if (!d || !q) return;
    return { grants: await listAccessGrants(d, (p) => sees(q.on_behalf_of, p)) };
  });

  app.get('/v1/access/grants/:id', async (req, reply) => {
    const d = ready(req, reply);
    const q = d ? parse(reply, Who, req.query) : null;
    const id = q ? grantId(req, reply) : null;
    if (!d || !q || !id) return;
    const v = await accessGrantView(d, id);
    // one answer for missing and invisible
    if (!v.ok || !(await sees(q.on_behalf_of, v.value))) {
      return fail(reply, coreError('not_found', `no access grant ${id}`));
    }
    return v.value;
  });

  app.post('/v1/access/grants', async (req, reply) => {
    const d = ready(req, reply);
    const b = d ? parse(reply, AccessProposeRequest, req.body) : null;
    if (!d || !b) return;
    const res = accessResourceOf(b.change.scope);
    if (!(await r.guard(reply, b.on_behalf_of, 'access.manage', res))) return;
    return send(
      reply,
      await proposeAccess(d, {
        by: b.on_behalf_of,
        change: b.change,
        reason: b.reason,
        origin: 'admin',
      }),
      201,
    );
  });

  app.post('/v1/access/requests', async (req, reply) => {
    const d = ready(req, reply);
    const b = d ? parse(reply, AccessRequestCreate, req.body) : null;
    if (!d || !b) return;
    return send(
      reply,
      await proposeAccess(d, {
        by: b.on_behalf_of,
        change: {
          op: 'grant',
          target: { kind: 'principal', principal_id: b.on_behalf_of },
          role_id: b.role_id,
          scope: b.scope,
          expiry: b.expiry,
        },
        reason: b.reason,
        origin: 'request',
      }),
      201,
    );
  });

  /** A decision on a grant's gate: the PDP's `access.manage` on its scope, then the kernel. */
  async function decision<S extends z.ZodType<{ on_behalf_of: string }>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    run: (d: AccessDeps, id: string, b: z.infer<S>) => Promise<Result<unknown, CoreError>>,
  ) {
    const d = ready(req, reply);
    const id = d ? grantId(req, reply) : null;
    const b = id ? parse(reply, schema, req.body) : null;
    if (!d || !id || !b) return;
    const v = await accessGrantView(d, id);
    if (!v.ok) return fail(reply, v.error);
    const res = accessResourceOf(v.value.change.scope);
    if (!(await r.guard(reply, b.on_behalf_of, 'access.manage', res))) return;
    return send(reply, await run(d, id, b));
  }

  app.post('/v1/access/grants/:id/prepare', (req, reply) =>
    decision(req, reply, RevisionPrepareRequest, (d, id, b) =>
      prepareAccess(d, { grant_id: id, principal: b.on_behalf_of }),
    ),
  );
  app.post('/v1/access/grants/:id/evidence', (req, reply) =>
    decision(req, reply, RevisionEvidenceRequest, (d, id, b) =>
      recordAccessEvidence(d, {
        grant_id: id,
        principal: b.on_behalf_of,
        nonce: b.nonce,
        evidence_hash: b.evidence_hash,
      }),
    ),
  );
  app.post('/v1/access/grants/:id/decide', (req, reply) =>
    decision(req, reply, RevisionDecideRequest, (d, id, b) =>
      decideAccess(d, {
        grant_id: id,
        principal: b.on_behalf_of,
        nonce: b.nonce,
        decision: b.decision,
        step_up: b.step_up,
      }),
    ),
  );
  app.post('/v1/access/grants/:id/apply', (req, reply) =>
    decision(req, reply, Who, (d, id) => applyAccess(d, id)),
  );

  app.get('/v1/access/bindings', async (req, reply) => {
    const d = ready(req, reply);
    const q = d ? parse(reply, BindingsQuery, req.query) : null;
    if (!d || !q) return;
    const s = parseScopeKey(q.scope);
    const scope = s.ok ? Scope.safeParse(s.value) : null;
    if (!scope?.success || (scope.data.kind !== 'fleet' && scope.data.kind !== 'project')) {
      return fail(reply, coreError('invalid_input', 'scope is fleet:* or project:<id>'));
    }
    if (!(await r.guard(reply, q.on_behalf_of, 'access.manage', accessResourceOf(scope.data))))
      return;
    const rows = await listBindings(d.pool, scope.data);
    return rows.ok ? { bindings: rows.value } : fail(reply, rows.error);
  });
}
