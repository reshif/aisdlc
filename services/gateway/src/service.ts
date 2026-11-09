import {
  BudgetExhaustedPayload,
  BudgetGroupSpec,
  GATEWAY_ADMIN_STREAM,
  GATEWAY_EVENT,
  ModelCallPayload,
  ModelCompleteRequest,
  ModelTextBlock,
  VKeyMint,
  VKeyMintedPayload,
  gatewayBudgetStream,
  gatewayVkeyStream,
  type BudgetGroupView,
  type DataClass,
  type GatewayEnvironment,
  type GatewayModel,
  type GatewayRefusal,
  type JsonObject,
  type ModelCallOutcome,
  type ModelCompleteResponse,
  type VKeyView,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import {
  err,
  hashCanonical,
  newId,
  ok,
  systemClock,
  type Clock,
  type Result,
} from '@aisdlc/kernel';
import {
  admitAgentWork,
  modelProviderError,
  type KillStatePort,
  type ModelProviderPort,
} from '@aisdlc/ports';
import { appendEvents } from '@aisdlc/record';
import type pg from 'pg';
import { z } from 'zod';
import { redactRequest } from './redact.js';
import { resolveRoute, type ConfigSource } from './routes.js';
import {
  addReservation,
  findVKey,
  findVKeyBySecret,
  getBudgetGroup,
  hashVKeySecret,
  insertBudgetGroup,
  insertVKey,
  markExhausted,
  newVKeySecret,
  revokeVKey,
  settleUsage,
  vkeyView,
  type VKeyRow,
} from './store.js';

// The gateway's decisions (PLAN M10.2, M10.3). Every model call of the factory passes through
// `complete`, in this order, and the first thing that fails refuses the call (nothing is ever
// "let through because the check could not run"):
//
//   key (known, not revoked, not expired) -> body -> process spend guard -> kill switch -> data class
//   (never above the key's, D3 never routed) -> route -> the key's model allow-list -> tool allow-list
//   (the key's, never the request's) -> redaction -> budget reservation (hard stop) -> the vendor ->
//   the response's tools against the allow-list -> settlement and the ModelCall event, in ONE
//   transaction.
//
// A call is recorded as a `gateway.model_call` event whatever its outcome (a refusal included, once
// the key is known), with hashes and counts and no text. The vendor key is never in this file: the
// adapters hold it.

const ORDER: Record<DataClass, number> = { D0: 0, D1: 1, D2: 2, D3: 3 };

export interface GatewayFailure {
  /** HTTP status. */
  readonly status: number;
  readonly code: GatewayRefusal | 'unauthenticated' | 'provider_error';
  readonly message: string;
  /** Anthropic's error type, for a client that parses it. */
  readonly type:
    | 'invalid_request_error'
    | 'authentication_error'
    | 'permission_error'
    | 'rate_limit_error'
    | 'api_error';
}

const REFUSAL: Record<GatewayRefusal, [number, GatewayFailure['type']]> = {
  key_revoked: [401, 'authentication_error'],
  key_expired: [401, 'authentication_error'],
  invalid_request: [400, 'invalid_request_error'],
  spend_guard: [503, 'api_error'],
  killed: [423, 'permission_error'],
  kill_switch_unreachable: [503, 'api_error'],
  data_class_exceeds_key: [403, 'permission_error'],
  d3_never_routed: [403, 'permission_error'],
  no_route: [403, 'permission_error'],
  route_broken: [503, 'api_error'],
  model_not_allowed: [403, 'permission_error'],
  tools_unsupported: [400, 'invalid_request_error'],
  tool_not_allowed: [403, 'permission_error'],
  tool_not_allowed_in_response: [502, 'api_error'],
  budget_exhausted: [429, 'rate_limit_error'],
  budget_unknown: [403, 'permission_error'],
  metering_failed: [503, 'api_error'],
};

const failure = (code: GatewayRefusal, message: string): GatewayFailure => {
  const [status, type] = REFUSAL[code];
  return { status, code, message, type };
};

/** The wire form of a Messages request: ours, plus what Anthropic's clients also send. */
const MessagesWire = ModelCompleteRequest.omit({ metadata: true }).extend({
  system: z.union([z.string(), z.array(ModelTextBlock)]).optional(),
  stream: z.boolean().optional(),
});

export interface MessagesResponse {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'assistant';
  readonly model: string;
  readonly content: ModelCompleteResponse['content'];
  readonly stop_reason: ModelCompleteResponse['stop_reason'];
  readonly stop_sequence: null;
  readonly usage: ModelCompleteResponse['usage'];
}

export interface GatewayDeps {
  readonly pool: pg.Pool;
  readonly config: ConfigSource;
  /** The adapters this process holds, by `provider_id`. Only these can ever be reached. */
  readonly adapters: ReadonlyMap<string, ModelProviderPort>;
  readonly kill: KillStatePort;
  readonly environment: GatewayEnvironment;
  /** The hard ceiling of calls that may reach a vendor in this process (`GATEWAY_MAX_PROVIDER_CALLS`). */
  readonly maxProviderCalls: number;
  readonly clock?: Clock;
}

interface CallCtx {
  readonly call_id: string;
  readonly key: VKeyRow;
  readonly started: number;
  data_class: DataClass;
  provider_id: string | null;
  model_id: string | null;
  request_hash: string | null;
  redactions: number;
}

export class GatewayService {
  private readonly clock: Clock;
  /** Calls that reached a vendor in this process. Never reset: a restart is the only way to more. */
  private providerCalls = 0;

  constructor(private readonly d: GatewayDeps) {
    if (!Number.isInteger(d.maxProviderCalls) || d.maxProviderCalls < 0) {
      throw new RangeError('maxProviderCalls must be a non-negative integer');
    }
    this.clock = d.clock ?? systemClock;
  }

  get providerCallCount(): number {
    return this.providerCalls;
  }

  // ------------------------------------------------------------ admin: budget groups and keys

  async createBudgetGroup(
    raw: unknown,
  ): Promise<Result<{ group: BudgetGroupView; created: boolean }, GatewayFailure>> {
    const spec = BudgetGroupSpec.safeParse(raw);
    if (!spec.success) return err(failure('invalid_request', spec.error.message));
    const created = await insertBudgetGroup(this.d.pool, spec.data, this.clock.now().toISOString());
    const group = (await getBudgetGroup(this.d.pool, spec.data.group_id)) as BudgetGroupView;
    if (
      !created &&
      (group.max_tokens !== spec.data.max_tokens ||
        group.max_cost_micro_usd !== spec.data.max_cost_micro_usd)
    ) {
      return err(failure('invalid_request', 'the budget group exists with other limits'));
    }
    return ok({ group, created });
  }

  async budgetGroup(id: string): Promise<BudgetGroupView | null> {
    return getBudgetGroup(this.d.pool, id);
  }

  /** Mints a key. The secret is in the result and nowhere else, ever. */
  async mintVKey(
    raw: unknown,
    mintedBy: string,
  ): Promise<Result<{ vkey: VKeyView; key: string }, GatewayFailure>> {
    const m = VKeyMint.safeParse(raw);
    if (!m.success) return err(failure('invalid_request', m.error.message));
    const now = this.clock.now();
    if (new Date(m.data.expires_at).getTime() <= now.getTime()) {
      return err(failure('invalid_request', 'expires_at is in the past'));
    }
    if (!(await getBudgetGroup(this.d.pool, m.data.budget_group))) {
      return err(failure('budget_unknown', `no budget group ${m.data.budget_group}`));
    }
    const secret = newVKeySecret();
    const vkey_id = newId<'VKey'>();
    const row = {
      vkey_id,
      key_hash: hashVKeySecret(secret),
      scope: m.data.scope,
      project_id: m.data.project_id,
      lane: m.data.lane ?? null,
      data_class_max: m.data.data_class_max,
      models: [...new Set(m.data.models)],
      tools: [...new Set(m.data.tools)],
      budget_group: m.data.budget_group,
      item_id: m.data.item_id ?? null,
      unit_id: m.data.unit_id ?? null,
      step: m.data.step ?? null,
      expires_at: m.data.expires_at,
      created_at: now.toISOString(),
      minted_by: mintedBy,
    };
    try {
      await withTransaction(this.d.pool, async (tx) => {
        await insertVKey(tx, row);
        await this.append(
          tx,
          GATEWAY_ADMIN_STREAM,
          GATEWAY_EVENT.vkey_minted,
          VKeyMintedPayload.parse({
            vkey_id,
            scope: row.scope,
            project_id: row.project_id,
            budget_group: row.budget_group,
            data_class_max: row.data_class_max,
            models: row.models,
            tools: row.tools,
            expires_at: row.expires_at,
            item_id: row.item_id,
            unit_id: row.unit_id,
            minted_by: mintedBy,
          }) as unknown as JsonObject,
          `vkey.minted:${vkey_id}`,
        );
      });
    } catch {
      return err(failure('metering_failed', 'the key could not be recorded'));
    }
    const stored = (await findVKey(this.d.pool, vkey_id)) as VKeyRow;
    return ok({ vkey: vkeyView(stored), key: secret });
  }

  async vkey(id: string): Promise<VKeyView | null> {
    const r = await findVKey(this.d.pool, id);
    return r ? vkeyView(r) : null;
  }

  async revoke(id: string, by: string): Promise<VKeyView | null> {
    const at = this.clock.now().toISOString();
    return withTransaction(this.d.pool, async (tx) => {
      const before = await findVKey(tx, id);
      if (!before) return null;
      const r = (await revokeVKey(tx, id, at)) as VKeyRow;
      if (before.revoked_at === null) {
        await this.append(
          tx,
          GATEWAY_ADMIN_STREAM,
          GATEWAY_EVENT.vkey_revoked,
          { vkey_id: id, revoked_by: by },
          `vkey.revoked:${id}`,
        );
      }
      return vkeyView(r);
    });
  }

  // ------------------------------------------------------------ the call path

  async complete(
    secret: string,
    body: unknown,
    dataClassHeader?: string,
  ): Promise<Result<MessagesResponse, GatewayFailure>> {
    const key = VKEY_SHAPE.test(secret) ? await findVKeyBySecret(this.d.pool, secret) : null;
    // An unknown key is not a caller we can attribute: refused, and not recorded (no flooding the record).
    if (!key) {
      return err({
        status: 401,
        code: 'unauthenticated',
        type: 'authentication_error',
        message: 'invalid virtual key',
      });
    }
    const ctx: CallCtx = {
      call_id: newId<'ModelCall'>(),
      key,
      started: performance.now(),
      data_class: key.data_class_max,
      provider_id: null,
      model_id: null,
      request_hash: null,
      redactions: 0,
    };
    // The ceiling is taken at the check, not at the vendor call, so calls in flight together cannot
    // pass it between them; a call refused before it reaches the vendor gives its slot back.
    let slot = false;
    const refuse = async (
      code: GatewayRefusal,
      message: string,
    ): Promise<Result<never, GatewayFailure>> => {
      if (slot) this.providerCalls -= 1;
      slot = false;
      await this.recordRefusal(ctx, code);
      return err(failure(code, message));
    };

    if (key.revoked_at !== null) return refuse('key_revoked', 'this key is revoked');
    if (key.expires_at.getTime() <= this.clock.now().getTime()) {
      return refuse('key_expired', 'this key has expired');
    }

    const wire = MessagesWire.safeParse(body);
    if (!wire.success) {
      return refuse(
        'invalid_request',
        wire.error.issues
          .map((i) => i.message)
          .join('; ')
          .slice(0, 300),
      );
    }
    if (wire.data.stream === true) {
      return refuse('invalid_request', 'streaming is not supported by this gateway yet');
    }
    if (dataClassHeader !== undefined) {
      const dc = z.enum(['D0', 'D1', 'D2', 'D3']).safeParse(dataClassHeader);
      if (!dc.success) return refuse('invalid_request', 'x-aisdlc-data-class is D0, D1, D2 or D3');
      ctx.data_class = dc.data;
    }

    if (this.providerCalls >= this.d.maxProviderCalls) {
      return refuse('spend_guard', 'this gateway process reached its provider call ceiling');
    }
    this.providerCalls += 1;
    slot = true;

    const scopeQuery = {
      project_id: key.project_id,
      ...(key.lane ? { lane: key.lane } : {}),
      ...(key.scope.kind === 'session' ? { session_id: key.scope.ref } : {}),
    };
    const admitted = await admitAgentWork(this.d.kill, scopeQuery);
    if (!admitted.admitted) {
      return refuse(
        admitted.why === 'killed' ? 'killed' : 'kill_switch_unreachable',
        admitted.message,
      );
    }

    if (ORDER[ctx.data_class] > ORDER[key.data_class_max]) {
      return refuse('data_class_exceeds_key', `this key carries up to ${key.data_class_max}`);
    }
    const route = resolveRoute(this.d.config, this.d.adapters, this.d.environment, ctx.data_class);
    if (!route.ok) return refuse(route.refusal, route.message);
    ctx.provider_id = route.provider_id;
    ctx.model_id = route.model.model_id;
    if (!key.models.includes(route.model.model_id)) {
      return refuse('model_not_allowed', `this key may not use ${route.model.model_id}`);
    }

    // The allow-list is the key's. Nothing in the request (text, a tool list, a forced tool choice,
    // an earlier tool call in the history) can add to it: a request that names a tool outside it is
    // refused as a whole, never trimmed.
    const w = wire.data;
    const named = new Set<string>();
    for (const t of w.tools ?? []) named.add(t.name);
    if (w.tool_choice?.type === 'tool') named.add(w.tool_choice.name);
    for (const m of w.messages) {
      if (typeof m.content !== 'string') {
        for (const b of m.content) if (b.type === 'tool_use') named.add(b.name);
      }
    }
    const allowed = new Set(key.tools);
    const outside = [...named].filter((n) => !allowed.has(n)).sort();
    if (outside.length > 0) {
      return refuse(
        'tool_not_allowed',
        `tools outside this key's allow-list: ${outside.join(', ')}`,
      );
    }
    if (named.size > 0 && !route.model.tools_capable) {
      return refuse('tools_unsupported', `${route.model.model_id} does not take tools`);
    }

    const metadata: Record<string, string> = { vkey_id: key.vkey_id };
    if (key.unit_id) metadata['unit_id'] = key.unit_id;
    if (key.item_id) metadata['item_id'] = key.item_id;
    const system =
      typeof w.system === 'string' ? w.system : w.system?.map((b) => b.text).join('\n\n');
    const asked: ModelCompleteRequest = {
      model: route.model.provider_model,
      ...(system === undefined ? {} : { system }),
      messages: w.messages,
      max_tokens: Math.min(w.max_tokens, route.model.max_tokens_cap),
      ...(w.tools ? { tools: w.tools } : {}),
      ...(w.tool_choice ? { tool_choice: w.tool_choice } : {}),
      ...(w.temperature === undefined ? {} : { temperature: w.temperature }),
      ...(w.stop_sequences ? { stop_sequences: w.stop_sequences } : {}),
      metadata,
    };
    const redacted = redactRequest(asked);
    ctx.redactions = redacted.redactions;
    ctx.request_hash = hashCanonical(withoutMetadata(redacted.request));

    const reserved = await this.reserve(ctx, route.model, redacted.request);
    if (!reserved.ok) return refuse(reserved.refusal, reserved.message);

    // From here a vendor call is made: its slot stays taken whatever the vendor answers.
    slot = false;
    const sent: ModelCompleteRequest = { ...redacted.request, max_tokens: reserved.max_tokens };
    let reply: Awaited<ReturnType<ModelProviderPort['complete']>>;
    try {
      reply = await route.provider.complete(sent);
    } catch {
      reply = err(modelProviderError('unavailable', 'the adapter failed'));
    }

    if (!reply.ok) {
      const settled = await this.settle(
        ctx,
        reserved,
        route.model,
        { in: 0, out: 0 },
        {
          outcome: 'provider_error',
          refusal: null,
          response_hash: null,
        },
      );
      if (!settled.ok) return settled;
      const e = reply.error;
      return err({
        status: e.code === 'rate_limited' ? 429 : e.code === 'invalid_request' ? 400 : 502,
        code: 'provider_error',
        type:
          e.code === 'rate_limited'
            ? 'rate_limit_error'
            : e.code === 'invalid_request'
              ? 'invalid_request_error'
              : 'api_error',
        message: `the model provider failed (${e.code})`,
      });
    }

    const out = reply.value;
    const blocked = out.content.flatMap((b) =>
      b.type === 'tool_use' && !allowed.has(b.name) ? [b.name] : [],
    );
    const usage = { in: out.usage.input_tokens, out: out.usage.output_tokens };
    if (blocked.length > 0) {
      const settled = await this.settle(ctx, reserved, route.model, usage, {
        outcome: 'tool_blocked',
        refusal: 'tool_not_allowed_in_response',
        response_hash: null,
      });
      if (!settled.ok) return settled;
      return err(
        failure(
          'tool_not_allowed_in_response',
          `the model asked for a tool outside this key's allow-list: ${[...new Set(blocked)].sort().join(', ')}`,
        ),
      );
    }
    const settled = await this.settle(ctx, reserved, route.model, usage, {
      outcome: 'ok',
      refusal: null,
      response_hash: hashCanonical(out.content),
    });
    if (!settled.ok) return settled;
    return ok({
      id: out.id,
      type: 'message',
      role: 'assistant',
      model: route.model.model_id,
      content: out.content,
      stop_reason: out.stop_reason,
      stop_sequence: null,
      usage: out.usage,
    });
  }

  // ------------------------------------------------------------ budget

  /**
   * The hard stop, before the vendor. Under the group's row lock: no room for even one output token
   * (counting what calls in flight may still spend) refuses the call; a spent group raises ET1 once.
   * The call's output is clamped to what the group can still pay for, in tokens and in cost.
   */
  private async reserve(
    ctx: CallCtx,
    model: GatewayModel,
    req: ModelCompleteRequest,
  ): Promise<
    | { ok: true; max_tokens: number; tokens: number; costMicro: number }
    | { ok: false; refusal: GatewayRefusal; message: string }
  > {
    const now = this.clock.now().toISOString();
    const estIn = Math.ceil(JSON.stringify(withoutMetadata(req)).length / 3);
    try {
      return await withTransaction(this.d.pool, async (tx) => {
        const g = await getBudgetGroup(tx, ctx.key.budget_group, true);
        if (!g) {
          return {
            ok: false as const,
            refusal: 'budget_unknown' as const,
            message: 'no budget group',
          };
        }
        const spent =
          g.used_tokens >= g.max_tokens || g.used_cost_micro_usd >= g.max_cost_micro_usd;
        if (g.exhausted_at !== null || spent) {
          if (g.exhausted_at === null) await markExhausted(tx, g.group_id, now);
          await this.raiseEt1(tx, ctx.key, g);
          return {
            ok: false as const,
            refusal: 'budget_exhausted' as const,
            message: 'the budget is spent',
          };
        }
        const availTokens = g.max_tokens - g.used_tokens - g.reserved_tokens;
        const availCost = g.max_cost_micro_usd - g.used_cost_micro_usd - g.reserved_cost_micro_usd;
        // $ per Mtok is micro-USD per token, so a price is the cost of one token in micro-USD.
        const costIn = estIn * model.usd_in_per_mtok;
        const byTokens = availTokens - estIn;
        const byCost =
          model.usd_out_per_mtok > 0
            ? Math.floor((availCost - costIn) / model.usd_out_per_mtok)
            : Number.POSITIVE_INFINITY;
        const max_tokens = Math.min(req.max_tokens, model.max_tokens_cap, byTokens, byCost);
        if (!(max_tokens >= 1)) {
          // Nothing in flight could free room: the group is spent for any call this size.
          if (g.reserved_tokens === 0 && g.reserved_cost_micro_usd === 0) {
            await markExhausted(tx, g.group_id, now);
            await this.raiseEt1(tx, ctx.key, { ...g, exhausted_at: now });
          }
          return {
            ok: false as const,
            refusal: 'budget_exhausted' as const,
            message: 'the budget cannot pay for this call',
          };
        }
        const tokens = estIn + max_tokens;
        const costMicro = Math.ceil(costIn + max_tokens * model.usd_out_per_mtok);
        await addReservation(tx, g.group_id, tokens, costMicro);
        return { ok: true as const, max_tokens, tokens, costMicro };
      });
    } catch {
      return { ok: false, refusal: 'metering_failed', message: 'the budget could not be checked' };
    }
  }

  /** Settles the call: usage, release of the reservation, the ModelCall event, and ET1 if it ran the budget out. */
  private async settle(
    ctx: CallCtx,
    reserved: { tokens: number; costMicro: number },
    model: GatewayModel,
    usage: { in: number; out: number },
    result: {
      outcome: ModelCallOutcome;
      refusal: GatewayRefusal | null;
      response_hash: string | null;
    },
  ): Promise<Result<true, GatewayFailure>> {
    const tokens = usage.in + usage.out;
    const costMicro = Math.ceil(
      usage.in * model.usd_in_per_mtok + usage.out * model.usd_out_per_mtok,
    );
    const now = this.clock.now().toISOString();
    try {
      await withTransaction(this.d.pool, async (tx) => {
        const before = await getBudgetGroup(tx, ctx.key.budget_group, true);
        const after = await settleUsage(
          tx,
          ctx.key.budget_group,
          reserved,
          { tokens, costMicro },
          now,
        );
        await this.appendCall(tx, ctx, {
          tokens_in: usage.in,
          tokens_out: usage.out,
          cost_micro_usd: costMicro,
          outcome: result.outcome,
          refusal: result.refusal,
          response_hash: result.response_hash,
        });
        if (after.exhausted_at !== null && before?.exhausted_at === null) {
          await this.raiseEt1(tx, ctx.key, after);
        }
      });
      return ok(true);
    } catch {
      // Not metered means not delivered: the reservation is released best-effort and the output is dropped.
      await withTransaction(this.d.pool, (tx) =>
        settleUsage(tx, ctx.key.budget_group, reserved, { tokens, costMicro }, now),
      ).catch(() => undefined);
      return err(failure('metering_failed', 'the call could not be metered'));
    }
  }

  // ------------------------------------------------------------ recording

  private async raiseEt1(tx: pg.PoolClient, key: VKeyRow, g: BudgetGroupView): Promise<void> {
    const limit = g.used_cost_micro_usd >= g.max_cost_micro_usd ? 'cost' : 'tokens';
    const payload = BudgetExhaustedPayload.parse({
      trigger: 'ET1',
      budget_group: g.group_id,
      vkey_id: key.vkey_id,
      project_id: key.project_id,
      item_id: key.item_id,
      unit_id: key.unit_id,
      step: key.step,
      limit,
      used_tokens: g.used_tokens,
      max_tokens: g.max_tokens,
      used_cost_micro_usd: g.used_cost_micro_usd,
      max_cost_micro_usd: g.max_cost_micro_usd,
    });
    // Once per group, however many calls find it spent.
    await this.append(
      tx,
      gatewayBudgetStream(g.group_id),
      GATEWAY_EVENT.budget_exhausted,
      payload as unknown as JsonObject,
      `et1:${g.group_id}`,
    );
  }

  private async recordRefusal(ctx: CallCtx, code: GatewayRefusal): Promise<void> {
    try {
      await withTransaction(this.d.pool, (tx) =>
        this.appendCall(tx, ctx, {
          tokens_in: 0,
          tokens_out: 0,
          cost_micro_usd: 0,
          outcome: 'refused',
          refusal: code,
          response_hash: null,
        }),
      );
    } catch {
      // A refusal that cannot be written down is still a refusal.
    }
  }

  private async appendCall(
    tx: pg.PoolClient,
    ctx: CallCtx,
    r: Pick<
      ModelCallPayload,
      'tokens_in' | 'tokens_out' | 'cost_micro_usd' | 'outcome' | 'refusal' | 'response_hash'
    >,
  ): Promise<void> {
    const payload = ModelCallPayload.parse({
      call_id: ctx.call_id,
      vkey_id: ctx.key.vkey_id,
      budget_group: ctx.key.budget_group,
      project_id: ctx.key.project_id,
      item_id: ctx.key.item_id,
      unit_id: ctx.key.unit_id,
      scope: ctx.key.scope,
      environment: this.d.environment,
      data_class: ctx.data_class,
      provider_id: ctx.provider_id,
      model_id: ctx.model_id,
      request_hash: ctx.request_hash,
      latency_ms: Math.max(0, Math.round(performance.now() - ctx.started)),
      redactions: ctx.redactions,
      ...r,
    });
    await this.append(
      tx,
      gatewayVkeyStream(ctx.key.vkey_id),
      GATEWAY_EVENT.model_call,
      payload as unknown as JsonObject,
      `call:${ctx.call_id}`,
    );
  }

  private async append(
    tx: pg.PoolClient,
    stream: string,
    type: string,
    body: JsonObject,
    idempotency_key: string,
  ): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const head = await tx.query<{ seq: string }>(
        'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
        [stream],
      );
      const r = await appendEvents(
        tx,
        stream,
        Number(head.rows[0]?.seq ?? 0),
        [{ type, body, actor: 'system.gateway', idempotency_key }],
        { clock: this.clock },
      );
      if (r.ok) return;
      if (r.error._tag !== 'ConcurrencyConflict') {
        throw new Error(`record append refused: ${r.error._tag}`);
      }
    }
    throw new Error('record append: too many conflicts');
  }
}

/** What the vendor is asked, less our own bookkeeping (ids): the part a hash and an estimate are about. */
function withoutMetadata(r: ModelCompleteRequest): Omit<ModelCompleteRequest, 'metadata'> {
  const { metadata, ...rest } = r;
  void metadata;
  return rest;
}

const VKEY_SHAPE = /^aisk_[0-9a-f]{48}$/;
