import { BudgetGroupView, VKeyView, type BudgetGroupSpec, type VKeyMint } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { callJson } from '@aisdlc/service-kit';
import { z } from 'zod';

// The admin API as the work engine (core) calls it: mint a per-Unit key and its budget, revoke it.
// Core never sees a vendor key, and the secret of a virtual key it mints goes to the sandbox and is
// not kept.

export interface GatewayAdminClientOptions {
  baseUrl: string;
  /** This caller's service token (scope `admin` to write, `read` to read). */
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GatewayClientError {
  readonly code: string;
  readonly message: string;
  /** 0: the gateway was not reached. */
  readonly status: number;
}

const Minted = z.object({ vkey: VKeyView, key: z.string().min(1) });
const ReloadView = z.object({
  revision: z.string().nullable(),
  integrations: z.array(
    z.object({
      integration_id: z.string(),
      adapter: z.string(),
      state: z.enum(['built', 'refused']),
      detail: z.string(),
    }),
  ),
});
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export class GatewayAdminClient {
  constructor(private readonly o: GatewayAdminClientOptions) {}

  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: S,
  ): Promise<Result<z.infer<S>, GatewayClientError>> {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
      timeoutMs: this.o.timeoutMs ?? 5_000,
    });
    if (!r.reached) return err({ code: 'unavailable', message: r.message, status: 0 });
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

  /** Idempotent: a second create with the same limits answers 200 with the group as it stands. */
  createBudgetGroup(spec: BudgetGroupSpec) {
    return this.call('POST', '/v1/admin/budget-groups', spec, BudgetGroupView);
  }
  budgetGroup(id: string) {
    return this.call(
      'GET',
      `/v1/admin/budget-groups/${encodeURIComponent(id)}`,
      undefined,
      BudgetGroupView,
    );
  }
  /** The secret comes back here once. */
  mintVKey(mint: VKeyMint) {
    return this.call('POST', '/v1/admin/vkeys', mint, Minted);
  }
  vkey(id: string) {
    return this.call('GET', `/v1/admin/vkeys/${encodeURIComponent(id)}`, undefined, VKeyView);
  }
  /** Re-reads the published config and rebuilds the adapters that changed (`force`: all of them). */
  reload(force = false) {
    return this.call('POST', '/v1/admin/reload', { force }, ReloadView);
  }
  integrations() {
    return this.call('GET', '/v1/admin/integrations', undefined, ReloadView);
  }
  revokeVKey(id: string) {
    return this.call('POST', `/v1/admin/vkeys/${encodeURIComponent(id)}/revoke`, {}, VKeyView);
  }
}
