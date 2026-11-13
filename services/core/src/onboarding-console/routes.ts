import {
  ConsoleControlRequest,
  ConsoleDraftPatch,
  ConsoleProposalDecideRequest,
  ConsoleMessageRequest,
  ConsoleSessionList,
  PrincipalId,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadS0 } from '../cards/read.js';
import { CORE_STATUS, coreError, type CoreError } from '../errors.js';
import {
  decideProposal,
  observe,
  patchDraft,
  postMessage,
  startSession,
  steer,
  wake,
  type ConsoleDeps,
} from './engine.js';
import { draftOf, listSessions, sessionView } from './store.js';

// The onboarding console's routes (docs/design/onboarding-console.md, P2), for the bff acting for a signed-in person.
// The person is always `on_behalf_of`. Every route asks the PDP for `project.view` AND `onboarding.console.use` on the
// session's project; pause, resume and stop also ask `onboarding.console.steer`. The agent itself holds no grant: what
// it proposes later is a person's request through that request's own action.
//
//   GET  /v1/s0/:id/console?on_behalf_of=            the session (404 until a person starts it)         scope read
//   POST /v1/s0/:id/console/start                     opens it (once) and reads the state first          scope onboard
//   POST /v1/s0/:id/console/messages                  the person says something; the agent answers       scope onboard
//   POST /v1/s0/:id/console/{pause,resume,stop}       steering                                           scope onboard
//   POST /v1/s0/:id/console/proposals/:pid/decide     accept, edit or reject one proposal; the agent goes on scope onboard
//   PATCH /v1/s0/:id/summary                          the person sets summary defaults directly       scope onboard
//   GET  /v1/console/sessions?on_behalf_of=           the sessions the person may see (the session list) scope read

export const CONSOLE_USE_ACTIONS = [
  'project.view',
  'onboarding.console.use',
] as const satisfies readonly ActionId[];

export interface ConsoleRouteDeps {
  readonly app: FastifyInstance;
  readonly console: ConsoleDeps | undefined;
  readonly allowed: (req: FastifyRequest, scope: string) => boolean;
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
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function registerConsoleRoutes(r: ConsoleRouteDeps): void {
  const { app } = r;
  const fail = (reply: FastifyReply, e: CoreError) =>
    sendError(reply, CORE_STATUS[e.code], e.code, e.message);

  const idOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const v = (req.params as Record<string, string>)['id'];
    if (z.uuid().safeParse(v).success) return v as string;
    fail(reply, coreError('invalid_input', 'bad id'));
    return null;
  };
  const pre = (
    req: FastifyRequest,
    reply: FastifyReply,
    scope: 'read' | 'onboard',
  ): ConsoleDeps | null => {
    if (!r.allowed(req, scope)) {
      sendError(reply, 403, 'forbidden', `scope ${scope} is needed`);
      return null;
    }
    if (!r.console) {
      fail(reply, coreError('unavailable', 'the onboarding console is not configured'));
      return null;
    }
    return r.console;
  };
  const guardUse = async (reply: FastifyReply, who: string, project: string) => {
    for (const a of CONSOLE_USE_ACTIONS) {
      if (!(await r.guard(reply, who, a, pdpResource.project(project)))) return false;
    }
    return true;
  };
  /** The project of an S0 record, or the answer to the request. */
  const projectOf = async (
    d: ConsoleDeps,
    reply: FastifyReply,
    id: string,
  ): Promise<string | null> => {
    const loaded = await loadS0(d.cards.pool, id);
    if (!loaded) {
      fail(reply, coreError('not_found', `no S0 record ${id}`));
      return null;
    }
    return loaded.s0.record.project_id;
  };

  app.get('/v1/s0/:id/console', async (req, reply) => {
    const d = pre(req, reply, 'read');
    const id = idOf(req, reply);
    if (!d || !id) return;
    const q = Who.safeParse(req.query ?? {});
    if (!q.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    const project = await projectOf(d, reply, id);
    if (project === null || !(await guardUse(reply, q.data.on_behalf_of, project))) return;
    const v = await sessionView(d.pool, id);
    return v ?? fail(reply, coreError('not_found', 'no console session'));
  });

  app.post('/v1/s0/:id/console/start', async (req, reply) => {
    const d = pre(req, reply, 'onboard');
    const id = idOf(req, reply);
    if (!d || !id) return;
    const b = ConsoleControlRequest.safeParse(req.body ?? {});
    if (!b.success) return fail(reply, coreError('invalid_input', b.error.message));
    const project = await projectOf(d, reply, id);
    if (project === null || !(await guardUse(reply, b.data.on_behalf_of, project))) return;
    const s = await startSession(d, { s0_id: id, by: b.data.on_behalf_of });
    if (!s.ok) return fail(reply, s.error);
    // the first look: the agent answers what is in the way, once
    await wake(d, id);
    const v = await sessionView(d.pool, id);
    return reply.code(s.value.opened ? 201 : 200).send(v);
  });

  app.post('/v1/s0/:id/console/messages', async (req, reply) => {
    const d = pre(req, reply, 'onboard');
    const id = idOf(req, reply);
    if (!d || !id) return;
    const b = ConsoleMessageRequest.safeParse(req.body ?? {});
    if (!b.success) return fail(reply, coreError('invalid_input', b.error.message));
    const project = await projectOf(d, reply, id);
    if (project === null || !(await guardUse(reply, b.data.on_behalf_of, project))) return;
    const m = await postMessage(d, { s0_id: id, by: b.data.on_behalf_of, text: b.data.text });
    if (!m.ok) return fail(reply, m.error);
    // the state may have moved since the last look; then the agent answers
    await observe(d, id);
    const w = await wake(d, id);
    if (!w.ok) return fail(reply, w.error);
    return sessionView(d.pool, id);
  });

  for (const action of ['pause', 'resume', 'stop'] as const) {
    app.post(`/v1/s0/:id/console/${action}`, async (req, reply) => {
      const d = pre(req, reply, 'onboard');
      const id = idOf(req, reply);
      if (!d || !id) return;
      const b = ConsoleControlRequest.safeParse(req.body ?? {});
      if (!b.success) return fail(reply, coreError('invalid_input', b.error.message));
      const project = await projectOf(d, reply, id);
      if (project === null) return;
      if (!(await guardUse(reply, b.data.on_behalf_of, project))) return;
      if (
        !(await r.guard(
          reply,
          b.data.on_behalf_of,
          'onboarding.console.steer',
          pdpResource.project(project),
        ))
      )
        return;
      const s = await steer(d, { s0_id: id, by: b.data.on_behalf_of, action });
      if (!s.ok) return fail(reply, s.error);
      // a resumed session looks at the record again, then answers if something is new
      if (action === 'resume') {
        await observe(d, id);
        await wake(d, id);
      }
      return sessionView(d.pool, id);
    });
  }

  app.post('/v1/s0/:id/console/proposals/:pid/decide', async (req, reply) => {
    const d = pre(req, reply, 'onboard');
    const id = idOf(req, reply);
    if (!d || !id) return;
    const pid = (req.params as Record<string, string>)['pid'];
    if (!z.uuid().safeParse(pid).success)
      return fail(reply, coreError('invalid_input', 'bad proposal id'));
    const b = ConsoleProposalDecideRequest.safeParse(req.body ?? {});
    if (!b.success) return fail(reply, coreError('invalid_input', b.error.message));
    const project = await projectOf(d, reply, id);
    if (project === null || !(await guardUse(reply, b.data.on_behalf_of, project))) return;
    const r = await decideProposal(d, {
      s0_id: id,
      by: b.data.on_behalf_of,
      proposal_id: pid as string,
      proposal_sha256: b.data.proposal_sha256,
      decision: b.data.decision,
      ...(b.data.edited_value === undefined ? {} : { edited_value: b.data.edited_value }),
    });
    if (!r.ok) return fail(reply, r.error);
    // the agent goes on from what the person chose
    await wake(d, id);
    return sessionView(d.pool, id);
  });

  app.patch('/v1/s0/:id/summary', async (req, reply) => {
    const d = pre(req, reply, 'onboard');
    const id = idOf(req, reply);
    if (!d || !id) return;
    const b = ConsoleDraftPatch.safeParse(req.body ?? {});
    if (!b.success) return fail(reply, coreError('invalid_input', b.error.message));
    const project = await projectOf(d, reply, id);
    if (project === null || !(await guardUse(reply, b.data.on_behalf_of, project))) return;
    const { on_behalf_of, ...patch } = b.data;
    const r = await patchDraft(d, { s0_id: id, by: on_behalf_of, patch });
    if (!r.ok) return fail(reply, r.error);
    return { set: r.value.set, draft: await draftOf(d.pool, id) };
  });

  app.get('/v1/console/sessions', async (req, reply) => {
    const d = pre(req, reply, 'read');
    if (!d) return;
    const q = Who.safeParse(req.query ?? {});
    if (!q.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    const who = q.data.on_behalf_of;
    const rows = await listSessions(d.pool, { limit: q.data.limit ?? 50 });
    const seen = new Map<string, boolean>();
    const keep: typeof rows = [];
    for (const s of rows) {
      if (!seen.has(s.project_id)) {
        let ok = true;
        for (const a of CONSOLE_USE_ACTIONS) {
          if (!(await r.decide(who, a, pdpResource.project(s.project_id)).catch(() => false)))
            ok = false;
        }
        seen.set(s.project_id, ok);
      }
      if (seen.get(s.project_id)) keep.push(s);
    }
    return ConsoleSessionList.parse({ sessions: keep });
  });
}
