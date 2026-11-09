import type { AgentId, JsonObject } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';

// AgentRunner (PLAN M11.3; DM `EvalRunner over AgentRunner`): how an eval calls the agent under test.
// It is handed the agent id and the case INPUT and nothing else: not the case's kind, its grader, its
// hidden ref or a baseline (holdout isolation, D36). The real adapter calls the gateway under a
// virtual key; the fake is deterministic.

export interface AgentRunRequest {
  readonly agent_id: AgentId;
  readonly input: JsonObject;
  /** 1-based trial number of this case (a fake may vary by it; the real runner ignores it). */
  readonly trial: number;
  /** Text the context builder produced (M11.4), put in front of the input. Absent: the input alone. */
  readonly context?: string;
}

export interface AgentRunAnswer {
  /** What the agent said: one JSON object, as text. Parsing and validation are the grader's job. */
  readonly text: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_micro_usd: number;
  /** The model the gateway says served the call. */
  readonly model: string;
}

export interface AgentRunnerFailure {
  /** `refused`: the gateway said no (budget, tool, kill, route). `infra_error`: no answer. */
  readonly code: 'refused' | 'infra_error';
  readonly message: string;
}

export interface AgentRunner {
  /** The provider the calls are routed to (`fake`, `anthropic`, ...): what a baseline is keyed by. */
  readonly provider: string;
  /** The model the runner expects (a run records the model each answer reports, else this). */
  readonly model: string;
  run(req: AgentRunRequest): Promise<Result<AgentRunAnswer, AgentRunnerFailure>>;
}

/** The deterministic fake: answers from a function of the request, and keeps every request it got. */
export class FakeAgentRunner implements AgentRunner {
  readonly requests: AgentRunRequest[] = [];
  constructor(
    private readonly answer: (
      req: AgentRunRequest,
    ) => string | AgentRunnerFailure | Promise<string | AgentRunnerFailure>,
    readonly provider = 'fake',
    readonly model = 'fake-model',
  ) {}

  async run(req: AgentRunRequest): Promise<Result<AgentRunAnswer, AgentRunnerFailure>> {
    this.requests.push(structuredClone(req));
    const a = await this.answer(req);
    if (typeof a !== 'string') return err(a);
    return ok({
      text: a,
      tokens_in: Math.max(1, Math.ceil(JSON.stringify(req.input).length / 4)),
      tokens_out: Math.max(1, Math.ceil(a.length / 4)),
      cost_micro_usd: 1,
      model: this.model,
    });
  }
}
