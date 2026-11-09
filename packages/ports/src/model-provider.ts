import type {
  ModelCompleteRequest,
  ModelCompleteResponse,
  ModelContentBlock,
  ModelStopReason,
} from '@aisdlc/contracts';
import { err, hashCanonical, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// ModelProviderPort (PLAN M10.1; DM §4): what the gateway calls to get a completion from a vendor.
// Only the gateway holds an adapter, and so only the gateway holds a vendor key (RV §2 "Model key
// custody"). An adapter turns a request into one vendor call and the answer into the shared
// Messages vocabulary; it does no routing, budgeting, redaction or tool policy (the gateway does,
// before and after). An adapter never puts a key, a prompt or a completion into an error message.

export type ModelProviderErrorCode =
  /** The vendor asked us to slow down (429) or is overloaded. */
  | 'rate_limited'
  /** The vendor could not be reached, timed out, or answered 5xx. */
  | 'unavailable'
  /** The vendor refused the request itself (4xx other than auth and rate). */
  | 'invalid_request'
  /** The vendor did not accept our credential. */
  | 'auth'
  /** A reply the adapter could not make sense of. */
  | 'bad_response';

export const ModelProviderError = taggedError('ModelProviderError');
export type ModelProviderError = TaggedError<
  'ModelProviderError',
  { code: ModelProviderErrorCode; message: string; status?: number }
>;
export const modelProviderError = (
  code: ModelProviderErrorCode,
  message: string,
  status?: number,
): ModelProviderError =>
  ModelProviderError({ code, message, ...(status === undefined ? {} : { status }) });

/** One piece of a streamed completion. `done` is last and carries what `complete` would have returned. */
export type ModelStreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'done'; readonly response: ModelCompleteResponse };

export interface ModelProviderPort {
  /** `anthropic`, `fake`, ... the adapter's own name (a registry row's `kind`). */
  readonly kind: string;
  /** Can this adapter carry `tools` and answer with `tool_use`? A route to a model that cannot is refused for a tool-bearing call. */
  readonly tools_capable: boolean;
  complete(req: ModelCompleteRequest): Promise<Result<ModelCompleteResponse, ModelProviderError>>;
  /** Optional. An adapter without it is never asked to stream. */
  stream?(req: ModelCompleteRequest): AsyncIterable<ModelStreamEvent>;
}

// ---------------------------------------------------------------- the deterministic fake

export interface ScriptedReply {
  readonly text?: string;
  readonly tool_uses?: ReadonlyArray<{ id?: string; name: string; input: Record<string, unknown> }>;
  /** Token counts to report; default: estimated from the sizes (4 characters a token, at least 1). */
  readonly usage?: { input_tokens: number; output_tokens: number };
  readonly stop_reason?: ModelStopReason;
  /** The adapter fails this call with it instead of answering. */
  readonly error?: ModelProviderError;
}

export type ScriptStep = ScriptedReply | ((req: ModelCompleteRequest) => ScriptedReply);

const estimate = (chars: number): number => Math.max(1, Math.ceil(chars / 4));

/**
 * The golden fake (DM `FakeProvider_B`): replies are what the test scripted, in order; with no script
 * left it answers `fake reply <n>` with estimated token counts. Every request it received is in
 * `calls`, exactly as the adapter got it, so a test can assert what the gateway let through.
 */
export class FakeProvider implements ModelProviderPort {
  readonly kind = 'fake';
  readonly tools_capable: boolean;
  readonly calls: ModelCompleteRequest[] = [];
  private readonly script: ScriptStep[];
  private n = 0;

  constructor(opts: { script?: ScriptStep[]; tools_capable?: boolean } = {}) {
    this.script = [...(opts.script ?? [])];
    this.tools_capable = opts.tools_capable ?? true;
  }

  /** Queues more replies. */
  enqueue(...steps: ScriptStep[]): this {
    this.script.push(...steps);
    return this;
  }

  private reply(req: ModelCompleteRequest): Result<ModelCompleteResponse, ModelProviderError> {
    this.calls.push(req);
    this.n += 1;
    const step = this.script.shift();
    const r: ScriptedReply = typeof step === 'function' ? step(req) : (step ?? {});
    if (r.error) return err(r.error);
    const content: ModelCompleteResponse['content'] = [];
    const text = r.text ?? (r.tool_uses ? '' : `fake reply ${this.n}`);
    if (text !== '') content.push({ type: 'text', text });
    for (const [i, t] of (r.tool_uses ?? []).entries()) {
      content.push({
        type: 'tool_use',
        id: t.id ?? `toolu_fake_${this.n}_${i}`,
        name: t.name,
        input: t.input,
      });
    }
    const inChars = JSON.stringify([req.system ?? '', req.messages]).length;
    const outChars = JSON.stringify(content).length;
    return ok({
      id: `msg_fake_${hashCanonical({ n: this.n, model: req.model }).slice(0, 16)}`,
      model: req.model,
      content,
      stop_reason: r.stop_reason ?? (r.tool_uses?.length ? 'tool_use' : 'end_turn'),
      usage: r.usage ?? { input_tokens: estimate(inChars), output_tokens: estimate(outChars) },
    });
  }

  async complete(
    req: ModelCompleteRequest,
  ): Promise<Result<ModelCompleteResponse, ModelProviderError>> {
    return this.reply(req);
  }

  async *stream(req: ModelCompleteRequest): AsyncIterable<ModelStreamEvent> {
    const r = this.reply(req);
    if (!r.ok) throw new Error(r.error.message);
    for (const b of r.value.content as ModelContentBlock[]) {
      if (b.type === 'text') {
        for (const w of b.text.split(/(?<= )/)) yield { type: 'text_delta', text: w };
      }
    }
    yield { type: 'done', response: r.value };
  }
}
