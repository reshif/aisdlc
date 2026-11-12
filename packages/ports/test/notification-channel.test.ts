import { describe, expect, it } from 'vitest';
import { FakeNotificationChannel } from '../src/index.js';
import { notificationChannelContract } from '../src/notification-channel-contract.js';

// PLAN M18: the fake channel behind NotificationChannelPort passes the same suite as the adapters.

function fakeHarness() {
  const port = new FakeNotificationChannel('slack_webhook');
  return {
    port,
    to: { kind: 'slack', mention: null } as const,
    received: async () => port.received,
    failNextTransient: () => void port.failNext(1, 'server_error', true),
    failNextPermanent: () => void port.failNext(1, 'rejected', false),
    secrets: [],
  };
}

notificationChannelContract('FakeNotificationChannel', async () => fakeHarness());

describe('FakeNotificationChannel', () => {
  it('is down until lifted, and refuses an address of the other kind', async () => {
    const c = new FakeNotificationChannel('email_smtp').setDown(true);
    const m = {
      idempotency_key: 'k',
      to: { kind: 'email', address: 'a@example.com' },
      subject: 's',
      text: 't',
    } as const;
    expect(await c.send(m)).toEqual({ ok: false, code: 'unreachable', retryable: true });
    c.setDown(false);
    expect(await c.send(m)).toEqual({ ok: true });
    expect(await c.send({ ...m, to: { kind: 'slack', mention: null } })).toEqual({
      ok: false,
      code: 'rejected',
      retryable: false,
    });
    expect(c.attempts).toBe(3);
    expect(c.accepted).toEqual(['k']);
  });
});
