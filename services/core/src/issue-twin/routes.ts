import {
  IssueTwinBatchRequest,
  IssueTwinLinkRequest,
  IssueTwinRequestRequest,
  PrincipalId,
  ProjectId,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { LedgerClientDeps } from '@aisdlc/ledger';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CORE_STATUS, coreError, type CoreError } from '../errors.js';
import type { CoreDeps } from '../journal.js';
import { getProject } from '../queries.js';
import { approveBatch, issueTwinView, linkDuplicate, requestFromTwin } from './twin.js';

// The issue twin's routes (PLAN M16), for the bff acting for a signed-in person (scope `work`). The person is always
// `on_behalf_of`, and the PDP decides every call about them, every time:
//
//   GET  /v1/projects/:id/issue-twin?on_behalf_of=       IssueTwinView: twins, sync state, batches, candidates  (project.view)
//   POST /v1/projects/:id/issue-twin/batches             IssueTwinBatchRequest -> IssueTwinBatchResult           (config.propose)
//   POST /v1/projects/:id/issue-twin/links               IssueTwinLinkRequest: link a duplicate issue            (config.propose)
//   POST /v1/projects/:id/issue-twin/requests            IssueTwinRequestRequest -> IssueTwinRequestResult       (work.request)
//
// PDP ACTIONS. The design reference puts "Propose a batch" behind `config.propose` on the project (the admin slot, and
// factory admins), and the action catalogue is not changed here (a catalogue action is a policy change with its own
// review): approving a batch is that action. Turning a gap into a request is `work.request`, as any request is.

export interface IssueTwinRouteDeps {
  readonly app: FastifyInstance;
  readonly deps: CoreDeps;
  readonly allowed: (req: FastifyRequest) => boolean;
  readonly guard: (
    reply: FastifyReply,
    principal: string,
    action: ActionId,
    resource: PdpResource,
  ) => Promise<boolean>;
}

export function registerIssueTwinRoutes(r: IssueTwinRouteDeps): void {
  const { app, deps } = r;
  const fail = (reply: FastifyReply, e: CoreError) =>
    sendError(reply, CORE_STATUS[e.code], e.code, e.message);

  /** The scope, the project id and its existence; `null` once the reply is sent. */
  async function project(req: FastifyRequest, reply: FastifyReply): Promise<ProjectId | null> {
    if (!r.allowed(req)) {
      sendError(reply, 403, 'forbidden', 'scope work is needed');
      return null;
    }
    const id = ProjectId.safeParse((req.params as { id?: string }).id);
    if (!id.success) {
      fail(reply, coreError('invalid_input', 'bad project id'));
      return null;
    }
    return id.data;
  }

  async function body<S extends z.ZodType>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    action: ActionId,
    project: ProjectId,
  ): Promise<z.infer<S> | null> {
    const b = schema.safeParse(req.body ?? {});
    if (!b.success) {
      fail(reply, coreError('invalid_input', b.error.message));
      return null;
    }
    const who = (b.data as { on_behalf_of: string }).on_behalf_of;
    if (!(await r.guard(reply, who, action, pdpResource.project(project)))) return null;
    if (!(await getProject(deps.pool, project))) {
      fail(reply, coreError('not_found', 'no such project'));
      return null;
    }
    return b.data;
  }

  app.get('/v1/projects/:id/issue-twin', async (req, reply) => {
    const id = await project(req, reply);
    if (!id) return;
    const who = PrincipalId.safeParse((req.query as Record<string, string>)['on_behalf_of']);
    if (!who.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    if (!(await r.guard(reply, who.data, 'project.view', pdpResource.project(id)))) return;
    try {
      if (!(await getProject(deps.pool, id)))
        return fail(reply, coreError('not_found', 'no such project'));
      return await issueTwinView(deps.pool, id);
    } catch {
      return fail(reply, coreError('unavailable', 'the issue twin could not be read'));
    }
  });

  app.post('/v1/projects/:id/issue-twin/batches', async (req, reply) => {
    const id = await project(req, reply);
    if (!id) return;
    const b = await body(req, reply, IssueTwinBatchRequest, 'config.propose', id);
    if (!b) return;
    if (!deps.ledger) return fail(reply, coreError('unavailable', 'no ledger is configured'));
    const out = await approveBatch({ ...deps, ledger: deps.ledger as LedgerClientDeps }, id, b);
    if (!out.ok) return fail(reply, out.error);
    return reply.code(201).send(out.value);
  });

  app.post('/v1/projects/:id/issue-twin/links', async (req, reply) => {
    const id = await project(req, reply);
    if (!id) return;
    const b = await body(req, reply, IssueTwinLinkRequest, 'config.propose', id);
    if (!b) return;
    const out = await linkDuplicate(deps, id, b);
    if (!out.ok) return fail(reply, out.error);
    return reply.code(out.value.duplicate ? 200 : 201).send(out.value);
  });

  app.post('/v1/projects/:id/issue-twin/requests', async (req, reply) => {
    const id = await project(req, reply);
    if (!id) return;
    const b = await body(req, reply, IssueTwinRequestRequest, 'work.request', id);
    if (!b) return;
    const out = await requestFromTwin(deps, id, b);
    if (!out.ok) return fail(reply, out.error);
    return reply.code(out.value.duplicate ? 200 : 201).send(out.value);
  });
}
