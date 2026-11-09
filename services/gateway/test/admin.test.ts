import { GATEWAY_EVENT, ProjectId, VKEY_SECRET_PATTERN } from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hello, startTestGateway, type TestGateway } from '../src/testing.js';

let gw: TestGateway;
beforeAll(async () => {
  gw = await startTestGateway();
});
afterAll(async () => {
  await gw.stop();
});

const call = (token: string | null, method: string, path: string, body?: unknown) =>
  fetch(`${gw.url}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> })); // eslint-disable-line @typescript-eslint/no-explicit-any -- a parsed test response, indexed freely

const mintBody = (group: string) => ({
  scope: { kind: 'job' as const, ref: 'job-1' },
  project_id: ProjectId.parse('testbed'),
  data_class_max: 'D1' as const,
  models: ['fake-model'],
  tools: ['read_file'],
  budget_group: group,
  expires_at: new Date(gw.clock.nowMs() + 60_000).toISOString(),
});

describe('the admin API', () => {
  it('needs a service token with the right scope', async () => {
    expect((await call(null, 'POST', '/v1/admin/budget-groups', {})).status).toBe(401);
    expect((await call('x'.repeat(40), 'POST', '/v1/admin/budget-groups', {})).status).toBe(401);
    const body = { group_id: 'g-admin', max_tokens: 1000, max_cost_micro_usd: 5000 };
    expect(
      (await call(gw.tokens['observer']!, 'POST', '/v1/admin/budget-groups', body)).status,
    ).toBe(403);
    const created = await call(gw.tokens['core']!, 'POST', '/v1/admin/budget-groups', body);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ group_id: 'g-admin', used_tokens: 0, exhausted_at: null });
    expect((await call(gw.tokens['core']!, 'POST', '/v1/admin/budget-groups', body)).status).toBe(
      200,
    );
    expect(
      (
        await call(gw.tokens['core']!, 'POST', '/v1/admin/budget-groups', {
          ...body,
          max_tokens: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(gw.tokens['observer']!, 'GET', '/v1/admin/budget-groups/g-admin')).status,
    ).toBe(200);
    expect((await call(gw.tokens['observer']!, 'GET', '/v1/admin/budget-groups/none')).status).toBe(
      404,
    );
    const m = await call(gw.tokens['observer']!, 'POST', '/v1/admin/vkeys', mintBody('g-admin'));
    expect(m.status).toBe(403);
  });

  it('mints a key whose secret is returned once and stored only as a hash', async () => {
    const client = gw.admin();
    expect(
      (
        await client.createBudgetGroup({
          group_id: 'g-mint',
          max_tokens: 1000,
          max_cost_micro_usd: 5000,
        })
      ).ok,
    ).toBe(true);
    const m = await client.mintVKey({
      ...mintBody('g-mint'),
      scope: { kind: 'session', ref: 's1' },
      project_id: 'testbed' as never,
    });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.key).toMatch(VKEY_SECRET_PATTERN);
    // read back: the view holds no secret and no hash
    const view = await client.vkey(m.value.vkey.vkey_id);
    expect(view.ok && JSON.stringify(view.value)).not.toContain(m.value.key);
    const row = await gw.database.pool.query('SELECT * FROM gateway.vkey WHERE vkey_id = $1', [
      m.value.vkey.vkey_id,
    ]);
    const dump = JSON.stringify(row.rows);
    expect(dump).not.toContain(m.value.key);
    expect(row.rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    const events = JSON.stringify(
      (await gw.database.pool.query('SELECT body FROM record.record_event')).rows,
    );
    expect(events).not.toContain(m.value.key);
    expect(events).not.toContain(row.rows[0].key_hash);
    // the minted key works
    expect((await gw.messages(m.value.key, hello())).status).toBe(200);
  });

  it('records the mint and the revocation as record events, and revocation stops the key at once', async () => {
    const { key, vkey } = await gw.mint();
    expect((await gw.messages(key, hello())).status).toBe(200);
    const r = await gw.admin().revokeVKey(vkey.vkey_id);
    expect(r.ok && r.value.revoked_at).toBeTruthy();
    expect((await gw.messages(key, hello())).status).toBe(401);
    // revoking twice is one event
    await gw.admin().revokeVKey(vkey.vkey_id);
    const ev = await gw.database.pool.query(
      `SELECT type FROM record.record_event WHERE stream = 'gateway:admin' AND body->>'vkey_id' = $1 ORDER BY global_seq`,
      [vkey.vkey_id],
    );
    expect(ev.rows.map((x) => x.type)).toEqual([
      GATEWAY_EVENT.vkey_minted,
      GATEWAY_EVENT.vkey_revoked,
    ]);
    expect((await gw.admin().revokeVKey('00000000-0000-4000-8000-000000000000')).ok).toBe(false);
  });

  it('refuses a malformed mint, a key in the past, and an unknown budget group', async () => {
    const t = gw.tokens['core']!;
    expect(
      (await call(t, 'POST', '/v1/admin/vkeys', { ...mintBody('g-admin'), data_class_max: 'D9' }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(t, 'POST', '/v1/admin/vkeys', {
          ...mintBody('g-admin'),
          expires_at: '2020-01-01T00:00:00.000Z',
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(t, 'POST', '/v1/admin/vkeys', { ...mintBody('g-admin'), extra: 1 })).status,
    ).toBe(400);
    expect((await call(t, 'POST', '/v1/admin/vkeys', mintBody('nope'))).status).toBe(403);
  });

  it('a virtual key opens nothing of the admin API, and a service token is no virtual key', async () => {
    const { key } = await gw.mint();
    expect((await call(key, 'POST', '/v1/admin/vkeys', mintBody('g-admin'))).status).toBe(401);
    expect((await call(key, 'GET', '/v1/admin/budget-groups/g-admin')).status).toBe(401);
    const r = await fetch(`${gw.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gw.tokens['core']}`, 'content-type': 'application/json' },
      body: JSON.stringify(hello()),
    });
    expect(r.status).toBe(401);
  });
});
