import { err, ok, type Result } from '@aisdlc/kernel';
import { z } from 'zod';
import type { AgentRunnerFailure } from './runner-port.js';

// One `POST /v1/messages` to the gateway as the holder of a virtual key (gateway-api.md §2).

const Message = z.looseObject({
  model: z.string(),
  content: z.array(
    z.union([
      z.looseObject({ type: z.literal('text'), text: z.string() }),
      z.looseObject({ type: z.literal('tool_use') }),
    ]),
  ),
  usage: z.looseObject({ input_tokens: z.number(), output_tokens: z.number() }),
});

export async function callMessages(o: {
  baseUrl: string;
  key: string;
  dataClass: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<
  Result<{ text: string; model: string; tokens_in: number; tokens_out: number }, AgentRunnerFailure>
> {
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(new URL('/v1/messages', o.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': o.key,
        'x-aisdlc-data-class': o.dataClass,
      },
      body: JSON.stringify(o.body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
    });
  } catch {
    return err({ code: 'infra_error', message: 'the gateway could not be reached' });
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // not JSON
  }
  const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
  if (code === 'tool_not_allowed_in_response') {
    // the gateway blocked a tool call the key does not carry: a refusal, whatever the status
    return err({ code: 'refused', message: 'the gateway blocked a tool outside the key' });
  }
  if (res.status >= 500 || res.status === 429) {
    // 429 is a spent budget or a rate limit: no answer to grade, and not the agent's fault
    return err({
      code: res.status === 429 ? 'refused' : 'infra_error',
      message: `the gateway answered ${res.status}`,
    });
  }
  if (res.status !== 200)
    return err({ code: 'refused', message: `the gateway refused: ${res.status}` });
  const m = Message.safeParse(json);
  if (!m.success) return err({ code: 'infra_error', message: 'the gateway answer is malformed' });
  if (m.data.content.some((b) => b.type === 'tool_use')) {
    // no tools were offered: a tool call in the answer is not an answer
    return err({ code: 'refused', message: 'the answer asked for a tool' });
  }
  const text = m.data.content
    .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
    .join('');
  return ok({
    text,
    model: m.data.model,
    tokens_in: m.data.usage.input_tokens,
    tokens_out: m.data.usage.output_tokens,
  });
}
