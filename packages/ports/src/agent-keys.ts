import { BudgetGroupSpec, VKeyMint, VKeyView } from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// The agent key port (PLAN M11.2): how the work driver gets a per-Unit virtual key for an agent-acted
// stage command. The real adapter calls the model gateway's admin API (`POST /v1/admin/budget-groups`,
// `POST /v1/admin/vkeys`); core never sees a vendor key, and the secret of the virtual key it mints is
// handed to whoever runs the agent (the sandbox, M13) and is NOT kept or recorded by the engine. The
// fake is deterministic and checks the request against the same contract, so a test with it cannot mint
// something the gateway would refuse. Fail closed: no key, no agent run.

export const AgentKeyError = taggedError('AgentKeyError');
export type AgentKeyError = TaggedError<'AgentKeyError', { code: string; message: string }>;
export const agentKeyError = (code: string, message: string): AgentKeyError =>
  AgentKeyError({ code, message });

/** What is asked: the Unit's (or job's) budget group and the key on it. Everything that limits the key is in it. */
export interface AgentKeyRequest {
  readonly budget: BudgetGroupSpec;
  readonly mint: VKeyMint;
}

export interface AgentKey {
  readonly vkey: VKeyView;
  /** The key's secret, once. The caller passes it on and drops it. */
  readonly secret: string;
}

export interface AgentKeyPort {
  mint(req: AgentKeyRequest): Promise<Result<AgentKey, AgentKeyError>>;
}

/**
 * Deterministic fake. It validates the request with the gateway's own contracts, mints ids in order
 * (`fake-vkey-1`, ...) and keeps what it minted. A key it minted has exactly the tools, models, data
 * class and budget of its request: `view()` returns copies, so nothing a caller holds can widen it.
 */
export class FakeAgentKeys implements AgentKeyPort {
  readonly requests: AgentKeyRequest[] = [];
  private readonly keys = new Map<string, VKeyView>();
  private down = false;
  private refuse: string | null = null;

  /** The service is unreachable: every mint is an error and nothing is minted. */
  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  /** The service refuses every mint with this code (a spent fleet budget, a kill...). */
  refuseWith(code: string | null): this {
    this.refuse = code;
    return this;
  }

  async mint(req: AgentKeyRequest): Promise<Result<AgentKey, AgentKeyError>> {
    if (this.down) return err(agentKeyError('unavailable', 'the gateway did not answer'));
    if (this.refuse) return err(agentKeyError(this.refuse, 'the gateway refused the key'));
    const budget = BudgetGroupSpec.safeParse(req.budget);
    const mint = VKeyMint.safeParse(req.mint);
    if (!budget.success || !mint.success) {
      return err(agentKeyError('invalid_request', 'the request is not a valid key request'));
    }
    if (mint.data.budget_group !== budget.data.group_id) {
      return err(agentKeyError('invalid_request', 'the key names another budget group'));
    }
    this.requests.push(structuredClone(req));
    const n = this.keys.size + 1;
    const vkey = VKeyView.parse({
      vkey_id: `fake-vkey-${n}`,
      scope: mint.data.scope,
      project_id: mint.data.project_id,
      lane: mint.data.lane ?? null,
      data_class_max: mint.data.data_class_max,
      models: [...mint.data.models],
      tools: [...mint.data.tools],
      budget_group: mint.data.budget_group,
      expires_at: mint.data.expires_at,
      revoked_at: null,
      item_id: mint.data.item_id ?? null,
      unit_id: mint.data.unit_id ?? null,
      step: mint.data.step ?? null,
    });
    this.keys.set(vkey.vkey_id, vkey);
    return ok({ vkey: structuredClone(vkey), secret: `aisk_${n.toString(16).padStart(48, '0')}` });
  }

  /** A copy of what was minted under `id`. */
  view(id: string): VKeyView | undefined {
    const v = this.keys.get(id);
    return v === undefined ? undefined : structuredClone(v);
  }

  all(): VKeyView[] {
    return [...this.keys.values()].map((v) => structuredClone(v));
  }
}
