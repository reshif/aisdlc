import type { ModelCompleteRequest } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  modelProviderError,
  type ModelProviderPort,
  type ScriptedReply,
} from './model-provider.js';

// The ModelProviderPort contract suite (PLAN M10.1). `modelProviderContract` runs against any adapter
// that can be SCRIPTED: the FakeProvider, and the Anthropic adapter over the in-repo fake Messages
// API server. Both answer in the one shared vocabulary, with the same error codes.

export interface ModelProviderHarness {
  port: ModelProviderPort;
  /** The next call answers like this (the harness's own way of making a vendor say it). */
  reply(r: ScriptedReply): void;
  /** What the vendor side saw last, in the shared vocabulary (at least tools, max_tokens, model, system). */
  lastRequest():
    Pick<ModelCompleteRequest, 'model' | 'max_tokens' | 'tools' | 'system'> | undefined;
  stop?: () => Promise<void>;
}

const REQ = (over: Partial<ModelCompleteRequest> = {}): ModelCompleteRequest => ({
  model: 'claude-sonnet-5-5',
  system: 'you are a terse assistant',
  messages: [{ role: 'user', content: 'say hello' }],
  max_tokens: 64,
  metadata: { vkey_id: 'vk-1' },
  ...over,
});

export function modelProviderContract(
  name: string,
  make: () => Promise<ModelProviderHarness>,
): void {
  describe(`ModelProviderPort contract: ${name}`, () => {
    const withHarness = async (fn: (h: ModelProviderHarness) => Promise<void>) => {
      const h = await make();
      try {
        await fn(h);
      } finally {
        await h.stop?.();
      }
    };

    it('completes a text turn with usage and a stop reason', () =>
      withHarness(async (h) => {
        h.reply({ text: 'hello there', usage: { input_tokens: 11, output_tokens: 3 } });
        const r = await h.port.complete(REQ());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.content).toEqual([{ type: 'text', text: 'hello there' }]);
        expect(r.value.stop_reason).toBe('end_turn');
        expect(r.value.usage).toEqual({ input_tokens: 11, output_tokens: 3 });
        expect(r.value.model).toBeTruthy();
        expect(r.value.id).toBeTruthy();
        expect(h.lastRequest()?.system).toBe('you are a terse assistant');
        expect(h.lastRequest()?.max_tokens).toBe(64);
      }));

    it('carries tools out and answers tool_use with the call intact', () =>
      withHarness(async (h) => {
        if (!h.port.tools_capable) return;
        h.reply({
          tool_uses: [{ id: 'toolu_1', name: 'read_file', input: { path: 'src/a.ts' } }],
          usage: { input_tokens: 40, output_tokens: 9 },
        });
        const r = await h.port.complete(
          REQ({
            tools: [
              {
                name: 'read_file',
                description: 'read a file',
                input_schema: { type: 'object', properties: { path: { type: 'string' } } },
              },
            ],
          }),
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.stop_reason).toBe('tool_use');
        const use = r.value.content.find((b) => b.type === 'tool_use');
        expect(use).toMatchObject({ name: 'read_file', input: { path: 'src/a.ts' } });
        expect(h.lastRequest()?.tools?.map((t) => t.name)).toEqual(['read_file']);
      }));

    it('sends no tools when none are given', () =>
      withHarness(async (h) => {
        h.reply({ text: 'ok' });
        await h.port.complete(REQ());
        expect(h.lastRequest()?.tools ?? []).toEqual([]);
      }));

    it('maps a vendor refusal to a tagged error and never throws', () =>
      withHarness(async (h) => {
        h.reply({ error: modelProviderError('rate_limited', 'slow down', 429) });
        const r = await h.port.complete(REQ());
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('rate_limited');
      }));

    it('maps an unavailable vendor to unavailable', () =>
      withHarness(async (h) => {
        h.reply({ error: modelProviderError('unavailable', 'down', 503) });
        const r = await h.port.complete(REQ());
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('unavailable');
      }));

    it('streams, when it can, the same completion as complete', () =>
      withHarness(async (h) => {
        if (!h.port.stream) return;
        h.reply({ text: 'a b c', usage: { input_tokens: 5, output_tokens: 2 } });
        let text = '';
        let done: unknown;
        for await (const e of h.port.stream(REQ())) {
          if (e.type === 'text_delta') text += e.text;
          else done = e.response;
        }
        expect(text).toBe('a b c');
        expect(done).toMatchObject({ usage: { input_tokens: 5, output_tokens: 2 } });
      }));
  });
}
