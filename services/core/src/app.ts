import {
  CardDecideRequest,
  CardEvidenceRequest,
  CardPrepareRequest,
  CardRecheckRequest,
  GatingProfile,
  KillDelegation,
  OnboardRequest,
  PrincipalId,
  ProjectId,
  RoleMap,
  RepoFullName,
  TwoPerson,
  Level,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { ConfigDeps, ConfigRegistry } from '@aisdlc/config';
import { ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import type { Pdp } from '@aisdlc/pdp';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { CORE_STATUS, coreError, type CoreError } from './errors.js';
import {
  getProject,
  getS0Overview,
  listS0ForRepo,
  overviewOf,
  registeredRepos,
} from './queries.js';
import { resumeS0, requestOnboarding, setSignableLevel, withdrawS0 } from './s0.js';
import { loadProjectSettings, proposeProjectSettings } from './settings.js';
import { readS0 } from './journal.js';
import {
  cardDetail,
  cardHeader,
  decideOnboardingCard,
  listCards,
  prepareOnboardingCard,
  recheckControls,
  recordOnboardingEvidence,
  syncCards,
  type CardDeps,
} from './cards/index.js';

/**
 * What a caller may do: `read` the model, `onboard` (the BFF, for a signed-in human: the PDP decides
 * about that human), `settings` (propose a settings revision, the BFF likewise), `registry` (the
 * codehost's allow-list reads the repos that have an S0 record).
 */
export type CoreScope = 'read' | 'onboard' | 'settings' | 'registry';

export interface CoreAppOptions {
  readonly pool: pg.Pool;
  readonly auth: ServiceAuth;
  /** caller name -> scopes. A caller with no entry may do nothing. */
  readonly callers: Record<string, readonly CoreScope[]>;
  /** The policy decision point; without one every route that needs a decision refuses. */
  readonly pdp?: Pdp;
  readonly registry: ConfigRegistry;
  /** The decision kernel's dependencies; without them a settings change cannot be proposed. */
  readonly config?: ConfigDeps;
  readonly clock?: Clock;
  /** The onboarding cards (M7.3); without them the card routes answer `unavailable`. */
  readonly cards?: CardDeps;
}

const Reason = z.string().min(1).max(500).optional();

/** HTTP in front of core's Projects and Onboarding context. Service tokens only. */
export function createCoreApp(o: CoreAppOptions): FastifyInstance {
  const app = newApp();
  const clock = o.clock ?? systemClock;
  const deps = { pool: o.pool, clock };

  app.get('/healthz', async () => ({ ok: true }));

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null) {
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    }
    (req as unknown as { caller: string }).caller = caller;
  });

  const callerOf = (req: FastifyRequest): string => (req as unknown as { caller: string }).caller;
  const allowed = (req: FastifyRequest, scope: CoreScope): boolean =>
    (o.callers[callerOf(req)] ?? []).includes(scope);
  const fail = (reply: FastifyReply, e: CoreError) =>
    sendError(reply, CORE_STATUS[e.code], e.code, e.message);
  const params = (req: FastifyRequest): Record<string, string> =>
    req.params as Record<string, string>;

  /** The scope check, then the body's contract. */
  function parse<S extends z.ZodType>(schema: S, v: unknown): Result<z.infer<S>, CoreError> {
    const p = schema.safeParse(v ?? {});
    return p.success
      ? { ok: true, value: p.data }
      : { ok: false, error: coreError('invalid_input', p.error.message) };
  }

  /** The PDP decides about the human the BFF acts for. Any answer but `allow` is a refusal. */
  async function guard(
    reply: FastifyReply,
    principal: string,
    action: ActionId,
    resource: PdpResource,
  ): Promise<boolean> {
    if (!o.pdp) {
      sendError(reply, 503, 'unavailable', 'no policy decision point is configured');
      return false;
    }
    const d = await o.pdp.decide({ principal, action, resource });
    if (d.decision === 'allow') return true;
    reply.code(403).send({
      error: { code: 'forbidden', message: `${action} denied`, reasons: d.reasons },
    });
    return false;
  }

  const projectIdOf = (req: FastifyRequest): ProjectId | null => {
    const p = ProjectId.safeParse(params(req)['id']);
    return p.success ? p.data : null;
  };

  // ------------------------------------------------------------ reads

  app.get('/v1/projects/:id', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const id = projectIdOf(req);
    if (!id) return fail(reply, coreError('invalid_input', 'bad project id'));
    const p = await getProject(o.pool, id);
    return p ?? fail(reply, coreError('not_found', 'no such project'));
  });

  app.get('/v1/projects/:id/settings', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const id = projectIdOf(req);
    if (!id) return fail(reply, coreError('invalid_input', 'bad project id'));
    const r = await loadProjectSettings(o.pool, o.registry, id);
    if (r.ok) return r.value;
    return fail(
      reply,
      coreError(r.error.code === 'unknown_project' ? 'not_found' : 'unavailable', r.error.message),
    );
  });

  app.get('/v1/registered-repos', async (req, reply) => {
    if (!allowed(req, 'registry')) {
      return sendError(reply, 403, 'forbidden', 'scope registry is needed');
    }
    try {
      return await registeredRepos(o.pool);
    } catch {
      return fail(reply, coreError('unavailable', 'the registered repos could not be read'));
    }
  });

  app.get('/v1/s0/:id', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const id = params(req)['id'] as string;
    if (!z.uuid().safeParse(id).success) return fail(reply, coreError('invalid_input', 'bad id'));
    return (
      (await getS0Overview(o.pool, id)) ?? fail(reply, coreError('not_found', 'no such record'))
    );
  });

  app.get('/v1/repos/:owner/:name/s0', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const repo = RepoFullName.safeParse(`${params(req)['owner']}/${params(req)['name']}`);
    if (!repo.success) return fail(reply, coreError('invalid_input', 'owner/name is required'));
    return listS0ForRepo(o.pool, repo.data);
  });

  // ------------------------------------------------------------ the project.onboard request (DEC-2)

  app.post('/v1/onboard', async (req, reply) => {
    if (!allowed(req, 'onboard'))
      return sendError(reply, 403, 'forbidden', 'scope onboard is needed');
    const b = parse(OnboardRequest, req.body);
    if (!b.ok) return fail(reply, b.error);
    if (!(await guard(reply, b.value.on_behalf_of, 'project.onboard', pdpResource.fleet()))) return;
    const r = await requestOnboarding(deps, b.value);
    if (!r.ok) return fail(reply, r.error);
    return reply.code(r.value.duplicate ? 200 : 201).send(r.value);
  });

  // ------------------------------------------------------------ the owner's moves on a record

  const Move = z.strictObject({ on_behalf_of: PrincipalId, reason: Reason });

  async function move(
    req: FastifyRequest,
    reply: FastifyReply,
    run: (
      id: string,
      actor: string,
      reason: string | undefined,
    ) => Promise<Result<unknown, CoreError>>,
  ) {
    if (!allowed(req, 'onboard'))
      return sendError(reply, 403, 'forbidden', 'scope onboard is needed');
    const id = params(req)['id'] as string;
    if (!z.uuid().safeParse(id).success) return fail(reply, coreError('invalid_input', 'bad id'));
    const b = parse(Move, req.body);
    if (!b.ok) return fail(reply, b.error);
    if (!(await guard(reply, b.value.on_behalf_of, 'project.onboard', pdpResource.fleet()))) return;
    const r = await run(id, b.value.on_behalf_of, b.value.reason);
    if (!r.ok) return fail(reply, r.error);
    return (
      (await getS0Overview(o.pool, id)) ?? fail(reply, coreError('not_found', 'no such record'))
    );
  }

  app.post('/v1/s0/:id/withdraw', (req, reply) =>
    move(req, reply, (id, actor, reason) =>
      withdrawS0(deps, id, { actor, ...(reason ? { reason } : {}) }),
    ),
  );
  app.post('/v1/s0/:id/resume', (req, reply) =>
    move(req, reply, (id, actor, reason) =>
      resumeS0(deps, id, { actor, ...(reason ? { reason } : {}) }),
    ),
  );

  app.post('/v1/s0/:id/signable-level', async (req, reply) => {
    if (!allowed(req, 'onboard'))
      return sendError(reply, 403, 'forbidden', 'scope onboard is needed');
    const id = params(req)['id'] as string;
    if (!z.uuid().safeParse(id).success) return fail(reply, coreError('invalid_input', 'bad id'));
    const b = parse(z.strictObject({ level: Level, on_behalf_of: PrincipalId }), req.body);
    if (!b.ok) return fail(reply, b.error);
    if (!(await guard(reply, b.value.on_behalf_of, 'project.onboard', pdpResource.fleet()))) return;
    const r = await setSignableLevel(deps, id, b.value.level, {
      actor: b.value.on_behalf_of,
      reason: 'human',
    });
    if (!r.ok) return fail(reply, r.error);
    return overviewOf((await readS0(o.pool, id)) ?? r.value);
  });

  // ------------------------------------------------------------ settings as a config revision

  app.put('/v1/projects/:id/settings', async (req, reply) => {
    if (!allowed(req, 'settings'))
      return sendError(reply, 403, 'forbidden', 'scope settings is needed');
    const id = projectIdOf(req);
    if (!id) return fail(reply, coreError('invalid_input', 'bad project id'));
    const b = parse(
      z.strictObject({
        role_map: RoleMap.optional(),
        two_person: TwoPerson.optional(),
        gating_profile: GatingProfile.optional(),
        kill_delegations: z.array(KillDelegation).optional(),
        on_behalf_of: PrincipalId,
      }),
      req.body,
    );
    if (!b.ok) return fail(reply, b.error);
    if (
      !(await guard(reply, b.value.on_behalf_of, 'project.settings.edit', pdpResource.project(id)))
    ) {
      return;
    }
    if (!o.config) return fail(reply, coreError('unavailable', 'no decision kernel is configured'));
    const { on_behalf_of, ...change } = b.value;
    const r = await proposeProjectSettings(o.config, {
      project: id,
      change,
      proposed_by: on_behalf_of,
    });
    if (!r.ok) return fail(reply, r.error);
    return reply.code(202).send(r.value);
  });

  // ------------------------------------------------------------ the onboarding cards (M7.3)

  const cardsOr = (reply: FastifyReply): CardDeps | null => {
    if (o.cards) return o.cards;
    fail(reply, coreError('unavailable', 'the onboarding cards are not configured'));
    return null;
  };
  const uuidParam = (req: FastifyRequest, reply: FastifyReply, name: string): string | null => {
    const v = params(req)[name] as string;
    if (z.uuid().safeParse(v).success) return v;
    fail(reply, coreError('invalid_input', 'bad id'));
    return null;
  };

  app.get('/v1/s0/:id/cards', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const cards = cardsOr(reply);
    const id = uuidParam(req, reply, 'id');
    if (!cards || !id) return;
    const r = await listCards(cards, id);
    return r.ok ? r.value : fail(reply, r.error);
  });

  /** Opens the cards the record waits for, applies decided ones, closes stale ones. Idempotent. */
  app.post('/v1/s0/:id/cards/sync', async (req, reply) => {
    if (!allowed(req, 'onboard'))
      return sendError(reply, 403, 'forbidden', 'scope onboard is needed');
    const cards = cardsOr(reply);
    const id = uuidParam(req, reply, 'id');
    if (!cards || !id) return;
    const r = await syncCards(cards, id);
    return r.ok ? r.value : fail(reply, r.error);
  });

  app.get('/v1/cards/:cardId', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const cards = cardsOr(reply);
    const id = uuidParam(req, reply, 'cardId');
    if (!cards || !id) return;
    const r = await cardDetail(cards, id);
    return r.ok ? r.value : fail(reply, r.error);
  });

  /** The PDP decides about the human (`card.decide`), then the decision kernel does the rest. */
  async function cardAction<S extends z.ZodType<{ on_behalf_of: string }>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    run: (cards: CardDeps, id: string, body: z.infer<S>) => Promise<Result<unknown, CoreError>>,
  ) {
    if (!allowed(req, 'onboard'))
      return sendError(reply, 403, 'forbidden', 'scope onboard is needed');
    const cards = cardsOr(reply);
    const id = uuidParam(req, reply, 'cardId');
    if (!cards || !id) return;
    const b = parse(schema, req.body);
    if (!b.ok) return fail(reply, b.error);
    const head = await cardHeader(cards, id);
    if (!head) return fail(reply, coreError('not_found', 'no such card'));
    if (
      !(await guard(
        reply,
        b.value.on_behalf_of,
        'card.decide',
        pdpResource.card(head.project_id, id),
      ))
    ) {
      return;
    }
    const r = await run(cards, id, b.value);
    return r.ok ? r.value : fail(reply, r.error);
  }

  app.post('/v1/cards/:cardId/prepare', (req, reply) =>
    cardAction(req, reply, CardPrepareRequest, (c, id, b) =>
      prepareOnboardingCard(c, { card_id: id, principal: b.on_behalf_of }),
    ),
  );
  app.post('/v1/cards/:cardId/evidence', (req, reply) =>
    cardAction(req, reply, CardEvidenceRequest, async (c, _id, b) => {
      const r = await recordOnboardingEvidence(c, {
        nonce: b.nonce,
        evidence_hash: b.evidence_hash,
      });
      return r.ok ? ok({ evidence_viewed: true }) : r;
    }),
  );
  app.post('/v1/cards/:cardId/decide', (req, reply) =>
    cardAction(req, reply, CardDecideRequest, (c, id, b) =>
      decideOnboardingCard(c, {
        card_id: id,
        principal: b.on_behalf_of,
        nonce: b.nonce,
        decision: b.decision,
        ...(b.content === undefined ? {} : { content: b.content }),
        ...(b.reason === undefined ? {} : { reason: b.reason }),
      }),
    ),
  );
  /** Card 4: reads the code host again. The factory fixes nothing; the person did, on GitHub. */
  app.post('/v1/cards/:cardId/recheck', (req, reply) =>
    cardAction(req, reply, CardRecheckRequest, (c, id, b) =>
      recheckControls(c, { card_id: id, principal: b.on_behalf_of }),
    ),
  );

  return app;
}
