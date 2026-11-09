import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_DEFAULT_MODELS,
  type AnthropicDefaultModels,
  type ModelCompleteRequest,
  type ModelCompleteResponse,
  type ModelStopReason,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  modelProviderError,
  type ModelProviderError,
  type ModelProviderPort,
  type ModelStreamEvent,
} from '@aisdlc/ports';

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
      msg = await this.client.messages.create(this.params(req));
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

  private params(req: ModelCompleteRequest) {
    return {
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
    };
  }

  /**
   * The vendor's stream (`stream: true`, server-sent events) as the factory's `ModelStreamEvent`s.
   * Thinking and server-tool blocks are dropped like in `complete`. A vendor failure, before or after
   * the first piece, is one `error` event and the end (never a throw); an abort (`signal`) just ends it.
   */
  async *stream(
    req: ModelCompleteRequest,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<ModelStreamEvent> {
    const blocks = new Map<number, { type: 'text' | 'tool' | 'skip'; json: string }>();
    const content: ModelCompleteResponse['content'] = [];
    const tools = new Map<number, { id: string; name: string }>();
    let id = '';
    let model = req.model;
    let inTokens: number | null = null;
    let outTokens: number | null = null;
    let stop: string | null = null;
    let text = '';
    const flushText = () => {
      if (text !== '') content.push({ type: 'text', text });
      text = '';
    };
    try {
      const events = await this.client.messages.create(
        { ...this.params(req), stream: true },
        opts.signal ? { signal: opts.signal } : {},
      );
      for await (const ev of events) {
        if (ev.type === 'message_start') {
          id = ev.message.id;
          model = ev.message.model;
          inTokens = ev.message.usage?.input_tokens ?? null;
          yield {
            type: 'start',
            id,
            ...(typeof inTokens === 'number' ? { input_tokens: inTokens } : {}),
          };
        } else if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          if (b.type === 'text') {
            blocks.set(ev.index, { type: 'text', json: '' });
            if (b.text) {
              text += b.text;
              yield { type: 'text_delta', text: b.text };
            }
          } else if (b.type === 'tool_use') {
            flushText();
            blocks.set(ev.index, { type: 'tool', json: '' });
            tools.set(ev.index, { id: b.id, name: b.name });
            yield { type: 'tool_use_start', id: b.id, name: b.name };
          } else {
            blocks.set(ev.index, { type: 'skip', json: '' });
          }
        } else if (ev.type === 'content_block_delta') {
          const blk = blocks.get(ev.index);
          if (ev.delta.type === 'text_delta' && blk?.type === 'text') {
            text += ev.delta.text;
            yield { type: 'text_delta', text: ev.delta.text };
          } else if (ev.delta.type === 'input_json_delta' && blk?.type === 'tool') {
            blk.json += ev.delta.partial_json;
            yield { type: 'tool_input_delta', partial_json: ev.delta.partial_json };
          }
        } else if (ev.type === 'content_block_stop') {
          const blk = blocks.get(ev.index);
          const t = tools.get(ev.index);
          if (blk?.type === 'tool' && t) {
            let input: Record<string, unknown> = {};
            try {
              input = blk.json === '' ? {} : (JSON.parse(blk.json) as Record<string, unknown>);
            } catch {
              yield {
                type: 'error',
                error: modelProviderError('bad_response', 'a tool input was not JSON'),
              };
              return;
            }
            content.push({ type: 'tool_use', id: t.id, name: t.name, input });
          } else if (blk?.type === 'text') flushText();
        } else if (ev.type === 'message_delta') {
          stop = ev.delta.stop_reason;
          outTokens = ev.usage?.output_tokens ?? outTokens;
          const i = (ev.usage as { input_tokens?: number | null } | undefined)?.input_tokens;
          if (typeof i === 'number') inTokens = i;
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) return;
      yield { type: 'error', error: this.mapError(e) };
      return;
    }
    flushText();
    if (typeof inTokens !== 'number' || typeof outTokens !== 'number') {
      yield {
        type: 'error',
        error: modelProviderError('bad_response', 'the vendor stream has no usage'),
      };
      return;
    }
    const stop_reason: ModelStopReason =
      stop === 'max_tokens' || stop === 'stop_sequence' || stop === 'tool_use' ? stop : 'end_turn';
    yield {
      type: 'done',
      response: {
        id,
        model,
        content,
        stop_reason,
        usage: { input_tokens: inTokens, output_tokens: outTokens },
      },
    };
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
