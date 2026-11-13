import { err, ok, type Result } from '@aisdlc/kernel';
import {
  callMessages,
  type ContentBlock,
  type ModelCallFailure,
  type ModelCallOptions,
} from '@aisdlc/ports';

// The model behind the onboarder (docs/design/onboarding-console.md, P2): ONE call of the conversation, as the holder of
// the session's key. The engine owns the loop (tools, retries, judging); the port owns only "send these messages with
// these tools, get blocks back". In a deployment it is the gateway's `/v1/messages`; in tests a script.

export interface ModelToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: unknown;
}

export interface ModelStepRequest {
  /** The session key's secret, lent for this call only. A fake ignores it. */
  readonly secret: string;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDef[];
  readonly dataClass: 'D1' | 'D2';
}

export interface ModelStepAnswer {
  readonly blocks: ContentBlock[];
  readonly text: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
}

export interface OnboarderModelPort {
  step(req: ModelStepRequest): Promise<Result<ModelStepAnswer, ModelCallFailure>>;
}

/** The gateway's `/v1/messages` under the session's key. */
export class GatewayOnboarderModel implements OnboarderModelPort {
  constructor(private readonly o: ModelCallOptions) {}

  async step(req: ModelStepRequest): Promise<Result<ModelStepAnswer, ModelCallFailure>> {
    const r = await callMessages(this.o, req.secret, req.dataClass, {
      model: req.model,
      max_tokens: 2048,
      system: req.system,
      messages: req.messages,
      ...(req.tools.length > 0 ? { tools: req.tools } : {}),
    });
    if (!r.ok) return err(r.error);
    return ok({
      blocks: r.value.blocks,
      text: r.value.text,
      tokens_in: r.value.tokens_in,
      tokens_out: r.value.tokens_out,
    });
  }
}

/** One scripted reply: blocks (text and tool_use) or a failure. */
export type ScriptedStep =
  | { readonly blocks: readonly ContentBlock[]; readonly tokens?: number }
  | { readonly fail: ModelCallFailure }
  | ((req: ModelStepRequest, n: number) => ScriptedStep);

/** A deterministic model: replays its script in order; running out is an unreachable gateway (fail closed). */
export class ScriptedOnboarderModel implements OnboarderModelPort {
  readonly requests: ModelStepRequest[] = [];
  private i = 0;

  constructor(private readonly script: readonly ScriptedStep[]) {}

  get calls(): number {
    return this.requests.length;
  }

  async step(req: ModelStepRequest): Promise<Result<ModelStepAnswer, ModelCallFailure>> {
    this.requests.push(req);
    let s: ScriptedStep | undefined = this.script[this.i];
    this.i += 1;
    while (typeof s === 'function') s = s(req, this.i);
    if (s === undefined) return err({ kind: 'unreachable', code: 'script_exhausted', status: 0 });
    if ('fail' in s) return err(s.fail);
    const blocks = [...s.blocks];
    const text = blocks
      .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
      .join('');
    return ok({ blocks, text, tokens_in: s.tokens ?? 100, tokens_out: s.tokens ?? 50 });
  }
}

/** A final turn as the model would write it: the JSON of `onboarder.v1`. */
export const turnText = (o: {
  text: string;
  next?: 'await_person' | 'working' | 'done';
  citations?: unknown[];
  noticed?: string[];
}): ContentBlock => ({
  type: 'text',
  text: JSON.stringify({
    kind: 'turn',
    text: o.text,
    citations: o.citations ?? [],
    next: o.next ?? 'await_person',
    noticed: o.noticed ?? [],
  }),
});

export const toolUse = (
  id: string,
  name: string,
  input: Record<string, unknown>,
): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
});
