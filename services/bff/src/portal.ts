import {
  AgentId,
  AgentRunsView,
  AgentScoresView,
  AgentStats,
  CardDecideRequest,
  CardEvidenceRequest,
  GateCardDecideRequest,
  GateCardEvidenceRequest,
  GateCardView,
  CoreInboxItem,
  EvalRunsView,
  EvalSummaryView,
  LedgerAuditView,
  OnboardRequest,
  GateArtefactsView,
  OnboardingCardSummary,
  ProjectId,
  ProjectPrrView,
  ItemActionResult,
  ItemAnswerRequest,
  ItemObserveRequest,
  ItemPlanRequest,
  ItemPlanResult,
  ItemReadyRequest,
  ItemView,
  PortalItemView,
  ProjectSummary,
  RevisionDecideRequest,
  RevisionEvidenceRequest,
  S0Overview,
  SubmitRequestBody,
  S0Revision,
  SettingsRevisionView,
  pdpResource,
  type PortalInbox,
  type PortalInboxItem,
  type ActionId,
  type PdpResource,
  type PortalCardSummary,
} from '@aisdlc/contracts';
import type { Pdp } from '@aisdlc/pdp';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';

// The portal's API (PLAN M8.1): the only thing the browser calls besides the sign-in routes. Each
// route asks the PDP in this process for the signed-in principal (fail closed: no answer, an error
// or anything but `allow` is a 403), then calls core with the bff's service token and nothing of
// the browser's: no cookie, no CSRF token, no IdP token. The principal is `on_behalf_of` in the body
// of a write, taken from the session and never from the request, so a body that names one is
// refused. Core asks the PDP a second time for every write.
//
// Reads that start from an id (an S0 record, a card) first fetch the thing's project from core,
// decide on that project, and only then return or fetch more, so a person without access to the
// project learns nothing but the refusal.
//
//   GET  /api/projects                    the projects the principal may view
//   GET  /api/projects/:id                one project, its repos and S0 records       (project.view)
//   POST /api/onboard                     request an onboarding                       (project.onboard)
//   POST /api/requests                    ask for work: portal Ask, channel N1       (work.request)
//   GET  /api/items/:id                   a work item: position, waits, questions, and what the person may do (item.view_floor)
//   POST /api/items/:id/ready             1.6 the Ready decision                       (item.ready)
//   POST /api/items/:id/answers           the answer to one S1 clarification question  (item.ready)
//   POST /api/items/:id/observe           B4 or R2 while G3d is open                   (item.observe)
//   POST /api/items/:id/plan              B5: the plan a person writes                 (item.plan)
//   GET  /api/agent-runs?item=            the agent runs of an item and their outcomes (project.view)
//   GET  /api/agents/:id/stats            acceptance, back-edge rate, cost per run     (audit.read)
//   GET  /api/agents/:id/scores           AgentScore per prompt, provider and model    (audit.read)
//   GET  /api/evals/summary               the quality board's rows (allow-listed)      (audit.read)
//   GET  /api/evals/runs                  the eval run history                         (audit.read)
//   GET  /api/s0/:id                      the S0 record with its steps                (project.view)
//   GET  /api/s0/:id/cards                its cards, with `may_decide`                (project.view)
//   GET  /api/cards/:id                   one card with its view and deciders         (project.view)
//   GET  /api/cards/:id/artefacts         a work-item gate card's artefacts, rendered (project.view)
//   POST /api/cards/:id/prepare|evidence|decide|recheck                               (card.decide)
//   GET  /api/cards/:id/gate              a work-item gate card as something to decide  (project.view)
//   POST /api/cards/:id/gate/prepare|evidence|decide      deciding G0/G1, G1f, G2, G3d, G3 ...  (card.decide;
//                                         core asks gate.decide for every gate of the card)
//   GET  /api/inbox                       what waits for the person, and what they only see
//   GET  /api/s0/:id/revision             the settings revision card 4 proposed       (project.view)
//   GET  /api/revisions/:gate             the same, by its gate                       (project.view)
//   POST /api/revisions/:gate/prepare|evidence|decide|publish                         (gate.decide on the M1 gate)
//   GET  /api/projects/:id/prr            the project's readiness records             (project.view)
//   GET  /api/projects/:id/ledger         the ledger entries of the project           (audit.read)
//
// `may_decide` is the PDP's yes AND the person holding the slot core says decides (a card 5 also
// needs the `m4` slot): the button is shown only when both hold; deciding asks core again.

export interface PortalDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp;
  readonly core: CoreClient | undefined;
  /** The signed-in principal of an authenticated request (the session's, never the body's). */
  readonly principalOf: (req: FastifyRequest) => string;
  /** Display names of principals, from the directory; an unknown principal is left out. */
  readonly namesOf?: (ids: readonly string[]) => Promise<Record<string, string>>;
}

const uuid = z.uuid();

/** What the browser may send to start an onboarding: `on_behalf_of` is the session's, not a field. */
export const PortalOnboardBody = OnboardRequest.omit({ on_behalf_of: true });
/** Portal Ask: the channel is the portal's (N1) and `on_behalf_of` the session's, neither is a field. */
export const PortalAskBody = SubmitRequestBody.omit({ on_behalf_of: true, channel: true });
export const PortalEvidenceBody = CardEvidenceRequest.omit({ on_behalf_of: true });
export const PortalDecideBody = CardDecideRequest.omit({ on_behalf_of: true });
export const PortalGateEvidenceBody = GateCardEvidenceRequest.omit({ on_behalf_of: true });
export const PortalGateDecideBody = GateCardDecideRequest.omit({ on_behalf_of: true });
export const PortalRevisionEvidenceBody = RevisionEvidenceRequest.omit({ on_behalf_of: true });
export const PortalRevisionDecideBody = RevisionDecideRequest.omit({ on_behalf_of: true });
export const PortalReadyBody = ItemReadyRequest.omit({ on_behalf_of: true });
export const PortalAnswerBody = ItemAnswerRequest.omit({ on_behalf_of: true });
export const PortalObserveBody = z.discriminatedUnion('edge', [
  ItemObserveRequest.options[0].omit({ on_behalf_of: true }),
  ItemObserveRequest.options[1].omit({ on_behalf_of: true }),
]);
export const PortalPlanBody = ItemPlanRequest.omit({ on_behalf_of: true });
const EmptyBody = z.strictObject({});

export function registerPortalRoutes(d: PortalDeps): void {
  const { app } = d;

  const deny = (reply: FastifyReply, action: ActionId) =>
    sendError(reply, 403, 'forbidden', `${action} denied`);

  /** `allow` or nothing: a thrown error or a deny both refuse. */
  async function allowed(principal: string, action: ActionId, resource: PdpResource) {
    try {
      return (await d.pdp.decide({ principal, action, resource })).decision === 'allow';
    } catch {
      return false;
    }
  }

  /** Core's answer, or the error the browser gets. Core's own refusals keep their status and code. */
  function upstream<T = unknown>(
    reply: FastifyReply,
    r: CallResult,
    parse?: (v: unknown) => T,
  ): { readonly value: T } | null {
    if (!r.reached) {
      sendError(reply, 502, 'core_unavailable', 'the factory core could not be reached');
      return null;
    }
    if (r.status >= 500) {
      sendError(reply, 502, 'core_error', 'the factory core could not answer');
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
      return { value: parse ? parse(r.json) : (r.json as T) };
    } catch {
      sendError(reply, 502, 'core_error', 'the factory core sent something unexpected');
      return null;
    }
  }

  const names = async (ids: readonly string[]): Promise<Record<string, string>> => {
    try {
      return (await d.namesOf?.(ids)) ?? {};
    } catch {
      return {};
    }
  };

  const core = (reply: FastifyReply): CoreClient | null => {
    if (d.core) return d.core;
    sendError(reply, 503, 'core_not_configured', 'the bff has no core to call');
    return null;
  };

  const idParam = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const v = (req.params as { id?: string }).id;
    if (uuid.safeParse(v).success) return v as string;
    sendError(reply, 400, 'invalid_input', 'bad id');
    return null;
  };

  // ------------------------------------------------------------ projects

  app.get('/api/projects', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const who = d.principalOf(req);
    const got = upstream(reply, await c.call('GET', '/v1/projects'), (v) =>
      z.array(ProjectSummary).parse(v),
    );
    if (!got) return;
    const visible: ProjectSummary[] = [];
    for (const p of got.value) {
      if (await allowed(who, 'project.view', pdpResource.project(p.project.project_id))) {
        visible.push(p);
      }
    }
    return visible;
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const id = ProjectId.safeParse((req.params as { id: string }).id);
    if (!id.success) return sendError(reply, 400, 'invalid_input', 'bad project id');
    if (!(await allowed(d.principalOf(req), 'project.view', pdpResource.project(id.data)))) {
      return deny(reply, 'project.view');
    }
    const got = upstream(reply, await c.call('GET', `/v1/projects/${id.data}/overview`));
    return got?.value;
  });

  // ------------------------------------------------------------ onboarding

  app.post('/api/onboard', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const who = d.principalOf(req);
    const body = PortalOnboardBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const target = body.data.team_id ? pdpResource.team(body.data.team_id) : pdpResource.fleet();
    if (!(await allowed(who, 'project.onboard', target))) {
      return deny(reply, 'project.onboard');
    }
    const r = await c.call('POST', '/v1/onboard', { ...body.data, on_behalf_of: who });
    const got = upstream(reply, r);
    if (!got) return;
    return reply.code(r.reached && r.status === 201 ? 201 : 200).send(got.value);
  });

  // ------------------------------------------------------------ requests and items (M9.1)

  app.post('/api/requests', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const who = d.principalOf(req);
    const body = PortalAskBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    if (!(await allowed(who, 'work.request', pdpResource.project(body.data.project_id)))) {
      return deny(reply, 'work.request');
    }
    const r = await c.call('POST', '/v1/requests', {
      ...body.data,
      channel: 'N1',
      on_behalf_of: who,
    });
    const got = upstream(reply, r);
    if (!got) return;
    return reply.code(r.reached && r.status === 201 ? 201 : 200).send(got.value);
  });

  /** The item, read through core as the person (core asks the PDP too), and the bff's own yes on its project. */
  async function itemOf(req: FastifyRequest, reply: FastifyReply, c: CoreClient, id: string) {
    const got = upstream(
      reply,
      await c.call('GET', `/v1/items/${id}?on_behalf_of=${encodeURIComponent(d.principalOf(req))}`),
      (v) => ItemView.parse(v),
    );
    if (!got) return null;
    const v = got.value;
    const resource = pdpResource.item(v.project_id, v.item_id, v.lane ?? v.proposed_lane);
    if (!(await allowed(d.principalOf(req), 'item.view_floor', resource))) {
      deny(reply, 'item.view_floor');
      return null;
    }
    return { view: v, resource };
  }

  app.get('/api/items/:id', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const id = idParam(req, reply);
    if (!id) return;
    const it = await itemOf(req, reply, c, id);
    if (!it) return;
    const { view: v, resource } = it;
    const who = d.principalOf(req);
    const atG3d = v.gates.some((g) => g.gate === 'G3d' && g.status === 'pending');
    // a button is shown only when the PDP says yes AND the item is where the action applies
    const may = {
      ready: v.waiting === 'human:ready' && (await allowed(who, 'item.ready', resource)),
      answer: v.questions.some((q) => !q.answered) && (await allowed(who, 'item.ready', resource)),
      observe: atG3d && (await allowed(who, 'item.observe', resource)),
      plan: v.waiting === 'human:plan' && (await allowed(who, 'item.plan', resource)),
    };
    return PortalItemView.parse({ ...v, may });
  });

  /** The PDP's yes for the action on the item's project and the item, then core with the principal from the session. */
  async function itemMove<S extends z.ZodType<object>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    verb: 'ready' | 'answers' | 'observe' | 'plan',
    action: ActionId,
  ) {
    const c = core(reply);
    const id = idParam(req, reply);
    if (!c || !id) return;
    const body = schema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const who = d.principalOf(req);
    const it = await itemOf(req, reply, c, id);
    if (!it) return;
    if (!(await allowed(who, action, it.resource))) return deny(reply, action);
    const got = upstream(
      reply,
      await c.call('POST', `/v1/items/${id}/${verb}`, { ...body.data, on_behalf_of: who }),
      (v) => (verb === 'plan' ? ItemPlanResult.parse(v) : ItemActionResult.parse(v)),
    );
    return got?.value;
  }

  app.post('/api/items/:id/ready', (req, reply) =>
    itemMove(req, reply, PortalReadyBody, 'ready', 'item.ready'),
  );
  app.post('/api/items/:id/answers', (req, reply) =>
    itemMove(req, reply, PortalAnswerBody, 'answers', 'item.ready'),
  );
  app.post('/api/items/:id/observe', (req, reply) =>
    itemMove(req, reply, PortalObserveBody, 'observe', 'item.observe'),
  );
  app.post('/api/items/:id/plan', (req, reply) =>
    itemMove(req, reply, PortalPlanBody, 'plan', 'item.plan'),
  );

  // ------------------------------------------------------------ agent runs (M11.2)

  app.get('/api/agent-runs', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const q = z.strictObject({ item: z.uuid() }).safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'item (a uuid) is needed');
    // Core asks the PDP for this principal already; the bff asks too, on the item's own project.
    const got = upstream(
      reply,
      await c.call(
        'GET',
        `/v1/agent-runs?item=${q.data.item}&on_behalf_of=${encodeURIComponent(d.principalOf(req))}`,
      ),
      (v) => AgentRunsView.parse(v),
    );
    if (!got) return;
    if (
      !(await allowed(
        d.principalOf(req),
        'project.view',
        pdpResource.project(got.value.project_id),
      ))
    ) {
      return deny(reply, 'project.view');
    }
    return got.value;
  });

  app.get('/api/agents/:id/stats', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const agent = AgentId.safeParse((req.params as { id: string }).id);
    if (!agent.success) return sendError(reply, 400, 'invalid_input', 'unknown agent');
    const q = z.strictObject({ project: ProjectId.optional() }).safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'bad query');
    const resource =
      q.data.project === undefined ? pdpResource.fleet() : pdpResource.project(q.data.project);
    if (!(await allowed(d.principalOf(req), 'audit.read', resource))) {
      return deny(reply, 'audit.read');
    }
    const qs = new URLSearchParams({ on_behalf_of: d.principalOf(req) });
    if (q.data.project !== undefined) qs.set('project', q.data.project);
    return upstream(reply, await c.call('GET', `/v1/agents/${agent.data}/stats?${qs}`), (v) =>
      AgentStats.parse(v),
    )?.value;
  });

  // ------------------------------------------------------------ evals (M11.3)

  /** Evals are factory-wide: `audit.read` on the fleet, or on the project tag asked for. */
  async function evalRead(
    req: FastifyRequest,
    reply: FastifyReply,
    keys: readonly string[],
  ): Promise<{ qs: URLSearchParams; c: CoreClient } | null> {
    const c = core(reply);
    if (!c) return null;
    const shape = Object.fromEntries(keys.map((k) => [k, z.string().min(1).max(64).optional()]));
    const q = z
      .strictObject({ ...shape, project: ProjectId.optional() })
      .safeParse(req.query ?? {});
    if (!q.success) {
      sendError(reply, 400, 'invalid_input', 'bad query');
      return null;
    }
    const resource =
      q.data.project === undefined ? pdpResource.fleet() : pdpResource.project(q.data.project);
    if (!(await allowed(d.principalOf(req), 'audit.read', resource))) {
      deny(reply, 'audit.read');
      return null;
    }
    const qs = new URLSearchParams({ on_behalf_of: d.principalOf(req) });
    for (const [k, v] of Object.entries(q.data)) if (typeof v === 'string') qs.set(k, v);
    return { qs, c };
  }

  app.get('/api/evals/summary', async (req, reply) => {
    const r = await evalRead(req, reply, []);
    if (!r) return;
    return upstream(reply, await r.c.call('GET', `/v1/evals/summary?${r.qs}`), (v) =>
      EvalSummaryView.parse(v),
    )?.value;
  });

  app.get('/api/evals/runs', async (req, reply) => {
    const r = await evalRead(req, reply, ['suite', 'agent', 'limit']);
    if (!r) return;
    return upstream(reply, await r.c.call('GET', `/v1/evals/runs?${r.qs}`), (v) =>
      EvalRunsView.parse(v),
    )?.value;
  });

  app.get('/api/agents/:id/scores', async (req, reply) => {
    const agent = AgentId.safeParse((req.params as { id: string }).id);
    if (!agent.success) return sendError(reply, 400, 'invalid_input', 'unknown agent');
    const r = await evalRead(req, reply, []);
    if (!r) return;
    return upstream(reply, await r.c.call('GET', `/v1/agents/${agent.data}/scores?${r.qs}`), (v) =>
      AgentScoresView.parse(v),
    )?.value;
  });

  // ------------------------------------------------------------ S0 records and their cards

  /** The S0 record, once the principal may view its project. */
  async function viewableS0(req: FastifyRequest, reply: FastifyReply, c: CoreClient, id: string) {
    const got = upstream(reply, await c.call('GET', `/v1/s0/${id}`), (v) => S0Overview.parse(v));
    if (!got) return null;
    if (
      !(await allowed(
        d.principalOf(req),
        'project.view',
        pdpResource.project(got.value.record.project_id),
      ))
    ) {
      deny(reply, 'project.view');
      return null;
    }
    return got.value;
  }

  app.get('/api/s0/:id', async (req, reply) => {
    const c = core(reply);
    const id = idParam(req, reply);
    if (!c || !id) return;
    return (await viewableS0(req, reply, c, id)) ?? undefined;
  });

  app.get('/api/s0/:id/cards', async (req, reply) => {
    const c = core(reply);
    const id = idParam(req, reply);
    if (!c || !id) return;
    const s0 = await viewableS0(req, reply, c, id);
    if (!s0) return;
    const got = upstream(reply, await c.call('GET', `/v1/s0/${id}/cards`), (v) =>
      z.array(OnboardingCardSummary).parse(v),
    );
    if (!got) return;
    const who = d.principalOf(req);
    const out: PortalCardSummary[] = [];
    for (const card of got.value) {
      out.push({
        ...card,
        may_decide: await allowed(
          who,
          'card.decide',
          pdpResource.card(card.project_id, card.card_id),
        ),
      });
    }
    return out;
  });

  /** A card's summary (its project) before anything else is done with it. */
  async function cardHead(reply: FastifyReply, c: CoreClient, id: string) {
    return upstream(reply, await c.call('GET', `/v1/cards/${id}/summary`), (v) =>
      OnboardingCardSummary.parse(v),
    );
  }

  /**
   * The artefacts a work-item gate card (G1f, G2) decides, rendered, each with its hash (M12). Core reads
   * them back through its store, which checks every hash; the person needs `project.view` on the project.
   */
  app.get('/api/cards/:id/artefacts', async (req, reply) => {
    const c = core(reply);
    const id = idParam(req, reply);
    if (!c || !id) return;
    const got = upstream(reply, await c.call('GET', `/v1/cards/${id}/artefacts`), (v) =>
      GateArtefactsView.parse(v),
    );
    if (!got) return;
    const who = d.principalOf(req);
    if (!(await allowed(who, 'project.view', pdpResource.project(got.value.project_id)))) {
      return deny(reply, 'project.view');
    }
    return got.value;
  });

  app.get('/api/cards/:id', async (req, reply) => {
    const c = core(reply);
    const id = idParam(req, reply);
    if (!c || !id) return;
    const head = await cardHead(reply, c, id);
    if (!head) return;
    const who = d.principalOf(req);
    if (!(await allowed(who, 'project.view', pdpResource.project(head.value.project_id)))) {
      return deny(reply, 'project.view');
    }
    const got = upstream<Record<string, unknown>>(reply, await c.call('GET', `/v1/cards/${id}`));
    if (!got) return;
    const holders = (key: string): readonly string[] | null => {
      const x = got.value[key] as { holders?: unknown } | null | undefined;
      return Array.isArray(x?.holders) ? (x.holders as string[]) : null;
    };
    const slotHolders = holders('deciders');
    const m4Holders = holders('m4_deciders');
    const pdpYes = await allowed(
      who,
      'card.decide',
      pdpResource.card(head.value.project_id, head.value.card_id),
    );
    const mine =
      pdpYes &&
      (slotHolders?.includes(who) ?? false) &&
      (head.value.card !== 'C5' || (m4Holders?.includes(who) ?? false));
    const ids = [...new Set([...(slotHolders ?? []), ...(m4Holders ?? []), who])];
    return {
      ...got.value,
      may_decide: mine,
      principal_names: await names(ids),
    };
  });

  // ------------------------------------------------------------ a work-item gate card (Gap B)

  /** A work-item card's view (its project first): `project.view`, then who may decide it. */
  app.get('/api/cards/:id/gate', async (req, reply) => {
    const c = core(reply);
    const id = idParam(req, reply);
    if (!c || !id) return;
    const got = upstream(reply, await c.call('GET', `/v1/cards/${id}/gate`), (v) =>
      GateCardView.parse(v),
    );
    if (!got) return;
    const who = d.principalOf(req);
    if (!(await allowed(who, 'project.view', pdpResource.project(got.value.project_id)))) {
      return deny(reply, 'project.view');
    }
    const pdpYes = await allowed(
      who,
      'card.decide',
      pdpResource.card(got.value.project_id, got.value.card_id),
    );
    const open = got.value.status === 'open' && got.value.gates.some((g) => g.status === 'pending');
    return {
      ...got.value,
      // never for a gate that needs a step-up: the portal does not decide those here
      may_decide:
        pdpYes &&
        open &&
        (got.value.deciders.holders as readonly string[]).includes(who) &&
        got.value.gates.every((g) => !g.step_up_required),
      principal_names: await names([...new Set([...got.value.deciders.holders, who])]),
    };
  });

  /** The PDP's `card.decide` on the card's project, then core (which asks `gate.decide` too). */
  async function gateMove<S extends z.ZodType<object>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    verb: 'prepare' | 'evidence' | 'decide',
  ) {
    const c = core(reply);
    const id = idParam(req, reply);
    if (!c || !id) return;
    const body = schema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const who = d.principalOf(req);
    const head = upstream(reply, await c.call('GET', `/v1/cards/${id}/gate`), (v) =>
      GateCardView.parse(v),
    );
    if (!head) return;
    if (!(await allowed(who, 'card.decide', pdpResource.card(head.value.project_id, id)))) {
      return deny(reply, 'card.decide');
    }
    const got = upstream(
      reply,
      await c.call('POST', `/v1/cards/${id}/gate/${verb}`, { ...body.data, on_behalf_of: who }),
    );
    return got?.value;
  }

  app.post('/api/cards/:id/gate/prepare', (req, reply) =>
    gateMove(req, reply, EmptyBody, 'prepare'),
  );
  app.post('/api/cards/:id/gate/evidence', (req, reply) =>
    gateMove(req, reply, PortalGateEvidenceBody, 'evidence'),
  );
  app.post('/api/cards/:id/gate/decide', (req, reply) =>
    gateMove(req, reply, PortalGateDecideBody, 'decide'),
  );

  // ------------------------------------------------------------ the card moves

  /** The PDP's `card.decide` on the card's project, then core with the principal from the session. */
  async function cardMove<S extends z.ZodType<object>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    verb: 'prepare' | 'evidence' | 'decide' | 'recheck',
  ) {
    const c = core(reply);
    const id = idParam(req, reply);
    if (!c || !id) return;
    const body = schema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const who = d.principalOf(req);
    const head = await cardHead(reply, c, id);
    if (!head) return;
    if (!(await allowed(who, 'card.decide', pdpResource.card(head.value.project_id, id)))) {
      return deny(reply, 'card.decide');
    }
    const got = upstream(
      reply,
      await c.call('POST', `/v1/cards/${id}/${verb}`, { ...body.data, on_behalf_of: who }),
    );
    return got?.value;
  }

  app.post('/api/cards/:id/prepare', (req, reply) => cardMove(req, reply, EmptyBody, 'prepare'));
  app.post('/api/cards/:id/evidence', (req, reply) =>
    cardMove(req, reply, PortalEvidenceBody, 'evidence'),
  );
  app.post('/api/cards/:id/decide', (req, reply) =>
    cardMove(req, reply, PortalDecideBody, 'decide'),
  );
  app.post('/api/cards/:id/recheck', (req, reply) => cardMove(req, reply, EmptyBody, 'recheck'));

  // ------------------------------------------------------------ inbox (M8.3)

  /** The PDP's `project.view`, then what the person may do with the item and who does. */
  app.get('/api/inbox', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const who = d.principalOf(req);
    const got = upstream(reply, await c.call('GET', '/v1/inbox'), (v) =>
      z.array(CoreInboxItem).parse(v),
    );
    if (!got) return;
    const items: Array<Omit<PortalInboxItem, 'deciders'>> = [];
    for (const item of got.value) {
      if (!(await allowed(who, 'project.view', pdpResource.project(item.project_id)))) continue;
      const pdpYes =
        item.kind === 'onboarding_card'
          ? await allowed(who, 'card.decide', pdpResource.card(item.project_id, item.id))
          : await allowed(who, 'gate.decide', pdpResource.gate(item.project_id, item.id, 'M1'));
      items.push({ ...item, may_decide: pdpYes && item.holders.includes(who as never) });
    }
    const nameOf = await names([...new Set(items.flatMap((i) => i.holders))]);
    const full: PortalInboxItem[] = items.map((i) => ({
      ...i,
      deciders: i.holders.map((p) => ({ principal_id: p, display_name: nameOf[p] ?? p })),
    }));
    const out: PortalInbox = {
      decide: full.filter((i) => i.may_decide),
      view: full.filter((i) => !i.may_decide),
    };
    return out;
  });

  // ------------------------------------------------------------ settings revision (card 4's M1 gate)

  async function revisionMay(who: string, v: SettingsRevisionView): Promise<boolean> {
    return (
      v.status === 'pending' &&
      v.deciders.holders.includes(who as never) &&
      (await allowed(who, 'gate.decide', pdpResource.gate(v.project_id, v.gate_instance_id, 'M1')))
    );
  }

  app.get('/api/s0/:id/revision', async (req, reply) => {
    const c = core(reply);
    const id = idParam(req, reply);
    if (!c || !id) return;
    if (!(await viewableS0(req, reply, c, id))) return;
    const got = upstream(reply, await c.call('GET', `/v1/s0/${id}/revision`), (v) =>
      S0Revision.parse(v),
    );
    if (!got) return;
    const rev = got.value.revision;
    return {
      revision: rev
        ? {
            ...rev,
            may_decide: await revisionMay(d.principalOf(req), rev),
            principal_names: await names(rev.deciders.holders),
          }
        : null,
    };
  });

  app.get('/api/revisions/:gate', async (req, reply) => {
    const c = core(reply);
    const gate = (req.params as { gate?: string }).gate;
    if (!c) return;
    if (!uuid.safeParse(gate).success) return sendError(reply, 400, 'invalid_input', 'bad id');
    const got = upstream(reply, await c.call('GET', `/v1/revisions/${gate}`), (v) =>
      SettingsRevisionView.parse(v),
    );
    if (!got) return;
    const who = d.principalOf(req);
    if (!(await allowed(who, 'project.view', pdpResource.project(got.value.project_id)))) {
      return deny(reply, 'project.view');
    }
    return {
      ...got.value,
      may_decide: await revisionMay(who, got.value),
      principal_names: await names(got.value.deciders.holders),
    };
  });

  /** `gate.decide` on the M1 gate of the revision's project, then core with the principal from the session. */
  async function revisionMove<S extends z.ZodType<object>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    verb: 'prepare' | 'evidence' | 'decide' | 'publish',
  ) {
    const c = core(reply);
    const gate = (req.params as { gate?: string }).gate;
    if (!c) return;
    if (!uuid.safeParse(gate).success) return sendError(reply, 400, 'invalid_input', 'bad id');
    const body = schema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const who = d.principalOf(req);
    const head = upstream(reply, await c.call('GET', `/v1/revisions/${gate}`), (v) =>
      SettingsRevisionView.parse(v),
    );
    if (!head) return;
    if (
      !(await allowed(
        who,
        'gate.decide',
        pdpResource.gate(head.value.project_id, gate as string, 'M1'),
      ))
    ) {
      return deny(reply, 'gate.decide');
    }
    const got = upstream(
      reply,
      await c.call('POST', `/v1/revisions/${gate}/${verb}`, { ...body.data, on_behalf_of: who }),
    );
    return got?.value;
  }

  app.post('/api/revisions/:gate/prepare', (req, reply) =>
    revisionMove(req, reply, EmptyBody, 'prepare'),
  );
  app.post('/api/revisions/:gate/evidence', (req, reply) =>
    revisionMove(req, reply, PortalRevisionEvidenceBody, 'evidence'),
  );
  app.post('/api/revisions/:gate/decide', (req, reply) =>
    revisionMove(req, reply, PortalRevisionDecideBody, 'decide'),
  );
  app.post('/api/revisions/:gate/publish', (req, reply) =>
    revisionMove(req, reply, EmptyBody, 'publish'),
  );

  // ------------------------------------------------------------ readiness record and ledger (M8.4)

  app.get('/api/projects/:id/prr', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const id = ProjectId.safeParse((req.params as { id: string }).id);
    if (!id.success) return sendError(reply, 400, 'invalid_input', 'bad project id');
    if (!(await allowed(d.principalOf(req), 'project.view', pdpResource.project(id.data)))) {
      return deny(reply, 'project.view');
    }
    return upstream(reply, await c.call('GET', `/v1/projects/${id.data}/prr`), (v) =>
      ProjectPrrView.parse(v),
    )?.value;
  });

  app.get('/api/projects/:id/ledger', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const id = ProjectId.safeParse((req.params as { id: string }).id);
    if (!id.success) return sendError(reply, 400, 'invalid_input', 'bad project id');
    const q = z
      .strictObject({
        s0: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(2000).optional(),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'bad query');
    if (!(await allowed(d.principalOf(req), 'audit.read', pdpResource.project(id.data)))) {
      return deny(reply, 'audit.read');
    }
    const qs = new URLSearchParams();
    if (q.data.s0) qs.set('s0', q.data.s0);
    if (q.data.limit) qs.set('limit', String(q.data.limit));
    const path = `/v1/projects/${id.data}/ledger${qs.size > 0 ? `?${qs}` : ''}`;
    return upstream(reply, await c.call('GET', path), (v) => LedgerAuditView.parse(v))?.value;
  });
}
