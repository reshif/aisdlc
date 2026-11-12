import { err, ok, type Result } from '@aisdlc/kernel';
import { z } from 'zod';

// One `POST /v1/messages` to the model gateway as the holder of a virtual key (gateway-api.md §2), for the stage ports
// that call an agent once (core's planning port, the verify service's reviewer: M14.3 moved it here from core). The
// key's secret is a parameter of this one call and is used for one header; this module
// never stores it, logs it or puts it in an error (an error names the gateway's own code and status).
// Non-streaming: a planning answer is one JSON object.

const Block = z.union([
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
]);
const Message = z.looseObject({
  model: z.string(),
  content: z.array(Block),
  stop_reason: z.string().nullable().optional(),
  usage: z.looseObject({ input_tokens: z.number(), output_tokens: z.number() }),
});
export type ContentBlock = z.infer<typeof Block>;

export interface ModelCallFailure {
  /**
   * `unreachable`: no answer (retry the command later). `rate_limited`: a spent budget or a rate limit
   * (the gateway's own ET1 handles a budget). `refused`: the gateway said no (kill, route, tool, class):
   * not retried.
   */
  readonly kind: 'unreachable' | 'rate_limited' | 'refused';
  readonly code: string;
  readonly status: number;
}

export interface ModelAnswer {
  readonly blocks: ContentBlock[];
  readonly text: string;
  readonly stop_reason: string | null;
  readonly model: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
}

export interface ModelCallOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function callMessages(
  o: ModelCallOptions,
  key: string,
  dataClass: string,
  body: unknown,
): Promise<Result<ModelAnswer, ModelCallFailure>> {
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(new URL('/v1/messages', o.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'x-aisdlc-data-class': dataClass,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
    });
  } catch {
    return err({ kind: 'unreachable', code: 'unreachable', status: 0 });
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
  const codeText = typeof code === 'string' ? code : `http_${res.status}`;
  if (res.status === 429) return err({ kind: 'rate_limited', code: codeText, status: 429 });
  if (res.status >= 500) return err({ kind: 'unreachable', code: codeText, status: res.status });
  if (res.status !== 200) return err({ kind: 'refused', code: codeText, status: res.status });
  const m = Message.safeParse(json);
  if (!m.success) return err({ kind: 'unreachable', code: 'malformed_answer', status: 200 });
  const text = m.data.content
    .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
    .join('');
  return ok({
    blocks: m.data.content,
    text,
    stop_reason: m.data.stop_reason ?? null,
    model: m.data.model,
    tokens_in: m.data.usage.input_tokens,
    tokens_out: m.data.usage.output_tokens,
  });
}
