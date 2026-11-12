import {
  ASSISTANT_QUESTION_MAX,
  AskResult,
  AssistantBudgetView,
  S0Overview,
  ThreadId,
  ThreadList,
  ThreadSubjectRequest,
  ThreadView,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { Clock } from '@aisdlc/kernel';
import type { Pdp } from '@aisdlc/pdp';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { dataClassOn } from './access.js';
import type { CoreClient } from './core-client.js';

// The assistant in front of core (PLAN M18; portal-config §4): the onboarding assistant beside the S0 page and
// "Ask the factory".
//
//   POST /api/assistant/ask               {thread_id} or {subject}, and the text: a turn and its answer
//   GET  /api/assistant/threads?s0=|project=   the person's own threads
//   GET  /api/assistant/threads/:id       one of them, with what it is grounded on and the budget left
//   GET  /api/assistant/budget            the person's day budget (`assistant_user_day`)
//
// The person is ALWAYS the session's (`on_behalf_of`), never the body's. Their data class on the subject's project is
// read here from their roles (the same reading as `/api/me/access`) and sent along; core caps it at the assistant's
// D1. The PDP is asked here (`project.view` on the subject's project: the catalogue has no `assistant.use`) and again
// by core. The assistant answers; it never decides. A ProposalButton it returns names the normal route and the PDP
// action, and the portal calls that route under this same session when the person clicks it.

export interface AssistantRouteDeps {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly pdp: Pdp;
  readonly clock: Clock;
  readonly core: CoreClient | undefined;
  readonly principalOf: (req: FastifyRequest) => string;
}

/** What the browser may send: never `on_behalf_of` or a data class. */
export const PortalAskBody = z
  .strictObject({
    thread_id: ThreadId.optional(),
    subject: ThreadSubjectRequest.optional(),
    text: z.string().trim().min(1).max(ASSISTANT_QUESTION_MAX),
  })
  .refine((r) => (r.thread_id === undefined) !== (r.subject === undefined), {
    message: 'name either thread_id or subject',
  });

const ListQuery = z.strictObject({
  s0: z.uuid().optional(),
  project: z.string().min(1).max(128).optional(),
});

export function registerAssistantRoutes(d: AssistantRouteDeps): void {
  const { app } = d;

  async function allowed(principal: string, action: ActionId, resource: PdpResource) {
    try {
      return (await d.pdp.decide({ principal, action, resource })).decision === 'allow';
    } catch {
      return false;
    }
  }

  const core = (reply: FastifyReply): CoreClient | null => {
    if (d.core) return d.core;
    sendError(reply, 503, 'core_not_configured', 'the bff has no core to call');
    return null;
  };

  function upstream<T>(reply: FastifyReply, r: CallResult, parse: (v: unknown) => T): T | null {
    if (!r.reached || r.status >= 500) {
      const e = (r.reached ? (r.json as { error?: { code?: unknown } } | null)?.error : null)?.code;
      sendError(
        reply,
        502,
        e === 'unavailable' ? 'assistant_unavailable' : 'core_unavailable',
        'the assistant could not answer',
      );
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
      sendError(reply, 502, 'core_error', 'the factory core sent something unexpected');
      return null;
    }
  }

  /** The project of what the browser named, read from core, or `null` (a reply was sent). */
  async function projectOf(
    reply: FastifyReply,
    c: CoreClient,
    who: string,
    body: z.infer<typeof PortalAskBody>,
  ): Promise<string | null | undefined> {
    if (body.subject?.kind === 'project') return body.subject.project_id;
    if (body.subject?.kind === 's0') {
      const got = upstream(reply, await c.call('GET', `/v1/s0/${body.subject.s0_id}`), (v) =>
        S0Overview.parse(v),
      );
      return got ? got.record.project_id : null;
    }
    // an existing thread: core reads its subject and asks the PDP; its project is learnt from the thread
    const t = upstream(
      reply,
      await c.call(
        'GET',
        `/v1/assistant/threads/${body.thread_id}?on_behalf_of=${encodeURIComponent(who)}`,
      ),
      (v) => ThreadView.parse(v),
    );
    return t ? t.thread.subject.project_id : null;
  }

  app.post('/api/assistant/ask', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const body = PortalAskBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const who = d.principalOf(req);
    const project = await projectOf(reply, c, who, body.data);
    if (!project) return;
    if (!(await allowed(who, 'project.view', pdpResource.project(project)))) {
      return sendError(reply, 403, 'forbidden', 'project.view denied');
    }
    const dc = await dataClassOn(d.pool, who, project, d.clock.now()).catch(() => null);
    const r = await c.call('POST', '/v1/assistant/ask', {
      ...body.data,
      on_behalf_of: who,
      // no role in force on the project is the least: positions only
      viewer_data_class: dc ?? 'D0',
    });
    const got = upstream(reply, r, (v) => AskResult.parse(v));
    if (!got) return;
    return reply.code(r.reached && r.status === 201 ? 201 : 200).send(got);
  });

  app.get('/api/assistant/threads', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const q = ListQuery.safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 's0 or project');
    const who = d.principalOf(req);
    const qs = new URLSearchParams({ on_behalf_of: who });
    if (q.data.s0) qs.set('s0', q.data.s0);
    if (q.data.project) qs.set('project', q.data.project);
    return upstream(reply, await c.call('GET', `/v1/assistant/threads?${qs}`), (v) =>
      ThreadList.parse(v),
    );
  });

  app.get('/api/assistant/threads/:id', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const id = ThreadId.safeParse((req.params as { id?: string }).id);
    if (!id.success) return sendError(reply, 400, 'invalid_input', 'bad id');
    const who = d.principalOf(req);
    const v = upstream(
      reply,
      await c.call(
        'GET',
        `/v1/assistant/threads/${id.data}?on_behalf_of=${encodeURIComponent(who)}`,
      ),
      (x) => ThreadView.parse(x),
    );
    if (!v) return;
    if (!(await allowed(who, 'project.view', pdpResource.project(v.thread.subject.project_id)))) {
      return sendError(reply, 403, 'forbidden', 'project.view denied');
    }
    return v;
  });

  app.get('/api/assistant/budget', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const who = d.principalOf(req);
    return upstream(
      reply,
      await c.call('GET', `/v1/assistant/budget?on_behalf_of=${encodeURIComponent(who)}`),
      (v) => AssistantBudgetView.parse(v),
    );
  });
}
