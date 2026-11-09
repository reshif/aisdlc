import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_DEFAULT_MODELS,
  type AnthropicDefaultModels,
  type ModelCompleteRequest,
  type ModelCompleteResponse,
  type ModelStopReason,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { modelProviderError, type ModelProviderError, type ModelProviderPort } from '@aisdlc/ports';

// The Anthropic adapter (PLAN M10.1): the official SDK, an injectable base URL (tests point it at the
// in-repo fake Messages API), and the key held in this object and nowhere else. The SDK would put the
// key in an `x-api-key` header and in nothing it prints; this adapter still scrubs the key out of every
// message it returns, because an error text is the one place a vendor (or a hostile fake) might echo it.

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  /** Default `https://api.anthropic.com`. */
  readonly baseUrl?: string;
  /** What `opus`, `sonnet` and `haiku` mean (and what an empty model means: sonnet). */
  readonly models?: AnthropicDefaultModels;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export class AnthropicProvider implements ModelProviderPort {
  readonly kind = 'anthropic';
  readonly tools_capable = true;
  private readonly client: Anthropic;
  private readonly models: AnthropicDefaultModels;
  private readonly key: string;

  constructor(o: AnthropicProviderOptions) {
    if (o.apiKey.trim() === '') throw new RangeError('AnthropicProvider needs an API key');
    this.key = o.apiKey;
    this.models = o.models ?? ANTHROPIC_DEFAULT_MODELS;
    this.client = new Anthropic({
      apiKey: o.apiKey,
      ...(o.baseUrl ? { baseURL: o.baseUrl } : {}),
      timeout: o.timeoutMs ?? 120_000,
      maxRetries: o.maxRetries ?? 1,
    });
  }

  /** `opus` / `sonnet` / `haiku` (the family names) become the configured ids; anything else goes through. */
  resolveModel(model: string): string {
    const m = model.trim().toLowerCase();
    if (m === 'opus' || m === 'sonnet' || m === 'haiku') return this.models[m];
    return model;
  }

  private scrub(text: string): string {
    return text.split(this.key).join('[redacted]').slice(0, 300);
  }

  async complete(
    req: ModelCompleteRequest,
  ): Promise<Result<ModelCompleteResponse, ModelProviderError>> {
    let msg: Anthropic.Message;
    try {
      msg = await this.client.messages.create({
        model: this.resolveModel(req.model),
        max_tokens: req.max_tokens,
        messages: req.messages as Anthropic.MessageParam[],
        ...(req.system === undefined ? {} : { system: req.system }),
        ...(req.tools?.length ? { tools: req.tools as Anthropic.Tool[] } : {}),
        ...(req.tool_choice && req.tools?.length
          ? { tool_choice: req.tool_choice as Anthropic.ToolChoice }
          : {}),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.stop_sequences?.length ? { stop_sequences: req.stop_sequences } : {}),
        // Only an opaque id of ours goes along, for the vendor's abuse tooling; never text.
        ...(req.metadata['vkey_id'] ? { metadata: { user_id: req.metadata['vkey_id'] } } : {}),
      });
    } catch (e) {
      return err(this.mapError(e));
    }
    const content: ModelCompleteResponse['content'] = [];
    for (const b of msg.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: b.id,
          name: b.name,
          input: (b.input ?? {}) as Record<string, unknown>,
        });
      }
      // other block kinds (thinking, server tools) are not part of the shared vocabulary: dropped
    }
    const stop = msg.stop_reason;
    const stop_reason: ModelStopReason =
      stop === 'max_tokens' || stop === 'stop_sequence' || stop === 'tool_use' ? stop : 'end_turn';
    if (
      typeof msg.usage?.input_tokens !== 'number' ||
      typeof msg.usage?.output_tokens !== 'number'
    ) {
      return err(modelProviderError('bad_response', 'the vendor reply has no usage'));
    }
    return ok({
      id: msg.id,
      model: msg.model,
      content,
      stop_reason,
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
    });
  }

  private mapError(e: unknown): ModelProviderError {
    if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
      const detail = this.scrub(`${e.type ?? 'error'}: ${e.apiMessage ?? ''}`);
      const s = e.status;
      if (s === 401 || s === 403) return modelProviderError('auth', `vendor ${s}: ${detail}`, s);
      if (s === 429 || s === 529)
        return modelProviderError('rate_limited', `vendor ${s}: ${detail}`, s);
      if (s >= 500) return modelProviderError('unavailable', `vendor ${s}: ${detail}`, s);
      return modelProviderError('invalid_request', `vendor ${s}: ${detail}`, s);
    }
    return modelProviderError(
      'unavailable',
      this.scrub(
        e instanceof Error ? `${e.name}: ${e.message}` : 'the vendor could not be reached',
      ),
    );
  }
}
