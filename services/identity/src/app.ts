import {
  GateId,
  GroupId,
  IdentityGrantRequest,
  IdentityRevokeRequest,
  IdentityLinkKind,
  LedgerEntryId,
  PrincipalId,
  PrincipalStatus,
  ProjectId,
  Qualification,
  SetCodeownerMembersRequest,
  Team,
  parseScopeKey,
  type Scope,
} from '@aisdlc/contracts';
import { systemClock, type Clock, type Result } from '@aisdlc/kernel';
import type { LedgerClientDeps } from '@aisdlc/ledger';
import type { IdentityProviderPort, ProjectSettingsPort } from '@aisdlc/ports';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { accessSyncStatus, syncAccessLedger } from './access-sync.js';
import {
  addMember,
  createBinding,
  createGroup,
  createPrincipal,
  createTeam,
  grantQualification,
  linkIdentity,
  removeMember,
  revokeBinding,
  setPrincipalStatus,
  updatePrincipal,
  NewPrincipal,
} from './commands.js';
import { setCodeownerMembers } from './codeowners.js';
import { grantAccess, revokeAccess } from './grants.js';
import { explainGate, explainProject } from './explain.js';
import { freshReadModel } from './eligibility.js';
import { IDENTITY_STATUS, identityError, type IdentityError } from './errors.js';
import { syncFromIdp } from './idp-sync.js';
import { effectiveBindings, getPrincipal, resolveGroups, resolveLink } from './queries.js';
import { reconcileProject } from './reconcile.js';

/**
 * What a caller may do: read the model, change principals/groups/bindings, reconcile, sync,
 * (`codeowners`, the codehost only) set the members of a project's g4 group from CODEOWNERS, and
 * (`grant`, core only, P1-6) write or end the binding an approved M1 decided (`m_gate_ref` required).
 */
export const IDENTITY_SCOPES = [
  'read',
  'write',
  'reconcile',
  'sync',
  'codeowners',
  'grant',
] as const;
export type IdentityScope = (typeof IDENTITY_SCOPES)[number];

export interface IdentityAppOptions {
  readonly pool: pg.Pool;
  readonly auth: ServiceAuth;
  /** caller name -> scopes. A caller with no entry may do nothing. */
  readonly callers: Record<string, readonly IdentityScope[]>;
  readonly settings: ProjectSettingsPort;
  /** Absent: `POST /v1/idp/sync` answers `unavailable`. */
  readonly idp?: IdentityProviderPort | undefined;
  /** Absent: the access-sync routes and the lag metric still read the record, but nothing is written. */
  readonly ledger?: LedgerClientDeps | undefined;
  readonly clock?: Clock;
  /** Called after a write committed; the service uses it to run the access-sync loop at once. */
  readonly onWrite?: () => void;
}

const atOf = (raw: unknown, clock: Clock): Date | null => {
  if (raw === undefined) return clock.now();
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** HTTP in front of identity: reads for core, writes and reconcile for trusted callers. Service tokens only. */
export function createIdentityApp(o: IdentityAppOptions): FastifyInstance {
  const app = newApp();
  const clock = o.clock ?? systemClock;
  const deps = { pool: o.pool, clock };

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/metrics', async (_req, reply) => {
    const s = await accessSyncStatus(o.pool, clock);
    return reply
      .type('text/plain; version=0.0.4')
      .send(
        `# TYPE identity_access_sync_lag_seconds gauge\nidentity_access_sync_lag_seconds ${s.lag_seconds}\n` +
          `# TYPE identity_access_sync_slo_breached gauge\nidentity_access_sync_slo_breached ${s.breached ? 1 : 0}\n`,
      );
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null) {
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    }
    (req as unknown as { caller: string }).caller = caller;
  });

  const fail = (reply: FastifyReply, e: IdentityError) =>
    sendError(reply, IDENTITY_STATUS[e.code], e.code, e.message);
  const callerOf = (req: FastifyRequest): string => (req as unknown as { caller: string }).caller;
  const allowed = (req: FastifyRequest, scope: IdentityScope): boolean =>
    (o.callers[callerOf(req)] ?? []).includes(scope);

  /** A route that needs `scope`. `run` returns a Result; a write also nudges the access-sync loop. */
  function route(
    method: 'get' | 'post',
    path: string,
    scope: IdentityScope,
    run: (req: FastifyRequest, caller: string) => Promise<Result<unknown, IdentityError>>,
    write = false,
  ): void {
    app[method](path, async (req: FastifyRequest, reply: FastifyReply) => {
      if (!allowed(req, scope)) {
        return sendError(reply, 403, 'forbidden', `caller may not use scope ${scope}`);
      }
      const r = await run(req, callerOf(req));
      if (!r.ok) return fail(reply, r.error);
      if (write) o.onWrite?.();
      return r.value;
    });
  }

  const parse = <S extends z.ZodType>(schema: S, v: unknown): Result<z.infer<S>, IdentityError> => {
    const p = schema.safeParse(v);
    return p.success
      ? { ok: true, value: p.data }
      : { ok: false, error: identityError('invalid_input', p.error.message) };
  };
  const bad = (message: string) =>
    ({ ok: false, error: identityError('invalid_input', message) }) as const;
  const notFound = (message: string) =>
    ({ ok: false, error: identityError('not_found', message) }) as const;
  const params = (req: FastifyRequest): Record<string, string> =>
    req.params as Record<string, string>;
  const query = (req: FastifyRequest): Record<string, string | undefined> =>
    req.query as Record<string, string | undefined>;

  // ------------------------------------------------------------ reads (core)

  route('get', '/v1/principals/:id', 'read', async (req) => {
    const fresh = await freshReadModel(o.pool);
    if (!fresh.ok) return { ok: false, error: identityError('unavailable', fresh.error.message) };
    const p = await getPrincipal(o.pool, params(req)['id'] as string);
    return p ? { ok: true, value: p } : notFound('no such principal');
  });

  route('get', '/v1/principals/:id/groups', 'read', async (req) => {
    const at = atOf(query(req)['at'], clock);
    if (!at) return bad('at is not a date');
    const fresh = await freshReadModel(o.pool);
    if (!fresh.ok) return { ok: false, error: identityError('unavailable', fresh.error.message) };
    const id = params(req)['id'] as string;
    if (!(await getPrincipal(o.pool, id))) return notFound('no such principal');
    return {
      ok: true,
      value: {
        principal_id: id,
        at: at.toISOString(),
        groups: await resolveGroups(o.pool, id, at),
      },
    };
  });

  route('get', '/v1/principals/:id/bindings', 'read', async (req) => {
    const at = atOf(query(req)['at'], clock);
    if (!at) return bad('at is not a date');
    const scopeKey = query(req)['scope'];
    if (scopeKey === undefined) return bad('scope=<kind>:<ref> is required');
    const scope = parseScopeKey(scopeKey);
    if (!scope.ok) return bad(`bad scope ${scopeKey}`);
    const fresh = await freshReadModel(o.pool);
    if (!fresh.ok) return { ok: false, error: identityError('unavailable', fresh.error.message) };
    const id = params(req)['id'] as string;
    if (!(await getPrincipal(o.pool, id))) return notFound('no such principal');
    return {
      ok: true,
      value: {
        principal_id: id,
        scope: scope.value as Scope,
        at: at.toISOString(),
        bindings: await effectiveBindings(o.pool, id, scope.value, at),
      },
    };
  });

  route('get', '/v1/resolve', 'read', async (req) => {
    const q = parse(
      z.strictObject({
        kind: IdentityLinkKind,
        issuer: z.string().min(1).optional(),
        value: z.string().min(1),
      }),
      query(req),
    );
    if (!q.ok) return q;
    const fresh = await freshReadModel(o.pool);
    if (!fresh.ok) return { ok: false, error: identityError('unavailable', fresh.error.message) };
    const p = await resolveLink(o.pool, {
      kind: q.value.kind,
      issuer: q.value.issuer ?? null,
      value: q.value.value,
    });
    return p ? { ok: true, value: p } : notFound('no principal is linked to that identity');
  });

  route('get', '/v1/projects/:project/explain', 'read', async (req) => {
    const project = ProjectId.safeParse(params(req)['project']);
    if (!project.success) return bad('bad project id');
    const rd = { pool: o.pool, settings: o.settings, clock };
    const gate = query(req)['gate'];
    if (gate === undefined) return explainProject(rd, project.data);
    const g = GateId.safeParse(gate);
    return g.success ? explainGate(rd, project.data, g.data) : bad(`unknown gate ${gate}`);
  });

  route('get', '/v1/access-sync', 'read', async () => ({
    ok: true,
    value: await accessSyncStatus(o.pool, clock),
  }));

  // ------------------------------------------------------------ writes

  const actorOf = (body: { on_behalf_of?: string | undefined }, caller: string): string =>
    body.on_behalf_of ?? caller;
  const OnBehalf = { on_behalf_of: PrincipalId.optional() };

  route(
    'post',
    '/v1/principals',
    'write',
    async (req, caller) => {
      const b = parse(z.object({ principal: z.unknown(), ...OnBehalf }), req.body);
      if (!b.ok) return b;
      const p = NewPrincipal.safeParse(b.value.principal);
      if (!p.success) return bad(p.error.message);
      return createPrincipal(deps, p.data as never, actorOf(b.value, caller));
    },
    true,
  );

  route(
    'post',
    '/v1/principals/:id/update',
    'write',
    async (req, caller) => {
      const b = parse(z.object({ changes: z.unknown(), ...OnBehalf }), req.body);
      return b.ok
        ? updatePrincipal(
            deps,
            params(req)['id'] as string,
            b.value.changes,
            actorOf(b.value, caller),
          )
        : b;
    },
    true,
  );

  route(
    'post',
    '/v1/principals/:id/status',
    'write',
    async (req, caller) => {
      const b = parse(
        z.object({ status: PrincipalStatus, reason: z.string().min(1), ...OnBehalf }),
        req.body,
      );
      return b.ok
        ? setPrincipalStatus(
            deps,
            params(req)['id'] as string,
            b.value.status,
            b.value.reason,
            actorOf(b.value, caller),
          )
        : b;
    },
    true,
  );

  route(
    'post',
    '/v1/principals/:id/qualifications',
    'write',
    async (req, caller) => {
      const b = parse(z.object({ qualification: Qualification, ...OnBehalf }), req.body);
      if (!b.ok) return b;
      if (b.value.qualification.principal_id !== params(req)['id'])
        return bad('principal_id differs from the path');
      return grantQualification(deps, b.value.qualification, actorOf(b.value, caller));
    },
    true,
  );

  route(
    'post',
    '/v1/identity-links',
    'write',
    async (req, caller) => {
      const b = parse(z.object({ link: z.unknown(), ...OnBehalf }), req.body);
      return b.ok ? linkIdentity(deps, b.value.link, actorOf(b.value, caller)) : b;
    },
    true,
  );

  route(
    'post',
    '/v1/groups',
    'write',
    async (req, caller) => {
      const b = parse(z.object({ group: z.unknown(), ...OnBehalf }), req.body);
      return b.ok ? createGroup(deps, b.value.group, actorOf(b.value, caller)) : b;
    },
    true,
  );

  route(
    'post',
    '/v1/groups/:id/members',
    'write',
    async (req, caller) => {
      const b = parse(
        z.object({
          principal_id: PrincipalId,
          active_until: z.string().nullable().optional(),
          ...OnBehalf,
        }),
        req.body,
      );
      if (!b.ok) return b;
      return addMember(
        deps,
        {
          group_id: GroupId.parse(params(req)['id']),
          principal_id: b.value.principal_id,
          ...(b.value.active_until !== undefined ? { active_until: b.value.active_until } : {}),
        },
        actorOf(b.value, caller),
      );
    },
    true,
  );

  route(
    'post',
    '/v1/groups/:id/members/remove',
    'write',
    async (req, caller) => {
      const b = parse(
        z.object({ principal_id: PrincipalId, reason: z.string().min(1), ...OnBehalf }),
        req.body,
      );
      return b.ok
        ? removeMember(
            deps,
            params(req)['id'] as string,
            b.value.principal_id,
            b.value.reason,
            actorOf(b.value, caller),
          )
        : b;
    },
    true,
  );

  route(
    'post',
    '/v1/bindings',
    'write',
    async (req, caller) => {
      const b = parse(
        z.object({
          group_id: z.string().min(1),
          role_id: z.string().min(1),
          scope: z.unknown(),
          constraints: z.record(z.string(), z.unknown()).optional(),
          expiry: z.string().nullable().optional(),
          m_gate_ref: LedgerEntryId.nullable().optional(),
          config_rev: z.string().nullable().optional(),
          ...OnBehalf,
        }),
        req.body,
      );
      if (!b.ok) return b;
      const { on_behalf_of, scope, ...rest } = b.value;
      const s = parse(z.object({ kind: z.string(), ref: z.string() }), scope);
      if (!s.ok) return s;
      return createBinding(
        deps,
        { ...rest, scope: s.value as Scope } as never,
        actorOf({ on_behalf_of }, caller),
      );
    },
    true,
  );

  route(
    'post',
    '/v1/bindings/:id/revoke',
    'write',
    async (req, caller) => {
      const b = parse(z.object({ reason: z.string().min(1), ...OnBehalf }), req.body);
      return b.ok
        ? revokeBinding(deps, params(req)['id'] as string, b.value.reason, actorOf(b.value, caller))
        : b;
    },
    true,
  );

  route(
    'post',
    '/v1/teams',
    'write',
    async (req, caller) => {
      const b = parse(z.object({ team: Team, ...OnBehalf }), req.body);
      return b.ok ? createTeam(deps, b.value.team, actorOf(b.value, caller)) : b;
    },
    true,
  );

  // ------------------------------------------------------------ the decided grant path (P1-6, core only)

  route(
    'post',
    '/v1/grants',
    'grant',
    async (req) => {
      const b = parse(IdentityGrantRequest, req.body);
      return b.ok ? grantAccess(deps, b.value) : b;
    },
    true,
  );

  route(
    'post',
    '/v1/grants/revoke',
    'grant',
    async (req) => {
      const b = parse(IdentityRevokeRequest, req.body);
      return b.ok ? revokeAccess(deps, b.value) : b;
    },
    true,
  );

  // ------------------------------------------------------------ role map and IdP sync

  route(
    'post',
    '/v1/projects/:project/reconcile',
    'reconcile',
    async (req, caller) => {
      const project = ProjectId.safeParse(params(req)['project']);
      if (!project.success) return bad('bad project id');
      const b = parse(
        z.object({
          config_rev: z.string().min(1).nullable().optional(),
          m_gate_ref: LedgerEntryId.nullable().optional(),
          ...OnBehalf,
        }),
        req.body ?? {},
      );
      if (!b.ok) return b;
      return reconcileProject(
        { ...deps, settings: o.settings },
        {
          project_id: project.data,
          actor: actorOf(b.value, caller),
          ...(b.value.config_rev !== undefined ? { config_rev: b.value.config_rev } : {}),
          ...(b.value.m_gate_ref !== undefined ? { m_gate_ref: b.value.m_gate_ref } : {}),
        },
      );
    },
    true,
  );

  route(
    'post',
    '/v1/projects/:project/codeowners/members',
    'codeowners',
    async (req) => {
      const project = ProjectId.safeParse(params(req)['project']);
      if (!project.success) return bad('bad project id');
      const b = parse(SetCodeownerMembersRequest, req.body);
      if (!b.ok) return b;
      return setCodeownerMembers(
        { ...deps, settings: o.settings },
        {
          project_id: project.data,
          principals: b.value.principals,
          source_ref: b.value.source_ref,
        },
      );
    },
    true,
  );

  route(
    'post',
    '/v1/idp/sync',
    'sync',
    async () => {
      if (!o.idp)
        return {
          ok: false,
          error: identityError('unavailable', 'no identity provider configured'),
        };
      return syncFromIdp({ ...deps, idp: o.idp });
    },
    true,
  );

  route('post', '/v1/access-sync/run', 'sync', async () => {
    if (!o.ledger)
      return { ok: false, error: identityError('unavailable', 'no ledger configured') };
    return syncAccessLedger({ pool: o.pool, ledger: o.ledger, clock });
  });

  return app;
}
