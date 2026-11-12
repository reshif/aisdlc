import { describe, expect, it } from 'vitest';
import type {
  FakeChannelReceipt,
  NotificationAddress,
  NotificationChannelPort,
} from './notification-channel.js';

// The NotificationChannelPort contract suite (PLAN M18). `notificationChannelContract` runs against any channel: the
// fake always, the Slack and SMTP adapters (services/notifier) against local sinks on 127.0.0.1. The harness says what
// the receiver got and can make the receiver fail.

export interface NotificationChannelHarness {
  readonly port: NotificationChannelPort;
  /** The address this channel delivers to. */
  readonly to: NotificationAddress;
  /** What the receiver got, in order (a retry of one key may appear twice: at least once). */
  received(): Promise<readonly FakeChannelReceipt[]>;
  /** The receiver answers the next send with a transient failure (a 5xx, a 4xx SMTP reply). */
  failNextTransient(): void;
  /** The receiver refuses the next send for good (a 4xx webhook answer, a 5xx SMTP reply). */
  failNextPermanent(): void;
  /** Words that must never appear in what `send` answers (a webhook URL, a password). */
  readonly secrets: readonly string[];
  stop?: () => Promise<void>;
}

export function notificationChannelContract(
  name: string,
  make: () => Promise<NotificationChannelHarness>,
): void {
  describe(`NotificationChannelPort contract: ${name}`, () => {
    it('delivers the rendered subject and text, keyed by the delivery id', async () => {
      const h = await make();
      try {
        const r = await h.port.send({
          idempotency_key: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a7b',
          to: h.to,
          subject: 'A gate waits for you',
          text: 'G3 on project acme waits for you: /inbox',
        });
        expect(r).toEqual({ ok: true });
        const got = await h.received();
        expect(got).toHaveLength(1);
        expect(got[0]?.idempotency_key).toBe('0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a7b');
        expect(got[0]?.text).toContain('G3 on project acme waits for you');
      } finally {
        await h.stop?.();
      }
    });

    it('answers a transient failure as retryable and a permanent one as not, with a code and no secret', async () => {
      const h = await make();
      try {
        const m = {
          idempotency_key: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a7c',
          to: h.to,
          subject: 's',
          text: 't',
        };
        h.failNextTransient();
        const a = await h.port.send(m);
        expect(a.ok).toBe(false);
        expect(!a.ok && a.retryable).toBe(true);
        h.failNextPermanent();
        const b = await h.port.send(m);
        expect(b.ok).toBe(false);
        expect(!b.ok && b.retryable).toBe(false);
        for (const s of h.secrets) expect(JSON.stringify([a, b])).not.toContain(s);
        // the retry gets through, under the same key
        expect(await h.port.send(m)).toEqual({ ok: true });
        expect((await h.received()).map((x) => x.idempotency_key)).toEqual([m.idempotency_key]);
      } finally {
        await h.stop?.();
      }
    });
  });
}
