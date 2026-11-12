import {
  acceptHealth,
  effectiveRegistry,
  healthTiles,
  integrationEvents,
} from './integration-api.js';
import { registerPortalListRoutes } from './portal-lists.js';
import { registerFloorRoutes } from './floor.js';
import { registerFleetRoutes } from './fleet.js';
import { readHealthView } from './health.js';
import { readDegraded } from './degraded.js';
import type { KillVerdictPort } from './floor-live.js';
import {
  ItemAnswerRequest,
  ItemObserveRequest,
  ItemPlanRequest,
  ItemHumanDoneRequest,
  ItemReadyRequest,
  ItemReleaseRequest,
  ProjectDefaultEnvelope,
  ProjectWipLimit,
  CardDecideRequest,
  GateCardDecideRequest,
  GateCardEvidenceRequest,
  GateCardPrepareRequest,
  CardEvidenceRequest,
  CardPrepareRequest,
  BannerSeverity,
  BannerTarget,
  C2InstructionEditRequest,
  CardRecheckRequest,
  DEFAULT_LIGHT_TESTS,
  SpikeKind,
  SpikeRecordRequest,
  ControlKind,
  ControlScope,
  AgentId,
  Sha256Hex,
  UnitKey,
  WorkItemId,
  GatingProfile,
  IntegrationKind,
  IsoDateTime,
  KillDelegation,
  ReleaseSetting,
  OnboardRequest,
  PrincipalId,
  ProjectId,
  RevisionDecideRequest,
  RevisionEvidenceRequest,
  RevisionPrepareRequest,
  ConfigProposeRequest,
  RoleMap,
  SubmitRequestBody,
  RepoFullName,
  TwoPerson,
  AreaId,
  Lane,
  Level,
  pdpResource,
  projectOfScope,
  SIGNED_EVIDENCE_PACK_CONTENT_TYPE,
  type ActionId,
  type MergeBypassConfig,
  type PdpResource,
} from '@aisdlc/contracts';
import type { ConfigDeps, ConfigRegistry } from '@aisdlc/config';
import { ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import type { Pdp } from '@aisdlc/pdp';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { gateArtefactsView } from './planning/gate-view.js';
import {
  decideGateCard,
  gateCardView,
  itemCardHead,
  prepareGateCard,
  recordGateCardEvidence,
} from './gate-cards.js';
import type { DecisionDeps } from '@aisdlc/decisions';
import { CORE_STATUS, coreError, type CoreError } from './errors.js';
import { listBreakers, requestBreakerReset } from './breaker.js';
import {
  activeBanners,
  activeControls,
  applyControl,
  liftControl,
  listControls,
  previewControl,
  publishBanner,
} from './controls.js';
import { laneEligibility } from './lane-eligibility.js';
import { listReonboardProposals } from './knowledge-defects.js';
import { projectKnowledge } from './portal-knowledge.js';
import {
  getProject,
  getProjectDetail,
  getS0Overview,
  listProjects,
  listS0ForRepo,
  overviewOf,
  registeredRepos,
} from './queries.js';
import { resumeS0, requestOnboarding, setSignableLevel, withdrawS0 } from './s0.js';
import { agentStatsOf, listAgentRuns } from './agent-runs.js';
import { CorePushGuards } from './build/push.js';
import { agentScoresOf, evalHistory, evalSummary, recordEvalRun } from './evals.js';
import { itemView } from './work-view.js';
import { itemGateLinks } from './item-gates.js';
import type { ItemState } from '@aisdlc/work';
import {
  evidencePackView,
  gateCardContext,
  itemVerifyView,
  signedPackBytes,
} from './verify/portal.js';
import type { ObjectStorePort } from '@aisdlc/ports';
import { answerQuestion, decideReady, requestReceipt, submitRequest } from './requests.js';
import { observeRelane, reRequestRelease, requestRework } from './work-signals.js';
import { submitHumanPlan } from './planning/human-plan.js';
import { completeHumanWork } from './work-signals.js';
import type { GroundingPort } from './planning/grounding.js';
import { readItem, readItemEvents } from './work-items.js';
import { loadProjectSettings, proposeProjectSettings } from './settings.js';
import { readS0 } from './journal.js';
import {
  coreInbox,
  decideRevision,
  ledgerAudit,
  prepareRevision,
  projectPrr,
  publishRevision,
  recordRevisionEvidence,
  revisionOfS0,
  settingsRevision,
} from './portal-reads.js';
import type { AssistantDeps } from './conversation/assistant.js';
import { registerAssistantRoutes } from './conversation/routes.js';
import { registerIssueTwinRoutes } from './issue-twin/routes.js';
import { registerDriftRoutes } from './drift/routes.js';
import { registerErasableRoutes } from './conversation/erasable.js';
import { registerGovernanceRoutes } from './governance-routes.js';
import { registerAccessRoutes } from './access-routes.js';
import type { AccessGrantWriterPort } from './clients.js';
import { configKeyView, listConfigKeys, proposeConfigKey } from './config-console.js';
import {
  cardDetail,
  cardHeader,
  cardSummary,
  decideOnboardingCard,
  listCards,
  prepareOnboardingCard,
  recheckControls,
  recordOnboardingEvidence,
  syncCards,
  type CardDeps,
  editOnboardingInstructions,
  latestSpike,
  lightFloorsOf,
  recordSpike,
  requestProbeRetry,
} from './cards/index.js';

/**
 * What a caller may do: `read` the model, `onboard` (the BFF, for a signed-in human: the PDP decides
 * about that human), `settings` (propose a settings revision, the BFF likewise), `registry` (the
 * codehost's allow-list reads the repos that have an S0 record), `portal` (the BFF's fleet-wide
 * listings for the portal: every project, a project with all of its records; the BFF filters them
 * by the PDP for the signed-in human, so no other caller has a reason to hold this scope), `work`
 * (requests and items, M9.1: the BFF for a signed-in human, or an API client; the PDP decides about the
 * human named in `on_behalf_of`), `ops` (controls, previews and banners, M9.6: the BFF for a signed-in
 * human; the PDP decides about the human, over the resource of the scope), `integrations` (M10.4: a
 * process that holds adapters reports its health per integration; the registry read is `registry`, the
 * tiles and events are `portal`), `evals` (M11.3: the eval tooling posts each finished run; reads of the
 * history are `work`, decided by the PDP for the human like the agent stats), `push_guard` (M13.6: the codehost's Push
 * Broker asks whether a Unit's lease is held at an epoch and whether an approved X2 is bound to a patch hash: core's own
 * word, read from the lease and the ledger), `erasure` (M19: the audit service lists the payloads kept off the hash chain
 * and erases one it has the `erasure.execute` entry for; no other caller has a reason to hold it),
 * `activity` (M19: a session's reporter posts its heartbeat; nothing else).
 */
export type CoreScope =
  | 'read'
  | 'onboard'
  | 'settings'
  | 'registry'
  | 'portal'
  | 'work'
  | 'ops'
  | 'integrations'
  | 'evals'
  | 'push_guard'
  | 'erasure'
  | 'activity';

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
  /** The merged head a hand-written plan is made against (B5, M12.5); without it that route answers `unavailable`. */
  readonly grounding?: GroundingPort;
  /** The assistant (M18): the onboarding assistant and "Ask the factory"; without it those routes answer `unavailable`. */
  readonly assistant?: AssistantDeps;
  /** The object store of the Evidence Packs (M14.6: the pack viewer reads them back); without it the contents are not shown. */
  readonly objects?: ObjectStorePort;
  /** M16: config `codehost.merge_bypass` now in force (a restore re-attests it); absent or `null`: no restore. */
  readonly bypass?: () => MergeBypassConfig | null;
  /** M19: the kill switch's verdict for the floor (core-worker's `/admission`); without it the floor shows killed (AR9). */
  readonly kill?: KillVerdictPort;
  /** P1-6: identity's `grant` scope, which writes what an approved access M1 decided; absent: nothing is applied. */
  readonly grants?: AccessGrantWriterPort;
}

const Reason = z.string().min(1).max(500).optional();

/** HTTP in front of core's Projects and Onboarding context. Service tokens only. */
export function createCoreApp(o: CoreAppOptions): FastifyInstance {
  const app = newApp();
  const clock = o.clock ?? systemClock;
  // The ledger is needed for the one ledger entry core's own writes make: the bootstrap grant.
  const deps = { pool: o.pool, clock, ...(o.config ? { ledger: o.config.ledger } : {}) };

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

  app.get('/v1/projects', async (req, reply) => {
    if (!allowed(req, 'portal'))
      return sendError(reply, 403, 'forbidden', 'scope portal is needed');
    try {
      return await listProjects(o.pool);
    } catch {
      return fail(reply, coreError('unavailable', 'the projects could not be read'));
    }
  });

  app.get('/v1/projects/:id/overview', async (req, reply) => {
    if (!allowed(req, 'portal'))
      return sendError(reply, 403, 'forbidden', 'scope portal is needed');
    const id = projectIdOf(req);
    if (!id) return fail(reply, coreError('invalid_input', 'bad project id'));
    try {
      return (
        (await getProjectDetail(o.pool, id)) ??
        fail(reply, coreError('not_found', 'no such project'))
      );
    } catch {
      return fail(reply, coreError('unavailable', 'the project could not be read'));
    }
  });

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

  // ------------------------------------------------------------ integration registry (M10.4)

  /** The effective registry (`?kind=code_host|model_provider`): what the codehost selects its adapter from. */
  app.get('/v1/integrations', async (req, reply) => {
    if (!allowed(req, 'registry')) {
      return sendError(reply, 403, 'forbidden', 'scope registry is needed');
    }
    const raw = (req.query as { kind?: string }).kind;
    const kind = IntegrationKind.safeParse(raw);
    if (raw !== undefined && !kind.success) {
      return fail(reply, coreError('invalid_input', 'kind is code_host, model_provider, ...'));
    }
    try {
      return await effectiveRegistry(o.pool, kind.success ? kind.data : undefined);
    } catch {
      return fail(reply, coreError('unavailable', 'the registry could not be read'));
    }
  });

  /** A reporter's health per integration. The gateway writes its own straight to the table; the codehost reports here. */
  app.post('/v1/integrations/health', async (req, reply) => {
    if (!allowed(req, 'integrations')) {
      return sendError(reply, 403, 'forbidden', 'scope integrations is needed');
    }
    if ((req.body as { reporter?: unknown } | null)?.reporter !== 'codehost') {
      return fail(reply, coreError('invalid_input', 'only the codehost reports through core'));
    }
    try {
      const r = await acceptHealth(o.pool, req.body, clock.now());
      return 'error' in r ? fail(reply, coreError('invalid_input', r.error)) : r;
    } catch {
      return fail(reply, coreError('unavailable', 'the health report could not be stored'));
    }
  });

  /** The tiles of the integrations panel: every integration, one shared health shape (a stale report reads `unknown`). */
  app.get('/v1/integrations/health', async (req, reply) => {
    if (!allowed(req, 'portal'))
      return sendError(reply, 403, 'forbidden', 'scope portal is needed');
    try {
      return await healthTiles(o.pool, clock.now());
    } catch {
      return fail(reply, coreError('unavailable', 'the health tiles could not be read'));
    }
  });

  /** What published revisions did to each integration, each with the ledger entry that made it effective. */
  app.get('/v1/integrations/events', async (req, reply) => {
    if (!allowed(req, 'portal'))
      return sendError(reply, 403, 'forbidden', 'scope portal is needed');
    try {
      return await integrationEvents(
        o.pool,
        (req.query as { integration_id?: string }).integration_id,
      );
    } catch {
      return fail(reply, coreError('unavailable', 'the integration events could not be read'));
    }
  });

  // ------------------------------------------------------------ the portal's list reads (2026-11-12)

  registerPortalListRoutes({
    app,
    pool: o.pool,
    pdp: o.pdp,
    now: () => clock.now(),
    allowed: (req, scope) => allowed(req, scope),
  });

  // M19: the floor's live read model (floor.read on the project, item.view_floor per item)
  registerFloorRoutes({
    app,
    pool: o.pool,
    pdp: o.pdp,
    now: () => clock.now(),
    eligibility: (o.config ?? o.cards?.decisions)?.eligibility,
    kill: o.kill,
    allowed: (req, scope) => allowed(req, scope),
  });
  // M19: the fleet (counts per project, the bff cuts it) and the sessions' heartbeats
  registerFleetRoutes({
    app,
    pool: o.pool,
    now: () => clock.now(),
    eligibility: (o.config ?? o.cards?.decisions)?.eligibility,
    kill: o.kill,
    allowed: (req, scope) => allowed(req, scope),
    core: deps,
  });

  // M19: HealthTile / HealthSnapshot. The tiles of the Operate › Health screen, the HealthSnapshot rule applied at read
  // time (older than two minutes: unknown). Scope `portal`: the bff asks the PDP (ops.read on the fleet) first.
  app.get('/v1/health', async (req, reply) => {
    if (!allowed(req, 'portal'))
      return sendError(reply, 403, 'forbidden', 'scope portal is needed');
    try {
      return await readHealthView(o.pool, clock.now());
    } catch {
      return fail(reply, coreError('unavailable', 'the health tiles could not be read'));
    }
  });

  // M19: the degraded states a screen states first (kill verdicts of the projects named, the Notary, stale read
  // models). Scope `portal`: the bff names only projects the person may view.
  app.get('/v1/degraded', async (req, reply) => {
    if (!allowed(req, 'portal'))
      return sendError(reply, 403, 'forbidden', 'scope portal is needed');
    const raw = (req.query as { projects?: unknown }).projects;
    const projects = (typeof raw === 'string' ? raw.split(',') : [])
      .map((p) => p.trim())
      .filter((p) => ProjectId.safeParse(p).success);
    if (projects.length > 50) return fail(reply, coreError('invalid_input', 'at most 50 projects'));
    try {
      return await readDegraded({ pool: o.pool, now: () => clock.now(), kill: o.kill }, projects);
    } catch {
      return fail(reply, coreError('unavailable', 'the degraded states could not be read'));
    }
  });

  /**
   * The Push Broker's questions (M13.6, scope `push_guard`): the Unit's lease (held, epoch) and the item's lane, and whether
   * an APPROVED X2 decision is bound to this item and exactly this patch hash. From core's rows and the ledger, nothing from
   * the caller. A question core cannot answer is a 503, which the broker reads as unknown (it refuses).
   */
  const guards = new CorePushGuards(o.pool);
  app.get('/v1/push-guards/:item/units/:unit/lease', async (req, reply) => {
    if (!allowed(req, 'push_guard')) {
      return sendError(reply, 403, 'forbidden', 'scope push_guard is needed');
    }
    const item = WorkItemId.safeParse(params(req)['item']);
    const unit = UnitKey.safeParse(params(req)['unit']);
    if (!item.success || !unit.success)
      return fail(reply, coreError('invalid_input', 'item and unit are required'));
    const r = await guards.lease(item.data, unit.data);
    return r.state === 'ok'
      ? r.value
      : fail(reply, coreError('unavailable', 'the lease could not be read'));
  });

  app.get('/v1/push-guards/:item/x2', async (req, reply) => {
    if (!allowed(req, 'push_guard')) {
      return sendError(reply, 403, 'forbidden', 'scope push_guard is needed');
    }
    const item = WorkItemId.safeParse(params(req)['item']);
    const hash = Sha256Hex.safeParse((req.query as { patch_hash?: string }).patch_hash);
    if (!item.success || !hash.success)
      return fail(reply, coreError('invalid_input', 'item and patch_hash are required'));
    const r = await guards.x2Bound(item.data, hash.data);
    return r.state === 'ok'
      ? { bound: r.value }
      : fail(reply, coreError('unavailable', 'the decisions could not be read'));
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

  /**
   * `eligibility(repo, lane)` (PLAN M7.6): whether the lane runs for the repo and where a request
   * for it goes: `normal`, `n8_hold` (no active PRR) or `l8` (the 1.4 rule: level too low, or the
   * PRR is stale, suspended or expired).
   */
  app.get('/v1/repos/:owner/:name/eligibility', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const repo = RepoFullName.safeParse(`${params(req)['owner']}/${params(req)['name']}`);
    if (!repo.success) return fail(reply, coreError('invalid_input', 'owner/name is required'));
    const q = req.query as { lane?: string; area?: string };
    const lane = Lane.safeParse(q.lane);
    if (!lane.success) return fail(reply, coreError('invalid_input', 'lane must be L0 to L8'));
    // DEC-25: `?area=` asks for one area of the repo (the system map's), absent the repo as a whole
    const area = q.area === undefined ? undefined : AreaId.safeParse(q.area);
    if (area && !area.success) return fail(reply, coreError('invalid_input', 'area is invalid'));
    try {
      return await laneEligibility(
        o.pool,
        repo.data,
        lane.data,
        clock,
        undefined,
        area?.success ? area.data : undefined,
      );
    } catch {
      return fail(reply, coreError('unavailable', 'the eligibility could not be read'));
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
    // A request that names a team is asked about that team, so a team-scoped onboarder reaches it.
    const target = b.value.team_id ? pdpResource.team(b.value.team_id) : pdpResource.fleet();
    if (!(await guard(reply, b.value.on_behalf_of, 'project.onboard', target))) return;
    const r = await requestOnboarding(deps, b.value);
    if (!r.ok) return fail(reply, r.error);
    return reply.code(r.value.duplicate ? 200 : 201).send(r.value);
  });

  // ------------------------------------------------------------ requests and items (PLAN M9.1)

  app.post('/v1/requests', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = parse(SubmitRequestBody, req.body);
    if (!b.ok) return fail(reply, b.error);
    if (
      !(await guard(
        reply,
        b.value.on_behalf_of,
        'work.request',
        pdpResource.project(b.value.project_id),
      ))
    ) {
      return;
    }
    const r = await submitRequest(deps, {
      project_id: b.value.project_id,
      repo: b.value.repo,
      lane: b.value.lane,
      requester: b.value.on_behalf_of,
      channel: b.value.channel,
      text: b.value.text,
      ...(b.value.request_id ? { request_id: b.value.request_id } : {}),
    });
    if (!r.ok) return fail(reply, r.error);
    const receipt = await requestReceipt(
      r.value,
      b.value.project_id,
      (o.config ?? o.cards?.decisions)?.eligibility,
    );
    return reply.code(r.value.duplicate ? 200 : 201).send(receipt);
  });

  // ------------------------------------------------------------ the R3 circuit breaker (PLAN M9.5)

  /** The breakers of a project (every lane that ever counted), tripped or not. */
  app.get('/v1/projects/:id/breakers', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const id = projectIdOf(req);
    if (!id) return fail(reply, coreError('invalid_input', 'bad project id'));
    const who = PrincipalId.safeParse((req.query as Record<string, string>)['on_behalf_of']);
    if (!who.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    if (!(await guard(reply, who.data, 'project.view', pdpResource.project(id)))) return;
    return { breakers: (await listBreakers(o.pool)).filter((b) => b.project_id === id) };
  });

  /** Asks for a reset: an M5 gate in the project admin's inbox. Proposing is `config.propose`. */
  app.post('/v1/projects/:id/breakers/:lane/reset', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const id = projectIdOf(req);
    const lane = Lane.safeParse(params(req)['lane']);
    if (!id || !lane.success) return fail(reply, coreError('invalid_input', 'bad project or lane'));
    const b = parse(z.strictObject({ on_behalf_of: PrincipalId }), req.body);
    if (!b.ok) return fail(reply, b.error);
    if (!(await guard(reply, b.value.on_behalf_of, 'config.propose', pdpResource.project(id))))
      return;
    const decisions = o.config ?? o.cards?.config;
    if (!decisions)
      return sendError(reply, 503, 'unavailable', 'the decision kernel is not configured');
    const r = await requestBreakerReset(
      { ...deps, decisions },
      { project_id: id, lane: lane.data, requested_by: b.value.on_behalf_of },
    );
    return r.ok ? reply.code(201).send(r.value) : fail(reply, r.error);
  });

  // ------------------------------------------------------------ controls, previews and banners (PLAN M9.6)

  const OpsWho = { on_behalf_of: PrincipalId };
  /** The PDP resource a control or banner of `scope` is authorised against: the fleet only for a factory admin. */
  const resourceOfScope = (scope: ControlScope) => {
    if (scope.kind === 'fleet') return pdpResource.fleet();
    if (scope.kind === 'project') return pdpResource.project(scope.ref);
    if (scope.kind === 'lane') {
      const [p, l] = scope.ref.split('/');
      return pdpResource.lane(p as string, l as string);
    }
    return null;
  };

  app.post('/v1/controls/preview', async (req, reply) => {
    if (!allowed(req, 'ops')) return sendError(reply, 403, 'forbidden', 'scope ops is needed');
    const b = parse(
      z.strictObject({ ...OpsWho, kind: ControlKind, scope: ControlScope }),
      req.body,
    );
    if (!b.ok) return fail(reply, b.error);
    const res = resourceOfScope(b.value.scope);
    if (!res)
      return fail(reply, coreError('invalid_input', 'no control is enforced on that scope'));
    if (!(await guard(reply, b.value.on_behalf_of, 'control.apply', res))) return;
    const r = await previewControl(deps, {
      kind: b.value.kind,
      scope: b.value.scope,
      actor: b.value.on_behalf_of,
    });
    return r.ok ? reply.code(201).send(r.value) : fail(reply, r.error);
  });

  app.post('/v1/controls', async (req, reply) => {
    if (!allowed(req, 'ops')) return sendError(reply, 403, 'forbidden', 'scope ops is needed');
    const b = parse(
      z.strictObject({
        ...OpsWho,
        preview_id: z.uuid(),
        nonce: z.string().min(16),
        kind: ControlKind,
        scope: ControlScope,
        params: z.record(z.string(), z.unknown()).optional(),
        expires_at: IsoDateTime.nullable().optional(),
        step_up: z.strictObject({ proof: z.string().min(1).max(8192) }).optional(),
      }),
      req.body,
    );
    if (!b.ok) return fail(reply, b.error);
    const res = resourceOfScope(b.value.scope);
    if (!res)
      return fail(reply, coreError('invalid_input', 'no control is enforced on that scope'));
    if (!(await guard(reply, b.value.on_behalf_of, 'control.apply', res))) return;
    const stepUp = (o.config ?? o.cards?.decisions)?.stepUp;
    const r = await applyControl(stepUp ? { ...deps, stepUp } : deps, {
      preview_id: b.value.preview_id,
      nonce: b.value.nonce,
      kind: b.value.kind,
      scope: b.value.scope,
      actor: b.value.on_behalf_of,
      ...(b.value.params ? { params: b.value.params } : {}),
      ...(b.value.expires_at !== undefined ? { expires_at: b.value.expires_at } : {}),
      ...(b.value.step_up ? { step_up: b.value.step_up } : {}),
    });
    return r.ok ? reply.code(201).send(r.value) : fail(reply, r.error);
  });

  app.post('/v1/controls/:id/lift', async (req, reply) => {
    if (!allowed(req, 'ops')) return sendError(reply, 403, 'forbidden', 'scope ops is needed');
    const id = params(req)['id'] as string;
    const b = parse(z.strictObject({ ...OpsWho, reason: z.string().min(1).max(500) }), req.body);
    if (!b.ok || !z.uuid().safeParse(id).success) {
      return fail(reply, b.ok ? coreError('invalid_input', 'bad id') : b.error);
    }
    const cur = (await listControls(o.pool, clock.now())).find((c) => c.control_id === id);
    if (!cur) return fail(reply, coreError('not_found', 'no such control'));
    const res = resourceOfScope(cur.scope);
    if (!res)
      return fail(reply, coreError('invalid_input', 'no control is enforced on that scope'));
    if (!(await guard(reply, b.value.on_behalf_of, 'control.lift', res))) return;
    const r = await liftControl(deps, {
      control_id: id,
      actor: b.value.on_behalf_of,
      reason: b.value.reason,
    });
    return r.ok ? r.value : fail(reply, r.error);
  });

  app.get('/v1/projects/:id/controls', async (req, reply) => {
    if (!allowed(req, 'ops')) return sendError(reply, 403, 'forbidden', 'scope ops is needed');
    const id = projectIdOf(req);
    const who = PrincipalId.safeParse((req.query as Record<string, string>)['on_behalf_of']);
    if (!id || !who.success)
      return fail(reply, coreError('invalid_input', 'project and on_behalf_of are needed'));
    if (!(await guard(reply, who.data, 'project.view', pdpResource.project(id)))) return;
    const now = clock.now();
    return {
      controls: (await activeControls(o.pool, now)).filter(
        (c) => c.scope.kind === 'fleet' || projectOfScope(c.scope) === id,
      ),
      banners: (await activeBanners(o.pool, now)).filter(
        (b) => b.scope.kind === 'fleet' || projectOfScope(b.scope) === id,
      ),
    };
  });

  app.post('/v1/banners', async (req, reply) => {
    if (!allowed(req, 'ops')) return sendError(reply, 403, 'forbidden', 'scope ops is needed');
    const b = parse(
      z.strictObject({
        ...OpsWho,
        scope: ControlScope,
        severity: BannerSeverity,
        target: BannerTarget.optional(),
        text: z.string().min(1).max(500),
        expires_at: IsoDateTime,
      }),
      req.body,
    );
    if (!b.ok) return fail(reply, b.error);
    if (b.value.scope.kind !== 'fleet' && b.value.scope.kind !== 'project') {
      return fail(reply, coreError('invalid_input', 'a banner is for the fleet or a project'));
    }
    const res = resourceOfScope(b.value.scope);
    if (!res || !(await guard(reply, b.value.on_behalf_of, 'banner.publish', res))) return;
    const r = await publishBanner(deps, {
      actor: b.value.on_behalf_of,
      scope: b.value.scope,
      severity: b.value.severity,
      ...(b.value.target ? { target: b.value.target } : {}),
      text: b.value.text,
      expires_at: b.value.expires_at,
    });
    return r.ok ? reply.code(201).send(r.value) : fail(reply, r.error);
  });

  /** The card and ledger entry of each of the item's gates (P1-2), from the record. */
  const gateLinksOf = (st: ItemState) =>
    itemGateLinks(
      o.pool,
      st.item_id,
      st.gates.map((g) => g.gate_instance_id),
    );

  app.get('/v1/items/:id', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const id = params(req)['id'] as string;
    if (!z.uuid().safeParse(id).success) return fail(reply, coreError('invalid_input', 'bad id'));
    const who = PrincipalId.safeParse((req.query as Record<string, string>)['on_behalf_of']);
    if (!who.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    let item;
    try {
      item = await readItem(o.pool, id);
    } catch {
      return fail(reply, coreError('unavailable', 'the item could not be read'));
    }
    if (!item) return fail(reply, coreError('not_found', 'no such item'));
    const s = item.state;
    if (
      !(await guard(
        reply,
        who.data,
        'item.view_floor',
        pdpResource.item(s.project_id, s.item_id, s.lane ?? s.proposed_lane),
      ))
    ) {
      return;
    }
    return itemView(s, await gateLinksOf(s));
  });

  // ------------------------------------------------------------ the portal's actions on an item (PLAN M12.5)
  //
  // Each is the PDP's yes for the person on the item (core asks; the bff asked first), then one signal in the
  // item's stream with an idempotency key, which the interpreter decides on. Ready, answers, B4/R2 and the
  // human-written plan are steps of the lifecycle; the gates they lead to (G0, E1, G3) are decided and
  // ledgered through the kernel by their own slots.

  /** The item an action is about, and the PDP's answer for the person; or the refusal already sent. */
  async function itemFor(req: FastifyRequest, reply: FastifyReply, who: string, action: ActionId) {
    const id = params(req)['id'] as string;
    if (!z.uuid().safeParse(id).success) {
      fail(reply, coreError('invalid_input', 'bad id'));
      return null;
    }
    let item;
    try {
      item = await readItem(o.pool, id);
    } catch {
      fail(reply, coreError('unavailable', 'the item could not be read'));
      return null;
    }
    if (!item) {
      fail(reply, coreError('not_found', 'no such item'));
      return null;
    }
    const st = item.state;
    if (
      !(await guard(
        reply,
        who,
        action,
        pdpResource.item(st.project_id, st.item_id, st.lane ?? st.proposed_lane),
      ))
    ) {
      return null;
    }
    return { id, state: st };
  }
  const itemDeps = deps;
  /** MM-2 is on: the decisions of the lifecycle are refused (drafts and answers are not decisions). */
  const maintenanceOn = async (): Promise<boolean> => (await o.config?.maintenance?.()) === true;
  const view = async (id: string) => {
    const again = await readItem(o.pool, id);
    return again ? itemView(again.state, await gateLinksOf(again.state)) : null;
  };

  /** 1.6: the Ready decision. */
  app.post('/v1/items/:id/ready', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = parse(ItemReadyRequest, req.body);
    if (!b.ok) return fail(reply, b.error);
    const it = await itemFor(req, reply, b.value.on_behalf_of, 'item.ready');
    if (!it) return;
    if (it.state.waiting?.kind !== 'human' || it.state.waiting.what !== 'ready') {
      return fail(reply, coreError('conflict', 'the item is not waiting for the Ready decision'));
    }
    if (await maintenanceOn()) {
      return fail(reply, coreError('refused', 'maintenance mode MM-2: decisions are disabled'));
    }
    const r = await decideReady(itemDeps, it.id, b.value.on_behalf_of);
    if (!r.ok) return fail(reply, r.error);
    return { item: await view(it.id), duplicate: r.value.duplicate };
  });

  /** S1 1.5: the requester's answer to one clarification question. */
  app.post('/v1/items/:id/answers', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = parse(ItemAnswerRequest, req.body);
    if (!b.ok) return fail(reply, b.error);
    const it = await itemFor(req, reply, b.value.on_behalf_of, 'item.ready');
    if (!it) return;
    const r = await answerQuestion(itemDeps, it.id, {
      question_id: b.value.question_id,
      text: b.value.text,
      by: b.value.on_behalf_of,
      channel: 'N1',
    });
    if (!r.ok) return fail(reply, r.error);
    return { item: await view(it.id), duplicate: r.value.duplicate };
  });

  /** While G3d is open: B4 (the design reveals a gap in the spec) or R2 (the work is smaller than its lane). */
  app.post('/v1/items/:id/observe', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = parse(ItemObserveRequest, req.body);
    if (!b.ok) return fail(reply, b.error);
    const it = await itemFor(req, reply, b.value.on_behalf_of, 'item.observe');
    if (!it) return;
    const w = it.state.waiting;
    const o2 = b.value;
    // a retry of a signal that was taken (the item has moved on since) is the same signal, not a conflict
    const signalKey = o2.edge === 'B4' ? `rework:B4:${o2.key}` : `relane:R2:${o2.key}`;
    const taken = (await readItemEvents(o.pool, it.id)).some(
      (e) => e.idempotency_key === signalKey,
    );
    if (!taken && (w?.kind !== 'gates' || w.conditional !== null || !w.gates.includes('G3d'))) {
      return fail(reply, coreError('conflict', 'the design review (G3d) is not open'));
    }
    const r =
      o2.edge === 'B4'
        ? await requestRework(itemDeps, it.id, {
            edge: 'B4',
            step: null,
            reason_code: o2.reason_code,
            by: o2.on_behalf_of,
            key: o2.key,
          })
        : await observeRelane(itemDeps, it.id, {
            to_lane: o2.to_lane,
            reason_code: o2.reason_code,
            by: o2.on_behalf_of,
            key: o2.key,
          });
    if (!r.ok) return fail(reply, r.error);
    return { item: await view(it.id), duplicate: r.value.duplicate };
  });

  /** RELHOLD (M15.3): the release approvers ask for the held release again after the fix window; G5 opens again. */
  app.post('/v1/items/:id/release/re-request', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = parse(ItemReleaseRequest, req.body);
    if (!b.ok) return fail(reply, b.error);
    const it = await itemFor(req, reply, b.value.on_behalf_of, 'item.release');
    if (!it) return;
    const signalKey = `rerequest:${b.value.key}`;
    const taken = (await readItemEvents(o.pool, it.id)).some(
      (e) => e.idempotency_key === signalKey,
    );
    if (!taken && it.state.waiting?.kind !== 'release_held') {
      return fail(reply, coreError('conflict', 'the release is not held'));
    }
    if (await maintenanceOn()) {
      return fail(reply, coreError('refused', 'maintenance mode MM-2: decisions are disabled'));
    }
    const r = await reRequestRelease(itemDeps, it.id, b.value.on_behalf_of, b.value.key);
    if (!r.ok) return fail(reply, r.error);
    return { item: await view(it.id), duplicate: r.value.duplicate };
  });

  /** B5: a person writes the plan (the four parts, the same checks as the agent's); G3 decides it. */
  app.post('/v1/items/:id/plan', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = parse(ItemPlanRequest, req.body);
    if (!b.ok) return fail(reply, b.error);
    const it = await itemFor(req, reply, b.value.on_behalf_of, 'item.plan');
    if (!it) return;
    if (!o.grounding) return sendError(reply, 503, 'unavailable', 'no grounding is configured');
    if (await maintenanceOn()) {
      return fail(reply, coreError('refused', 'maintenance mode MM-2: decisions are disabled'));
    }
    const r = await submitHumanPlan(
      { ...itemDeps, grounding: o.grounding },
      it.id,
      b.value.on_behalf_of,
      {
        split: b.value.split,
        sequence: b.value.sequence,
        tasks: b.value.tasks,
        verification: b.value.verification,
        ...(b.value.capacity ? { capacity: b.value.capacity } : {}),
      },
      b.value.key,
    );
    if (!r.ok) return fail(reply, r.error);
    return { item: await view(it.id), ...r.value };
  });

  /** D5 (M14.6): the developer says the human-led work of an L8 item is done; S7 checks it next. */
  app.post('/v1/items/:id/human-done', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = parse(ItemHumanDoneRequest, req.body);
    if (!b.ok) return fail(reply, b.error);
    const it = await itemFor(req, reply, b.value.on_behalf_of, 'item.human_done');
    if (!it) return;
    // a retry of a signal that was taken (the item has moved on since) is the same signal, not a conflict
    const taken = (await readItemEvents(o.pool, it.id)).some(
      (e) => e.idempotency_key === `human_done:${b.value.key}`,
    );
    const w = it.state.waiting;
    if (!taken && (w?.kind !== 'human' || w.what !== 'human_led')) {
      return fail(reply, coreError('conflict', 'the item is not waiting for human-led work'));
    }
    if (await maintenanceOn()) {
      return fail(reply, coreError('refused', 'maintenance mode MM-2: decisions are disabled'));
    }
    const r = await completeHumanWork(itemDeps, it.id, b.value.on_behalf_of, b.value.key);
    if (!r.ok) return fail(reply, r.error);
    return { item: await view(it.id), duplicate: r.value.duplicate };
  });

  /**
   * The agent runs of one item, each with what came of it (M11.2). Decided on the item's project
   * (`project.view`), like the item itself.
   */
  app.get('/v1/agent-runs', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const q = req.query as Record<string, string>;
    if (!z.uuid().safeParse(q['item']).success) {
      return fail(reply, coreError('invalid_input', 'item (a uuid) is needed'));
    }
    const who = PrincipalId.safeParse(q['on_behalf_of']);
    if (!who.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    let item;
    try {
      item = await readItem(o.pool, q['item'] as string);
    } catch {
      return fail(reply, coreError('unavailable', 'the item could not be read'));
    }
    if (!item) return fail(reply, coreError('not_found', 'no such item'));
    const project = item.state.project_id as ProjectId;
    if (!(await guard(reply, who.data, 'project.view', pdpResource.project(project)))) return;
    try {
      return {
        item_id: item.state.item_id,
        project_id: project,
        runs: await listAgentRuns(o.pool, item.state.item_id),
      };
    } catch {
      return fail(reply, coreError('unavailable', 'the agent runs could not be read'));
    }
  });

  // ------------------------------------------------------------ S7 for the portal (PLAN M14.6)
  //
  // The checks 7.1 to 7.5 of a Unit head, the signed Evidence Pack and its bytes: built from the record alone and
  // decided on the item's project (`project.view` for the person the bff acts for). Core answers uncut (D2); the bff
  // asks for view level V2 and cuts finding text to the person's data class.

  /** The item a read is about and the PDP's `project.view` on its project; or the refusal already sent. */
  async function itemRead(req: FastifyRequest, reply: FastifyReply) {
    if (!allowed(req, 'work')) {
      sendError(reply, 403, 'forbidden', 'scope work is needed');
      return null;
    }
    const id = params(req)['id'] as string;
    if (!z.uuid().safeParse(id).success) {
      fail(reply, coreError('invalid_input', 'bad id'));
      return null;
    }
    const who = PrincipalId.safeParse((req.query as Record<string, string>)['on_behalf_of']);
    if (!who.success) {
      fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
      return null;
    }
    let item;
    try {
      item = await readItem(o.pool, id);
    } catch {
      fail(reply, coreError('unavailable', 'the item could not be read'));
      return null;
    }
    if (!item) {
      fail(reply, coreError('not_found', 'no such item'));
      return null;
    }
    const project = item.state.project_id as ProjectId;
    if (!(await guard(reply, who.data, 'project.view', pdpResource.project(project)))) return null;
    return { id, project };
  }
  const shaQuery = (req: FastifyRequest, key: string, re: RegExp): string | undefined | null => {
    const v = (req.query as Record<string, string | undefined>)[key];
    if (v === undefined) return undefined;
    return re.test(v) ? v : null;
  };

  app.get('/v1/items/:id/verify', async (req, reply) => {
    const head = shaQuery(req, 'head', /^[0-9a-f]{40}$/);
    if (head === null) return fail(reply, coreError('invalid_input', 'head is a commit sha'));
    const it = await itemRead(req, reply);
    if (!it) return;
    try {
      const r = await itemVerifyView(o.pool, it.id, head);
      return r.ok ? r.value : fail(reply, r.error);
    } catch {
      return fail(reply, coreError('unavailable', 'the S7 results could not be read'));
    }
  });

  app.get('/v1/items/:id/evidence', async (req, reply) => {
    const pack = shaQuery(req, 'pack', /^[0-9a-f]{64}$/);
    if (pack === null) return fail(reply, coreError('invalid_input', 'pack is a sha256'));
    const it = await itemRead(req, reply);
    if (!it) return;
    try {
      const r = await evidencePackView(o.pool, o.objects, it.id, pack);
      return r.ok ? r.value : fail(reply, r.error);
    } catch {
      return fail(reply, coreError('unavailable', 'the Evidence Packs could not be read'));
    }
  });

  /** The signed bytes exactly as stored (canonical JSON), for `aisdlc-verify-pack`. */
  app.get('/v1/items/:id/evidence/:pack/signed', async (req, reply) => {
    const pack = params(req)['pack'] as string;
    if (!/^[0-9a-f]{64}$/.test(pack)) return fail(reply, coreError('invalid_input', 'bad pack'));
    const it = await itemRead(req, reply);
    if (!it) return;
    try {
      const r = await signedPackBytes(o.pool, o.objects, it.id, pack);
      if (!r.ok) return fail(reply, r.error);
      return reply
        .type(SIGNED_EVIDENCE_PACK_CONTENT_TYPE)
        .header('x-object-key', r.value.object_key)
        .send(Buffer.from(r.value.bytes));
    } catch {
      return fail(reply, coreError('unavailable', 'the signed pack could not be read'));
    }
  });

  /**
   * Acceptance rate, back-edge rate and cost per run of an agent (M11.2), over the fleet (`quality.read`
   * on the fleet) or one project (`?project=`, `quality.read` on it; PLAN §7a).
   */
  app.get('/v1/agents/:id/stats', async (req, reply) => {
    if (!allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const agent = AgentId.safeParse(params(req)['id']);
    if (!agent.success) return fail(reply, coreError('invalid_input', 'unknown agent'));
    const q = req.query as Record<string, string>;
    const who = PrincipalId.safeParse(q['on_behalf_of']);
    if (!who.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    const project = q['project'] === undefined ? null : ProjectId.safeParse(q['project']);
    if (project !== null && !project.success) {
      return fail(reply, coreError('invalid_input', 'bad project id'));
    }
    const scope = project === null ? null : project.data;
    if (
      !(await guard(
        reply,
        who.data,
        'quality.read',
        scope === null ? pdpResource.fleet() : pdpResource.project(scope),
      ))
    ) {
      return;
    }
    try {
      return await agentStatsOf(o.pool, agent.data, scope);
    } catch {
      return fail(reply, coreError('unavailable', 'the agent stats could not be read'));
    }
  });

  /**
   * The eval tooling posts a finished run (M11.3). Recorded once per run id; the body is ids, hashes,
   * pass vectors and counts (the contract has no field for a prompt, an input or an output).
   */
  app.post('/v1/evals/runs', async (req, reply) => {
    if (!allowed(req, 'evals')) return sendError(reply, 403, 'forbidden', 'scope evals is needed');
    const r = await recordEvalRun(deps, req.body);
    if (!r.ok) return fail(reply, r.error);
    reply.code(r.value.duplicate ? 200 : 201);
    return { recorded: !r.value.duplicate };
  });

  /** Who may read the eval history and scores: `quality.read` on the fleet, or the project tag asked for (PLAN §7a). */
  async function evalReadGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!allowed(req, 'work')) {
      sendError(reply, 403, 'forbidden', 'scope work is needed');
      return null;
    }
    const q = req.query as Record<string, string>;
    const who = PrincipalId.safeParse(q['on_behalf_of']);
    if (!who.success) {
      fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
      return null;
    }
    const project = q['project'] === undefined ? null : ProjectId.safeParse(q['project']);
    if (project !== null && !project.success) {
      fail(reply, coreError('invalid_input', 'bad project id'));
      return null;
    }
    const tag = project === null ? null : (project as { data: ProjectId }).data;
    if (
      !(await guard(
        reply,
        who.data,
        'quality.read',
        tag === null ? pdpResource.fleet() : pdpResource.project(tag),
      ))
    ) {
      return null;
    }
    return { q, project: tag };
  }

  /**
   * The quality board's rows (M11.3; DM §5.1): one per task of the newest run of each suite and
   * provider, allow-listed fields only (never a prompt, an output or a per-task cost). Evals are
   * factory-wide; `?project=` shows the suites tagged with a project.
   */
  app.get('/v1/evals/summary', async (req, reply) => {
    const g = await evalReadGuard(req, reply);
    if (!g) return;
    try {
      return { rows: await evalSummary(o.pool, g.project) };
    } catch {
      return fail(reply, coreError('unavailable', 'the eval summary could not be read'));
    }
  });

  /** The history of eval runs, newest first: what a trend is drawn from. `?suite=`, `?agent=`, `?limit=`. */
  app.get('/v1/evals/runs', async (req, reply) => {
    const g = await evalReadGuard(req, reply);
    if (!g) return;
    const agent = g.q['agent'] === undefined ? null : AgentId.safeParse(g.q['agent']);
    if (agent !== null && !agent.success)
      return fail(reply, coreError('invalid_input', 'unknown agent'));
    const limit = g.q['limit'] === undefined ? 100 : Number(g.q['limit']);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return fail(reply, coreError('invalid_input', 'limit is 1 to 500'));
    }
    try {
      return {
        runs: await evalHistory(o.pool, {
          project: g.project,
          limit,
          ...(g.q['suite'] === undefined ? {} : { suite: g.q['suite'] }),
          ...(agent === null ? {} : { agent: agent.data }),
        }),
      };
    } catch {
      return fail(reply, coreError('unavailable', 'the eval history could not be read'));
    }
  });

  /** AgentScore per (prompt sha, provider, model): eval results and production outcomes of one agent. */
  app.get('/v1/agents/:id/scores', async (req, reply) => {
    const agent = AgentId.safeParse(params(req)['id']);
    if (!agent.success) return fail(reply, coreError('invalid_input', 'unknown agent'));
    const g = await evalReadGuard(req, reply);
    if (!g) return;
    try {
      return { agent_id: agent.data, scores: await agentScoresOf(o.pool, agent.data) };
    } catch {
      return fail(reply, coreError('unavailable', 'the agent scores could not be read'));
    }
  });

  // ------------------------------------------------------------ the owner's moves on a record

  const Move = z.strictObject({ on_behalf_of: PrincipalId, reason: Reason });

  /** The resource an onboarding move on S0 record `id` is asked about: its project's team, else the fleet. */
  async function moveTarget(id: string): Promise<PdpResource> {
    const rec = await readS0(o.pool, id);
    const team = rec ? (await getProject(o.pool, rec.record.project_id))?.team_id : null;
    return team ? pdpResource.team(team) : pdpResource.fleet();
  }

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
    if (!(await guard(reply, b.value.on_behalf_of, 'project.onboard', await moveTarget(id))))
      return;
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
    if (!(await guard(reply, b.value.on_behalf_of, 'project.onboard', await moveTarget(id))))
      return;
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
        // M15.3: the release choice, off or a deploy target (null: not chosen)
        release: ReleaseSetting.nullable().optional(),
        // M15.5: the project's admission limits (ADR-0003 §6)
        wip_limit: ProjectWipLimit.optional(),
        default_envelope: ProjectDefaultEnvelope.optional(),
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

  /** A card's header (its project, S0 record, status and who decides it), without building its view. */
  app.get('/v1/cards/:cardId/summary', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const cards = cardsOr(reply);
    const id = uuidParam(req, reply, 'cardId');
    if (!cards || !id) return;
    const r = await cardSummary(cards, id);
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

  /**
   * What a work-item gate card (G1f, G2) decides: the artefacts its subject hash binds, rendered as
   * markdown, each with its hash and whether its stored bytes still hash to it (M12). The bff decides
   * whether the person may see the project.
   */
  app.get('/v1/cards/:cardId/artefacts', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const id = uuidParam(req, reply, 'cardId');
    if (!id) return;
    try {
      const r = await gateArtefactsView(o.pool, id);
      return r.ok ? r.value : fail(reply, r.error);
    } catch {
      return fail(reply, coreError('unavailable', 'the card could not be read'));
    }
  });

  // ------------------------------------------------------------ deciding a work-item gate card (Gap B)

  const kernelOr = (reply: FastifyReply): DecisionDeps | null => {
    const k = o.config ?? o.cards?.decisions;
    if (k) return k;
    fail(reply, coreError('unavailable', 'no decision kernel is configured'));
    return null;
  };

  /** What a work-item card is as something to decide: its gates, who may, what a decision may be. */
  app.get('/v1/cards/:cardId/gate', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const k = kernelOr(reply);
    const id = uuidParam(req, reply, 'cardId');
    if (!k || !id) return;
    try {
      const r = await gateCardView(k, id);
      return r.ok ? r.value : fail(reply, r.error);
    } catch {
      return fail(reply, coreError('unavailable', 'the card could not be read'));
    }
  });

  /**
   * The gate-specific facts of a work-item card (M14.6: Q1's SECT triage, E6, X2, X3, E2): what its subject hash binds,
   * the S7 check that raised it, the decisions so far. Uncut; the bff asks `project.view` and cuts it.
   */
  app.get('/v1/cards/:cardId/gate/context', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const id = uuidParam(req, reply, 'cardId');
    if (!id) return;
    try {
      const r = await gateCardContext(o.pool, id);
      return r.ok ? r.value : fail(reply, r.error);
    } catch {
      return fail(reply, coreError('unavailable', 'the card could not be read'));
    }
  });

  /**
   * The PDP decides about the human FIRST: `card.decide` on the card and `gate.decide` on every gate it
   * carries (all must say yes); then the decision kernel checks the slot, two-person, own-request and step-up
   * rules and writes the ledger entries. Nothing here has a default decision.
   */
  async function gateCardAction<S extends z.ZodType<{ on_behalf_of: string }>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    run: (k: DecisionDeps, id: string, body: z.infer<S>) => Promise<Result<unknown, CoreError>>,
  ) {
    if (!allowed(req, 'onboard'))
      return sendError(reply, 403, 'forbidden', 'scope onboard is needed');
    const k = kernelOr(reply);
    const id = uuidParam(req, reply, 'cardId');
    if (!k || !id) return;
    const b = parse(schema, req.body);
    if (!b.ok) return fail(reply, b.error);
    const head = await itemCardHead(o.pool, id);
    if (!head) return fail(reply, coreError('not_found', 'no such work item card'));
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
    for (const g of head.gates) {
      if (
        !(await guard(
          reply,
          b.value.on_behalf_of,
          'gate.decide',
          pdpResource.gate(head.project_id, g.gate_instance_id, g.gate),
        ))
      ) {
        return;
      }
    }
    const r = await run(k, id, b.value);
    return r.ok ? r.value : fail(reply, r.error);
  }

  app.post('/v1/cards/:cardId/gate/prepare', (req, reply) =>
    gateCardAction(req, reply, GateCardPrepareRequest, (k, id, b) =>
      prepareGateCard(k, { card_id: id, principal: b.on_behalf_of }),
    ),
  );
  app.post('/v1/cards/:cardId/gate/evidence', (req, reply) =>
    gateCardAction(req, reply, GateCardEvidenceRequest, (k, id, b) =>
      recordGateCardEvidence(k, { card_id: id, views: b.views }),
    ),
  );
  app.post('/v1/cards/:cardId/gate/decide', (req, reply) =>
    gateCardAction(req, reply, GateCardDecideRequest, (k, id, b) =>
      decideGateCard(k, {
        card_id: id,
        principal: b.on_behalf_of,
        decision: b.decision,
        votes: b.votes,
        ...(b.reason === undefined ? {} : { reason: b.reason }),
      }),
    ),
  );

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
        ...(b.step_up === undefined ? {} : { step_up: b.step_up }),
      }),
    ),
  );
  /** Card 2: the person edits a file's proposed instruction text (secret-scanned before it is stored). */
  app.post('/v1/cards/:cardId/instructions', (req, reply) =>
    cardAction(req, reply, C2InstructionEditRequest, (c, id, b) =>
      editOnboardingInstructions(c, {
        card_id: id,
        principal: b.on_behalf_of,
        path: b.path,
        text: b.text,
        base_text_sha256: b.base_text_sha256,
      }),
    ),
  );
  /** Card 4: reads the code host again. The factory fixes nothing; the person did, on GitHub. */
  app.post('/v1/cards/:cardId/recheck', (req, reply) =>
    cardAction(req, reply, CardRecheckRequest, (c, id, b) =>
      recheckControls(c, { card_id: id, principal: b.on_behalf_of }),
    ),
  );

  /**
   * Card 2: a person who holds card 2's slot asks for the onboarding probe again (M16). Recorded first; the
   * `onboarding_probe` loop runs it at once instead of after the hour (a probe that ran is final for its census head).
   */
  app.post('/v1/cards/:cardId/probe/retry', (req, reply) =>
    cardAction(req, reply, CardRecheckRequest, (c, id, b) =>
      requestProbeRetry(c, { card_id: id, principal: b.on_behalf_of }),
    ),
  );

  /** LF1 to LF8 of an S0 record as they stand (M16): unknown is unmet. */
  app.get('/v1/s0/:id/light-floors', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const cards = cardsOr(reply);
    const id = uuidParam(req, reply, 'id');
    if (!cards || !id) return;
    const r = await lightFloorsOf(cards, id);
    return r.ok ? r.value : fail(reply, r.error);
  });

  // ------------------------------------------------------------ the Light spikes (M16: SP-STD-1, SP-STD-3)

  /** An operator records a spike report; core computes the verdict against `onboarding.light_tests`. */
  app.post('/v1/onboarding/spikes', async (req, reply) => {
    if (!allowed(req, 'ops')) return sendError(reply, 403, 'forbidden', 'scope ops is needed');
    const b = parse(SpikeRecordRequest, req.body);
    if (!b.ok) return fail(reply, b.error);
    const r = await recordSpike(
      { ...deps, lightTests: o.cards?.lightTests ?? (() => DEFAULT_LIGHT_TESTS) },
      b.value,
      'ops',
    );
    if (!r.ok) return fail(reply, r.error);
    reply.code(201);
    return r.value;
  });

  /** The latest recorded spike of a kind (`?image=` for SP-STD-1 of one worker image). */
  app.get('/v1/onboarding/spikes/:kind', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const k = SpikeKind.safeParse(params(req)['kind']);
    if (!k.success) return fail(reply, coreError('invalid_input', 'unknown spike kind'));
    const image = (req.query as Record<string, string | undefined>)['image'];
    const r = await latestSpike(o.pool, k.data, image);
    if (!r) return fail(reply, coreError('not_found', 'no such spike is recorded'));
    return r;
  });

  // ------------------------------------------------------------ inbox, settings revisions (M8.3)

  const configOr = (reply: FastifyReply): ConfigDeps | null => {
    const c = o.config ?? o.cards?.config;
    if (c) return c;
    fail(reply, coreError('unavailable', 'no decision kernel is configured'));
    return null;
  };

  /** Everything open and waiting for a person, across projects (the bff filters it for the person). */
  app.get('/v1/inbox', async (req, reply) => {
    if (!allowed(req, 'portal'))
      return sendError(reply, 403, 'forbidden', 'scope portal is needed');
    const cards = cardsOr(reply);
    if (!cards) return;
    try {
      return await coreInbox({ cards, config: o.config ?? cards.config, clock });
    } catch {
      return fail(reply, coreError('unavailable', 'the inbox could not be read'));
    }
  });

  /** The settings revision card 4 proposed for an S0 record, in whatever state. */
  app.get('/v1/s0/:id/revision', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const config = configOr(reply);
    const id = uuidParam(req, reply, 'id');
    if (!config || !id) return;
    const r = await revisionOfS0({ pool: o.pool, config }, id);
    return r.ok ? r.value : fail(reply, r.error);
  });

  app.get('/v1/revisions/:gate', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const config = configOr(reply);
    const gate = uuidParam(req, reply, 'gate');
    if (!config || !gate) return;
    const r = await settingsRevision({ pool: o.pool, config }, gate);
    return r.ok ? r.value : fail(reply, r.error);
  });

  /** The PDP's `gate.decide` on the M1 gate for the human, then the decision kernel. */
  async function revisionAction<S extends z.ZodType<{ on_behalf_of: string }>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    run: (
      deps: { pool: pg.Pool; config: ConfigDeps },
      gate: string,
      body: z.infer<S>,
    ) => Promise<Result<unknown, CoreError>>,
  ) {
    if (!allowed(req, 'onboard'))
      return sendError(reply, 403, 'forbidden', 'scope onboard is needed');
    const config = configOr(reply);
    const gate = uuidParam(req, reply, 'gate');
    if (!config || !gate) return;
    const b = parse(schema, req.body);
    if (!b.ok) return fail(reply, b.error);
    const deps = { pool: o.pool, config };
    const view = await settingsRevision(deps, gate);
    if (!view.ok) return fail(reply, view.error);
    if (
      !(await guard(
        reply,
        b.value.on_behalf_of,
        'gate.decide',
        pdpResource.gate(view.value.project_id, gate, 'M1'),
      ))
    ) {
      return;
    }
    const r = await run(deps, gate, b.value);
    return r.ok ? r.value : fail(reply, r.error);
  }

  app.post('/v1/revisions/:gate/prepare', (req, reply) =>
    revisionAction(req, reply, RevisionPrepareRequest, (d, gate, b) =>
      prepareRevision(d, { gate, principal: b.on_behalf_of }),
    ),
  );
  app.post('/v1/revisions/:gate/evidence', (req, reply) =>
    revisionAction(req, reply, RevisionEvidenceRequest, (d, _gate, b) =>
      recordRevisionEvidence(d, { nonce: b.nonce, evidence_hash: b.evidence_hash }),
    ),
  );
  app.post('/v1/revisions/:gate/decide', (req, reply) =>
    revisionAction(req, reply, RevisionDecideRequest, (d, _gate, b) =>
      decideRevision(d, { nonce: b.nonce, decision: b.decision }),
    ),
  );
  /** Retries the publish of an approved revision (the decision is already on the ledger). */
  app.post('/v1/revisions/:gate/publish', (req, reply) =>
    revisionAction(req, reply, RevisionPrepareRequest, (d, gate) => publishRevision(d, gate)),
  );

  // ------------------------------------------------------------ configuration console (portal)

  // Factory-layer keys of this registry: read (scope read; the bff asks the PDP for the person) and
  // propose (scope portal; the PDP's config.propose on the fleet for the person). A proposal is an
  // ordinary revision with its M1 gate; nothing here publishes.
  const keyParam = (req: FastifyRequest): string | null => {
    const k = params(req)['key'];
    return typeof k === 'string' && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(k) ? k : null;
  };

  app.get('/v1/config/keys', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const config = configOr(reply);
    if (!config) return;
    return listConfigKeys(config);
  });

  app.get('/v1/config/keys/:key', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const config = configOr(reply);
    const key = keyParam(req);
    if (!config) return;
    if (!key) return fail(reply, coreError('invalid_input', 'bad config key'));
    try {
      const r = await configKeyView(config, key);
      return r.ok ? r.value : fail(reply, r.error);
    } catch {
      return fail(reply, coreError('unavailable', 'the configuration could not be read'));
    }
  });

  app.post('/v1/config/keys/:key/proposals', async (req, reply) => {
    if (!allowed(req, 'portal'))
      return sendError(reply, 403, 'forbidden', 'scope portal is needed');
    const config = configOr(reply);
    const key = keyParam(req);
    if (!config) return;
    if (!key) return fail(reply, coreError('invalid_input', 'bad config key'));
    const b = parse(ConfigProposeRequest, req.body);
    if (!b.ok) return fail(reply, b.error);
    if (!(await guard(reply, b.value.on_behalf_of, 'config.propose', pdpResource.fleet()))) return;
    const r = await proposeConfigKey(config, {
      key,
      value: b.value.value,
      principal: b.value.on_behalf_of,
      parent_rev_hash: b.value.parent_rev_hash,
    });
    return r.ok ? reply.code(201).send(r.value) : fail(reply, r.error);
  });

  // ------------------------------------------------------------ readiness record and ledger (M8.4)

  app.get('/v1/projects/:id/prr', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const id = projectIdOf(req);
    if (!id) return fail(reply, coreError('invalid_input', 'bad project id'));
    try {
      return (
        (await projectPrr(o.pool, id, clock)) ??
        fail(reply, coreError('not_found', 'no such project'))
      );
    } catch {
      return fail(reply, coreError('unavailable', 'the readiness record could not be read'));
    }
  });

  // M17: the Knowledge screen's read, from the record (the Full baseline and card 3's decision), at D2: the bff
  // checks project.view and V2 and cuts it to the person's data class.
  app.get('/v1/projects/:id/knowledge', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const id = projectIdOf(req);
    if (!id) return fail(reply, coreError('invalid_input', 'bad project id'));
    try {
      return (
        (await projectKnowledge(o.pool, id)) ??
        fail(reply, coreError('not_found', 'no such project'))
      );
    } catch {
      return fail(reply, coreError('unavailable', 'the knowledge could not be read'));
    }
  });

  // M17: the re-onboarding proposals knowledge defects raised for a repo (OB §8), from the record.
  app.get('/v1/repos/:owner/:name/reonboarding', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const repo = RepoFullName.safeParse(`${params(req)['owner']}/${params(req)['name']}`);
    if (!repo.success) return fail(reply, coreError('invalid_input', 'owner/name is required'));
    try {
      return { repo: repo.data, proposals: await listReonboardProposals(o.pool, repo.data) };
    } catch {
      return fail(reply, coreError('unavailable', 'the proposals could not be read'));
    }
  });

  app.get('/v1/projects/:id/ledger', async (req, reply) => {
    if (!allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const id = projectIdOf(req);
    if (!id) return fail(reply, coreError('invalid_input', 'bad project id'));
    const q = req.query as { s0?: string; limit?: string };
    if (q.s0 !== undefined && !z.uuid().safeParse(q.s0).success) {
      return fail(reply, coreError('invalid_input', 'bad s0 id'));
    }
    try {
      if (!(await getProject(o.pool, id))) {
        return fail(reply, coreError('not_found', 'no such project'));
      }
      return await ledgerAudit(o.pool, id, {
        ...(q.s0 ? { s0_id: q.s0 } : {}),
        ...(q.limit ? { limit: Number(q.limit) || 500 } : {}),
      });
    } catch {
      return fail(reply, coreError('unavailable', 'the ledger entries could not be read'));
    }
  });

  // ------------------------------------------------------------ the GitHub issue twin (M16)

  registerIssueTwinRoutes({ app, deps, allowed: (req) => allowed(req, 'work'), guard });

  // ------------------------------------------------------------ after onboarding: drift, restore, re-affirm (M16)

  registerDriftRoutes({
    app,
    deps,
    allowed: (req) => allowed(req, 'work'),
    guard,
    ...(o.cards
      ? {
          drift: {
            source: o.cards.source,
            eligibility: o.cards.decisions.eligibility,
            stepUp: o.cards.decisions.stepUp,
            bypass: o.bypass ?? (() => null),
          },
        }
      : {}),
  });
  // ------------------------------------------------------------ M15.5: B14, B17, 9.3, 9.5, 9.4 and the factory M1

  registerGovernanceRoutes({
    app,
    pool: o.pool,
    deps,
    config: o.config ?? o.cards?.config,
    allowed: (req, scope) => allowed(req, scope),
    guard,
  });

  // ------------------------------------------------------------ role-binding grants and access requests (P1-6)

  registerAccessRoutes({
    app,
    pool: o.pool,
    decisions: o.config ?? o.cards?.config,
    writer: o.grants,
    allowed: (req, scope) => allowed(req, scope),
    guard,
    may: async (principal, action, resource) =>
      o.pdp ? (await o.pdp.decide({ principal, action, resource })).decision === 'allow' : false,
  });

  // ------------------------------------------------------------ the erasable payloads (M19, the audit service)

  registerErasableRoutes({ app, deps, allowed: (req) => allowed(req, 'erasure') });

  // ------------------------------------------------------------ the assistant (M18)

  registerAssistantRoutes({
    app,
    assistant: o.assistant,
    allowed: (req) => allowed(req, 'work'),
    guard,
    decide: async (principal, action, resource) => {
      if (!o.pdp) return false;
      try {
        return (await o.pdp.decide({ principal, action, resource })).decision === 'allow';
      } catch {
        return false;
      }
    },
  });

  return app;
}
