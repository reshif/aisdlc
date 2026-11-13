import {
  BreakerResetRequested,
  BreakersView,
  BudgetsView,
  CostView,
  GatewayAdapterState,
  GatewayReloadView,
  Lane,
  OnboardReposView,
  ProjectId,
  ProviderTestResult,
  PublishBannerBody,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { Pdp } from '@aisdlc/pdp';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';

// The portal's operate and govern gaps (docs/design/portal-review.md §12; contracts `portal-ops.ts`). Each route asks
// the PDP in this process for the signed-in person (fail closed), then calls core (which asks again) or the gateway's
// admin API with the bff's own token. The gateway does not know people: the bff's PDP decision is its only guard
// there, so its token holds the gateway scope `operate` alone (reload, test, the adapter list), never `admin`.
//
//   GET  /api/budgets                          budget groups: used, reserved, exhausted        (ops.read, fleet)
//   GET  /api/cost[?days=]                     spend per day and project, per merged item       (quality.read, fleet)
//   GET  /api/projects/:id/breakers            P2-11: the R3 breakers of a project              (project.view)
//   POST /api/projects/:id/breakers/:lane/reset   ask for a reset: an M5 gate                   (config.propose there)
//   POST /api/banners                          P2-12: publish a banner                          (banner.publish on the scope)
//   GET  /api/onboard/repos                    P2-21: the installation's repos                  (project.onboard, fleet)
//   GET  /api/models/providers                 P2-5: the gateway's adapters and its bounds      (quality.read, fleet)
//   POST /api/models/providers/:id/test        one tiny metered call to that provider           (config.propose, fleet)
//   POST /api/models/reload                    rebuild the adapters (a rotated key file)        (config.propose, fleet)

export interface OpsRouteDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp;
  readonly core: CoreClient | undefined;
  /** The model gateway's admin API, scope `operate`; without it the provider routes answer 503. */
  readonly gateway?: CoreClient;
  readonly principalOf: (req: FastifyRequest) => string;
}

const ProvidersView = z.strictObject({
  revision: z.string().nullable(),
  integrations: z.array(GatewayAdapterState),
  bounds: z.strictObject({
    secret_refs: z.array(z.string()),
    egress_hosts: z.array(z.string()),
  }),
});

const Slug = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/);

export function registerOpsRoutes(d: OpsRouteDeps): void {
  const { app } = d;

  async function allowed(principal: string, action: ActionId, resource: PdpResource) {
    try {
      return (await d.pdp.decide({ principal, action, resource })).decision === 'allow';
    } catch {
      return false;
    }
  }
  const deny = (reply: FastifyReply, action: ActionId) =>
    sendError(reply, 403, 'forbidden', `${action} denied`);

  /** Pass an upstream answer through: a refusal keeps its status and code, a failure is a 502, never a success. */
  function upstream<T>(
    reply: FastifyReply,
    r: CallResult,
    parse: (v: unknown) => T,
    who = 'the factory core',
  ): T | null {
    if (!r.reached) {
      sendError(reply, 502, 'upstream_unavailable', `${who} could not be reached`);
      return null;
    }
    if (r.status >= 500) {
      sendError(reply, 502, 'upstream_error', `${who} could not answer`);
      return null;
    }
    if (r.status < 200 || r.status >= 300) {
      const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      sendError(
        reply,
        r.status,
        typeof e?.code === 'string' ? e.code : 'refused',
        typeof e?.message === 'string' ? e.message : 'the request was refused',
      );
      return null;
    }
    try {
      return parse(r.json);
    } catch {
      sendError(reply, 502, 'upstream_error', `${who} sent something unexpected`);
      return null;
    }
  }

  const core = (reply: FastifyReply): CoreClient | null => {
    if (d.core) return d.core;
    sendError(reply, 503, 'core_not_configured', 'the bff has no core to call');
    return null;
  };
  const gateway = (reply: FastifyReply): CoreClient | null => {
    if (d.gateway) return d.gateway;
    sendError(reply, 503, 'gateway_not_configured', 'the bff has no route to the model gateway');
    return null;
  };
  const as = (req: FastifyRequest) => encodeURIComponent(d.principalOf(req));

  /** `action` on the fleet for the signed-in person, else a 403 naming it. */
  async function onFleet(req: FastifyRequest, reply: FastifyReply, action: ActionId) {
    if (await allowed(d.principalOf(req), action, pdpResource.fleet())) return true;
    deny(reply, action);
    return false;
  }

  // ------------------------------------------------------------ P2-8: budgets and cost

  app.get('/api/budgets', async (req, reply) => {
    const c = core(reply);
    if (!c || !(await onFleet(req, reply, 'ops.read'))) return;
    return upstream(reply, await c.call('GET', `/v1/budgets?on_behalf_of=${as(req)}`), (v) =>
      BudgetsView.parse(v),
    );
  });

  app.get('/api/cost', async (req, reply) => {
    const q = z
      .strictObject({ days: z.coerce.number().int().min(1).max(366).optional() })
      .safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'days is 1 to 366');
    const c = core(reply);
    if (!c || !(await onFleet(req, reply, 'quality.read'))) return;
    const qs = new URLSearchParams({ on_behalf_of: d.principalOf(req) });
    if (q.data.days) qs.set('days', String(q.data.days));
    return upstream(reply, await c.call('GET', `/v1/cost?${qs}`), (v) => CostView.parse(v));
  });

  // ------------------------------------------------------------ P2-11: the R3 breakers of a project

  const projectOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const p = ProjectId.safeParse((req.params as { id?: string }).id);
    if (p.success) return p.data;
    sendError(reply, 400, 'invalid_input', 'bad project id');
    return null;
  };

  app.get('/api/projects/:id/breakers', async (req, reply) => {
    const id = projectOf(req, reply);
    const c = core(reply);
    if (!id || !c) return;
    if (!(await allowed(d.principalOf(req), 'project.view', pdpResource.project(id)))) {
      return deny(reply, 'project.view');
    }
    return upstream(
      reply,
      await c.call('GET', `/v1/projects/${id}/breakers?on_behalf_of=${as(req)}`),
      (v) => BreakersView.parse(v),
    );
  });

  app.post('/api/projects/:id/breakers/:lane/reset', async (req, reply) => {
    const id = projectOf(req, reply);
    const lane = Lane.safeParse((req.params as { lane?: string }).lane);
    if (!id) return;
    if (!lane.success) return sendError(reply, 400, 'invalid_input', 'bad lane');
    const c = core(reply);
    if (!c) return;
    const who = d.principalOf(req);
    // the reset itself is decided at the M5 gate it opens; asking for it is a configuration proposal
    if (!(await allowed(who, 'config.propose', pdpResource.project(id)))) {
      return deny(reply, 'config.propose');
    }
    const r = await c.call('POST', `/v1/projects/${id}/breakers/${lane.data}/reset`, {
      on_behalf_of: who,
    });
    const got = upstream(reply, r, (v) => BreakerResetRequested.parse(v));
    if (!got) return;
    return reply.code(201).send(got);
  });

  // ------------------------------------------------------------ P2-12: banners

  app.post('/api/banners', async (req, reply) => {
    const b = PublishBannerBody.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
    const c = core(reply);
    if (!c) return;
    const who = d.principalOf(req);
    const res =
      b.data.scope.kind === 'fleet' ? pdpResource.fleet() : pdpResource.project(b.data.scope.ref);
    if (!(await allowed(who, 'banner.publish', res))) return deny(reply, 'banner.publish');
    const r = await c.call('POST', '/v1/banners', { ...b.data, on_behalf_of: who });
    const got = upstream(reply, r, (v) => z.looseObject({}).parse(v));
    if (!got) return;
    return reply.code(201).send(got);
  });

  // ------------------------------------------------------------ P2-21: the onboard form's repo picker

  app.get('/api/onboard/repos', async (req, reply) => {
    const c = core(reply);
    if (!c || !(await onFleet(req, reply, 'project.onboard'))) return;
    return upstream(
      reply,
      await c.call('GET', `/v1/onboarding/repos?on_behalf_of=${as(req)}`),
      (v) => OnboardReposView.parse(v),
    );
  });

  // ------------------------------------------------------------ P2-5: model providers at the gateway

  app.get('/api/models/providers', async (req, reply) => {
    const g = gateway(reply);
    if (!g || !(await onFleet(req, reply, 'quality.read'))) return;
    return upstream(
      reply,
      await g.call('GET', '/v1/admin/integrations'),
      (v) => ProvidersView.parse(v),
      'the model gateway',
    );
  });

  app.post('/api/models/providers/:id/test', async (req, reply) => {
    const id = Slug.safeParse((req.params as { id?: string }).id);
    if (!id.success) return sendError(reply, 400, 'invalid_input', 'bad provider id');
    const g = gateway(reply);
    if (!g || !(await onFleet(req, reply, 'config.propose'))) return;
    return upstream(
      reply,
      await g.call('POST', `/v1/admin/providers/${id.data}/test`, {
        tested_by: d.principalOf(req),
      }),
      (v) => ProviderTestResult.parse(v),
      'the model gateway',
    );
  });

  app.post('/api/models/reload', async (req, reply) => {
    const b = z.strictObject({ force: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
    const g = gateway(reply);
    if (!g || !(await onFleet(req, reply, 'config.propose'))) return;
    return upstream(
      reply,
      await g.call('POST', '/v1/admin/reload', { force: b.data.force === true }),
      (v) => GatewayReloadView.parse(v),
      'the model gateway',
    );
  });
}
