import {
  AuditResultRequest,
  AuditResultResult,
  DuplicateResult,
  EscapeReportRequest,
  FactoryRevisionView,
  ItemActionResult,
  ItemReleaseRequest,
  LearnProposeResult,
  LearnRunResult,
  ProjectId,
  ProjectLearnView,
  RevisionDecideRequest,
  RevisionEvidenceRequest,
  ReviewerUnsureRequest,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';

// The portal's M15.5 routes (the bff side of core's `governance-routes.ts`, and M15.3's RELHOLD re-request). As every
// portal route: the PDP in this process for the signed-in principal first (no answer, an error or a deny is a 403),
// then core with the principal from the session as `on_behalf_of` (a body that names one is refused), and core asks
// the PDP again.
//
//   POST /api/items/:id/release/re-request   RELHOLD: G5 again after the fix window      (item.release)
//   POST /api/items/:id/review/unsure        B14: the mode-E approver is unsure           (item.unsure)
//   POST /api/items/:id/escape               B17: an escape after the merge               (item.escape)
//   GET  /api/items/:id/closeout             9.3: the close-out record                    (closeout.read)
//   POST /api/items/:id/audit                9.5: the audit of a drawn mode-E merge       (audit.record)
//   GET  /api/projects/:id/learn             9.4: proposals, earned autonomy, B19         (audit.read)
//   POST /api/projects/:id/learn/run         9.4 now                                      (learn.propose)
//   POST /api/projects/:id/learn/mode-e-lift ask for B19's lift: an M5                    (learn.propose)
//   GET  /api/config/revisions/:gate         a factory revision as something to decide   (audit.read or config.decide)
//   POST /api/config/revisions/:gate/prepare|evidence|decide                              (config.decide)

export interface GovernancePortalDeps {
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
  readonly idParam: (req: FastifyRequest, reply: FastifyReply) => string | null;
  readonly itemOf: (
    req: FastifyRequest,
    reply: FastifyReply,
    c: CoreClient,
    id: string,
  ) => Promise<{ resource: PdpResource } | null>;
}

export const PortalReleaseBody = ItemReleaseRequest.omit({ on_behalf_of: true });
export const PortalUnsureBody = ReviewerUnsureRequest.omit({ on_behalf_of: true });
export const PortalEscapeBody = EscapeReportRequest.omit({ on_behalf_of: true });
export const PortalAuditBody = AuditResultRequest.omit({ on_behalf_of: true });
const Empty = z.strictObject({});

export function registerGovernancePortalRoutes(g: GovernancePortalDeps): void {
  const { app } = g;
  const uuid = z.uuid();

  /** An item write: the PDP's yes on the item (read through core as the person), then core. */
  async function itemWrite<S extends z.ZodType<object>, T>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    path: string,
    action: ActionId,
    parse: (v: unknown) => T,
  ) {
    const c = g.core(reply);
    const id = c ? g.idParam(req, reply) : null;
    if (!c || !id) return;
    const body = schema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const who = g.principalOf(req);
    const it = await g.itemOf(req, reply, c, id);
    if (!it) return;
    if (!(await g.allowed(who, action, it.resource))) return g.deny(reply, action);
    const r = await c.call('POST', `/v1/items/${id}/${path}`, { ...body.data, on_behalf_of: who });
    return g.upstream(reply, r, parse)?.value;
  }

  app.post('/api/items/:id/release/re-request', (req, reply) =>
    itemWrite(req, reply, PortalReleaseBody, 'release/re-request', 'item.release', (v) =>
      ItemActionResult.parse(v),
    ),
  );
  app.post('/api/items/:id/review/unsure', (req, reply) =>
    itemWrite(req, reply, PortalUnsureBody, 'review/unsure', 'item.unsure', (v) =>
      DuplicateResult.parse(v),
    ),
  );
  app.post('/api/items/:id/escape', (req, reply) =>
    itemWrite(req, reply, PortalEscapeBody, 'escape', 'item.escape', (v) =>
      DuplicateResult.parse(v),
    ),
  );
  app.post('/api/items/:id/audit', (req, reply) =>
    itemWrite(req, reply, PortalAuditBody, 'audit', 'audit.record', (v) =>
      AuditResultResult.parse(v),
    ),
  );

  app.get('/api/items/:id/closeout', async (req, reply) => {
    const c = g.core(reply);
    const id = c ? g.idParam(req, reply) : null;
    if (!c || !id) return;
    const who = g.principalOf(req);
    const it = await g.itemOf(req, reply, c, id);
    if (!it) return;
    if (!(await g.allowed(who, 'closeout.read', it.resource)))
      return g.deny(reply, 'closeout.read');
    const r = await c.call(
      'GET',
      `/v1/items/${id}/closeout?on_behalf_of=${encodeURIComponent(who)}`,
    );
    return g.upstream(reply, r)?.value;
  });

  // ------------------------------------------------------------ 9.4

  const projectOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const p = ProjectId.safeParse((req.params as { id?: string }).id);
    if (p.success) return p.data;
    sendError(reply, 400, 'invalid_input', 'bad project id');
    return null;
  };

  app.get('/api/projects/:id/learn', async (req, reply) => {
    const c = g.core(reply);
    const p = c ? projectOf(req, reply) : null;
    if (!c || !p) return;
    const who = g.principalOf(req);
    if (!(await g.allowed(who, 'audit.read', pdpResource.project(p))))
      return g.deny(reply, 'audit.read');
    const r = await c.call(
      'GET',
      `/v1/projects/${p}/learn?on_behalf_of=${encodeURIComponent(who)}`,
    );
    const got = g.upstream(reply, r, (v) => ProjectLearnView.parse(v));
    if (!got) return;
    return {
      ...got.value,
      may_propose: await g.allowed(who, 'learn.propose', pdpResource.project(p)),
    };
  });

  async function learnWrite(req: FastifyRequest, reply: FastifyReply, path: string) {
    const c = g.core(reply);
    const p = c ? projectOf(req, reply) : null;
    if (!c || !p) return;
    const body = Empty.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const who = g.principalOf(req);
    if (!(await g.allowed(who, 'learn.propose', pdpResource.project(p)))) {
      return g.deny(reply, 'learn.propose');
    }
    const r = await c.call('POST', `/v1/projects/${p}/learn/${path}`, { on_behalf_of: who });
    const got = g.upstream(reply, r, (v) =>
      path === 'run' ? LearnRunResult.parse(v) : LearnProposeResult.parse(v),
    );
    if (!got) return;
    return reply.code(r.reached ? r.status : 200).send(got.value);
  }
  app.post('/api/projects/:id/learn/run', (req, reply) => learnWrite(req, reply, 'run'));
  app.post('/api/projects/:id/learn/mode-e-lift', (req, reply) =>
    learnWrite(req, reply, 'mode-e-lift'),
  );

  // ------------------------------------------------------------ the factory M1 (configuration console's decide path)

  const gateOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const v = (req.params as { gate?: string }).gate;
    if (uuid.safeParse(v).success) return v as string;
    sendError(reply, 400, 'invalid_input', 'bad id');
    return null;
  };

  app.get('/api/config/revisions/:gate', async (req, reply) => {
    const c = g.core(reply);
    const gate = c ? gateOf(req, reply) : null;
    if (!c || !gate) return;
    const who = g.principalOf(req);
    const decide = await g.allowed(who, 'config.decide', pdpResource.fleet());
    if (!decide && !(await g.allowed(who, 'audit.read', pdpResource.fleet()))) {
      return g.deny(reply, 'audit.read');
    }
    const got = g.upstream(reply, await c.call('GET', `/v1/config/revisions/${gate}`), (v) =>
      FactoryRevisionView.parse(v),
    );
    if (!got) return;
    return {
      ...got.value,
      may_decide:
        decide && got.value.status === 'pending' && got.value.deciders.includes(who as never),
    };
  });

  const bodies = {
    prepare: Empty,
    evidence: RevisionEvidenceRequest.omit({ on_behalf_of: true }),
    decide: RevisionDecideRequest.omit({ on_behalf_of: true }),
  } as const;
  for (const verb of ['prepare', 'evidence', 'decide'] as const) {
    app.post(`/api/config/revisions/:gate/${verb}`, async (req, reply) => {
      const c = g.core(reply);
      const gate = c ? gateOf(req, reply) : null;
      if (!c || !gate) return;
      const body = bodies[verb].safeParse(req.body ?? {});
      if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
      const who = g.principalOf(req);
      if (!(await g.allowed(who, 'config.decide', pdpResource.fleet()))) {
        return g.deny(reply, 'config.decide');
      }
      const r = await c.call('POST', `/v1/config/revisions/${gate}/${verb}`, {
        ...body.data,
        on_behalf_of: who,
      });
      return g.upstream(reply, r)?.value;
    });
  }
}
