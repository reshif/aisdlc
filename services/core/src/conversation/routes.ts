import {
  ASSISTANT_ACTIONS,
  AskRequest,
  AskResult,
  PrincipalId,
  ThreadList,
  ThreadView,
  pdpResource,
  type ActionId,
  type PdpResource,
  type ThreadSubject,
} from '@aisdlc/contracts';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadS0 } from '../cards/read.js';
import { CORE_STATUS, coreError, type CoreError } from '../errors.js';
import { getProject } from '../queries.js';
import { ask, assistantBudget, threadView, type AssistantDeps } from './assistant.js';
import { listThreads, readThread, threadHead } from './store.js';

// The assistant's routes (PLAN M18), for the bff acting for a signed-in person (scope `work`). The person is always
// `on_behalf_of`; a thread is theirs alone (anybody else's thread reads as missing, the same as no thread). Every route
// asks the PDP for `project.view` AND `assistant.use` on the subject's project (`ASSISTANT_ACTIONS`, PLAN §7a), every
// time: a person who lost the project, or the assistant, loses its threads with it. The assistant answers only from
// what that person can already see, and what they may DO through a proposal button is decided again by the PDP action
// of the route the button calls.
//
//   POST /v1/assistant/ask                          AskRequest -> AskResult (a new thread, or a turn on one)
//   GET  /v1/assistant/threads?on_behalf_of=&s0=&project=   the person's threads (one S0 record's, or a project's Ask threads)
//   GET  /v1/assistant/threads/:id?on_behalf_of=    ThreadView: the turns, the grounding now, the budget left
//   GET  /v1/assistant/budget?on_behalf_of=         the person's day budget (`assistant_user_day`)

export interface AssistantRouteDeps {
  readonly app: FastifyInstance;
  readonly assistant: AssistantDeps | undefined;
  readonly allowed: (req: FastifyRequest) => boolean;
  readonly guard: (
    reply: FastifyReply,
    principal: string,
    action: ActionId,
    resource: PdpResource,
  ) => Promise<boolean>;
  /** The PDP's yes, without answering the request (filtering a list). Any error is a no. */
  readonly decide: (principal: string, action: ActionId, resource: PdpResource) => Promise<boolean>;
}

const Who = z.strictObject({
  on_behalf_of: PrincipalId,
  s0: z.uuid().optional(),
  project: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function registerAssistantRoutes(r: AssistantRouteDeps): void {
  const { app } = r;
  const fail = (reply: FastifyReply, e: CoreError) =>
    sendError(reply, CORE_STATUS[e.code], e.code, e.message);

  /** Every one of `ASSISTANT_ACTIONS` on the project, in order; the first refusal answers the request. */
  const guardAll = async (reply: FastifyReply, who: string, project: string) => {
    for (const a of ASSISTANT_ACTIONS) {
      if (!(await r.guard(reply, who, a, pdpResource.project(project)))) return false;
    }
    return true;
  };
  /** The same without answering (filtering a list); any error is a no. */
  const decideAll = async (who: string, project: string) => {
    for (const a of ASSISTANT_ACTIONS) {
      if (!(await r.decide(who, a, pdpResource.project(project)).catch(() => false))) return false;
    }
    return true;
  };

  /** The scope, then the deps: an unconfigured assistant answers 503 and nothing else. */
  const pre = (req: FastifyRequest, reply: FastifyReply): AssistantDeps | null => {
    if (!r.allowed(req)) {
      sendError(reply, 403, 'forbidden', 'scope work is needed');
      return null;
    }
    if (!r.assistant) {
      fail(reply, coreError('unavailable', 'the assistant is not configured'));
      return null;
    }
    return r.assistant;
  };

  app.post('/v1/assistant/ask', async (req, reply) => {
    const d = pre(req, reply);
    if (!d) return;
    const b = AskRequest.safeParse(req.body ?? {});
    if (!b.success) return fail(reply, coreError('invalid_input', b.error.message));
    const who = b.data.on_behalf_of;
    let subject: ThreadSubject;
    try {
      if (b.data.thread_id !== undefined) {
        const head = await threadHead(d.pool, b.data.thread_id);
        // somebody else's thread is the same answer as no thread
        if (!head || head.owner !== who)
          return fail(reply, coreError('not_found', 'no such thread'));
        subject = head.subject;
      } else if (b.data.subject?.kind === 's0') {
        const loaded = await loadS0(d.pool, b.data.subject.s0_id);
        if (!loaded) return fail(reply, coreError('not_found', 'no such S0 record'));
        subject = {
          kind: 's0',
          s0_id: b.data.subject.s0_id,
          project_id: loaded.s0.record.project_id,
        };
      } else {
        const project = b.data.subject?.project_id as string;
        if (!(await getProject(d.pool, project))) {
          return fail(reply, coreError('not_found', 'no such project'));
        }
        subject = { kind: 'project', project_id: project as never };
      }
    } catch {
      return fail(reply, coreError('unavailable', 'the thread could not be read'));
    }
    if (!(await guardAll(reply, who, subject.project_id))) return;
    const done = await ask(d, {
      principal: who,
      thread_id: b.data.thread_id ?? null,
      subject,
      text: b.data.text,
      viewer_data_class: b.data.viewer_data_class,
    });
    if (!done.ok) return fail(reply, done.error);
    const t = await readThread(d.pool, who, done.value.thread_id);
    if (!t) return fail(reply, coreError('unavailable', 'the thread could not be read'));
    const turns = t.turns.filter((x) => x.ask_id === done.value.ask.ask_id);
    return reply.code(b.data.thread_id === undefined ? 201 : 200).send(
      AskResult.parse({
        thread: t.thread,
        turns,
        ask: done.value.ask,
        budget: done.value.budget,
      }),
    );
  });

  app.get('/v1/assistant/threads', async (req, reply) => {
    const d = pre(req, reply);
    if (!d) return;
    const q = Who.safeParse(req.query ?? {});
    if (!q.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    const who = q.data.on_behalf_of;
    try {
      let threads = await listThreads(d.pool, who, {
        ...(q.data.s0 ? { s0_id: q.data.s0 } : {}),
        ...(q.data.project ? { project_id: q.data.project } : {}),
        ...(q.data.limit ? { limit: q.data.limit } : {}),
      });
      // a thread about a project the person can no longer view is not listed
      const seen = new Map<string, boolean>();
      const keep: typeof threads = [];
      for (const t of threads) {
        const p = t.subject.project_id;
        if (!seen.has(p)) {
          seen.set(p, await decideAll(who, p));
        }
        if (seen.get(p)) keep.push(t);
      }
      threads = keep;
      return ThreadList.parse({ threads });
    } catch {
      return fail(reply, coreError('unavailable', 'the threads could not be read'));
    }
  });

  app.get('/v1/assistant/threads/:id', async (req, reply) => {
    const d = pre(req, reply);
    if (!d) return;
    const id = (req.params as { id?: string }).id;
    if (!z.uuid().safeParse(id).success) return fail(reply, coreError('invalid_input', 'bad id'));
    const q = Who.safeParse(req.query ?? {});
    if (!q.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    const who = q.data.on_behalf_of;
    const head = await threadHead(d.pool, id as string);
    if (!head || head.owner !== who) return fail(reply, coreError('not_found', 'no such thread'));
    if (!(await guardAll(reply, who, head.subject.project_id))) return;
    const v = await threadView(d, who, id as string);
    if (!v) return fail(reply, coreError('not_found', 'no such thread'));
    return ThreadView.parse(v);
  });

  app.get('/v1/assistant/budget', async (req, reply) => {
    const d = pre(req, reply);
    if (!d) return;
    const q = Who.safeParse(req.query ?? {});
    if (!q.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    const b = await assistantBudget(d, q.data.on_behalf_of);
    if (!b) return fail(reply, coreError('unavailable', 'the gateway did not say'));
    return b;
  });
}
