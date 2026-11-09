import { modelProviderContract } from '@aisdlc/ports/testing';
import type { ModelCompleteRequest } from '@aisdlc/contracts';
import { modelProviderError } from '@aisdlc/ports';
import { describe, expect, it } from 'vitest';
import { startFakeOpenAIServer } from '../src/fake-openai-server.js';
import { OpenAICompatProvider, toChatMessages } from '../src/openai-compat-provider.js';

// The OpenAI-compatible adapter (PLAN M10.5) against a local fake of the Chat Completions API. No real
// network: the key and the host are made up here.

const KEY = ['sk', 'test', 'oa1c0mp4t'.repeat(4)].join('-');

modelProviderContract('OpenAICompatProvider over the fake Chat Completions API', async () => {
  const server = await startFakeOpenAIServer({ apiKey: KEY });
  const port = new OpenAICompatProvider({ apiKey: KEY, baseUrl: `${server.url}/v1` });
  return {
    port,
    reply: (r) => server.reply(r),
    lastRequest: () => {
      const b = server.seen.at(-1)?.body as
        | {
            model: string;
            max_tokens: number;
            tools?: Array<{ function: { name: string } }>;
            messages: Array<{ role: string; content: string }>;
          }
        | undefined;
      if (!b) return undefined;
      return {
        model: b.model,
        max_tokens: b.max_tokens,
        ...(b.tools
          ? { tools: b.tools.map((t) => ({ name: t.function.name, input_schema: {} })) }
          : {}),
        ...(b.messages[0]?.role === 'system' ? { system: b.messages[0].content } : {}),
      };
    },
    stop: () => server.stop(),
  };
});

const REQ = (over: Partial<ModelCompleteRequest> = {}): ModelCompleteRequest => ({
  model: 'codex-mini',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 50,
  metadata: { vkey_id: 'vk-7' },
  ...over,
});

describe('the Messages vocabulary as chat completions', () => {
  it('maps system, text, tool_use and tool_result blocks to chat messages', () => {
    const msgs = toChatMessages(
      REQ({
        system: 'be brief',
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'ok ' },
              { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: 'file text' },
              { type: 'text', text: 'now summarise' },
            ],
          },
        ],
      }),
    );
    expect(msgs).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'ok ',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file text' },
      { role: 'user', content: 'now summarise' },
    ]);
  });
});

describe('OpenAICompatProvider', () => {
  const withServer = async (
    fn: (
      s: Awaited<ReturnType<typeof startFakeOpenAIServer>>,
      p: OpenAICompatProvider,
    ) => Promise<void>,
    opts: {
      echoKeyInErrors?: boolean;
      streamDelayMs?: number;
      maxTokensParam?: 'max_completion_tokens';
    } = {},
  ) => {
    const s = await startFakeOpenAIServer({ apiKey: KEY, ...opts });
    try {
      await fn(
        s,
        new OpenAICompatProvider({
          apiKey: KEY,
          baseUrl: `${s.url}/v1`,
          ...(opts.maxTokensParam ? { maxTokensParam: opts.maxTokensParam } : {}),
        }),
      );
    } finally {
      await s.stop();
    }
  };

  it('sends the key as a bearer credential, the tools as functions, and only an opaque id as the user', () =>
    withServer(async (s, p) => {
      s.reply({
        tool_uses: [{ id: 'call_9', name: 'read_file', input: { path: 'src/a.ts' } }],
        usage: { input_tokens: 30, output_tokens: 6 },
      });
      const r = await p.complete(
        REQ({
          tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object' } }],
          tool_choice: { type: 'any' },
          temperature: 0.2,
          stop_sequences: ['END'],
        }),
      );
      expect(r).toMatchObject({
        ok: true,
        value: {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'call_9', name: 'read_file', input: { path: 'src/a.ts' } },
          ],
          usage: { input_tokens: 30, output_tokens: 6 },
        },
      });
      const seen = s.seen[0]!;
      expect(seen.headers['authorization']).toBe(`Bearer ${KEY}`);
      expect(seen.body).toMatchObject({
        model: 'codex-mini',
        max_tokens: 50,
        user: 'vk-7',
        temperature: 0.2,
        stop: ['END'],
        tool_choice: 'required',
        tools: [
          {
            type: 'function',
            function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
          },
        ],
      });
      expect(JSON.stringify(seen.body)).not.toContain(KEY);
    }));

  it('uses max_completion_tokens when the row says so', () =>
    withServer(
      async (s, p) => {
        s.reply({ text: 'x' });
        await p.complete(REQ());
        expect(s.seen[0]!.body['max_completion_tokens']).toBe(50);
        expect(s.seen[0]!.body['max_tokens']).toBeUndefined();
      },
      { maxTokensParam: 'max_completion_tokens' },
    ));

  it('maps finish reasons and refuses a reply with no usage or a tool call it cannot read', () =>
    withServer(async (s, p) => {
      s.reply({ text: 'cut off', stop_reason: 'max_tokens' });
      const r = await p.complete(REQ());
      expect(r.ok && r.value.stop_reason).toBe('max_tokens');
      // a fake that answers without usage
      const bad = new OpenAICompatProvider({
        apiKey: KEY,
        baseUrl: `${s.url}/v1`,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              id: 'x',
              choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
            }),
            { status: 200 },
          ),
      });
      const b = await bad.complete(REQ());
      expect(b).toMatchObject({ ok: false, error: { code: 'bad_response' } });
      const worse = new OpenAICompatProvider({
        apiKey: KEY,
        baseUrl: `${s.url}/v1`,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              id: 'x',
              choices: [
                {
                  message: {
                    tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{not json' } }],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200 },
          ),
      });
      expect(await worse.complete(REQ())).toMatchObject({
        ok: false,
        error: { code: 'bad_response' },
      });
    }));

  it('maps vendor statuses and never lets an echoed key out of an error', () =>
    withServer(
      async (s, p) => {
        for (const [code, want] of [
          ['rate_limited', 'rate_limited'],
          ['unavailable', 'unavailable'],
          ['invalid_request', 'invalid_request'],
          ['auth', 'auth'],
        ] as const) {
          s.reply({ error: modelProviderError(code, `vendor said ${code}`, 0) });
          const r = await p.complete(REQ());
          expect(r).toMatchObject({ ok: false, error: { code: want } });
          expect(JSON.stringify(r)).not.toContain(KEY);
        }
        // a wrong key: 401, whatever the server echoes
        const wrong = new OpenAICompatProvider({ apiKey: KEY + 'x', baseUrl: `${s.url}/v1` });
        const w = await wrong.complete(REQ());
        expect(w).toMatchObject({ ok: false, error: { code: 'auth' } });
        expect(JSON.stringify(w)).not.toContain(KEY);
        // an unreachable host is `unavailable`, not a throw
        const down = new OpenAICompatProvider({
          apiKey: KEY,
          baseUrl: 'http://127.0.0.1:1/v1',
          timeoutMs: 2_000,
        });
        expect(await down.complete(REQ())).toMatchObject({
          ok: false,
          error: { code: 'unavailable' },
        });
      },
      { echoKeyInErrors: true },
    ));

  it('streams text, and a tool call whole (start, input, done) with the usage of the final frame', () =>
    withServer(async (s, p) => {
      s.reply({
        text: 'looking ',
        tool_uses: [{ id: 'call_s', name: 'read_file', input: { path: 'b.ts' } }],
        usage: { input_tokens: 12, output_tokens: 5 },
      });
      const events = [];
      for await (const e of p.stream(REQ({ tools: [{ name: 'read_file', input_schema: {} }] })))
        events.push(e);
      expect(events.map((e) => e.type)).toEqual([
        'start',
        'text_delta',
        'tool_use_start',
        'tool_input_delta',
        'done',
      ]);
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        response: {
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'looking ' },
            { type: 'tool_use', id: 'call_s', name: 'read_file', input: { path: 'b.ts' } },
          ],
          usage: { input_tokens: 12, output_tokens: 5 },
        },
      });
      expect(s.seen[0]!.body).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
    }));

  it('a dropped connection mid-stream is an error event, an abort ends it quietly and reaches the vendor', () =>
    withServer(
      async (s, p) => {
        s.reply({ text: 'one two three', chunks: ['one ', 'two ', 'three'], fail_after_chunks: 1 });
        const ev = [];
        for await (const e of p.stream(REQ())) ev.push(e);
        expect(ev.at(-1)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
        const long = Array.from({ length: 100 }, (_, i) => `w${i} `);
        s.reply({ text: long.join(''), chunks: long });
        const ac = new AbortController();
        const got: string[] = [];
        const before = s.streamsAborted;
        for await (const e of p.stream(REQ(), { signal: ac.signal })) {
          got.push(e.type);
          if (e.type === 'text_delta') ac.abort();
        }
        expect(got).not.toContain('error');
        expect(got).not.toContain('done');
        const deadline = Date.now() + 3_000;
        while (s.streamsAborted === before && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 20));
        expect(s.streamsAborted).toBe(before + 1);
      },
      { streamDelayMs: 5 },
    ));
});
