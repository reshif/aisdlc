import {
  OnboardingVersionRequest,
  OnboardingVersionResult,
  PortalProjectDriftView,
  ProjectDriftView,
  ProjectId,
  ReaffirmRequest,
  ReaffirmResult,
  ReaffirmView,
  ReonboardDecideRequest,
  ReonboardDecideResult,
  RepoDriftView,
  RepoFullName,
  RestoreRequest,
  RestoreResult,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { Pdp } from '@aisdlc/pdp';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { CoreClient } from './core-client.js';

// The portal's after-onboarding screens (PLAN M16; OB §4.2, §8; DEC-21): the project's Drift tab, the re-affirm card
// and the one-click restore. Each route asks the PDP in this process for the signed-in principal (fail closed), then
// calls core with the principal from the session as `on_behalf_of` (a body that names one is refused). Core asks the
// PDP again, and checks the slot and the facts itself.
//
//   GET  /api/projects/:id/drift                          the drift view, with `may`             (project.view)
//   GET  /api/projects/:id/drift/reaffirm?repo=&path=     the re-affirm card: both texts         (project.view)
//   POST /api/projects/:id/drift/recheck      {repo}      poll now                               (config.propose)
//   POST /api/projects/:id/drift/restore      {repo, bypass, attestation}                       (project.settings.edit)
//   POST /api/projects/:id/drift/reaffirm     {repo, path, text_sha256, step_up}                 (project.settings.edit)
//   POST /api/projects/:id/onboarding-versions {repo, reason, level}  level-up or re-sign      (project.onboard)
//   POST /api/projects/:id/reonboarding/decide {repo, proposal_id, decision, reason}
//                                                  accept or decline a re-onboarding proposal   (project.settings.edit)

export interface DriftRouteDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp;
  readonly core: CoreClient | undefined;
  readonly principalOf: (req: FastifyRequest) => string;
}

export const PortalRecheckBody = RestoreRequest.pick({ repo: true });
export const PortalRestoreBody = RestoreRequest.omit({ on_behalf_of: true });
export const PortalReaffirmBody = ReaffirmRequest.omit({ on_behalf_of: true });
export const PortalVersionBody = OnboardingVersionRequest.omit({ on_behalf_of: true });
export const PortalReonboardBody = ReonboardDecideRequest.omit({ on_behalf_of: true });

export function registerDriftRoutes(d: DriftRouteDeps): void {
  const { app } = d;

  async function allowed(principal: string, action: ActionId, resource: PdpResource) {
    try {
      return (await d.pdp.decide({ principal, action, resource })).decision === 'allow';
    } catch {
      return false;
    }
  }

  function upstream<T>(reply: FastifyReply, r: CallResult, parse: (v: unknown) => T): T | null {
    if (!r.reached) {
      sendError(reply, 502, 'core_unavailable', 'the factory core could not be reached');
      return null;
    }
    if (r.status >= 500) {
      const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      // core's "unavailable" (a code host read failed, no bypass list) is said as it is, never as a success
      sendError(
        reply,
        502,
        typeof e?.code === 'string' ? e.code : 'core_error',
        typeof e?.message === 'string' ? e.message : 'the factory core could not answer',
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

  async function pre(
    req: FastifyRequest,
    reply: FastifyReply,
    action: ActionId,
    resource: (project: string) => PdpResource,
  ): Promise<{ c: CoreClient; id: string; who: string } | null> {
    if (!d.core) {
      sendError(reply, 503, 'core_not_configured', 'the bff has no core to call');
      return null;
    }
    const id = ProjectId.safeParse((req.params as { id?: string }).id);
    if (!id.success) {
      sendError(reply, 400, 'invalid_input', 'bad project id');
      return null;
    }
    const who = d.principalOf(req);
    if (!(await allowed(who, action, resource(id.data)))) {
      sendError(reply, 403, 'forbidden', `${action} denied`);
      return null;
    }
    return { c: d.core, id: id.data, who };
  }

  app.get('/api/projects/:id/drift', async (req, reply) => {
    const p = await pre(req, reply, 'project.view', pdpResource.project);
    if (!p) return;
    const v = upstream(
      reply,
      await p.c.call('GET', `/v1/projects/${p.id}/drift?on_behalf_of=${encodeURIComponent(p.who)}`),
      (x) => ProjectDriftView.parse(x),
    );
    if (!v) return;
    const edit = await allowed(p.who, 'project.settings.edit', pdpResource.project(p.id));
    return PortalProjectDriftView.parse({
      ...v,
      may: {
        restore: edit,
        reaffirm: edit,
        recheck: await allowed(p.who, 'config.propose', pdpResource.project(p.id)),
        request_version: await allowed(p.who, 'project.onboard', pdpResource.fleet()),
        reonboard: edit,
      },
    });
  });

  app.get('/api/projects/:id/drift/reaffirm', async (req, reply) => {
    const p = await pre(req, reply, 'project.view', pdpResource.project);
    if (!p) return;
    const q = req.query as Record<string, string>;
    const repo = RepoFullName.safeParse(q['repo']);
    const path = q['path'];
    if (!repo.success || !path)
      return sendError(reply, 400, 'invalid_input', 'repo and path are needed');
    const qs = new URLSearchParams({ repo: repo.data, path, on_behalf_of: p.who });
    return (
      upstream(reply, await p.c.call('GET', `/v1/projects/${p.id}/drift/reaffirm?${qs}`), (x) =>
        ReaffirmView.parse(x),
      ) ?? undefined
    );
  });

  async function write<S extends z.ZodType<object>, T>(
    req: FastifyRequest,
    reply: FastifyReply,
    o: {
      schema: S;
      action: ActionId;
      resource?: (project: string) => PdpResource;
      path: string;
      parse: (v: unknown) => T;
    },
  ) {
    const body = o.schema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    const p = await pre(req, reply, o.action, o.resource ?? pdpResource.project);
    if (!p) return;
    const r = await p.c.call('POST', `/v1/projects/${p.id}/${o.path}`, {
      ...body.data,
      on_behalf_of: p.who,
    });
    const v = upstream(reply, r, o.parse);
    if (v === null) return;
    return reply.code(r.reached && r.status === 201 ? 201 : 200).send(v);
  }

  app.post('/api/projects/:id/drift/recheck', (req, reply) =>
    write(req, reply, {
      schema: PortalRecheckBody,
      action: 'config.propose',
      path: 'drift/recheck',
      parse: (v) => RepoDriftView.parse(v),
    }),
  );
  app.post('/api/projects/:id/drift/restore', (req, reply) =>
    write(req, reply, {
      schema: PortalRestoreBody,
      action: 'project.settings.edit',
      path: 'drift/restore',
      parse: (v) => RestoreResult.parse(v),
    }),
  );
  app.post('/api/projects/:id/drift/reaffirm', (req, reply) =>
    write(req, reply, {
      schema: PortalReaffirmBody,
      action: 'project.settings.edit',
      path: 'drift/reaffirm',
      parse: (v) => ReaffirmResult.parse(v),
    }),
  );
  app.post('/api/projects/:id/onboarding-versions', (req, reply) =>
    write(req, reply, {
      schema: PortalVersionBody,
      action: 'project.onboard',
      resource: () => pdpResource.fleet(),
      path: 'onboarding-versions',
      parse: (v) => OnboardingVersionResult.parse(v),
    }),
  );
  app.post('/api/projects/:id/reonboarding/decide', (req, reply) =>
    write(req, reply, {
      schema: PortalReonboardBody,
      action: 'project.settings.edit',
      path: 'reonboarding/decide',
      parse: (v) => ReonboardDecideResult.parse(v),
    }),
  );
}
