import { ConfigReader, configPublish, proposeRevision, type ConfigDeps } from '@aisdlc/config';
import {
  GATEWAY_CONFIG_KEYS,
  INTEGRATION_CONFIG_KEYS,
  type GatewayModel,
  type GatewayRoute,
} from '@aisdlc/contracts';
import { modelProviderRow } from '@aisdlc/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_MODEL, hello, startTestGateway, type TestGateway } from '../src/testing.js';
import { decideGate, pr, startM1Stack, type M1Stack } from './m1-stack.js';

// PLAN M10.2: the routing table is config. A route to D2 or lower is added or changed by a
// revision, and a revision is an M1 gate: nothing routes until a human decided it. The gateway
// follows the published revision without a restart, and D3 is not a thing the registry can hold.

let s: M1Stack;
let reader: ConfigReader;
let gw: TestGateway;
beforeAll(async () => {
  s = await startM1Stack();
  reader = await ConfigReader.create({
    pool: s.record.pool,
    registry: s.deps.registry,
    pollIntervalMs: 0,
  });
  await reader.start();
  gw = await startTestGateway({ database: s.record, config: reader });
});
afterAll(async () => {
  await reader.stop();
  await gw.stop();
  await s.stop();
});

const modelB: GatewayModel = {
  ...FAKE_MODEL,
  model_id: 'fake-model-b',
  provider_model: 'fake-model-b-1',
};
const base = {
  [INTEGRATION_CONFIG_KEYS.registry]: [modelProviderRow('fake', 'fake')],
  [GATEWAY_CONFIG_KEYS.models]: [FAKE_MODEL, modelB],
};
const routes = (...r: GatewayRoute[]) => ({ ...base, [GATEWAY_CONFIG_KEYS.routes]: r });

async function propose(doc: Record<string, unknown>) {
  const p = await proposeRevision(s.deps as ConfigDeps, {
    layer: 'factory',
    doc,
    proposed_by: pr('dev'),
  });
  if (!p.ok) throw new Error(`propose: ${p.error.code}: ${p.error.message}`);
  return p.value;
}
async function approveAndPublish(p: { rev_hash: string; gate_instance_id: string }) {
  const d = await decideGate(s, p.gate_instance_id, 'root', 'approve');
  if (!d.ok) throw new Error(`decide: ${JSON.stringify(d.error)}`);
  const r = await configPublish(s.deps, { rev_hash: p.rev_hash });
  if (!r.ok) throw new Error(`publish: ${r.error.message}`);
}
const waitForChange = () =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the reader did not see the revision')), 10_000);
    const off = reader.subscribe(() => {
      clearTimeout(t);
      off();
      resolve();
    });
  });

describe('the routing table as gated config', () => {
  it('refuses a D3 route in the registry: the document is refused before any approver sees it', async () => {
    const before = await s.record.pool.query('SELECT count(*) FROM record.record_event');
    const r = await proposeRevision(s.deps, {
      layer: 'factory',
      doc: routes({ environment: 'local', data_class: 'D3' as never, model_id: 'fake-model' }),
      proposed_by: pr('dev'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_value');
    const after = await s.record.pool.query('SELECT count(*) FROM record.record_event');
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('refuses duplicate routes, and a project layer cannot set any of the three keys', async () => {
    const dup = await proposeRevision(s.deps, {
      layer: 'factory',
      doc: routes(
        { environment: 'local', data_class: 'D1', model_id: 'fake-model' },
        { environment: 'local', data_class: 'D1', model_id: 'fake-model-b' },
      ),
      proposed_by: pr('dev'),
    });
    expect(dup.ok).toBe(false);
    for (const key of Object.values(GATEWAY_CONFIG_KEYS)) {
      const p = await proposeRevision(s.deps, {
        layer: 'project',
        scope: { kind: 'project', ref: 'p1' },
        doc: { [key]: [] },
        proposed_by: pr('dev'),
      });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.error.code).toBe('not_overridable');
    }
  });

  it('routes nothing until a revision is published, then follows it without a restart', async () => {
    const { key } = await gw.mint();
    // a fresh factory: no route, the call is refused (fail closed)
    expect((await gw.messages(key, hello())).json.error.code).toBe('no_route');

    // adding a route to D2 is a gated change: the proposal opens an M1 gate, and publishing is refused until it is decided
    const p = await propose(
      routes({ environment: 'local', data_class: 'D2', model_id: 'fake-model' }),
    );
    const gate = await s.record.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND seq = 1`,
      [`gate:${p.gate_instance_id}`],
    );
    expect(gate.rows[0].body).toMatchObject({
      gate_id: 'M1',
      subject_kind: 'config',
      subject_hash: p.rev_hash,
    });
    const early = await configPublish(s.deps, { rev_hash: p.rev_hash });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.code).toBe('not_decided');
    await reader.refresh();
    expect((await gw.messages(key, hello())).json.error.code).toBe('no_route');

    // the human decides; the gateway (same instance, same reader) serves the route from the next call
    const changed = waitForChange();
    await approveAndPublish(p);
    await changed; // pushed by NOTIFY, not polled and not restarted
    const ok = await gw.messages(key, hello());
    expect(ok.status).toBe(200);
    expect(gw.provider.calls.at(-1)?.model).toBe('fake-model-1');
    // D1 still has no route
    expect((await gw.messages(key, hello(), { 'x-aisdlc-data-class': 'D1' })).json.error.code).toBe(
      'no_route',
    );
  });

  it('changes a route by a new gated revision: the old model serves until the decision, the new one after', async () => {
    const { key } = await gw.mint({ models: ['fake-model', 'fake-model-b'] });
    const p = await propose(
      routes({ environment: 'local', data_class: 'D2', model_id: 'fake-model-b' }),
    );
    await gw.messages(key, hello());
    expect(gw.provider.calls.at(-1)?.model).toBe('fake-model-1'); // proposed only: not in force
    const changed = waitForChange();
    await approveAndPublish(p);
    await changed;
    await gw.messages(key, hello());
    expect(gw.provider.calls.at(-1)?.model).toBe('fake-model-b-1');
  });

  it('never applies a rejected revision', async () => {
    const { key } = await gw.mint({ models: ['fake-model', 'fake-model-b'] });
    const p = await propose(
      routes({ environment: 'local', data_class: 'D2', model_id: 'fake-model' }),
    );
    expect((await decideGate(s, p.gate_instance_id, 'root', 'reject')).ok).toBe(true);
    const r = await configPublish(s.deps, { rev_hash: p.rev_hash });
    expect(r.ok).toBe(false);
    await reader.refresh();
    await gw.messages(key, hello());
    expect(gw.provider.calls.at(-1)?.model).toBe('fake-model-b-1'); // still the published one
  });

  it('switches a provider off by a gated revision, and the next call is refused', async () => {
    const { key } = await gw.mint({ models: ['fake-model-b'] });
    const doc = {
      ...routes({ environment: 'local', data_class: 'D2', model_id: 'fake-model-b' }),
      [INTEGRATION_CONFIG_KEYS.registry]: [
        modelProviderRow('fake', 'fake', { status: 'disabled' }),
      ],
    };
    const p = await propose(doc);
    const changed = waitForChange();
    await approveAndPublish(p);
    await changed;
    expect((await gw.messages(key, hello())).json.error.code).toBe('route_broken');
  });
});
