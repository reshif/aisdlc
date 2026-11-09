import { ReservationAbandonedPayload, type ModelCompleteRequest } from '@aisdlc/contracts';
import { ok } from '@aisdlc/kernel';
import type { ModelProviderPort } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hello, startTestGateway, type TestGateway } from '../src/testing.js';

// The reservation leak (PLAN M10 follow-up): a process that dies between "reserve" and "settle" used to
// leave `reserved_*` raised for ever. Every reservation is a row now, and a sweep settles the ones older
// than a bound as `abandoned`, with a recorded event, without double-counting a call that completes.

/** A vendor that answers when the test says so: a call "in flight" whose process may die. */
class GatedProvider implements ModelProviderPort {
  readonly kind = 'fake';
  readonly tools_capable = true;
  private waiting: Array<() => void> = [];
  complete(req: ModelCompleteRequest) {
    return new Promise<ReturnType<typeof ok<never>> | never>((resolve) => {
      this.waiting.push(() =>
        resolve(
          ok({
            id: 'msg_gated',
            model: req.model,
            content: [{ type: 'text' as const, text: 'late but whole' }],
            stop_reason: 'end_turn' as const,
            usage: { input_tokens: 40, output_tokens: 10 },
          }) as never,
        ),
      );
    });
  }
  get inFlight(): number {
    return this.waiting.length;
  }
  releaseAll(): void {
    for (const w of this.waiting.splice(0)) w();
  }
}

let gw: TestGateway;
const gate = new GatedProvider();
beforeAll(async () => {
  gw = await startTestGateway({ adapters: { fake: gate } });
});
afterAll(() => gw.stop());

const group = async (id: string) => {
  const g = await gw.admin().budgetGroup(id);
  if (!g.ok) throw new Error('no group');
  return g.value;
};
const rows = async (g: string) =>
  (
    await gw.database.pool.query(
      `SELECT reservation_id, status, tokens FROM gateway.reservation WHERE budget_group = $1 ORDER BY reserved_at`,
      [g],
    )
  ).rows as Array<{ reservation_id: string; status: string; tokens: string }>;
const events = async (g: string) =>
  (
    await gw.database.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'gateway.reservation_abandoned' ORDER BY seq`,
      [`gateway:budget:${g}`],
    )
  ).rows.map((r) => r.body);
async function until(fn: () => Promise<boolean>, what: string) {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const MIN = 60_000;

describe('the reservation sweep', () => {
  it('abandons a reservation older than the bound, records it, and a call that completes later is counted once', async () => {
    const { key, vkey } = await gw.mint({
      budget: { max_tokens: 10_000, max_cost_micro_usd: 1_000_000 },
    });
    const g = vkey.budget_group;
    const call = gw.service.complete(key, hello({ max_tokens: 100 }));
    await until(
      async () => (await rows(g)).length === 1 && gate.inFlight === 1,
      'the call to be in flight',
    );
    const held = await group(g);
    expect(held.reserved_tokens).toBeGreaterThan(0);
    const [open] = await rows(g);
    expect(open?.status).toBe('open');

    // younger than the bound: nothing is touched
    gw.clock.advance(14 * MIN);
    expect(await gw.service.sweepReservations()).toMatchObject({ abandoned: 0 });
    expect((await group(g)).reserved_tokens).toBe(held.reserved_tokens);

    // older than the default 15 minutes: abandoned, the hold released, one event
    gw.clock.advance(2 * MIN);
    const swept = await gw.service.sweepReservations();
    expect(swept).toMatchObject({ abandoned: 1, tokens: held.reserved_tokens });
    const after = await group(g);
    expect(after).toMatchObject({ reserved_tokens: 0, reserved_cost_micro_usd: 0, used_tokens: 0 });
    expect((await rows(g))[0]?.status).toBe('abandoned');
    const [ev] = await events(g);
    expect(ReservationAbandonedPayload.parse(ev)).toMatchObject({
      reservation_id: open?.reservation_id,
      budget_group: g,
      vkey_id: vkey.vkey_id,
      tokens: held.reserved_tokens,
      max_age_ms: 15 * MIN,
    });
    // a second sweep finds nothing and writes nothing
    expect(await gw.service.sweepReservations()).toMatchObject({ abandoned: 0 });
    expect(await events(g)).toHaveLength(1);

    // the call was never dead: it completes now. Its usage is counted once, the hold is NOT released again
    gate.releaseAll();
    const r = await call;
    expect(r.ok).toBe(true);
    const done = await group(g);
    expect(done).toMatchObject({ reserved_tokens: 0, reserved_cost_micro_usd: 0, used_tokens: 50 });
    expect((await rows(g))[0]?.status).toBe('abandoned'); // stays what the sweep decided
    const calls = await gw.database.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'gateway.model_call'`,
      [`gateway:vkey:${vkey.vkey_id}`],
    );
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0]?.body).toMatchObject({ outcome: 'ok', tokens_in: 40, tokens_out: 10 });
  });

  it("does not touch a call that completed, however old, and never lowers another call's hold", async () => {
    const a = await gw.mint({ budget: { max_tokens: 10_000, max_cost_micro_usd: 1_000_000 } });
    const g = a.vkey.budget_group;
    const first = gw.service.complete(a.key, hello({ max_tokens: 100 }));
    await until(async () => gate.inFlight === 1, 'the first call');
    gate.releaseAll();
    expect((await first).ok).toBe(true);
    expect((await rows(g))[0]?.status).toBe('settled');
    // a second call on the same group stays in flight and young while time passes for the first
    gw.clock.advance(20 * MIN);
    const second = gw.service.complete(a.key, hello({ max_tokens: 100 }));
    await until(async () => (await rows(g)).length === 2 && gate.inFlight === 1, 'the second call');
    const held = (await group(g)).reserved_tokens;
    expect(held).toBeGreaterThan(0);
    expect(await gw.service.sweepReservations()).toMatchObject({ abandoned: 0 });
    expect((await group(g)).reserved_tokens).toBe(held);
    gate.releaseAll();
    expect((await second).ok).toBe(true);
    expect(await group(g)).toMatchObject({ reserved_tokens: 0, used_tokens: 100 });
    expect(await events(g)).toHaveLength(0);
  });

  it('the bound is configurable', async () => {
    const gw2 = await startTestGateway({ adapters: { fake: gate }, reservationMaxAgeMs: 2 * MIN });
    try {
      const { key, vkey } = await gw2.mint();
      const call = gw2.service.complete(key, hello());
      await until(async () => gate.inFlight === 1, 'the call');
      gw2.clock.advance(3 * MIN);
      expect(await gw2.service.sweepReservations()).toMatchObject({ abandoned: 1 });
      const ev = await gw2.database.pool.query(
        `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'gateway.reservation_abandoned'`,
        [`gateway:budget:${vkey.budget_group}`],
      );
      expect(ev.rows[0]?.body.max_age_ms).toBe(2 * MIN);
      gate.releaseAll();
      await call;
    } finally {
      await gw2.stop();
    }
  });
});

describe('provider evidence (the health a gateway reports)', () => {
  it('reads unknown with no recent call, ok after a good one, and never ok on old evidence', async () => {
    const g = await startTestGateway();
    try {
      expect(g.service.providerEvidence('fake')).toEqual({
        state: 'unknown',
        detail: 'no_recent_call',
      });
      const { key } = await g.mint();
      expect((await g.messages(key, hello())).status).toBe(200);
      expect(g.service.providerEvidence('fake')).toEqual({ state: 'ok', detail: 'ok' });
      g.clock.advance(16 * MIN);
      expect(g.service.providerEvidence('fake')).toEqual({
        state: 'unknown',
        detail: 'no_recent_call',
      });
    } finally {
      await g.stop();
    }
  });
});
