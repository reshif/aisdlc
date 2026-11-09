import { modelProviderRow } from '@aisdlc/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelProviderError } from '@aisdlc/ports';
import { AnthropicProvider } from '../src/anthropic-provider.js';
import { startFakeMessagesServer, type FakeMessagesServer } from '../src/fake-messages-server.js';
import { FAKE_MODEL, hello, startTestGateway, type TestGateway } from '../src/testing.js';

// The vendor key lives in the adapter and nowhere else. This test gives the gateway a key (made up
// here), a vendor that echoes it in every error (the worst case), and then looks for it, and for
// every credential, in everything the gateway ever said or wrote.

const KEY = ['sk', 'ant', 'api03', 'Zk9wQ2xN'.repeat(6)].join('-');

let vendor: FakeMessagesServer;
let gw: TestGateway;
beforeAll(async () => {
  vendor = await startFakeMessagesServer({ apiKey: KEY, echoKeyInErrors: true });
  const anthropic = new AnthropicProvider({ apiKey: KEY, baseUrl: vendor.url, maxRetries: 0 });
  gw = await startTestGateway({
    adapters: { anthropic },
    routing: {
      providers: [
        modelProviderRow('anthropic', 'anthropic', {
          credentials: [
            {
              credential_id: 'key',
              secret_ref: 'file:/run/secrets/anthropic-api-key',
              kind: 'api_key',
            },
          ],
        }),
      ],
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
  await gw.stop();
  await vendor.stop();
});

describe('the vendor key', () => {
  it('reaches the vendor, and appears in no response, log line, record event, table or metric', async () => {
    const lines: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    console.error = console.log;
    console.warn = console.log;
    console.info = console.log;
    const responses: string[] = [];
    const secrets: string[] = [];
    try {
      const { key, vkey } = await gw.mint({
        models: ['claude-sonnet'],
        data_class_max: 'D2',
        tools: ['read_file'],
      });
      secrets.push(key);
      const send = async (body: unknown, headers: Record<string, string> = {}) => {
        const r = await gw.messages(key, body, headers);
        responses.push(JSON.stringify(r));
        return r;
      };
      vendor.reply({ text: 'fine', usage: { input_tokens: 9, output_tokens: 2 } });
      expect((await send(hello())).status).toBe(200);
      expect(
        String(
          vendor.seen.at(-1)?.headers['x-api-key'] ?? vendor.seen.at(-1)?.headers['authorization'],
        ),
      ).toContain(KEY);
      // the vendor fails in every way and echoes the key each time
      for (const code of [
        'auth',
        'rate_limited',
        'unavailable',
        'invalid_request',
        'bad_response',
      ] as const) {
        vendor.reply({ error: modelProviderError(code, `vendor said ${code}`) });
        const r = await send(hello());
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      // refusals
      await send(hello(), { 'x-aisdlc-data-class': 'D3' });
      await send(hello({ tools: [{ name: 'run_shell', input_schema: {} }] }));
      await send({ nonsense: true });
      await gw.messages('aisk_' + 'b'.repeat(48), hello());
      // admin surfaces
      for (const [m, p] of [
        ['GET', `/v1/admin/vkeys/${vkey.vkey_id}`],
        ['GET', `/v1/admin/budget-groups/${vkey.budget_group}`],
        ['GET', '/healthz'],
        ['GET', '/metrics'],
        ['GET', '/v1/nope'],
      ] as const) {
        const r = await fetch(`${gw.url}${p}`, {
          method: m,
          headers: { authorization: `Bearer ${gw.tokens['core']}` },
        });
        responses.push(`${r.status} ${await r.text()}`);
      }
      await gw.service.revoke(vkey.vkey_id, 'core');
    } finally {
      Object.assign(console, orig);
    }

    const tables = await gw.database.pool.query(
      `SELECT row_to_json(t)::text AS j FROM (
         SELECT body::text, type, stream FROM record.record_event
         UNION ALL SELECT to_jsonb(v)::text, 'vkey', '' FROM gateway.vkey v
         UNION ALL SELECT to_jsonb(b)::text, 'group', '' FROM gateway.budget_group b) t`,
    );
    const haystack = [...responses, ...lines, ...tables.rows.map((r) => r.j as string)].join('\n');
    expect(haystack.length).toBeGreaterThan(1000);
    const body = KEY.split('-').slice(-1)[0] as string;
    for (const needle of [KEY, body, ...secrets]) {
      expect(haystack.includes(needle), `output contains ${needle.slice(0, 10)}...`).toBe(false);
    }
    // the service tokens are not echoed either
    for (const t of Object.values(gw.tokens)) expect(haystack.includes(t)).toBe(false);
    // and the calls really did go to the vendor with the key (the test could not pass by never calling)
    expect(vendor.seen.length).toBeGreaterThanOrEqual(6);
  });
});
