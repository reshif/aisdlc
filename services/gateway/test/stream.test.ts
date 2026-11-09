import Anthropic from '@anthropic-ai/sdk';
import { makeCanary } from '@aisdlc/secrets-rules';
import { modelProviderError } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/anthropic-provider.js';
import { startFakeMessagesServer, type FakeMessagesServer } from '../src/fake-messages-server.js';
import {
  FAKE_MODEL,
  fakeRouting,
  hello,
  startTestGateway,
  type TestGateway,
} from '../src/testing.js';
import { modelProviderRow } from '@aisdlc/integrations';

// Streaming (`stream: true`) through the gateway: server-sent events in the Messages wire format, with
// redaction on the streamed text (secrets split across pieces), the tool allow-list enforced on streamed
// tool calls, metering from the final usage, and the budget reservation settled at the end or on abort.

let gw: TestGateway;
beforeAll(async () => {
  gw = await startTestGateway();
});
afterAll(() => gw.stop());

interface Frame {
  event: string;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a parsed wire frame, asserted field by field
}
function parseSse(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim() !== '')
    .map((b) => {
      const event = /^event: (.+)$/m.exec(b)?.[1] ?? '';
      const data = JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? 'null');
      return { event, data };
    });
}
async function stream(key: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${gw.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, ...headers },
    body: JSON.stringify({ ...(body as object), stream: true }),
  });
  const text = await res.text();
  return {
    res,
    text,
    frames: res.headers.get('content-type')?.includes('text/event-stream') ? parseSse(text) : [],
  };
}
const textOf = (frames: Frame[]) =>
  frames
    .filter((f) => f.event === 'content_block_delta' && f.data['delta'].type === 'text_delta')
    .map((f) => f.data['delta'].text as string)
    .join('');
const calls = async (vkey: string) =>
  (
    await gw.database.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'gateway.model_call' ORDER BY seq`,
      [`gateway:vkey:${vkey}`],
    )
  ).rows.map((r) => r.body as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('POST /v1/messages with stream: true', () => {
  it('answers with Messages server-sent events and meters the call from the final usage', async () => {
    const { key, vkey } = await gw.mint();
    gw.provider.enqueue({
      text: 'hello streamed world',
      usage: { input_tokens: 11, output_tokens: 4 },
    });
    const r = await stream(key, hello());
    expect(r.res.status).toBe(200);
    expect(r.frames.map((f) => f.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(r.frames[0]?.data['message']).toMatchObject({
      role: 'assistant',
      model: FAKE_MODEL.model_id,
    });
    expect(textOf(r.frames)).toBe('hello streamed world');
    expect(r.frames.at(-2)?.data).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 11, output_tokens: 4 },
    });
    // metered: one ModelCall event with the usage and the stream flag, no text; the group is settled
    const [call] = await calls(vkey.vkey_id);
    expect(call).toMatchObject({
      outcome: 'ok',
      tokens_in: 11,
      tokens_out: 4,
      stream: true,
      cost_micro_usd: 11 + 8,
    });
    expect(JSON.stringify(call)).not.toContain('streamed world');
    const g = await gw.admin().budgetGroup(vkey.budget_group);
    expect(g.ok && g.value).toMatchObject({
      used_tokens: 15,
      reserved_tokens: 0,
      reserved_cost_micro_usd: 0,
    });
  });

  it('catches a secret split across pieces: it never reaches the caller, and the count is recorded', async () => {
    const { key, vkey } = await gw.mint();
    const secret = makeCanary('split');
    const cut = 9;
    gw.provider.enqueue({
      text: `The deploy token is ${secret} and that is all.`,
      chunks: [
        'The deploy ',
        'token is ',
        secret.slice(0, cut),
        secret.slice(cut),
        ' and that ',
        'is all.',
      ],
      usage: { input_tokens: 5, output_tokens: 9 },
    });
    const r = await stream(key, hello());
    const out = textOf(r.frames);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(secret.slice(cut));
    expect(out).toContain('[REDACTED:aisdlc-canary]');
    expect(out).toContain('The deploy token is');
    expect(out).toContain('and that is all.');
    expect(r.text).not.toContain(secret.slice(cut));
    const [call] = await calls(vkey.vkey_id);
    expect(call).toMatchObject({ response_redactions: 1, stream: true });
    expect(JSON.stringify(call)).not.toContain(secret);
  });

  it('delivers long text whole (the held tail is released as it ages, and at the end)', async () => {
    const { key } = await gw.mint();
    const words = Array.from({ length: 400 }, (_, i) => `word${i} `);
    gw.provider.enqueue({ text: words.join(''), chunks: words });
    const r = await stream(key, hello());
    expect(textOf(r.frames)).toBe(words.join(''));
    // released before the end, not all at once
    expect(r.frames.filter((f) => f.event === 'content_block_delta').length).toBeGreaterThan(1);
  });

  it('streams an allowed tool call, redacting the secrets inside its input', async () => {
    const { key } = await gw.mint({ tools: ['read_file'] });
    const secret = makeCanary('toolin');
    gw.provider.enqueue({
      tool_uses: [{ id: 'toolu_a', name: 'read_file', input: { path: 'a.ts', note: secret } }],
    });
    const r = await stream(
      key,
      hello({ tools: [{ name: 'read_file', input_schema: { type: 'object' } }] }),
    );
    const start = r.frames.find(
      (f) => f.event === 'content_block_start' && f.data['content_block'].type === 'tool_use',
    );
    expect(start?.data['content_block']).toMatchObject({ id: 'toolu_a', name: 'read_file' });
    const json = r.frames
      .filter(
        (f) => f.event === 'content_block_delta' && f.data['delta'].type === 'input_json_delta',
      )
      .map((f) => f.data['delta'].partial_json)
      .join('');
    expect(JSON.parse(json)).toEqual({ path: 'a.ts', note: '[REDACTED:aisdlc-canary]' });
    expect(r.text).not.toContain(secret);
    expect(r.frames.at(-2)?.data['delta']).toMatchObject({ stop_reason: 'tool_use' });
  });

  it('aborts on a streamed tool call outside the key allow-list: nothing of it is delivered, the output is charged', async () => {
    const { key, vkey } = await gw.mint({ tools: ['read_file'] });
    gw.provider.enqueue({
      text: 'let me do that ',
      tool_uses: [{ name: 'delete_everything', input: { path: '/' } }],
      usage: { input_tokens: 20, output_tokens: 8 },
    });
    const r = await stream(key, hello());
    const last = r.frames.at(-1);
    expect(last?.event).toBe('error');
    expect(last?.data['error']).toMatchObject({ code: 'tool_not_allowed_in_response' });
    expect(r.frames.some((f) => f.event === 'message_stop')).toBe(false);
    expect(r.text).not.toContain('"input":{"path"');
    expect(r.frames.some((f) => f.data['content_block']?.type === 'tool_use')).toBe(false);
    const [call] = await calls(vkey.vkey_id);
    expect(call).toMatchObject({
      outcome: 'tool_blocked',
      refusal: 'tool_not_allowed_in_response',
      stream: true,
    });
    expect(call?.['tokens_out']).toBeGreaterThan(0);
    const g = await gw.admin().budgetGroup(vkey.budget_group);
    expect(g.ok && g.value.reserved_tokens).toBe(0);
  });

  it('a vendor that fails part-way ends the stream with an error event, charged for what was produced', async () => {
    const { key, vkey } = await gw.mint();
    gw.provider.enqueue({
      text: 'one two three four',
      chunks: ['one ', 'two ', 'three ', 'four'],
      fail_after_chunks: 2,
    });
    const r = await stream(key, hello());
    expect(r.frames.at(-1)?.event).toBe('error');
    expect(r.frames.some((f) => f.event === 'message_stop')).toBe(false);
    const [call] = await calls(vkey.vkey_id);
    expect(call).toMatchObject({ outcome: 'aborted', stream: true });
    expect(call?.['tokens_out']).toBeGreaterThan(0);
    const g = await gw.admin().budgetGroup(vkey.budget_group);
    expect(g.ok && g.value).toMatchObject({
      reserved_tokens: 0,
      used_tokens: call?.['tokens_in'] + call?.['tokens_out'],
    });
  });

  it('a vendor that fails before the stream starts is a JSON 502, nothing charged', async () => {
    const { key, vkey } = await gw.mint();
    gw.provider.enqueue({ error: modelProviderError('unavailable', 'down', 503) });
    const r = await stream(key, hello());
    expect(r.res.status).toBe(502);
    expect(JSON.parse(r.text).error.code).toBe('provider_error');
    const [call] = await calls(vkey.vkey_id);
    expect(call).toMatchObject({ outcome: 'provider_error', tokens_in: 0, tokens_out: 0 });
  });

  it('refuses before streaming: a JSON error, the same checks as a plain call', async () => {
    const { key } = await gw.mint({ tools: [] });
    const n = gw.provider.calls.length;
    const tool = await stream(key, hello({ tools: [{ name: 'rm', input_schema: {} }] }));
    expect(tool.res.status).toBe(403);
    expect(JSON.parse(tool.text).error.code).toBe('tool_not_allowed');
    const { key: k3 } = await gw.mint({ data_class_max: 'D3' });
    const d3 = await stream(k3, hello(), { 'x-aisdlc-data-class': 'D3' });
    expect(JSON.parse(d3.text).error.code).toBe('d3_never_routed');
    expect((await stream('aisk_' + '0'.repeat(48), hello())).res.status).toBe(401);
    expect(gw.provider.calls.length).toBe(n);
  });

  it('a spent budget refuses the stream with 429 and raises ET1; a stream that spends it raises ET1 at its end', async () => {
    const { key, vkey } = await gw.mint({
      budget: { max_tokens: 60, max_cost_micro_usd: 10_000_000 },
    });
    gw.provider.enqueue({ text: 'a b c', usage: { input_tokens: 30, output_tokens: 30 } });
    expect((await stream(key, hello({ max_tokens: 20 }))).res.status).toBe(200);
    const et1 = async () =>
      (
        await gw.database.pool.query(
          `SELECT count(*)::int AS n FROM record.record_event WHERE type = 'gateway.budget_exhausted' AND stream = $1`,
          [`gateway:budget:${vkey.budget_group}`],
        )
      ).rows[0].n as number;
    expect(await et1()).toBe(1);
    const again = await stream(key, hello());
    expect(again.res.status).toBe(429);
    expect(JSON.parse(again.text).error.code).toBe('budget_exhausted');
    expect(await et1()).toBe(1); // once per group
  });

  it('does not stream through a provider that cannot: a 400 before anything is sent', async () => {
    const quiet = await startTestGateway({
      adapters: {
        quiet: {
          kind: 'fake',
          tools_capable: true,
          complete: async () => {
            throw new Error('unused');
          },
        },
      },
      routing: {
        ...fakeRouting(),
        providers: [modelProviderRow('quiet', 'fake')],
        models: [{ ...FAKE_MODEL, provider_id: 'quiet' }],
      },
    });
    try {
      const { key } = await quiet.mint();
      const res = await fetch(`${quiet.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ ...hello(), stream: true }),
      });
      const txt = await res.text();
      expect(res.status, txt).toBe(400);
      expect((JSON.parse(txt) as { error: { code: string } }).error.code).toBe('invalid_request');
    } finally {
      await quiet.stop();
    }
  });
});

describe('the real Anthropic SDK and the Anthropic adapter, end to end', () => {
  let vendor: FakeMessagesServer;
  let g2: TestGateway;
  const KEY = ['sk', 'ant', 'api03', 'Qw8eR3tY'.repeat(6)].join('-');
  beforeAll(async () => {
    vendor = await startFakeMessagesServer({ apiKey: KEY, streamDelayMs: 5 });
    g2 = await startTestGateway({
      adapters: {
        anthropic: new AnthropicProvider({ apiKey: KEY, baseUrl: vendor.url, maxRetries: 0 }),
      },
      routing: {
        providers: [
          modelProviderRow('anthropic', 'anthropic', {
            credentials: [
              {
                credential_id: 'k',
                secret_ref: 'file:/run/secrets/anthropic-api-key',
                kind: 'api_key',
              },
            ],
          }),
        ],
        installs: [],
        models: [
          {
            ...FAKE_MODEL,
            model_id: 'claude-sonnet',
            provider_id: 'anthropic',
            provider_model: 'claude-sonnet-5-5',
          },
        ],
        routes: [{ environment: 'local', data_class: 'D2', model_id: 'claude-sonnet' }],
      },
    });
  });
  afterAll(async () => {
    await g2.stop();
    await vendor.stop();
  });

  it('runs the Anthropic SDK (what the Claude Agent SDK is built on) against the gateway in streaming mode', async () => {
    const { key } = await g2.mint({ models: ['claude-sonnet'], tools: ['read_file'] });
    vendor.reply({
      text: 'streamed through two hops',
      tool_uses: [{ id: 'toolu_sdk', name: 'read_file', input: { path: 'x' } }],
      usage: { input_tokens: 21, output_tokens: 7 },
    });
    // exactly how the Agent SDK is pointed at a gateway: ANTHROPIC_BASE_URL and the key
    const client = new Anthropic({ baseURL: g2.url, apiKey: key, maxRetries: 0 });
    const s = client.messages.stream({
      model: 'sonnet',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    });
    const texts: string[] = [];
    s.on('text', (t) => texts.push(t));
    const final = await s.finalMessage();
    expect(texts.join('')).toBe('streamed through two hops');
    expect(final.stop_reason).toBe('tool_use');
    expect(final.content.find((b) => b.type === 'tool_use')).toMatchObject({
      id: 'toolu_sdk',
      name: 'read_file',
      input: { path: 'x' },
    });
    expect(final.usage).toMatchObject({ input_tokens: 21, output_tokens: 7 });
    expect(vendor.seen.at(-1)?.body['stream']).toBe(true);
    // the vendor key went to the vendor only
    const sent = vendor.seen.at(-1)!.headers;
    expect(String(sent['x-api-key'] ?? sent['authorization'])).toContain(KEY);
  });

  it('a client that goes away mid-stream stops the vendor call and settles the reservation as aborted', async () => {
    const { key, vkey } = await g2.mint({ models: ['claude-sonnet'] });
    const aborted0 = vendor.streamsAborted;
    const long = Array.from({ length: 200 }, (_, i) => `piece${i} `);
    vendor.reply({ text: long.join(''), chunks: long });
    const ac = new AbortController();
    const res = await fetch(`${g2.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ ...hello(), model: 'sonnet', stream: true }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // the first bytes arrive
    ac.abort();
    await reader.cancel().catch(() => undefined);
    // the abort reaches the vendor, and the call is settled with what was produced
    const deadline = Date.now() + 5_000;
    let call: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    while (Date.now() < deadline) {
      [call] = await (async () =>
        (
          await g2.database.pool.query(
            `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'gateway.model_call'`,
            [`gateway:vkey:${vkey.vkey_id}`],
          )
        ).rows.map((x) => x.body))();
      if (call) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(call).toMatchObject({ outcome: 'aborted', stream: true });
    expect(vendor.streamsAborted).toBe(aborted0 + 1);
    const grp = await g2.admin().budgetGroup(vkey.budget_group);
    expect(grp.ok && grp.value.reserved_tokens).toBe(0);
  });
});
