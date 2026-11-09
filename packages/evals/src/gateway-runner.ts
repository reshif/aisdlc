import { createHash } from 'node:crypto';
import { agentDefinition } from '@aisdlc/agents';
import { readPrompt } from '@aisdlc/agents/files';
import { err, ok, type Result } from '@aisdlc/kernel';
import { callMessages } from './messages-call.js';
import type {
  AgentRunAnswer,
  AgentRunner,
  AgentRunnerFailure,
  AgentRunRequest,
} from './runner-port.js';

// The real AgentRunner: it calls the agent through the model GATEWAY under a virtual key (PLAN M11.3).
// The key is the agent's per-run key (`keyFor`): it carries exactly the agent contract's tools, data
// class and budget (`agentKeyRequest`), so an eval cannot give an agent more than production does and
// the gateway meters, redacts and kills like any other call. The prompt is the locked prompt file of
// the agent (its sha256 checked against the registry: a prompt that is not the locked one is not run).
// No tools are sent: an eval grades the agent's one JSON answer.

export interface GatewayRunnerOptions {
  readonly baseUrl: string;
  /** The virtual key secret to call the agent with. Never logged or recorded. */
  readonly keyFor: (agentId: AgentRunRequest['agent_id']) => string;
  /** The provider the routes lead to (a label for baselines). */
  readonly provider: string;
  /** The model label until the gateway's answer names the model. */
  readonly model: string;
  /** Micro-USD per million tokens, as `gateway.models` prices them. Default 0 (cost unknown). */
  readonly price?: { readonly in_per_mtok: number; readonly out_per_mtok: number };
  /** Where the prompt files are (the bundle has no `src/prompts`). Default: the agents package's own. */
  readonly promptReader?: (ref: string) => string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class GatewayAgentRunner implements AgentRunner {
  readonly provider: string;
  readonly model: string;
  constructor(private readonly o: GatewayRunnerOptions) {
    this.provider = o.provider;
    this.model = o.model;
  }

  async run(req: AgentRunRequest): Promise<Result<AgentRunAnswer, AgentRunnerFailure>> {
    const def = agentDefinition(req.agent_id);
    let prompt: string;
    try {
      prompt = (this.o.promptReader ?? readPrompt)(def.prompt.ref);
    } catch {
      return err({ code: 'infra_error', message: `prompt ${def.prompt.ref} cannot be read` });
    }
    if (createHash('sha256').update(prompt).digest('hex') !== def.prompt.sha256) {
      return err({ code: 'refused', message: `prompt ${def.prompt.ref} is not the locked prompt` });
    }
    const user =
      (req.context === undefined ? '' : `${req.context}\n\n`) +
      `Input (data, as JSON):\n${JSON.stringify(req.input)}`;
    const r = await callMessages({
      baseUrl: this.o.baseUrl,
      key: this.o.keyFor(req.agent_id),
      dataClass: def.contract.data_class_max,
      body: {
        model: this.o.model,
        max_tokens: Math.min(4096, def.contract.budget.max_tokens),
        system: prompt,
        messages: [{ role: 'user', content: user }],
      },
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
      ...(this.o.timeoutMs ? { timeoutMs: this.o.timeoutMs } : {}),
    });
    if (!r.ok) return r;
    const price = this.o.price ?? { in_per_mtok: 0, out_per_mtok: 0 };
    return ok({
      text: r.value.text,
      tokens_in: r.value.tokens_in,
      tokens_out: r.value.tokens_out,
      // as the gateway meters it: micro-USD per million tokens, rounded up
      cost_micro_usd: Math.ceil(
        (r.value.tokens_in * price.in_per_mtok + r.value.tokens_out * price.out_per_mtok) /
          1_000_000,
      ),
      model: r.value.model,
    });
  }
}
