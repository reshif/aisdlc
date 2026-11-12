import {
  AgentId,
  AgentRunsView,
  AgentScoresView,
  AgentStats,
  C2InstructionEditRequest,
  CardDecideRequest,
  CardEvidenceRequest,
  GateCardDecideRequest,
  GateCardEvidenceRequest,
  GateCardView,
  ConfigKeySummary,
  ConfigKeyView,
  ConfigProposeRequest,
  ConfigProposeResult,
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
  ItemHumanDoneRequest,
  ItemPlanResult,
  ItemReadyRequest,
  ItemView,
  PortalItemView,
  ProjectSummary,
  EvidencePackView,
  GateCardContext,
  GateCheckRunsView,
  ItemVerifyView,
  cutGateContext,
  cutVerifyView,
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
import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';
import { registerGovernancePortalRoutes } from './governance.js';
import type { Levels } from './levels.js';

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
//   GET  /api/items/:id/verify[?head=]    S7: the checks 7.1-7.5 of a Unit head      (project.view, V2; cut to the data class)
//   GET  /api/items/:id/evidence[?pack=]  the signed Evidence Pack(s) of 7.6          (project.view, V2)
//   GET  /api/items/:id/evidence/:pack/signed  the signed bytes, for aisdlc-verify-pack (project.view, V2)
//   GET  /api/items/:id/gate-check        gate-check's verdicts on the item's PRs     (item.view_floor, V2; unknown
//                                         when gate-check is not configured or does not answer, never success)
//   GET  /api/cards/:id/gate/context      what an exception or quarantine gate binds (project.view, V2; cut)
//   GET  /api/agent-runs?item=            the agent runs of an item and their outcomes (project.view)
//   GET  /api/agents/:id/stats            acceptance, back-edge rate, cost per run     (audit.read)
//   GET  /api/agents/:id/scores           AgentScore per prompt, provider and model    (audit.read)
//   GET  /api/evals/summary               the quality board's rows (allow-listed)      (audit.read)
//   GET  /api/evals/runs                  the eval run history                         (audit.read)
//   GET  /api/s0/:id                      the S0 record with its steps                (project.view)
//   GET  /api/s0/:id/cards                its cards, with `may_decide`                (project.view)
//   GET  /api/cards/:id                   one card with its view and deciders         (project.view)
//   GET  /api/cards/:id/artefacts         a work-item gate card's artefacts, rendered (project.view)
//   POST /api/cards/:id/prepare|evidence|decide|recheck|probe/retry                   (card.decide)
//   GET  /api/cards/:id/gate              a work-item gate card as something to decide  (project.view)
//   POST /api/cards/:id/gate/prepare|evidence|decide      deciding G0/G1, G1f, G2, G3d, G3 ...  (card.decide;
//                                         core asks gate.decide for every gate of the card)
//   GET  /api/inbox                       what waits for the person, and what they only see
//   GET  /api/s0/:id/revision             the settings revision card 4 proposed       (project.view)
//   GET  /api/revisions/:gate             the same, by its gate                       (project.view)
//   POST /api/revisions/:gate/prepare|evidence|decide|publish                         (gate.decide on the M1 gate)
//   GET  /api/projects/:id/prr            the project's readiness records             (project.view)
//   GET  /api/projects/:id/ledger         the ledger entries of the project           (audit.read)
//   GET  /api/config/keys                 the registered config keys, with may_propose (audit.read or
//                                         config.propose on the fleet)
//   GET  /api/config/keys/:key            one key: effective value and lineage, pending, history (same)
//   POST /api/config/keys/:key/proposals  propose a value: a revision with its M1 gate   (config.propose)
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
  /**
   * The view level and data class the person reaches on a project (`levels.ts`); `null` or a throw: none (V1/D0
   * is never assumed above what the roles give). The S7 reads (M14.6) need V2 and are cut to the data class.
   */
  readonly levelsOf?: (principal: string, project: string) => Promise<Levels | null>;
  /** gate-check's read API (`GET /v1/verdicts`), scope `read`; without it the gate-check status reads `unknown`. */
  readonly gateCheck?: CoreClient;
}

const uuid = z.uuid();

/** What the browser may send to start an onboarding: `on_behalf_of` is the session's, not a field. */
export const PortalOnboardBody = OnboardRequest.omit({ on_behalf_of: true });
/** Portal Ask: the channel is the portal's (N1) and `on_behalf_of` the session's, neither is a field. */
export const PortalAskBody = SubmitRequestBody.omit({ on_behalf_of: true, channel: true });
export const PortalEvidenceBody = CardEvidenceRequest.omit({ on_behalf_of: true });
export const PortalDecideBody = CardDecideRequest.omit({ on_behalf_of: true });
/** Card 2 (M16): a person edits a file's proposed instruction text. */
export const PortalInstructionEditBody = C2InstructionEditRequest.omit({ on_behalf_of: true });
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
export const PortalHumanDoneBody = ItemHumanDoneRequest.omit({ on_behalf_of: true });
export const PortalConfigProposeBody = ConfigProposeRequest.omit({ on_behalf_of: true });
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

  /** The PDP's answer with its reasons (a throw is a deny with `evaluator_error`). */
  async function decideWithReasons(principal: string, action: ActionId, resource: PdpResource) {
    try {
      const out = await d.pdp.decide({ principal, action, resource });
      return { allow: out.decision === 'allow', reasons: [...out.reasons] };
    } catch {
      return { allow: false, reasons: ['evaluator_error'] };
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
    verb: 'ready' | 'answers' | 'observe' | 'plan' | 'human-done',
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
  // M14.6: D5, the human-led work of an L8 item is done (no portal button yet: the compose e2e calls it)
  app.post('/api/items/:id/human-done', (req, reply) =>
    itemMove(req, reply, PortalHumanDoneBody, 'human-done', 'item.human_done'),
  );

  // ------------------------------------------------------------ configuration console

  /** Reading the factory's configuration: an auditor or anyone who may propose a change. */
  async function configReader(req: FastifyRequest, reply: FastifyReply) {
    const c = core(reply);
    if (!c) return null;
    const who = d.principalOf(req);
    const propose = await allowed(who, 'config.propose', pdpResource.fleet());
    if (!propose && !(await allowed(who, 'audit.read', pdpResource.fleet()))) {
      deny(reply, 'audit.read');
      return null;
    }
    return { c, who, propose };
  }
  const configKey = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const k = (req.params as { key?: string }).key;
    if (typeof k === 'string' && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(k)) return k;
    sendError(reply, 400, 'invalid_input', 'bad config key');
    return null;
  };

  app.get('/api/config/keys', async (req, reply) => {
    const r = await configReader(req, reply);
    if (!r) return;
    const got = upstream(reply, await r.c.call('GET', '/v1/config/keys'), (v) =>
      z.array(ConfigKeySummary).parse(v),
    );
    return got ? { keys: got.value, may_propose: r.propose } : undefined;
  });

  app.get('/api/config/keys/:key', async (req, reply) => {
    const r = await configReader(req, reply);
    const key = r ? configKey(req, reply) : null;
    if (!r || !key) return;
    const got = upstream(reply, await r.c.call('GET', `/v1/config/keys/${key}`), (v) =>
      ConfigKeyView.parse(v),
    );
    if (!got) return;
    const ids = new Set<string>();
    for (const h of got.value.history) ids.add(h.proposed_by);
    for (const p of got.value.pending) for (const h of p.deciders.holders) ids.add(h);
    return { ...got.value, may_propose: r.propose, principal_names: await names([...ids]) };
  });

  app.post('/api/config/keys/:key/proposals', async (req, reply) => {
    const c = core(reply);
    const key = c ? configKey(req, reply) : null;
    if (!c || !key) return;
    const body = PortalConfigProposeBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const who = d.principalOf(req);
    if (!(await allowed(who, 'config.propose', pdpResource.fleet()))) {
      return deny(reply, 'config.propose');
    }
    const r = await c.call('POST', `/v1/config/keys/${key}/proposals`, {
      ...body.data,
      on_behalf_of: who,
    });
    const got = upstream(reply, r, (v) => ConfigProposeResult.parse(v));
    if (!got) return;
    return reply.code(201).send(got.value);
  });

  // ------------------------------------------------------------ S7 Verify and the Evidence Pack (M14.6)
  //
  // Content of the work: the PDP's `project.view` (core asks it too) AND view level V2 on the project, and the answer
  // cut to the person's data class (finding text needs D1, tripwire evidence and secret findings D2). A level that
  // cannot be read is no level: the read is refused.

  /** The person's levels on the project, or the refusal sent (403 below V2). */
  async function contentLevels(req: FastifyRequest, reply: FastifyReply, project: string) {
    let lv: Levels | null;
    try {
      lv = (await d.levelsOf?.(d.principalOf(req), project)) ?? null;
    } catch {
      lv = null;
    }
    if (lv === null || lv.view_level === 'V1') {
      sendError(
        reply,
        403,
        'view_level',
        'the S7 results and the Evidence Pack are content of the work: they need view level V2 on the project',
      );
      return null;
    }
    return lv;
  }

  /** `project.view` here as well as in core, on the project core's answer names. */
  async function projectViewable(req: FastifyRequest, reply: FastifyReply, project: string) {
    if (!(await allowed(d.principalOf(req), 'project.view', pdpResource.project(project)))) {
      deny(reply, 'project.view');
      return false;
    }
    return true;
  }

  const onBehalf = (req: FastifyRequest, extra: Record<string, string> = {}) =>
    new URLSearchParams({ ...extra, on_behalf_of: d.principalOf(req) }).toString();

  app.get('/api/items/:id/verify', async (req, reply) => {
    const c = core(reply);
    const id = c ? idParam(req, reply) : null;
    if (!c || !id) return;
    const q = z
      .strictObject({
        head: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'head is a commit sha');
    const got = upstream(
      reply,
      await c.call(
        'GET',
        `/v1/items/${id}/verify?${onBehalf(req, q.data.head ? { head: q.data.head } : {})}`,
      ),
      (v) => ItemVerifyView.parse(v),
    );
    if (!got || !(await projectViewable(req, reply, got.value.project_id))) return;
    const lv = await contentLevels(req, reply, got.value.project_id);
    if (!lv) return;
    return cutVerifyView(got.value, lv.data_class);
  });

  app.get('/api/items/:id/evidence', async (req, reply) => {
    const c = core(reply);
    const id = c ? idParam(req, reply) : null;
    if (!c || !id) return;
    const q = z
      .strictObject({
        pack: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'pack is a sha256');
    const got = upstream(
      reply,
      await c.call(
        'GET',
        `/v1/items/${id}/evidence?${onBehalf(req, q.data.pack ? { pack: q.data.pack } : {})}`,
      ),
      (v) => EvidencePackView.parse(v),
    );
    if (!got || !(await projectViewable(req, reply, got.value.project_id))) return;
    if (!(await contentLevels(req, reply, got.value.project_id))) return;
    return got.value;
  });

  /**
   * The signed bytes for offline checking. Core answers them as canonical JSON; they are written out again in
   * canonical form here and must hash to the recorded object key, or nothing is sent.
   */
  app.get('/api/items/:id/evidence/:pack/signed', async (req, reply) => {
    const c = core(reply);
    const id = c ? idParam(req, reply) : null;
    if (!c || !id) return;
    const pack = (req.params as { pack?: string }).pack ?? '';
    if (!/^[0-9a-f]{64}$/.test(pack)) return sendError(reply, 400, 'invalid_input', 'bad pack');
    const view = upstream(
      reply,
      await c.call('GET', `/v1/items/${id}/evidence?${onBehalf(req, { pack })}`),
      (v) => EvidencePackView.parse(v),
    );
    if (!view || !(await projectViewable(req, reply, view.value.project_id))) return;
    if (!(await contentLevels(req, reply, view.value.project_id))) return;
    const objectKey = view.value.pack?.object_key;
    const got = upstream(
      reply,
      await c.call('GET', `/v1/items/${id}/evidence/${pack}/signed?${onBehalf(req)}`),
    );
    if (!got) return;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(canonicalJson(got.value as never), 'utf8');
    } catch {
      return sendError(reply, 502, 'core_error', 'the signed pack is not canonical JSON');
    }
    if (objectKey === undefined || sha256Hex(bytes) !== objectKey) {
      return sendError(reply, 502, 'core_error', 'the signed pack does not hash to its object key');
    }
    return reply
      .type('application/json')
      .header('content-disposition', `attachment; filename="${objectKey}.json"`)
      .send(bytes);
  });

  /** gate-check's verdicts on the item's PRs. Not configured, not reached, or an odd answer: `unknown`. */
  app.get('/api/items/:id/gate-check', async (req, reply) => {
    const c = core(reply);
    const id = c ? idParam(req, reply) : null;
    if (!c || !id) return;
    const it = await itemOf(req, reply, c, id);
    if (!it) return;
    if (!(await contentLevels(req, reply, it.view.project_id))) return;
    const unknown = GateCheckRunsView.parse({ item_id: id, status: 'unknown', verdicts: [] });
    if (!d.gateCheck) return unknown;
    const r = await d.gateCheck.call('GET', `/v1/verdicts?item=${id}`);
    if (!r.reached || r.status !== 200) return unknown;
    const rows = z
      .strictObject({
        verdicts: z.array(
          z.looseObject({
            seq: z.number(),
            verdict: z.looseObject({}),
            verdict_sha256: z.string(),
            check_run_id: z.union([z.number(), z.string()]).nullable(),
            recorded_at: z.string(),
          }),
        ),
      })
      .safeParse(r.json);
    if (!rows.success) return unknown;
    try {
      return GateCheckRunsView.parse({
        item_id: id,
        status: 'ok',
        verdicts: rows.data.verdicts.map((x) => {
          const v = x.verdict as Record<string, unknown>;
          return {
            seq: x.seq,
            recorded_at: new Date(x.recorded_at).toISOString(),
            check_run_id: x.check_run_id === null ? null : Number(x.check_run_id),
            verdict_sha256: x.verdict_sha256,
            repo: v['repo'],
            pr_number: v['pr_number'],
            head_sha: v['head_sha'],
            outcome: v['outcome'],
            reason: v['reason'],
            detail: v['detail'],
            pack_sha256: v['pack_sha256'] ?? null,
          };
        }),
      });
    } catch {
      return unknown;
    }
  });

  /** What an exception or quarantine gate binds and decides, cut to the person's data class. */
  app.get('/api/cards/:id/gate/context', async (req, reply) => {
    const c = core(reply);
    const id = c ? idParam(req, reply) : null;
    if (!c || !id) return;
    const got = upstream(reply, await c.call('GET', `/v1/cards/${id}/gate/context`), (v) =>
      GateCardContext.parse(v),
    );
    if (!got || !(await projectViewable(req, reply, got.value.project_id))) return;
    const lv = await contentLevels(req, reply, got.value.project_id);
    if (!lv) return;
    const ctx = cutGateContext(got.value, lv.data_class);
    const ids = [
      ...new Set([...ctx.decisions.map((x) => x.actor), ...(ctx.requester ? [ctx.requester] : [])]),
    ];
    return { ...ctx, principal_names: await names(ids) };
  });

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
    const pdpYes = await decideWithReasons(
      who,
      'card.decide',
      pdpResource.card(got.value.project_id, got.value.card_id),
    );
    const open = got.value.status === 'open' && got.value.gates.some((g) => g.status === 'pending');
    const holder = (got.value.deciders.holders as readonly string[]).includes(who);
    // Why not this person, in the PDP's words first: the hint the page shows (the kernel decides again on decide).
    let why_not: { code: string; reasons: string[] } | null = null;
    if (!open) why_not = { code: 'not_open', reasons: [] };
    else if (!pdpYes.allow) why_not = { code: 'pdp_denied', reasons: pdpYes.reasons };
    else if (!holder) why_not = { code: 'not_slot_holder', reasons: [] };
    return {
      ...got.value,
      // a gate that needs a step-up is decided with a proof bound to its hash (the page asks for it first)
      may_decide: why_not === null,
      why_not,
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
    verb: 'prepare' | 'evidence' | 'decide' | 'recheck' | 'instructions' | 'probe/retry',
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
  app.post('/api/cards/:id/instructions', (req, reply) =>
    cardMove(req, reply, PortalInstructionEditBody, 'instructions'),
  );
  /** Card 2 (M16): a slot holder asks for the onboarding probe again (it ran nothing); core records it first. */
  app.post('/api/cards/:id/probe/retry', (req, reply) =>
    cardMove(req, reply, EmptyBody, 'probe/retry'),
  );

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

  // ------------------------------------------------------------ M15.5: RELHOLD, B14, B17, 9.3, 9.5, 9.4, factory M1

  registerGovernancePortalRoutes({
    app,
    principalOf: d.principalOf,
    core,
    allowed,
    deny,
    upstream,
    idParam,
    itemOf,
  });
}
