import { startTestKms } from '@aisdlc/kms-local/testing';
import { startTestKillswitch, type TestKillswitch } from '@aisdlc/killswitch/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hello, startTestGateway, type TestGateway } from '../src/testing.js';

// The gateway against the REAL kill switch service over HTTP (its own database and key), not the
// in-memory fake: a kill reaches the next call, a release lifts it, and a kill switch that cannot be
// reached is a kill.

let kms: Awaited<ReturnType<typeof startTestKms>>;
let ks: TestKillswitch;
let gw: TestGateway;
beforeAll(async () => {
  kms = await startTestKms();
  ks = await startTestKillswitch({
    custody: kms.custodyFor('killswitch'),
    admins: ['root', 'rita'],
  });
  gw = await startTestGateway({ kill: ks.killState() });
});
afterAll(async () => {
  await gw.stop();
  await ks.stop().catch(() => undefined);
  await kms.stop();
});

describe('kill switch (real service)', () => {
  it('refuses calls of a killed project from the next call, lifts at release, and fails closed when the kill switch is gone', async () => {
    const { key } = await gw.mint();
    expect((await gw.messages(key, hello())).status).toBe(200);

    const killed = await ks
      .clientFor('bff')
      .kill('root', { kind: 'project', ref: 'testbed' }, 'gateway test');
    expect(killed.ok).toBe(true);
    if (!killed.ok) return;
    const n = gw.provider.calls.length;
    const refused = await gw.messages(key, hello());
    expect(refused.status).toBe(423);
    expect(refused.json.error.code).toBe('killed');
    expect(gw.provider.calls.length).toBe(n);

    let released = await ks.clientFor('bff').release('root', killed.value.kill_id);
    if (released.ok && released.value.state === 'release_pending') {
      released = await ks.clientFor('bff').release('rita', killed.value.kill_id);
    }
    expect(released.ok && released.value.state).toBe('released');
    expect((await gw.messages(key, hello())).status).toBe(200);

    await ks.stop();
    const down = await gw.messages(key, hello());
    expect(down.status).toBe(503);
    expect(down.json.error.code).toBe('kill_switch_unreachable');
    expect(gw.provider.calls.length).toBe(n + 1);
  });
});
