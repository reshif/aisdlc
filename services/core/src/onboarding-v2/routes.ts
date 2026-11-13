import {
  PrincipalId,
  SignOffRequest,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { ConfigDeps } from '@aisdlc/config';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CardDeps } from '../cards/model.js';
import { loadS0, s0Cards } from '../cards/read.js';
import { CORE_STATUS, coreError, type CoreError } from '../errors.js';
import { overrideOf } from '../override.js';
import { getProject } from '../queries.js';
import { runOnboardingAgent, type OnboardingAgentPort } from './agent.js';
import type { PackDeps } from '../cards/pack.js';
import { signOff } from './sign-off.js';
import { onboardingSummary } from './summary.js';

// Portal v2's agent-led onboarding in core (N11-N13): the summary, the one sign-off, and "ask the agent again".
//   GET  /v1/s0/:id/summary?on_behalf_of=   scope read     PDP project.view on the project
//   POST /v1/s0/:id/sign-off                scope onboard  PDP card.decide on card 1 (the kernel decides each card)
//   POST /v1/s0/:id/agent/run               scope onboard  PDP project.onboard on the record's team (or the fleet)

export interface OnboardingV2RouteDeps {
  readonly app: FastifyInstance;
  readonly cards: CardDeps | undefined;
  readonly config: ConfigDeps | undefined;
  readonly agent: OnboardingAgentPort | undefined;
  readonly pack: PackDeps | undefined;
  readonly allowed: (req: FastifyRequest, scope: string) => boolean;
  readonly guard: (
    reply: FastifyReply,
    principal: string,
    action: ActionId,
    resource: PdpResource,
    opts?: { readonly kernel?: boolean },
  ) => Promise<boolean>;
}

const Who = z.strictObject({ on_behalf_of: PrincipalId });
const Run = z.strictObject({ on_behalf_of: PrincipalId });

export function registerOnboardingV2Routes(r: OnboardingV2RouteDeps): void {
  const { app } = r;
  const fail = (reply: FastifyReply, e: CoreError) =>
    sendError(reply, CORE_STATUS[e.code], e.code, e.message);
  const idOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const v = (req.params as Record<string, string>)['id'];
    if (z.uuid().safeParse(v).success) return v as string;
    fail(reply, coreError('invalid_input', 'bad id'));
    return null;
  };
  const cardsOr = (reply: FastifyReply): CardDeps | null => {
    if (r.cards) return r.cards;
    fail(reply, coreError('unavailable', 'the onboarding cards are not configured'));
    return null;
  };

  app.get('/v1/s0/:id/summary', async (req, reply) => {
    if (!r.allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const cards = cardsOr(reply);
    const id = idOf(req, reply);
    if (!cards || !id) return;
    const who = Who.safeParse(req.query);
    if (!who.success) return fail(reply, coreError('invalid_input', 'on_behalf_of is needed'));
    const loaded = await loadS0(cards.pool, id);
    if (!loaded) return fail(reply, coreError('not_found', `no S0 record ${id}`));
    const project = loaded.s0.record.project_id;
    if (
      !(await r.guard(reply, who.data.on_behalf_of, 'project.view', pdpResource.project(project)))
    )
      return;
    const v = await onboardingSummary(
      { cards, ...(r.config ? { config: r.config } : {}) },
      id,
      who.data.on_behalf_of,
    );
    return v.ok ? v.value : fail(reply, v.error);
  });

  app.post('/v1/s0/:id/sign-off', async (req, reply) => {
    if (!r.allowed(req, 'onboard'))
      return sendError(reply, 403, 'forbidden', 'scope onboard is needed');
    const cards = cardsOr(reply);
    const id = idOf(req, reply);
    if (!cards || !id) return;
    const b = SignOffRequest.safeParse(req.body ?? {});
    if (!b.success) return fail(reply, coreError('invalid_input', b.error.message));
    const loaded = await loadS0(cards.pool, id);
    if (!loaded) return fail(reply, coreError('not_found', `no S0 record ${id}`));
    const c1 = (await s0Cards(cards.pool, id)).find((c) => c.kind === 'C1');
    if (!c1) return fail(reply, coreError('conflict', 'card 1 is not open yet: nothing to sign'));
    if (
      !(await r.guard(
        reply,
        b.data.on_behalf_of,
        'card.decide',
        pdpResource.card(loaded.s0.record.project_id, c1.card_id),
        { kernel: true },
      ))
    ) {
      return;
    }
    const v = await signOff({ cards, ...(r.config ? { config: r.config } : {}) }, id, {
      ...b.data,
      override: overrideOf(req),
    });
    return v.ok ? v.value : fail(reply, v.error);
  });

  app.post('/v1/s0/:id/agent/run', async (req, reply) => {
    if (!r.allowed(req, 'onboard'))
      return sendError(reply, 403, 'forbidden', 'scope onboard is needed');
    const cards = cardsOr(reply);
    const id = idOf(req, reply);
    if (!cards || !id) return;
    if (!r.agent) return fail(reply, coreError('unavailable', 'no onboarding agent is configured'));
    const b = Run.safeParse(req.body ?? {});
    if (!b.success) return fail(reply, coreError('invalid_input', b.error.message));
    const loaded = await loadS0(cards.pool, id);
    if (!loaded) return fail(reply, coreError('not_found', `no S0 record ${id}`));
    const team = (await getProject(cards.pool, loaded.s0.record.project_id))?.team_id;
    const res = team ? pdpResource.team(team) : pdpResource.fleet();
    if (!(await r.guard(reply, b.data.on_behalf_of, 'project.onboard', res))) return;
    const v = await runOnboardingAgent(
      { cards, agent: r.agent, ...(r.pack ? { pack: r.pack } : {}) },
      id,
      { force: true },
    );
    return v.ok ? v.value : fail(reply, v.error);
  });
}
