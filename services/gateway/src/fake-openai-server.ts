import type { ModelCompleteRequest } from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import type { ModelProviderErrorCode, ScriptedReply, ScriptStep } from '@aisdlc/ports';
import { listen, newApp } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply } from 'fastify';

// A local fake of an OpenAI-compatible Chat Completions API (PLAN M10.5): `POST /v1/chat/completions`
// with the response, streaming (server-sent `data:` frames, a final usage frame, `[DONE]`) and error
// (`{error:{message,type,code}}`) shapes Codex's and DeepSeek's endpoints share, so the real adapter is
// exercised end to end and NO real call is made in a test. A call whose `Authorization: Bearer` is not
// the key it was started with is a 401. Tool calls come back as `tool_calls` with JSON `arguments`.

export interface SeenChatRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

export interface FakeOpenAIServer {
  /** Give the adapter `${url}/v1` as its base URL. */
  readonly url: string;
  reply(...steps: ScriptStep[]): void;
  readonly seen: SeenChatRequest[];
  /** Streams the client closed before the server finished them. */
  readonly streamsAborted: number;
  stop(): Promise<void>;
}

const STATUS: Record<ModelProviderErrorCode, { status: number; type: string }> = {
  rate_limited: { status: 429, type: 'rate_limit_exceeded' },
  unavailable: { status: 503, type: 'server_error' },
  auth: { status: 401, type: 'invalid_request_error' },
  invalid_request: { status: 400, type: 'invalid_request_error' },
  bad_response: { status: 500, type: 'server_error' },
};

const estimate = (chars: number): number => Math.max(1, Math.ceil(chars / 4));

export interface FakeOpenAIOptions {
  readonly apiKey: string;
  /** HOSTILE: every error message echoes the key it was called with. The adapter must not let that text out. */
  readonly echoKeyInErrors?: boolean;
  /** Streaming: pause between frames (a test that aborts a stream needs time to do it). */
  readonly streamDelayMs?: number;
  /** Serve the path without the `/v1` prefix too (a base URL such as DeepSeek's `https://api.deepseek.com`). */
  readonly bare?: boolean;
}

export async function startFakeOpenAIServer(o: FakeOpenAIOptions): Promise<FakeOpenAIServer> {
  const app: FastifyInstance = newApp();
  const script: ScriptStep[] = [];
  const seen: SeenChatRequest[] = [];
  let n = 0;
  let aborted = 0;

  const fail = (reply: FastifyReply, status: number, type: string, message: string) =>
    reply.code(status).send({ error: { message, type, code: null } });

  const handler = async (
    req: { headers: Record<string, string | string[] | undefined>; body: unknown },
    reply: FastifyReply,
  ) => {
    n += 1;
    seen.push({ headers: { ...req.headers }, body: (req.body ?? {}) as Record<string, unknown> });
    const bearer = /^Bearer (.+)$/.exec(String(req.headers['authorization'] ?? ''))?.[1];
    if (bearer !== o.apiKey)
      return fail(reply, 401, 'invalid_request_error', 'Incorrect API key provided');
    const b = (req.body ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a fake reads a loose wire body
    if (
      typeof b['model'] !== 'string' ||
      !Array.isArray(b['messages']) ||
      b['messages'].length === 0
    ) {
      return fail(reply, 400, 'invalid_request_error', 'model and messages are required');
    }
    const step = script.shift();
    const r: ScriptedReply = typeof step === 'function' ? step(toRequest(b)) : (step ?? {});
    if (r.error) {
      const s = STATUS[r.error.code];
      const msg = o.echoKeyInErrors
        ? `${r.error.message} (key ${String(bearer)})`
        : r.error.message;
      return fail(reply, s.status, s.type, msg);
    }
    const text = r.text ?? (r.tool_uses ? '' : `fake openai reply ${n}`);
    const calls = (r.tool_uses ?? []).map((t, i) => ({
      id: t.id ?? `call_${n}_${i}`,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.input) },
    }));
    const usage = r.usage ?? {
      input_tokens: estimate(JSON.stringify(b['messages']).length),
      output_tokens: estimate(text.length + JSON.stringify(calls).length),
    };
    const finish =
      r.stop_reason === 'max_tokens'
        ? 'length'
        : r.stop_reason === 'tool_use' || (r.stop_reason === undefined && calls.length > 0)
          ? 'tool_calls'
          : 'stop';
    const id = `chatcmpl-${hashCanonical({ n, model: b['model'] }).slice(0, 24)}`;
    const base = { id, object: 'chat.completion', created: 1_700_000_000, model: b['model'] };

    if (b['stream'] === true) {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let finished = false;
      raw.on('close', () => {
        if (!finished) aborted += 1;
      });
      const send = async (data: unknown): Promise<boolean> => {
        if (raw.destroyed) return false;
        raw.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
        if (o.streamDelayMs) await new Promise((res) => setTimeout(res, o.streamDelayMs));
        return !raw.destroyed;
      };
      // a vendor that drops the connection: what was written is flushed first, then the socket is cut
      const cut = async () => {
        await new Promise((res) => setTimeout(res, 30));
        raw.destroy();
      };
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason }],
      });
      if (!(await send(chunk({ role: 'assistant', content: '' })))) return reply;
      let sent = 0;
      if (text !== '') {
        for (const piece of r.chunks ?? text.split(/(?<= )/)) {
          if (r.fail_after_chunks !== undefined && sent >= r.fail_after_chunks) {
            // a vendor that drops the connection part-way
            finished = true;
            await cut();
            return reply;
          }
          sent += 1;
          if (!(await send(chunk({ content: piece })))) return reply;
        }
      }
      // tool calls in pieces: the first piece names the call, then the arguments in two halves
      for (const [i, c] of calls.entries()) {
        const mid = Math.ceil(c.function.arguments.length / 2);
        if (
          !(await send(
            chunk({
              tool_calls: [
                {
                  index: i,
                  id: c.id,
                  type: 'function',
                  function: { name: c.function.name, arguments: '' },
                },
              ],
            }),
          ))
        )
          return reply;
        for (const piece of [c.function.arguments.slice(0, mid), c.function.arguments.slice(mid)]) {
          if (!(await send(chunk({ tool_calls: [{ index: i, function: { arguments: piece } }] }))))
            return reply;
        }
      }
      if (r.fail_after_chunks !== undefined && sent <= r.fail_after_chunks) {
        finished = true;
        await cut();
        return reply;
      }
      if (!(await send(chunk({}, finish)))) return reply;
      if (b['stream_options']?.include_usage) {
        await send({
          ...base,
          object: 'chat.completion.chunk',
          choices: [],
          usage: {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
          },
        });
      }
      await send('[DONE]');
      finished = true;
      raw.end();
      return reply;
    }

    return reply.send({
      ...base,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text === '' ? null : text,
            ...(calls.length ? { tool_calls: calls } : {}),
          },
          finish_reason: finish,
        },
      ],
      usage: {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
      },
    });
  };

  app.post('/v1/chat/completions', handler);
  if (o.bare) app.post('/chat/completions', handler);

  const url = await listen(app);
  return {
    url,
    reply: (...steps) => void script.push(...steps),
    seen,
    get streamsAborted() {
      return aborted;
    },
    stop: async () => {
      // a test may leave a stream open on purpose (an abort): close its sockets, then the server
      app.server.closeAllConnections();
      await app.close();
    },
  };
}

/** The shared-vocabulary view of a chat body, for a scripted step that wants to see the request. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fake reads a loose wire body
function toRequest(b: Record<string, any>): ModelCompleteRequest {
  return {
    model: String(b['model']),
    messages: [{ role: 'user', content: JSON.stringify(b['messages']) }],
    max_tokens: Number(b['max_tokens'] ?? b['max_completion_tokens'] ?? 1),
    metadata: {},
  };
}
