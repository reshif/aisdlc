import type {
  ModelCompleteRequest,
  ModelCompleteResponse,
  ModelContentBlock,
  ModelStopReason,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  modelProviderError,
  type ModelProviderError,
  type ModelProviderPort,
  type ModelStreamEvent,
} from '@aisdlc/ports';

// The OpenAI-compatible adapter (PLAN M10.5; decided 2026-11-08: Codex is a model route through the
// gateway, an OpenAI-compatible provider row, not a sandbox harness). One class for every vendor that
// speaks Chat Completions (`POST {base_url}/chat/completions`): Codex and DeepSeek are two REGISTRY ROWS
// of it, each with its own base URL, key reference and models (`gateway.models.provider_model`). It does
// what the Anthropic adapter does and no more: maps the shared Messages vocabulary to chat completions and
// back, tool calls included, streams, and never lets a key, a prompt or a completion into an error. It
// uses `fetch` (Node's), so it adds no dependency, and the key is held in this object only.
//
// Mapping, in short:
//   system                      -> a `system` message
//   user text blocks            -> a `user` message
//   tool_result blocks          -> `tool` messages (`tool_call_id` = the tool_use id), before the user text
//   assistant tool_use blocks   -> `tool_calls` on the assistant message (`arguments` = JSON of the input)
//   tools / tool_choice         -> `tools` (function) / `tool_choice` (any -> required)
//   finish_reason               -> stop_reason: stop end_turn, length max_tokens, tool_calls tool_use
//   usage                       -> prompt_tokens / completion_tokens (a reply without them is refused)

export interface OpenAICompatOptions {
  readonly apiKey: string;
  /** Up to and including the version segment the vendor wants, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string;
  readonly toolsCapable?: boolean;
  readonly timeoutMs?: number;
  /** Newer OpenAI models want `max_completion_tokens`; most compatible vendors still take `max_tokens`. */
  readonly maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  readonly fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

const FINISH: Record<string, ModelStopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

const textOf = (c: string | Array<{ text: string }> | undefined): string =>
  c === undefined ? '' : typeof c === 'string' ? c : c.map((t) => t.text).join('\n');

export function toChatMessages(req: ModelCompleteRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (req.system !== undefined && req.system !== '')
    out.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as ModelContentBlock[];
    if (m.role === 'assistant') {
      const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls = blocks.flatMap((b) =>
        b.type === 'tool_use'
          ? [
              {
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input) },
              },
            ]
          : [],
      );
      out.push({
        role: 'assistant',
        content: text === '' && calls.length > 0 ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else {
      // tool results first (they answer the assistant message before), then what the user said
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const body = textOf(b.content);
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: b.is_error ? `error: ${body}` : body,
          });
        }
      }
      const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      if (text !== '') out.push({ role: 'user', content: text });
    }
  }
  return out;
}

export class OpenAICompatProvider implements ModelProviderPort {
  readonly kind = 'openai_compat';
  readonly tools_capable: boolean;
  private readonly key: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly f: typeof fetch;
  private readonly tokensParam: 'max_tokens' | 'max_completion_tokens';

  constructor(o: OpenAICompatOptions) {
    if (o.apiKey.trim() === '') throw new RangeError('OpenAICompatProvider needs an API key');
    this.key = o.apiKey;
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.tools_capable = o.toolsCapable ?? true;
    this.timeoutMs = o.timeoutMs ?? 120_000;
    this.f = o.fetchImpl ?? fetch;
    this.tokensParam = o.maxTokensParam ?? 'max_tokens';
  }

  private scrub(text: string): string {
    return text.split(this.key).join('[redacted]').slice(0, 300);
  }

  private body(req: ModelCompleteRequest, stream: boolean): Record<string, unknown> {
    const tools = req.tools?.length
      ? req.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            ...(t.description === undefined ? {} : { description: t.description }),
            parameters: t.input_schema,
          },
        }))
      : undefined;
    const choice = req.tool_choice;
    const tool_choice =
      tools === undefined || choice === undefined
        ? undefined
        : choice.type === 'auto'
          ? 'auto'
          : choice.type === 'any'
            ? 'required'
            : choice.type === 'none'
              ? 'none'
              : { type: 'function', function: { name: choice.name } };
    return {
      model: req.model,
      messages: toChatMessages(req),
      [this.tokensParam]: req.max_tokens,
      ...(tools ? { tools } : {}),
      ...(tool_choice === undefined ? {} : { tool_choice }),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(req.stop_sequences?.length ? { stop: req.stop_sequences } : {}),
      // Only an opaque id of ours goes along, for the vendor's abuse tooling; never text.
      ...(req.metadata['vkey_id'] ? { user: req.metadata['vkey_id'] } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private async post(
    req: ModelCompleteRequest,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Result<Response, ModelProviderError>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: stream ? 'text/event-stream' : 'application/json',
          authorization: `Bearer ${this.key}`,
        },
        body: JSON.stringify(this.body(req, stream)),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      return err(
        modelProviderError(
          'unavailable',
          this.scrub(
            e instanceof Error ? `${e.name}: ${e.message}` : 'the vendor could not be reached',
          ),
        ),
      );
    }
    if (res.ok) return ok(res);
    let detail: string;
    try {
      const j = (await res.json()) as { error?: { message?: unknown; type?: unknown } };
      detail = this.scrub(`${String(j.error?.type ?? 'error')}: ${String(j.error?.message ?? '')}`);
    } catch {
      detail = 'no readable body';
    }
    const s = res.status;
    if (s === 401 || s === 403) return err(modelProviderError('auth', `vendor ${s}: ${detail}`, s));
    if (s === 429) return err(modelProviderError('rate_limited', `vendor ${s}: ${detail}`, s));
    if (s >= 500) return err(modelProviderError('unavailable', `vendor ${s}: ${detail}`, s));
    return err(modelProviderError('invalid_request', `vendor ${s}: ${detail}`, s));
  }

  async complete(
    req: ModelCompleteRequest,
  ): Promise<Result<ModelCompleteResponse, ModelProviderError>> {
    const r = await this.post(req, false);
    if (!r.ok) return r;
    let j: ChatCompletion;
    try {
      j = (await r.value.json()) as ChatCompletion;
    } catch {
      return err(modelProviderError('bad_response', 'the vendor reply is not JSON'));
    }
    const choice = j.choices?.[0];
    if (!choice?.message)
      return err(modelProviderError('bad_response', 'the vendor reply has no choice'));
    if (
      typeof j.usage?.prompt_tokens !== 'number' ||
      typeof j.usage?.completion_tokens !== 'number'
    ) {
      return err(modelProviderError('bad_response', 'the vendor reply has no usage'));
    }
    const content: ModelCompleteResponse['content'] = [];
    if (typeof choice.message.content === 'string' && choice.message.content !== '') {
      content.push({ type: 'text', text: choice.message.content });
    }
    for (const c of choice.message.tool_calls ?? []) {
      const input = parseArgs(c.function?.arguments);
      if (input === null || !c.id || !c.function?.name) {
        return err(modelProviderError('bad_response', 'a tool call could not be read'));
      }
      content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
    }
    return ok({
      id: j.id ?? 'chatcmpl-unknown',
      model: j.model ?? req.model,
      content,
      stop_reason: FINISH[choice.finish_reason ?? 'stop'] ?? 'end_turn',
      usage: { input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens },
    });
  }

  /**
   * Chat Completions server-sent events as `ModelStreamEvent`s. Text is passed on as it arrives. A tool
   * call is assembled per `index` and sent whole when the stream finishes (a start and its input), in
   * index order: the vendor may interleave calls, the shared vocabulary does not, and nothing of a tool
   * call is useful before it is complete.
   */
  async *stream(
    req: ModelCompleteRequest,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<ModelStreamEvent> {
    const r = await this.post(req, true, opts.signal);
    if (!r.ok) {
      yield { type: 'error', error: r.error };
      return;
    }
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let text = '';
    let id = '';
    let model = req.model;
    let finish: string | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
    let started = false;
    try {
      const reader = r.value.body?.getReader();
      if (!reader) throw new Error('no body');
      const dec = new TextDecoder();
      let buf = '';
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let cut: number;
        while ((cut = buf.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
          const data = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (data === '') continue;
          if (data === '[DONE]') {
            done = true;
            break;
          }
          let j: ChatChunk;
          try {
            j = JSON.parse(data) as ChatChunk;
          } catch {
            yield {
              type: 'error',
              error: modelProviderError('bad_response', 'a stream frame is not JSON'),
            };
            return;
          }
          if (j.error) {
            yield {
              type: 'error',
              error: modelProviderError(
                'unavailable',
                this.scrub(`vendor stream error: ${String(j.error.message ?? '')}`),
              ),
            };
            return;
          }
          if (j.id) id = j.id;
          if (j.model) model = j.model;
          if (j.usage) usage = j.usage;
          const ch = j.choices?.[0];
          if (!started) {
            started = true;
            yield { type: 'start', ...(id ? { id } : {}) };
          }
          if (!ch) continue;
          if (ch.finish_reason) finish = ch.finish_reason;
          const d = ch.delta;
          if (typeof d?.content === 'string' && d.content !== '') {
            text += d.content;
            yield { type: 'text_delta', text: d.content };
          }
          for (const t of d?.tool_calls ?? []) {
            const cur = calls.get(t.index) ?? { id: '', name: '', args: '' };
            if (t.id) cur.id = t.id;
            if (t.function?.name) cur.name += t.function.name;
            if (t.function?.arguments) cur.args += t.function.arguments;
            calls.set(t.index, cur);
          }
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) return;
      yield {
        type: 'error',
        error: modelProviderError(
          'unavailable',
          this.scrub(e instanceof Error ? `${e.name}: ${e.message}` : 'the stream broke'),
        ),
      };
      return;
    }
    if (typeof usage?.prompt_tokens !== 'number' || typeof usage?.completion_tokens !== 'number') {
      yield {
        type: 'error',
        error: modelProviderError('bad_response', 'the vendor stream has no usage'),
      };
      return;
    }
    const content: ModelCompleteResponse['content'] = [];
    if (text !== '') content.push({ type: 'text', text });
    for (const [, c] of [...calls].sort((a, b) => a[0] - b[0])) {
      const input = parseArgs(c.args);
      if (input === null || !c.id || !c.name) {
        yield {
          type: 'error',
          error: modelProviderError('bad_response', 'a tool call could not be read'),
        };
        return;
      }
      yield { type: 'tool_use_start', id: c.id, name: c.name };
      yield { type: 'tool_input_delta', partial_json: c.args === '' ? '{}' : c.args };
      content.push({ type: 'tool_use', id: c.id, name: c.name, input });
    }
    yield {
      type: 'done',
      response: {
        id: id || 'chatcmpl-unknown',
        model,
        content,
        stop_reason: FINISH[finish ?? 'stop'] ?? 'end_turn',
        usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
      },
    };
  }
}

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ChatChunk {
  id?: string;
  model?: string;
  error?: { message?: unknown };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function parseArgs(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined || raw === '') return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
