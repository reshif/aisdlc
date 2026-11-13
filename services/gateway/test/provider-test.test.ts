import { GATEWAY_ADMIN_STREAM, GATEWAY_EVENT, ProviderTestResult } from '@aisdlc/contracts';
import { modelProviderError } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestGateway, type TestGateway } from '../src/testing.js';

// P2-5: the portal's "Test connection" for one provider. One tiny call through the spend guard and the kill switch,
// metered as `gateway.provider_tested` on the admin stream, never any text; the bff's `operate` scope may test and
// reload and nothing else.

let gw: TestGateway;
beforeAll(async () => {
  gw = await startTestGateway({
    callers: { core: ['admin', 'read'], observer: ['read'], bff: ['operate'] },
  });
});
afterAll(async () => {
  await gw.stop();
});

const post = (token: string | undefined, path: string, body: unknown) =>
  fetch(`${gw.url}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));

async function tested() {
  const q = await gw.database.pool.query<{ body: Record<string, unknown> }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq`,
    [GATEWAY_ADMIN_STREAM, GATEWAY_EVENT.provider_tested],
  );
  return q.rows.map((r) => r.body);
}

describe('POST /v1/admin/providers/:id/test', () => {
  it('makes one tiny call with the operate scope and records it, with no text', async () => {
    gw.provider.enqueue({
      text: 'pong, a secret answer',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    const before = gw.service.providerCallCount;
    const r = await post(gw.tokens['bff'], '/v1/admin/providers/fake/test', { tested_by: 'ada' });
    expect(r.status).toBe(200);
    const v = ProviderTestResult.parse(r.json);
    expect(v).toMatchObject({ integration_id: 'fake', outcome: 'ok', tokens_in: 3, tokens_out: 1 });
    expect(v.model_id).not.toBeNull();
    expect(gw.service.providerCallCount).toBe(before + 1);
    const rows = await tested();
    expect(rows.at(-1)).toMatchObject({ integration_id: 'fake', outcome: 'ok', tested_by: 'ada' });
    expect(JSON.stringify(rows)).not.toContain('pong');
    expect(JSON.stringify(rows)).not.toContain('ping');
  });

  it('a vendor failure is provider_error with its class only; an unknown provider is not_built', async () => {
    gw.provider.enqueue({ error: modelProviderError('auth', 'key sk-ant-xyz was refused', 401) });
    const bad = await post(gw.tokens['bff'], '/v1/admin/providers/fake/test', { tested_by: 'ada' });
    expect(bad.json).toMatchObject({ outcome: 'provider_error', code: 'auth' });
    expect(JSON.stringify(bad.json)).not.toContain('sk-ant');
    expect(gw.service.providerEvidence('fake').state).toBe('down');
    const none = await post(gw.tokens['bff'], '/v1/admin/providers/nobody/test', {
      tested_by: 'ada',
    });
    expect(none.json).toMatchObject({ outcome: 'not_built', model_id: null });
  });

  it('a killed fleet, or a kill switch that does not answer, refuses the test (fail closed)', async () => {
    const id = gw.kill.kill({ kind: 'fleet', ref: '*' });
    const killed = await post(gw.tokens['bff'], '/v1/admin/providers/fake/test', {
      tested_by: 'ada',
    });
    expect(killed.json).toMatchObject({ outcome: 'refused', code: 'killed', tokens_in: 0 });
    gw.kill.release(id);
    gw.kill.breakIt();
    const down = await post(gw.tokens['bff'], '/v1/admin/providers/fake/test', {
      tested_by: 'ada',
    });
    expect(down.json).toMatchObject({ outcome: 'refused', code: 'kill_switch_unreachable' });
    gw.kill.breakIt(false);
  });

  it('needs admin or operate and says who asked; operate opens nothing else', async () => {
    expect(
      (await post(undefined, '/v1/admin/providers/fake/test', { tested_by: 'x' })).status,
    ).toBe(401);
    expect(
      (await post(gw.tokens['observer'], '/v1/admin/providers/fake/test', { tested_by: 'x' }))
        .status,
    ).toBe(403);
    expect((await post(gw.tokens['bff'], '/v1/admin/providers/fake/test', {})).status).toBe(400);
    expect(
      (
        await post(gw.tokens['bff'], '/v1/admin/budget-groups', {
          group_id: 'g',
          max_tokens: 1,
          max_cost_micro_usd: 1,
        })
      ).status,
    ).toBe(403);
  });
});
