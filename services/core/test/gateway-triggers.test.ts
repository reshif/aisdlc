import { GATEWAY_EVENT, ITEM_EVENT, type Lane } from '@aisdlc/contracts';
import { hello, startTestGateway, type TestGateway } from '@aisdlc/gateway/testing';
import { err } from '@aisdlc/kernel';
import { FakeStagePorts, StagePortError } from '@aisdlc/ports';
import { appendEvents } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  driveWork,
  gatewayCursor,
  observeGatewayTriggers,
  readItem,
  readItemEvents,
  submitRequest,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// PLAN M10.3 acceptance: budget exhaustion stops a session and raises ET1, and the work item hands
// off (D1). The REAL gateway runs on the same record database; it writes `gateway.budget_exhausted`
// when a per-Unit budget runs out, and core's observer turns that into the item's ET1 trigger, which
// the interpreter turns into the D1 handoff (E4 to the owner of record).

let s: CoreStack;
let gw: TestGateway;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  gw = await startTestGateway({ database: s.record });
});
afterAll(async () => {
  await gw.stop();
  await s.stop();
});

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

let n = 0;
/** An L3 item that sits at S6 with its coding command unanswered. */
async function itemAtS6() {
  n += 1;
  const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
  approvers(s, seeded.project, ['bob']);
  const r = ok(
    await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: 'L3' as Lane,
      requester: pr('alice'),
      channel: 'N1',
      text: `gateway budget test ${n}`,
    }),
  );
  const ports = new FakeStagePorts();
  // the lease (6.0) is granted; every later coding step finds the port down, so the session is "running"
  const lease = ports.coding.run.bind(ports.coding);
  ports.coding.run = async (req) =>
    req.step === '6.0' ? lease(req) : err(StagePortError({ message: 'coding port busy' }));
  const d = driverOver(s, { ports });
  const itemId = r.item_id as string;
  await runItem(s, d, itemId, { stop: (q) => q.underlying === 'S6' && q.outstanding.length > 0 });
  const st = (await readItem(s.record.pool, itemId))?.state;
  expect(st?.underlying).toBe('S6');
  return { ...seeded, itemId, d };
}

describe('ET1 from the gateway', () => {
  it('a spent per-Unit budget hands the item off (D1, ET1) and the same event twice is one handoff', async () => {
    const x = await itemAtS6();
    // the work engine mints the Unit's key and budget (here: directly; M11 does it over the admin API)
    const { key, vkey } = await gw.mint({
      project_id: pid(x.project),
      item_id: x.itemId,
      unit_id: 'unit-1',
      step: '6.4',
      budget: { max_tokens: 120, max_cost_micro_usd: 1_000_000 },
    });
    gw.provider.enqueue({ usage: { input_tokens: 70, output_tokens: 50 } });
    expect((await gw.messages(key, hello({ max_tokens: 60 }))).status).toBe(200); // 120 of 120: spent
    // the session is stopped at the gateway: no further call is served
    const refused = await gw.messages(key, hello());
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe('budget_exhausted');

    const before = (await readItem(s.record.pool, x.itemId))?.state;
    expect(before?.handoffs).toHaveLength(0);

    const r = ok(await observeGatewayTriggers(s.deps));
    expect(r).toMatchObject({ fired: 1 });
    const after = (await readItem(s.record.pool, x.itemId))?.state;
    expect(after?.handoffs[0]).toMatchObject({ code: 'D1', trigger: 'ET1' });
    const fired = (await readItemEvents(s.record.pool, x.itemId)).filter(
      (e) => e.type === ITEM_EVENT.trigger_fired,
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]?.payload).toMatchObject({
      trigger: 'ET1',
      step: '6.4',
      reason_code: 'gateway.budget_tokens',
    });
    expect(fired[0]?.actor).toBe('system.gateway');

    // E4 opens for the owner of record as for any D1
    await driveWork(x.d);
    expect((await readItem(s.record.pool, x.itemId))?.state.waiting).toMatchObject({
      kind: 'handoff',
      stage: 'e4',
    });

    // a second pass, and a replay from a lost cursor, change nothing
    expect(ok(await observeGatewayTriggers(s.deps)).seen).toBe(0);
    await s.record.pool.query(`DELETE FROM core.observer_cursor`);
    expect(ok(await observeGatewayTriggers(s.deps))).toMatchObject({ fired: 0 });
    expect((await readItem(s.record.pool, x.itemId))?.state.handoffs).toHaveLength(1);
    expect(vkey.item_id).toBe(x.itemId);
  });

  it('an ET1 that names no item of ours is skipped, and the cursor moves past it', async () => {
    const { key } = await gw.mint({
      item_id: 'not-a-work-item',
      budget: { max_tokens: 40, max_cost_micro_usd: 1_000_000 },
    });
    gw.provider.enqueue({ usage: { input_tokens: 20, output_tokens: 20 } });
    await gw.messages(key, hello({ max_tokens: 30 }));
    await gw.messages(key, hello());
    const before = await gatewayCursor(s.record.pool);
    const r = ok(await observeGatewayTriggers(s.deps));
    expect(r).toMatchObject({ seen: 1, fired: 0, skipped: 1 });
    expect(await gatewayCursor(s.record.pool)).toBeGreaterThan(before);
  });

  it('is ignored when the item is not at a step that hands off on ET1 (its session already ended)', async () => {
    n += 1;
    const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
    approvers(s, seeded.project, ['bob']);
    const r = ok(
      await submitRequest(s.deps, {
        project_id: pid(seeded.project),
        repo: seeded.repo,
        lane: 'L3' as Lane,
        requester: pr('alice'),
        channel: 'N1',
        text: `gateway budget early ${n}`,
      }),
    );
    const itemId = r.item_id as string; // still at the start of the lifecycle
    const { key } = await gw.mint({
      project_id: pid(seeded.project),
      item_id: itemId,
      budget: { max_tokens: 40, max_cost_micro_usd: 1_000_000 },
    });
    gw.provider.enqueue({ usage: { input_tokens: 20, output_tokens: 20 } });
    await gw.messages(key, hello({ max_tokens: 30 }));
    ok(await observeGatewayTriggers(s.deps));
    const st = (await readItem(s.record.pool, itemId))?.state;
    expect(st?.handoffs).toHaveLength(0);
  });

  it('refuses to go past an ET1 event that does not parse (it is looked at, not skipped)', async () => {
    const client = await s.record.pool.connect();
    try {
      await client.query('BEGIN');
      const w = await appendEvents(client, 'gateway:budget:broken', 0, [
        {
          type: GATEWAY_EVENT.budget_exhausted,
          body: { trigger: 'ET1' },
          actor: 'system.gateway',
          idempotency_key: 'broken',
        },
      ]);
      expect(w.ok).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const r = await observeGatewayTriggers(s.deps);
    expect(r.ok).toBe(false);
  });
});
