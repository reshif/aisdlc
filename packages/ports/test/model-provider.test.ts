import { describe, expect, it } from 'vitest';
import { FakeProvider, modelProviderError } from '../src/index.js';
import { modelProviderContract } from '../src/testing.js';

modelProviderContract('FakeProvider', async () => {
  const port = new FakeProvider();
  return {
    port,
    reply: (r) => void port.enqueue(r),
    lastRequest: () => port.calls.at(-1),
  };
});

describe('FakeProvider', () => {
  const req = {
    model: 'm',
    messages: [{ role: 'user' as const, content: 'hi' }],
    max_tokens: 10,
    metadata: {},
  };

  it('answers deterministically with estimated usage when nothing is scripted', async () => {
    const a = await new FakeProvider().complete(req);
    const b = await new FakeProvider().complete(req);
    expect(a).toEqual(b);
    expect(a.ok && a.value.usage.input_tokens).toBeGreaterThan(0);
    expect(a.ok && a.value.content).toEqual([{ type: 'text', text: 'fake reply 1' }]);
  });

  it('runs scripted functions on the request and records every call', async () => {
    const p = new FakeProvider({
      script: [
        (r) => ({ text: `max=${r.max_tokens}` }),
        { error: modelProviderError('auth', 'no') },
      ],
    });
    const first = await p.complete(req);
    expect(first.ok && first.value.content[0]).toEqual({ type: 'text', text: 'max=10' });
    const second = await p.complete(req);
    expect(second.ok).toBe(false);
    expect(p.calls).toHaveLength(2);
  });
});
