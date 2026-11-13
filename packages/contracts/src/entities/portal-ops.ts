import { z } from 'zod';
import { Lane } from '../values.js';
import { BreakerState } from './breaker.js';
import { BannerSeverity, BannerTarget } from './controls.js';
import { InstallationRepo } from './codehost.js';
import { BudgetGroupView, ModelCallOutcome } from './gateway.js';
import { IsoDateTime, ProjectId, WorkItemId } from './ids.js';

// The portal's operate and govern views of the P2 gap list (docs/design/portal-review.md §12). Each is a read over
// what the record already holds, or a relay of a service's own answer; every route is PDP-guarded.
//
//   bff  GET  /api/cards/:id/kind                 CardKindView        (project.view; P3-8: one route, both kinds)
//   core GET  /v1/budgets                         BudgetsView         (ops.read on the fleet; P2-8)
//   core GET  /v1/cost                            CostView            (quality.read on the fleet; P2-8)
//   core GET  /v1/projects/:id/breakers           BreakersView        (project.view; P2-11)
//   core POST /v1/banners                         PublishBannerBody   (banner.publish on the scope; P2-12)
//   gw   POST /v1/admin/providers/:id/test        ProviderTestResult  (admin; P2-5)
//   core GET  /v1/onboarding/repos                OnboardReposView    (project.onboard on the fleet; P2-21)

// ---------------------------------------------------------------- P3-8: which kind of card an id is

export const CardRouteKind = z.enum(['onboarding', 'work_gate']);
export type CardRouteKind = z.infer<typeof CardRouteKind>;

export const CardKindView = z.strictObject({
  card_id: z.uuid(),
  kind: CardRouteKind,
});
export type CardKindView = z.infer<typeof CardKindView>;

// ---------------------------------------------------------------- P2-8: budget groups

/**
 * One budget group as the record shows it: what settled calls spent (`gateway.model_call`), whether ET1 was raised
 * (`gateway.budget_exhausted`, with the limits it was raised against), and the gateway's own live view when the
 * gateway answered (limits and what calls in flight have reserved). `live: null` means the gateway was not asked or
 * did not answer: the limits and reservations are then unknown, never zero.
 */
export const BudgetRow = z.strictObject({
  budget_group: z.string().min(1),
  project_ids: z.array(z.string()),
  item_ids: z.array(z.string()),
  calls: z.number().int().min(0),
  refused: z.number().int().min(0),
  used_tokens: z.number().int().min(0),
  used_cost_micro_usd: z.number().int().min(0),
  last_call_at: IsoDateTime.nullable(),
  exhausted_at: IsoDateTime.nullable(),
  exhausted_limit: z.enum(['tokens', 'cost']).nullable(),
  live: BudgetGroupView.nullable(),
});
export type BudgetRow = z.infer<typeof BudgetRow>;

export const BudgetsView = z.strictObject({
  as_of: IsoDateTime,
  /** `true` when core could ask the gateway for the live view of each group. */
  gateway: z.boolean(),
  groups: z.array(BudgetRow),
});
export type BudgetsView = z.infer<typeof BudgetsView>;

// ---------------------------------------------------------------- P2-8: cost reports

export const CostDay = z.strictObject({
  day: z.iso.date(),
  project_id: z.string(),
  calls: z.number().int().min(0),
  tokens_in: z.number().int().min(0),
  tokens_out: z.number().int().min(0),
  cost_micro_usd: z.number().int().min(0),
});
export type CostDay = z.infer<typeof CostDay>;

/** What an item that merged cost, over every model call made for it. */
export const MergedItemCost = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  lane: Lane.nullable(),
  merged_at: IsoDateTime,
  calls: z.number().int().min(0),
  tokens: z.number().int().min(0),
  cost_micro_usd: z.number().int().min(0),
});
export type MergedItemCost = z.infer<typeof MergedItemCost>;

export const CostOutcome = z.strictObject({
  outcome: ModelCallOutcome,
  calls: z.number().int().min(0),
  cost_micro_usd: z.number().int().min(0),
});

export const CostView = z.strictObject({
  as_of: IsoDateTime,
  since: IsoDateTime,
  days: z.number().int().min(1).max(366),
  by_day: z.array(CostDay),
  by_outcome: z.array(CostOutcome),
  merged_items: z.array(MergedItemCost),
});
export type CostView = z.infer<typeof CostView>;

// ---------------------------------------------------------------- P2-11: breakers

export const BreakersView = z.strictObject({ breakers: z.array(BreakerState) });
export type BreakersView = z.infer<typeof BreakersView>;

/** What a reset request opened: the M5 gate that decides it. */
export const BreakerResetRequested = z.looseObject({
  gate_instance_id: z.uuid(),
});

// ---------------------------------------------------------------- P2-12: banners

/** The portal's banner form (the bff adds the person; core asks `banner.publish` on the scope). */
export const PublishBannerBody = z.strictObject({
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('fleet'), ref: z.literal('*') }),
    z.strictObject({ kind: z.literal('project'), ref: ProjectId }),
  ]),
  severity: BannerSeverity,
  target: BannerTarget.optional(),
  text: z.string().trim().min(1).max(500),
  expires_at: IsoDateTime,
});
export type PublishBannerBody = z.infer<typeof PublishBannerBody>;

// ---------------------------------------------------------------- P2-5: model provider test and reload

/** One tiny call to one provider, asked for by an operator; metered as `gateway.provider_tested` (no text). */
export const ProviderTestResult = z.strictObject({
  integration_id: z.string().min(1),
  model_id: z.string().nullable(),
  outcome: z.enum(['ok', 'provider_error', 'not_built', 'no_model', 'refused']),
  /** The vendor's error class or the refusal, never a message from the vendor. */
  code: z.string().nullable(),
  tokens_in: z.number().int().min(0),
  tokens_out: z.number().int().min(0),
  cost_micro_usd: z.number().int().min(0),
  latency_ms: z.number().int().min(0),
  at: IsoDateTime,
});
export type ProviderTestResult = z.infer<typeof ProviderTestResult>;

export const ProviderTestedPayload = ProviderTestResult.extend({ tested_by: z.string().min(1) });
export type ProviderTestedPayload = z.infer<typeof ProviderTestedPayload>;

/** The gateway's adapters after a reload (`POST /v1/admin/reload`), and what `GET /v1/admin/integrations` says. */
export const GatewayAdapterState = z.strictObject({
  integration_id: z.string(),
  adapter: z.string(),
  state: z.string(),
  detail: z.string(),
});
export const GatewayReloadView = z.strictObject({
  revision: z.string().nullable(),
  integrations: z.array(GatewayAdapterState),
});
export type GatewayReloadView = z.infer<typeof GatewayReloadView>;

// ---------------------------------------------------------------- P2-21: the onboard repo picker

export const OnboardRepo = InstallationRepo.extend({
  /** A project already holds this repo (onboarded or being onboarded). */
  registered: z.boolean(),
});
export const OnboardReposView = z.strictObject({ repos: z.array(OnboardRepo) });
export type OnboardReposView = z.infer<typeof OnboardReposView>;
