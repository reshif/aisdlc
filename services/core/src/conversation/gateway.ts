import { BudgetGroupView, VKeyView, type BudgetGroupSpec, type VKeyMint } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { callJson } from '@aisdlc/service-kit';
import { z } from 'zod';
import type { GatewayKeyClient } from '../agent-keys.js';
import type { AssistantBudgetPort } from './assistant.js';

// The model gateway's admin API as the assistant uses it (M18): create the day budget group, mint and revoke the
// per-ask key (`GatewayAgentKeys` over this client) and read the group's spend. Core's own small client, so the core
// bundle does not pull in the gateway service; the routes and shapes are the gateway's (docs/specs/gateway-api.md §3).

export interface GatewayAdminHttpOptions {
  readonly baseUrl: string;
  /** Core's service token at the gateway (scopes `admin` and `read`). */
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

type Failure = { readonly code: string; readonly message: string; readonly status: number };
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const Minted = z.object({ vkey: VKeyView, key: z.string().min(1) });

export class GatewayAdminHttp implements GatewayKeyClient, AssistantBudgetPort {
  constructor(private readonly o: GatewayAdminHttpOptions) {}

  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: S,
  ): Promise<Result<z.infer<S>, Failure>> {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
      timeoutMs: this.o.timeoutMs ?? 5_000,
    });
    if (!r.reached)
      return err({ code: 'unavailable', message: 'the gateway did not answer', status: 0 });
    if (r.status < 200 || r.status > 299) {
      const e = ErrorBody.safeParse(r.json);
      return err({
        code: e.success ? e.data.error.code : 'unavailable',
        message: e.success ? e.data.error.message : `HTTP ${r.status}`,
        status: r.status,
      });
    }
    const p = schema.safeParse(r.json);
    return p.success
      ? ok(p.data)
      : err({ code: 'unavailable', message: 'malformed gateway response', status: r.status });
  }

  createBudgetGroup(spec: BudgetGroupSpec) {
    return this.call('POST', '/v1/admin/budget-groups', spec, BudgetGroupView);
  }

  mintVKey(mint: VKeyMint) {
    return this.call('POST', '/v1/admin/vkeys', mint, Minted);
  }

  revokeVKey(id: string) {
    return this.call('POST', `/v1/admin/vkeys/${encodeURIComponent(id)}/revoke`, {}, VKeyView);
  }

  async view(group_id: string): Promise<Result<BudgetGroupView | null, { readonly code: string }>> {
    const r = await this.call(
      'GET',
      `/v1/admin/budget-groups/${encodeURIComponent(group_id)}`,
      undefined,
      BudgetGroupView,
    );
    if (r.ok) return ok(r.value);
    return r.error.status === 404 ? ok(null) : err({ code: r.error.code });
  }
}

/** The gateway's own client (`GatewayAdminClient.budgetGroup`) as the budget port: tests and core-worker pass it. */
export function budgetFromClient(client: {
  budgetGroup(
    id: string,
  ): Promise<Result<BudgetGroupView, { readonly code: string; readonly status: number }>>;
}): AssistantBudgetPort {
  return {
    async view(id) {
      const r = await client.budgetGroup(id);
      if (r.ok) return ok(r.value);
      return r.error.status === 404 ? ok(null) : err({ code: r.error.code });
    },
  };
}
