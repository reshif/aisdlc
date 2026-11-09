import { describe, expect, it } from 'vitest';
import { modelProviderContract } from '@aisdlc/ports/testing';
import { modelProviderError } from '@aisdlc/ports';
import { AnthropicProvider } from '../src/anthropic-provider.js';
import { startFakeMessagesServer } from '../src/fake-messages-server.js';

// The key of these tests is made up here; there is no real key, no real host and no real call.
const KEY = ['sk', 'ant', 'test', 'f4k3k3y'.repeat(4)].join('-');

modelProviderContract('AnthropicProvider over the fake Messages API', async () => {
  const server = await startFakeMessagesServer({ apiKey: KEY });
  const port = new AnthropicProvider({ apiKey: KEY, baseUrl: server.url, maxRetries: 0 });
  return {
    port,
    reply: (r) => server.reply(r),
    lastRequest: () => {
      const b = server.seen.at(-1)?.body as
        | { model: string; max_tokens: number; tools?: Array<{ name: string }>; system?: string }
        | undefined;
      return b as never;
    },
    stop: () => server.stop(),
  };
});

describe('AnthropicProvider', () => {
  it('sends the key as a credential header, a version header and the configured model for a family alias', async () => {
    const server = await startFakeMessagesServer({ apiKey: KEY });
    try {
      const p = new AnthropicProvider({ apiKey: KEY, baseUrl: server.url, maxRetries: 0 });
      const req = {
        model: 'haiku',
        messages: [{ role: 'user' as const, content: 'hi' }],
        max_tokens: 5,
        metadata: { vkey_id: 'vk-9' },
      };
      expect((await p.complete(req)).ok).toBe(true);
      const seen = server.seen[0]!;
      expect(seen.headers['x-api-key'] ?? seen.headers['authorization']).toContain(KEY);
      expect(seen.headers['anthropic-version']).toBeTruthy();
      expect(seen.body['model']).toBe('claude-haiku-5-5');
      expect(seen.body['metadata']).toEqual({ user_id: 'vk-9' });
      expect(p.resolveModel('opus')).toBe('claude-opus-5-5');
      expect(p.resolveModel('sonnet')).toBe('claude-sonnet-5-5');
      expect(p.resolveModel('claude-x')).toBe('claude-x');
      const custom = new AnthropicProvider({
        apiKey: KEY,
        baseUrl: server.url,
        models: { opus: 'o', sonnet: 's', haiku: 'h' },
      });
      expect(custom.resolveModel('haiku')).toBe('h');
    } finally {
      await server.stop();
    }
  });

  it('maps vendor statuses and never lets an echoed key out of an error', async () => {
    const server = await startFakeMessagesServer({ apiKey: KEY, echoKeyInErrors: true });
    try {
      const p = new AnthropicProvider({ apiKey: KEY, baseUrl: server.url, maxRetries: 0 });
      server.reply(
        { error: modelProviderError('auth', 'bad') },
        { error: modelProviderError('invalid_request', 'nope') },
        { error: modelProviderError('unavailable', 'down') },
      );
      const req = {
        model: 'm',
        messages: [{ role: 'user' as const, content: 'hi' }],
        max_tokens: 5,
        metadata: {},
      };
      const codes = [];
      for (let i = 0; i < 3; i++) {
        const r = await p.complete(req);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          codes.push(r.error.code);
          expect(JSON.stringify(r.error)).not.toContain(KEY);
        }
      }
      expect(codes).toEqual(['auth', 'invalid_request', 'unavailable']);
    } finally {
      await server.stop();
    }
  });

  it('answers unavailable when nothing listens, without the key in the message', async () => {
    const p = new AnthropicProvider({
      apiKey: KEY,
      baseUrl: 'http://127.0.0.1:1',
      maxRetries: 0,
      timeoutMs: 2000,
    });
    const r = await p.complete({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
      metadata: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('unavailable');
      expect(JSON.stringify(r.error)).not.toContain(KEY);
    }
  });

  it('refuses to be built without a key', () => {
    expect(() => new AnthropicProvider({ apiKey: ' ' })).toThrow();
  });
});
