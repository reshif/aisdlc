import type { ModelCompleteRequest } from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import type { ModelProviderErrorCode, ScriptedReply, ScriptStep } from '@aisdlc/ports';
import { listen, newApp } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply } from 'fastify';

// A local fake of Anthropic's Messages API (PLAN M10.1): `POST /v1/messages` with the response and
// error shapes the real API has (message object with `usage`, `tool_use` blocks, `{type:'error',
// error:{type, message}}` bodies, `request-id` header), so the real SDK adapter is exercised end to end
// and NO real call is ever made in a test. It checks the headers and body the real API checks and
// refuses a call whose key (`x-api-key` or `Authorization: Bearer`) is not the one it was started with.

export interface SeenMessagesRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

export interface FakeMessagesServer {
  /** Base URL to give the adapter (`baseUrl`). */
  readonly url: string;
  /** Queue the next replies. */
  reply(...steps: ScriptStep[]): void;
  /** Every request, as it arrived. */
  readonly seen: SeenMessagesRequest[];
  stop(): Promise<void>;
}

const STATUS: Record<ModelProviderErrorCode, { status: number; type: string }> = {
  rate_limited: { status: 429, type: 'rate_limit_error' },
  unavailable: { status: 503, type: 'api_error' },
  auth: { status: 401, type: 'authentication_error' },
  invalid_request: { status: 400, type: 'invalid_request_error' },
  bad_response: { status: 500, type: 'api_error' },
};

const estimate = (chars: number): number => Math.max(1, Math.ceil(chars / 4));

export interface FakeMessagesOptions {
  /** The only key it accepts. */
  readonly apiKey: string;
  /**
   * HOSTILE: every error message it sends echoes the key it was called with, the way a
   * careless vendor (or an attacker's server) could. The adapter must not let that text out.
   */
  readonly echoKeyInErrors?: boolean;
}

export async function startFakeMessagesServer(o: FakeMessagesOptions): Promise<FakeMessagesServer> {
  const app: FastifyInstance = newApp();
  const script: ScriptStep[] = [];
  const seen: SeenMessagesRequest[] = [];
  let n = 0;

  const fail = (reply: FastifyReply, status: number, type: string, message: string) =>
    reply
      .code(status)
      .header('request-id', `req_fake_${n}`)
      .send({ type: 'error', error: { type, message }, request_id: `req_fake_${n}` });

  app.post('/v1/messages', async (req, reply) => {
    n += 1;
    seen.push({ headers: { ...req.headers }, body: (req.body ?? {}) as Record<string, unknown> });
    // The SDK of this version sends `Authorization: Bearer <key>`; the API also takes `x-api-key`.
    const bearer = /^Bearer (.+)$/.exec(String(req.headers['authorization'] ?? ''))?.[1];
    const key = req.headers['x-api-key'] ?? bearer;
    if (key !== o.apiKey) {
      return fail(reply, 401, 'authentication_error', 'invalid x-api-key');
    }
    if (!req.headers['anthropic-version']) {
      return fail(reply, 400, 'invalid_request_error', 'anthropic-version header is required');
    }
    const b = (req.body ?? {}) as Partial<ModelCompleteRequest> & Record<string, unknown>;
    if (
      typeof b.model !== 'string' ||
      !Number.isInteger(b.max_tokens) ||
      !Array.isArray(b.messages) ||
      b.messages.length === 0
    ) {
      return fail(
        reply,
        400,
        'invalid_request_error',
        'model, max_tokens and messages are required',
      );
    }
    const step = script.shift();
    const r: ScriptedReply =
      typeof step === 'function' ? step(b as ModelCompleteRequest) : (step ?? {});
    if (r.error) {
      const s = STATUS[r.error.code];
      const msg = o.echoKeyInErrors ? `${r.error.message} (key ${String(key)})` : r.error.message;
      return fail(reply, s.status, s.type, msg);
    }
    const content: unknown[] = [];
    const text = r.text ?? (r.tool_uses ? '' : `fake vendor reply ${n}`);
    if (text !== '') content.push({ type: 'text', text });
    for (const [i, t] of (r.tool_uses ?? []).entries()) {
      content.push({
        type: 'tool_use',
        id: t.id ?? `toolu_${n}_${i}`,
        name: t.name,
        input: t.input,
      });
    }
    const usage = r.usage ?? {
      input_tokens: estimate(JSON.stringify([b.system ?? '', b.messages]).length),
      output_tokens: estimate(JSON.stringify(content).length),
    };
    return reply.header('request-id', `req_fake_${n}`).send({
      id: `msg_${hashCanonical({ n, model: b.model }).slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      model: b.model,
      content,
      stop_reason: r.stop_reason ?? (r.tool_uses?.length ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: {
        ...usage,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
      },
    });
  });

  const url = await listen(app);
  return {
    url,
    reply: (...steps) => void script.push(...steps),
    seen,
    stop: () => app.close(),
  };
}
