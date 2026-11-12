import {
  OnboardingVersionRequest,
  PrincipalId,
  ProjectId,
  ReaffirmRequest,
  ReonboardDecideRequest,
  RepoFullName,
  RestoreRequest,
  MERGE_BYPASS_CONFIG_KEY,
  MergeBypassConfig,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { ConfigReader } from '@aisdlc/config';
import type { EligibilityPort, StepUpPort } from '@aisdlc/decisions';
import type { LedgerClientDeps } from '@aisdlc/ledger';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CORE_STATUS, coreError, type CoreError } from '../errors.js';
import type { CoreDeps } from '../journal.js';
import { getProject } from '../queries.js';
import {
  decideReonboarding,
  reaffirmInstruction,
  requestVersion,
  restoreRecord,
  type DriftActionDeps,
} from './actions.js';
import { checkDrift, recheckRepo, type DriftSource } from './check.js';
import { projectDriftView, reaffirmView, repoDriftView } from './view.js';

// The after-onboarding routes (PLAN M16; OB §4.2, §8; DEC-21), for the bff acting for a signed-in person (scope `work`).
// The PDP decides every call about `on_behalf_of`; core checks the slot and the facts again:
//
//   GET  /v1/projects/:id/drift?on_behalf_of=                          ProjectDriftView             (project.view)
//   GET  /v1/projects/:id/drift/reaffirm?repo=&path=&on_behalf_of=     ReaffirmView: both texts      (project.view)
//   POST /v1/projects/:id/drift/recheck      {repo, on_behalf_of}      poll now (recorded), fold     (config.propose)
//   POST /v1/projects/:id/drift/restore      RestoreRequest            DEC-21(b) one-click restore   (project.settings.edit)
//   POST /v1/projects/:id/drift/reaffirm     ReaffirmRequest           re-affirm with step-up        (project.settings.edit)
//   POST /v1/projects/:id/onboarding-versions OnboardingVersionRequest level-up or re-sign          (project.onboard)
//   POST /v1/projects/:id/reonboarding/decide ReonboardDecideRequest  accept or decline a re-onboarding
//                                                                      proposal (M17, OB §8)           (project.settings.edit)
//
// PDP ACTIONS: no action is added (the catalogue is a policy change with its own review). Restoring and re-affirming
// change what the project's agents may do, so they are `project.settings.edit` (the admin slot, and factory admins), and
// core then requires a holder of the project's admin slot itself: a factory admin alone restores nothing. "Poll now" is
// the design reference's `config.propose`. A new onboarding version is an onboarding request (`project.onboard`).

export interface DriftRouteDeps {
  readonly app: FastifyInstance;
  readonly deps: CoreDeps;
  readonly allowed: (req: FastifyRequest) => boolean;
  readonly guard: (
    reply: FastifyReply,
    principal: string,
    action: ActionId,
    resource: PdpResource,
  ) => Promise<boolean>;
  /** What the after-onboarding actions read and decide with; absent: they answer `unavailable`. */
  readonly drift?: {
    readonly source: DriftSource;
    readonly eligibility: EligibilityPort;
    readonly stepUp?: StepUpPort;
    readonly bypass: () => MergeBypassConfig | null;
  };
}

/** The published bypass list (config `codehost.merge_bypass`), or `null` when it does not read. */
export function mergeBypassFrom(reader: ConfigReader): () => MergeBypassConfig | null {
  return () => {
    try {
      const c = reader.current();
      if (c.rejected.includes(MERGE_BYPASS_CONFIG_KEY)) return null;
      const v = c.get(MERGE_BYPASS_CONFIG_KEY);
      if (v === undefined) return {};
      const p = MergeBypassConfig.safeParse(v);
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  };
}

export function registerDriftRoutes(r: DriftRouteDeps): void {
  const { app, deps } = r;
  const fail = (reply: FastifyReply, e: CoreError) =>
    sendError(reply, CORE_STATUS[e.code], e.code, e.message);
  const bypass = r.drift?.bypass ?? (() => null);

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

  async function exists(reply: FastifyReply, id: ProjectId): Promise<boolean> {
    if (await getProject(deps.pool, id)) return true;
    fail(reply, coreError('not_found', 'no such project'));
    return false;
  }

  async function body<S extends z.ZodType>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    action: ActionId,
    resource: PdpResource,
    id: ProjectId,
  ): Promise<z.infer<S> | null> {
    const b = schema.safeParse(req.body ?? {});
    if (!b.success) {
      fail(reply, coreError('invalid_input', b.error.message));
      return null;
    }
    const who = (b.data as { on_behalf_of: string }).on_behalf_of;
    if (!(await r.guard(reply, who, action, resource))) return null;
    return (await exists(reply, id)) ? b.data : null;
  }

  function actionDeps(reply: FastifyReply): DriftActionDeps | null {
    if (!r.drift || !deps.ledger) {
      fail(reply, coreError('unavailable', 'the after-onboarding actions are not configured'));
      return null;
    }
    return { ...deps, ...r.drift, ledger: deps.ledger as LedgerClientDeps };
  }

  const viewer = async (req: FastifyRequest, reply: FastifyReply, id: ProjectId) => {
    const who = PrincipalId.safeParse((req.query as Record<string, string>)['on_behalf_of']);
    if (!who.success) {
      fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
      return false;
    }
    if (!(await r.guard(reply, who.data, 'project.view', pdpResource.project(id)))) return false;
    return exists(reply, id);
  };

  app.get('/v1/projects/:id/drift', async (req, reply) => {
    const id = await project(req, reply);
    if (!id || !(await viewer(req, reply, id))) return;
    try {
      return await projectDriftView(deps.pool, id, {
        ...(deps.clock ? { clock: deps.clock } : {}),
        bypass,
      });
    } catch {
      return fail(reply, coreError('unavailable', 'the drift view could not be read'));
    }
  });

  app.get('/v1/projects/:id/drift/reaffirm', async (req, reply) => {
    const id = await project(req, reply);
    if (!id || !(await viewer(req, reply, id))) return;
    const q = req.query as Record<string, string>;
    const repo = RepoFullName.safeParse(q['repo']);
    const path = q['path'];
    if (!repo.success || !path)
      return fail(reply, coreError('invalid_input', 'repo and path are needed'));
    const d = actionDeps(reply);
    if (!d) return;
    const out = await reaffirmView(d, id, repo.data, path);
    return out.ok ? out.value : fail(reply, out.error);
  });

  app.post('/v1/projects/:id/drift/recheck', async (req, reply) => {
    const id = await project(req, reply);
    if (!id) return;
    const Body = RestoreRequest.pick({ repo: true, on_behalf_of: true });
    const b = await body(req, reply, Body, 'config.propose', pdpResource.project(id), id);
    if (!b) return;
    const d = actionDeps(reply);
    if (!d) return;
    const rc = await recheckRepo(d, b.repo);
    if (!rc.ok) return fail(reply, rc.error);
    const c = await checkDrift(d, b.repo);
    if (!c.ok) return fail(reply, c.error);
    const v = await repoDriftView(deps.pool, b.repo, {
      ...(deps.clock ? { clock: deps.clock } : {}),
      bypass,
    });
    return v ?? fail(reply, coreError('not_found', 'no such repository'));
  });

  app.post('/v1/projects/:id/drift/restore', async (req, reply) => {
    const id = await project(req, reply);
    if (!id) return;
    const b = await body(
      req,
      reply,
      RestoreRequest,
      'project.settings.edit',
      pdpResource.project(id),
      id,
    );
    if (!b) return;
    const d = actionDeps(reply);
    if (!d) return;
    const out = await restoreRecord(d, id, b);
    return out.ok ? reply.code(201).send(out.value) : fail(reply, out.error);
  });

  app.post('/v1/projects/:id/drift/reaffirm', async (req, reply) => {
    const id = await project(req, reply);
    if (!id) return;
    const b = await body(
      req,
      reply,
      ReaffirmRequest,
      'project.settings.edit',
      pdpResource.project(id),
      id,
    );
    if (!b) return;
    const d = actionDeps(reply);
    if (!d) return;
    const out = await reaffirmInstruction(d, id, b);
    return out.ok ? reply.code(201).send(out.value) : fail(reply, out.error);
  });

  app.post('/v1/projects/:id/onboarding-versions', async (req, reply) => {
    const id = await project(req, reply);
    if (!id) return;
    const b = await body(
      req,
      reply,
      OnboardingVersionRequest,
      'project.onboard',
      pdpResource.fleet(),
      id,
    );
    if (!b) return;
    const out = await requestVersion(deps, id, b);
    return out.ok
      ? reply.code(out.value.duplicate ? 200 : 201).send(out.value)
      : fail(reply, out.error);
  });

  app.post('/v1/projects/:id/reonboarding/decide', async (req, reply) => {
    const id = await project(req, reply);
    if (!id) return;
    const b = await body(
      req,
      reply,
      ReonboardDecideRequest,
      'project.settings.edit',
      pdpResource.project(id),
      id,
    );
    if (!b) return;
    const d = actionDeps(reply);
    if (!d) return;
    const out = await decideReonboarding(d, id, b);
    return out.ok
      ? reply.code(out.value.duplicate ? 200 : 201).send(out.value)
      : fail(reply, out.error);
  });
}
