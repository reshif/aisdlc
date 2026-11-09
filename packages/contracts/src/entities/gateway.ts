import { z } from 'zod';
import { DataClass, Lane, StepId } from '../values.js';
import { IsoDateTime, ProjectId, Sha256Hex } from './ids.js';

// The model gateway's vocabulary (PLAN M10; DM §3.8, §4 ModelProviderPort; RV §2 "Model key custody").
//
// Three groups live here and nowhere else:
//   1. the ROUTING TABLE, as config (`gateway.providers`, `gateway.models`, `gateway.routes`): a route
//      is `(environment, data_class) -> model`, D3 never has one, and the keys reach the gateway only
//      through `config_publish` behind an M1 gate;
//   2. the MESSAGES vocabulary the sandbox and the providers speak (an Anthropic Messages subset);
//   3. what the gateway RECORDS: `ModelCall` and the ET1 trigger. Neither ever holds prompt or output
//      text, only hashes, counts, cost and ids.

// ---------------------------------------------------------------- 1. routing table (config)

export const GatewayEnvironment = z.enum(['local', 'staging', 'prod']);
export type GatewayEnvironment = z.infer<typeof GatewayEnvironment>;

/** Adapters the gateway knows how to build. `fake` is the deterministic golden fake (never in prod). */
export const ModelProviderKind = z.enum(['anthropic', 'fake']);
export type ModelProviderKind = z.infer<typeof ModelProviderKind>;

const Slug = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/, 'lowercase slug');

/**
 * One provider row. It names NO key and NO URL: the credential reference and the endpoint belong to
 * the gateway's own deployment (`GATEWAY_PROVIDER_ADAPTERS`), so a config revision can switch a
 * provider off or point a route at it, but can never make the gateway send a key somewhere new.
 */
export const GatewayProvider = z.strictObject({
  provider_id: Slug,
  kind: ModelProviderKind,
  enabled: z.boolean(),
});
export type GatewayProvider = z.infer<typeof GatewayProvider>;

/** A model of a provider, with its price (the cost table is config: DM `ModelPrice`). */
export const GatewayModel = z.strictObject({
  /** The factory's name for it; what a route and a virtual key's allow-list say. */
  model_id: Slug,
  provider_id: Slug,
  /** What the vendor calls it (`claude-sonnet-5-5`). */
  provider_model: z.string().min(1).max(128),
  tools_capable: z.boolean(),
  /** A call asking for more output tokens than this is clamped to it. */
  max_tokens_cap: z.number().int().min(1).max(1_000_000),
  usd_in_per_mtok: z.number().min(0).max(100_000),
  usd_out_per_mtok: z.number().min(0).max(100_000),
});
export type GatewayModel = z.infer<typeof GatewayModel>;

/** A data class a route may serve. D3 is not in it: D3 has no route, ever (enforced by the schema). */
export const RoutableDataClass = z.enum(['D0', 'D1', 'D2']);
export type RoutableDataClass = z.infer<typeof RoutableDataClass>;

export const GatewayRoute = z.strictObject({
  environment: GatewayEnvironment,
  data_class: RoutableDataClass,
  model_id: Slug,
});
export type GatewayRoute = z.infer<typeof GatewayRoute>;

export const GATEWAY_CONFIG_KEYS = {
  providers: 'gateway.providers',
  models: 'gateway.models',
  routes: 'gateway.routes',
} as const;

const uniqueBy = <T>(rows: readonly T[], key: (r: T) => string): boolean =>
  new Set(rows.map(key)).size === rows.length;

export const GatewayProviders = z
  .array(GatewayProvider)
  .max(32)
  .refine((r) => uniqueBy(r, (p) => p.provider_id), 'duplicate provider_id');
export const GatewayModels = z
  .array(GatewayModel)
  .max(128)
  .refine((r) => uniqueBy(r, (m) => m.model_id), 'duplicate model_id');
export const GatewayRoutes = z
  .array(GatewayRoute)
  .max(64)
  .refine((r) => uniqueBy(r, (x) => `${x.environment}/${x.data_class}`), 'duplicate route');

export type GatewayProviders = z.infer<typeof GatewayProviders>;
export type GatewayModels = z.infer<typeof GatewayModels>;
export type GatewayRoutes = z.infer<typeof GatewayRoutes>;

/** Anthropic's current family, as the factory names and the gateway defaults them. */
export const ANTHROPIC_DEFAULT_MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
} as const;
export const AnthropicDefaultModels = z.strictObject({
  opus: z.string().min(1),
  sonnet: z.string().min(1),
  haiku: z.string().min(1),
});
export type AnthropicDefaultModels = z.infer<typeof AnthropicDefaultModels>;

// ---------------------------------------------------------------- 2. messages (Anthropic subset)

export const ModelTextBlock = z.object({ type: z.literal('text'), text: z.string() });
export const ModelToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()),
});
export const ModelToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1).max(128),
  content: z.union([z.string(), z.array(ModelTextBlock)]).optional(),
  is_error: z.boolean().optional(),
});
export const ModelContentBlock = z.discriminatedUnion('type', [
  ModelTextBlock,
  ModelToolUseBlock,
  ModelToolResultBlock,
]);
export type ModelContentBlock = z.infer<typeof ModelContentBlock>;

export const ModelMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(ModelContentBlock).min(1)]),
});
export type ModelMessage = z.infer<typeof ModelMessage>;

export const ModelTool = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(16_384).optional(),
  input_schema: z.record(z.string(), z.unknown()),
});
export type ModelTool = z.infer<typeof ModelTool>;

export const ModelToolChoice = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auto') }),
  z.object({ type: z.literal('any') }),
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('tool'), name: z.string().min(1).max(128) }),
]);
export type ModelToolChoice = z.infer<typeof ModelToolChoice>;

/**
 * What `ModelProviderPort.complete` takes. `metadata` is the gateway's own bookkeeping (vkey id, unit
 * id, item id): an adapter may forward at most an opaque id of it and never any text.
 */
export const ModelCompleteRequest = z.object({
  model: z.string().min(1).max(128),
  system: z.string().optional(),
  messages: z.array(ModelMessage).min(1).max(2_000),
  max_tokens: z.number().int().min(1).max(1_000_000),
  tools: z.array(ModelTool).max(256).optional(),
  tool_choice: ModelToolChoice.optional(),
  temperature: z.number().min(0).max(2).optional(),
  stop_sequences: z.array(z.string().min(1).max(256)).max(16).optional(),
  metadata: z.record(z.string(), z.string()),
});
export type ModelCompleteRequest = z.infer<typeof ModelCompleteRequest>;

export const ModelStopReason = z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']);
export type ModelStopReason = z.infer<typeof ModelStopReason>;

export const ModelUsage = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
});
export type ModelUsage = z.infer<typeof ModelUsage>;

export const ModelCompleteResponse = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  content: z.array(z.discriminatedUnion('type', [ModelTextBlock, ModelToolUseBlock])),
  stop_reason: ModelStopReason,
  usage: ModelUsage,
});
export type ModelCompleteResponse = z.infer<typeof ModelCompleteResponse>;

// ---------------------------------------------------------------- 3. virtual keys and budgets

export const VKeyScopeKind = z.enum(['unit', 'job', 'session']);
export type VKeyScopeKind = z.infer<typeof VKeyScopeKind>;

/** Letters, digits and `_ . : / -`; the ids the work engine uses for units, jobs and sessions. */
const RefId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:/-]+$/);

export const BudgetGroupSpec = z.strictObject({
  group_id: RefId,
  /** Hard stops. Both are checked before a call and settled after it. */
  max_tokens: z.number().int().min(1).max(1_000_000_000),
  /** In micro-USD (1 USD = 1_000_000). */
  max_cost_micro_usd: z.number().int().min(1).max(1_000_000_000_000),
});
export type BudgetGroupSpec = z.infer<typeof BudgetGroupSpec>;

export const BudgetGroupView = BudgetGroupSpec.extend({
  used_tokens: z.number().int().min(0),
  used_cost_micro_usd: z.number().int().min(0),
  reserved_tokens: z.number().int().min(0),
  reserved_cost_micro_usd: z.number().int().min(0),
  exhausted_at: IsoDateTime.nullable(),
});
export type BudgetGroupView = z.infer<typeof BudgetGroupView>;

/** What the work engine asks the admin API to mint. Everything that limits the key is here. */
export const VKeyMint = z.strictObject({
  scope: z.strictObject({ kind: VKeyScopeKind, ref: RefId }),
  project_id: ProjectId,
  /** Needed for a kill check by lane. */
  lane: Lane.optional(),
  /** The most sensitive data class this key may carry. D3 can be named, and is still never routed. */
  data_class_max: DataClass,
  /** Model ids (`GatewayModel.model_id`) the key may be served by. Empty: none (the key is useless). */
  models: z.array(z.string().min(1).max(64)).max(32),
  /** Tool names the key's holder may offer and use. Fixed at mint; nothing in a request widens it. */
  tools: z.array(z.string().min(1).max(128)).max(256),
  budget_group: RefId,
  expires_at: IsoDateTime,
  /** Where ET1 goes when the budget runs out. */
  item_id: z.string().min(1).max(128).optional(),
  unit_id: z.string().min(1).max(128).optional(),
  step: StepId.optional(),
});
export type VKeyMint = z.infer<typeof VKeyMint>;

/** What the admin API tells about a key. The secret itself is returned once, at mint, and never again. */
export const VKeyView = z.strictObject({
  vkey_id: z.string().min(1),
  scope: z.strictObject({ kind: VKeyScopeKind, ref: z.string() }),
  project_id: z.string(),
  lane: Lane.nullable(),
  data_class_max: DataClass,
  models: z.array(z.string()),
  tools: z.array(z.string()),
  budget_group: z.string(),
  expires_at: IsoDateTime,
  revoked_at: IsoDateTime.nullable(),
  item_id: z.string().nullable(),
  unit_id: z.string().nullable(),
  step: StepId.nullable(),
});
export type VKeyView = z.infer<typeof VKeyView>;

/** The secret of a virtual key: `aisk_` and 48 hex characters. Only its sha256 is stored. */
export const VKEY_SECRET_PATTERN = /^aisk_[0-9a-f]{48}$/;

// ---------------------------------------------------------------- 4. what the gateway records

export const GATEWAY_EVENT = {
  model_call: 'gateway.model_call',
  budget_exhausted: 'gateway.budget_exhausted',
  vkey_minted: 'gateway.vkey_minted',
  vkey_revoked: 'gateway.vkey_revoked',
} as const;
export type GatewayEventType = (typeof GATEWAY_EVENT)[keyof typeof GATEWAY_EVENT];

export const GATEWAY_STREAM_PREFIXES = ['gateway:'] as const;
export const gatewayVkeyStream = (vkeyId: string): string => `gateway:vkey:${vkeyId}`;
export const gatewayBudgetStream = (group: string): string => `gateway:budget:${group}`;
export const GATEWAY_ADMIN_STREAM = 'gateway:admin';

export const ModelCallOutcome = z.enum(['ok', 'refused', 'provider_error', 'tool_blocked']);
export type ModelCallOutcome = z.infer<typeof ModelCallOutcome>;

/** Why a call was refused (HTTP status in `GATEWAY_REFUSAL_STATUS` of the service). */
export const GatewayRefusal = z.enum([
  'key_revoked',
  'key_expired',
  'invalid_request',
  'spend_guard',
  'killed',
  'kill_switch_unreachable',
  'data_class_exceeds_key',
  'd3_never_routed',
  'no_route',
  'route_broken',
  'model_not_allowed',
  'tools_unsupported',
  'tool_not_allowed',
  'tool_not_allowed_in_response',
  'budget_exhausted',
  'budget_unknown',
  'metering_failed',
]);
export type GatewayRefusal = z.infer<typeof GatewayRefusal>;

/**
 * One call, as the record keeps it. NO prompt and NO output text: the two hashes bind the (redacted)
 * request the vendor saw and the response the sandbox got, and nothing else of either is kept.
 */
export const ModelCallPayload = z.strictObject({
  call_id: z.string().min(1),
  vkey_id: z.string().min(1),
  budget_group: z.string().min(1),
  project_id: z.string().min(1),
  item_id: z.string().nullable(),
  unit_id: z.string().nullable(),
  scope: z.strictObject({ kind: VKeyScopeKind, ref: z.string() }),
  environment: GatewayEnvironment,
  data_class: DataClass,
  provider_id: z.string().nullable(),
  model_id: z.string().nullable(),
  request_hash: Sha256Hex.nullable(),
  response_hash: Sha256Hex.nullable(),
  tokens_in: z.number().int().min(0),
  tokens_out: z.number().int().min(0),
  cost_micro_usd: z.number().int().min(0),
  latency_ms: z.number().int().min(0),
  outcome: ModelCallOutcome,
  refusal: GatewayRefusal.nullable(),
  /** How many values secrets-rules replaced in what left for the vendor. */
  redactions: z.number().int().min(0),
});
export type ModelCallPayload = z.infer<typeof ModelCallPayload>;

/**
 * ET1 (budget 100%): the budget group is spent. Core observes it and fires `item.trigger_fired` for the
 * item, which the interpreter turns into a D1 handoff (the ET table's effect of ET1 at S6).
 */
export const BudgetExhaustedPayload = z.strictObject({
  trigger: z.literal('ET1'),
  budget_group: z.string().min(1),
  vkey_id: z.string().min(1),
  project_id: z.string().min(1),
  item_id: z.string().nullable(),
  unit_id: z.string().nullable(),
  step: StepId.nullable(),
  /** Which hard stop was hit. */
  limit: z.enum(['tokens', 'cost']),
  used_tokens: z.number().int().min(0),
  max_tokens: z.number().int().min(1),
  used_cost_micro_usd: z.number().int().min(0),
  max_cost_micro_usd: z.number().int().min(1),
});
export type BudgetExhaustedPayload = z.infer<typeof BudgetExhaustedPayload>;

export const VKeyMintedPayload = z.strictObject({
  vkey_id: z.string().min(1),
  scope: z.strictObject({ kind: VKeyScopeKind, ref: z.string() }),
  project_id: z.string().min(1),
  budget_group: z.string().min(1),
  data_class_max: DataClass,
  models: z.array(z.string()),
  tools: z.array(z.string()),
  expires_at: IsoDateTime,
  item_id: z.string().nullable(),
  unit_id: z.string().nullable(),
  minted_by: z.string().min(1),
});
export type VKeyMintedPayload = z.infer<typeof VKeyMintedPayload>;
