import type { BudgetGroupSpec, VKeyMint, VKeyView } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { agentKeyError, type AgentKey, type AgentKeyError, type AgentKeyPort } from '@aisdlc/ports';

// The real adapter of `AgentKeyPort` (PLAN M11.2): the model gateway's admin API, as the work engine
// calls it (`GatewayAdminClient` of `@aisdlc/gateway/client`, taken structurally so core's code does not
// import the gateway). Core's service token has scope `admin` there; it can mint keys and budget groups
// and nothing else, and it never sees a vendor key.

/** The two admin calls this adapter makes: `GatewayAdminClient` satisfies it. */
export interface GatewayKeyClient {
  createBudgetGroup(
    spec: BudgetGroupSpec,
  ): Promise<Result<unknown, { readonly code: string; readonly message: string }>>;
  revokeVKey?(
    id: string,
  ): Promise<Result<unknown, { readonly code: string; readonly message: string }>>;
  mintVKey(
    mint: VKeyMint,
  ): Promise<
    Result<
      { readonly vkey: VKeyView; readonly key: string },
      { readonly code: string; readonly message: string }
    >
  >;
}

export class GatewayAgentKeys implements AgentKeyPort {
  constructor(
    private readonly client: GatewayKeyClient,
    private readonly o: {
      /**
       * Model ids the deployment's ROUTES serve that an agent contract does not name (the local
       * deployment routes every class to the deterministic `fake-model`). Added to the key's `models`;
       * the key's tools, data class and budget are never touched.
       */
      readonly extraModels?: readonly string[];
    } = {},
  ) {}

  async mint(req: Parameters<AgentKeyPort['mint']>[0]): Promise<Result<AgentKey, AgentKeyError>> {
    // creating the group is idempotent: the same limits answer 200 with the group as it stands
    const g = await this.client.createBudgetGroup(req.budget);
    if (!g.ok) return err(agentKeyError(g.error.code, g.error.message));
    const models = [...new Set([...req.mint.models, ...(this.o.extraModels ?? [])])];
    const m = await this.client.mintVKey({ ...req.mint, models });
    if (!m.ok) return err(agentKeyError(m.error.code, m.error.message));
    return ok({ vkey: m.value.vkey, secret: m.value.key });
  }

  async revoke(vkey_id: string): Promise<Result<void, AgentKeyError>> {
    if (!this.client.revokeVKey) return ok(undefined);
    const r = await this.client.revokeVKey(vkey_id);
    return r.ok ? ok(undefined) : err(agentKeyError(r.error.code, r.error.message));
  }
}
