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
  /**
   * Optional: ends a key early (a per-job key once its run is over, a key whose secret was lost with a
   * restart). An adapter without it relies on the key's expiry.
   */
  revoke?(vkey_id: string): Promise<Result<void, AgentKeyError>>;
}

// ---------------------------------------------------------------- The in-process seam for a key's secret

/**
 * What a stage port that calls the gateway itself is given (M12): the right to USE the secret of its
 * run's key for one call, never the secret as a value. `lend` runs `use` with the secret and returns what
 * it returns; `null`: this process holds no secret for the run (it restarted since the key was minted),
 * and the caller must ask for a new key rather than guess. A port that is handed only this interface
 * cannot store, log or return the secret by accident: nothing it holds contains it.
 */
export interface RunKeyLender {
  lend<T>(run_id: string, use: (secret: string) => Promise<T>): Promise<T | null>;
}

/**
 * Where the work driver puts a run's key secret the moment the gateway mints it, and where the planning
 * port borrows it. The secret lives only here, in this process's memory: it is never written to the
 * record, an outbox row, a log, an error or a read model (the dispatch records the key's ID only), and the
 * vault itself serialises and prints as a count. After a restart the vault is empty by design: the next
 * delivery of the command mints a fresh key (the lost one is revoked), so no secret ever has to be stored.
 */
export class RunKeyVault implements RunKeyLender {
  readonly #secrets = new Map<string, { vkey_id: string; secret: string }>();

  /** The driver's side: keeps `secret` for the run until `drop`. */
  put(run_id: string, vkey_id: string, secret: string): void {
    this.#secrets.set(run_id, { vkey_id, secret });
  }

  has(run_id: string): boolean {
    return this.#secrets.has(run_id);
  }

  /** The id (never the secret) of the key held for a run. */
  keyOf(run_id: string): string | null {
    return this.#secrets.get(run_id)?.vkey_id ?? null;
  }

  async lend<T>(run_id: string, use: (secret: string) => Promise<T>): Promise<T | null> {
    const held = this.#secrets.get(run_id);
    return held ? use(held.secret) : null;
  }

  /** Forgets the run's secret (its command is answered). */
  drop(run_id: string): string | null {
    const held = this.#secrets.get(run_id);
    this.#secrets.delete(run_id);
    return held?.vkey_id ?? null;
  }

  get size(): number {
    return this.#secrets.size;
  }

  toJSON(): { vault: string; held: number } {
    return { vault: 'run-key', held: this.#secrets.size };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `RunKeyVault(${this.#secrets.size} held)`;
  }
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

  async revoke(vkey_id: string): Promise<Result<void, AgentKeyError>> {
    const v = this.keys.get(vkey_id);
    if (!v) return err(agentKeyError('not_found', 'no such key'));
    this.keys.set(vkey_id, { ...v, revoked_at: '2026-11-09T00:00:00.000Z' });
    this.revoked.push(vkey_id);
    return ok(undefined);
  }

  /** The ids of the keys revoked, in order. */
  readonly revoked: string[] = [];

  /** A copy of what was minted under `id`. */
  view(id: string): VKeyView | undefined {
    const v = this.keys.get(id);
    return v === undefined ? undefined : structuredClone(v);
  }

  all(): VKeyView[] {
    return [...this.keys.values()].map((v) => structuredClone(v));
  }
}
