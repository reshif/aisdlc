import type { AccessChange } from '@aisdlc/contracts';
import {
  AccessBindingList,
  AccessDecideResult,
  AccessPrepared,
  AccessGrantList,
  AccessGrantView,
  AccessProposeResult,
  AccessRequestCreate,
  AccessProposeRequest,
  FACTORY_PROJECT_ID,
  RevisionDecideRequest,
  RevisionEvidenceRequest,
  accessResourceOf,
  parseScopeKey,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';

// The portal's side of P1-6 (core's `access-routes.ts`). As every portal route: the PDP in this process for the
// signed-in principal first (no answer, an error or a deny is a 403 and core is never asked), then core with the
// session's principal as `on_behalf_of` (a body that names one is refused), and core asks the PDP again; the M1 gate
// decides whether anything changes.
//
//   GET  /api/access/grants                       the proposals the person may see (core filters)
//   GET  /api/access/grants/:id                   one, with `may_decide`
//   POST /api/access/grants                       propose a grant or a revoke           (access.manage on its scope)
//   POST /api/access/requests                     ask for a role for oneself (no action: deciding it is the M1)
//   POST /api/access/grants/:id/prepare|evidence|decide                                 (access.manage on its scope)
//   GET  /api/access/bindings?scope=fleet:*|project:<id>                                (access.manage on the scope)

export interface AccessGrantPortalDeps {
  readonly app: FastifyInstance;
  readonly principalOf: (req: FastifyRequest) => string;
  readonly core: (reply: FastifyReply) => CoreClient | null;
  readonly allowed: (
    principal: string,
    action: ActionId,
    resource: PdpResource,
  ) => Promise<boolean>;
  readonly deny: (reply: FastifyReply, action: ActionId) => unknown;
  readonly upstream: <T>(
    reply: FastifyReply,
    r: CallResult,
    parse?: (v: unknown) => T,
  ) => { readonly value: T } | null;
}

export const PortalAccessProposeBody = AccessProposeRequest.omit({ on_behalf_of: true });
export const PortalAccessRequestBody = AccessRequestCreate.omit({ on_behalf_of: true });

/** The PDP resource an inbox item of kind `access_grant` is decided on: the project, or the fleet. */
export const accessInboxResource = (project: string): PdpResource =>
  project === FACTORY_PROJECT_ID ? pdpResource.fleet() : pdpResource.project(project);

export const PortalAccessGrantView = AccessGrantView.extend({ may_decide: z.boolean() });
export type PortalAccessGrantView = z.infer<typeof PortalAccessGrantView>;

export function registerAccessGrantPortalRoutes(g: AccessGrantPortalDeps): void {
  const { app } = g;
  const uuid = z.uuid();
  const idOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const v = (req.params as { id?: string }).id;
    if (uuid.safeParse(v).success) return v as string;
    sendError(reply, 400, 'invalid_input', 'bad id');
    return null;
  };
  const q = (who: string) => `on_behalf_of=${encodeURIComponent(who)}`;

  /** One grant as core shows it to the person (404 when they may not see it). */
  async function grantOf(reply: FastifyReply, c: CoreClient, id: string, who: string) {
    return g.upstream(reply, await c.call('GET', `/v1/access/grants/${id}?${q(who)}`), (v) =>
      AccessGrantView.parse(v),
    );
  }
  const mayDecide = async (who: string, v: AccessGrantView) =>
    v.status === 'pending' &&
    v.deciders.includes(who as never) &&
    (await g.allowed(who, 'access.manage', accessResourceOf(v.change.scope)));

  app.get('/api/access/grants', async (req, reply) => {
    const c = g.core(reply);
    if (!c) return;
    const who = g.principalOf(req);
    const got = g.upstream(reply, await c.call('GET', `/v1/access/grants?${q(who)}`), (v) =>
      AccessGrantList.parse(v),
    );
    if (!got) return;
    const grants: PortalAccessGrantView[] = [];
    for (const v of got.value.grants) grants.push({ ...v, may_decide: await mayDecide(who, v) });
    return { grants };
  });

  app.get('/api/access/grants/:id', async (req, reply) => {
    const c = g.core(reply);
    const id = c ? idOf(req, reply) : null;
    if (!c || !id) return;
    const who = g.principalOf(req);
    const got = await grantOf(reply, c, id, who);
    if (!got) return;
    return { ...got.value, may_decide: await mayDecide(who, got.value) };
  });

  app.post('/api/access/grants', async (req, reply) => {
    const c = g.core(reply);
    if (!c) return;
    const body = PortalAccessProposeBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const who = g.principalOf(req);
    const change: AccessChange = body.data.change;
    if (!(await g.allowed(who, 'access.manage', accessResourceOf(change.scope)))) {
      return g.deny(reply, 'access.manage');
    }
    const r = await c.call('POST', '/v1/access/grants', { ...body.data, on_behalf_of: who });
    const got = g.upstream(reply, r, (v) => AccessProposeResult.parse(v));
    return got ? reply.code(201).send(got.value) : undefined;
  });

  app.post('/api/access/requests', async (req, reply) => {
    const c = g.core(reply);
    if (!c) return;
    const body = PortalAccessRequestBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const r = await c.call('POST', '/v1/access/requests', {
      ...body.data,
      on_behalf_of: g.principalOf(req),
    });
    const got = g.upstream(reply, r, (v) => AccessProposeResult.parse(v));
    return got ? reply.code(201).send(got.value) : undefined;
  });

  const bodies = {
    prepare: z.strictObject({}),
    evidence: RevisionEvidenceRequest.omit({ on_behalf_of: true }),
    decide: RevisionDecideRequest.omit({ on_behalf_of: true }),
  } as const;
  const parsers = {
    prepare: (v: unknown) => AccessPrepared.parse(v),
    evidence: (v: unknown) => z.strictObject({ evidence_viewed: z.literal(true) }).parse(v),
    decide: (v: unknown) => AccessDecideResult.parse(v),
  } as const;
  for (const verb of ['prepare', 'evidence', 'decide'] as const) {
    app.post(`/api/access/grants/:id/${verb}`, async (req, reply) => {
      const c = g.core(reply);
      const id = c ? idOf(req, reply) : null;
      if (!c || !id) return;
      const body = bodies[verb].safeParse(req.body ?? {});
      if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
      const who = g.principalOf(req);
      const v = await grantOf(reply, c, id, who);
      if (!v) return;
      if (!(await g.allowed(who, 'access.manage', accessResourceOf(v.value.change.scope)))) {
        return g.deny(reply, 'access.manage');
      }
      const r = await c.call('POST', `/v1/access/grants/${id}/${verb}`, {
        ...body.data,
        on_behalf_of: who,
      });
      const parse: (v: unknown) => unknown = parsers[verb];
      return g.upstream(reply, r, parse)?.value;
    });
  }

  app.get('/api/access/bindings', async (req, reply) => {
    const c = g.core(reply);
    if (!c) return;
    const raw = (req.query as { scope?: unknown }).scope;
    const s = typeof raw === 'string' ? parseScopeKey(raw) : null;
    if (!s?.ok || (s.value.kind !== 'fleet' && s.value.kind !== 'project')) {
      return sendError(reply, 400, 'invalid_input', 'scope is fleet:* or project:<id>');
    }
    const who = g.principalOf(req);
    if (!(await g.allowed(who, 'access.manage', accessResourceOf(s.value)))) {
      return g.deny(reply, 'access.manage');
    }
    const r = await c.call(
      'GET',
      `/v1/access/bindings?${q(who)}&scope=${encodeURIComponent(raw as string)}`,
    );
    return g.upstream(reply, r, (v) => AccessBindingList.parse(v))?.value;
  });
}
