import type { DeliveryErrorCode, NotificationChannelKind } from '@aisdlc/contracts';

// The notifier's channel port (PLAN M18; ADR-0003 §1 Integration plane "notifier"; docs/specs/notifier-api.md). The
// notifier talks to Slack and to an SMTP relay ONLY through this port; the adapters (`SlackWebhookChannel`,
// `SmtpEmailChannel`) live in services/notifier, which is the only holder of their credentials, and
// `FakeNotificationChannel` is the deterministic fake every other test uses.
//
// A send never throws for something the channel did: it answers a code (`DeliveryErrorCode`) and whether a retry can
// help. A code is all that leaves the adapter: never a URL (a Slack webhook URL is a credential), a response body or
// an address, so nothing a channel says can reach the record or a log.

export type NotificationAddress =
  | { readonly kind: 'email'; readonly address: string }
  /** An incoming webhook posts to its own channel; `mention` is a Slack member id to mention there, or `null`. */
  | { readonly kind: 'slack'; readonly mention: string | null };

export interface OutgoingNotification {
  /**
   * Stable per delivery (the delivery id): every retry of one delivery carries the same key, so a receiver that can
   * dedupe does (email: the Message-ID). Delivery is at least once: a channel that cannot dedupe may show it twice.
   */
  readonly idempotency_key: string;
  readonly to: NotificationAddress;
  /** One line, plain text, already rendered at the allowed data class. */
  readonly subject: string;
  /** Plain text, already rendered at the allowed data class. */
  readonly text: string;
}

export type SendOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: DeliveryErrorCode; readonly retryable: boolean };

export interface NotificationChannelPort {
  readonly kind: NotificationChannelKind;
  send(message: OutgoingNotification): Promise<SendOutcome>;
}

/** What a fake channel received: every attempt, in order, and the keys it accepted. */
export interface FakeChannelReceipt {
  readonly idempotency_key: string;
  readonly to: NotificationAddress;
  readonly subject: string;
  readonly text: string;
}

/**
 * Deterministic in-memory channel. `received` is every message that got through (a retry of an accepted key is
 * received again, as a real webhook would show it twice: at least once); `accepted` is the distinct keys. `failNext`
 * scripts the next answers; `setDown` makes every send fail with `unreachable` until it is lifted.
 */
export class FakeNotificationChannel implements NotificationChannelPort {
  readonly received: FakeChannelReceipt[] = [];
  private readonly script: Array<{ code: DeliveryErrorCode; retryable: boolean }> = [];
  private down = false;
  attempts = 0;

  constructor(readonly kind: NotificationChannelKind = 'slack_webhook') {}

  get accepted(): string[] {
    return [...new Set(this.received.map((r) => r.idempotency_key))];
  }

  failNext(n: number, code: DeliveryErrorCode = 'server_error', retryable = true): this {
    for (let i = 0; i < n; i++) this.script.push({ code, retryable });
    return this;
  }

  setDown(down: boolean): this {
    this.down = down;
    return this;
  }

  async send(m: OutgoingNotification): Promise<SendOutcome> {
    this.attempts += 1;
    if (this.down) return { ok: false, code: 'unreachable', retryable: true };
    const next = this.script.shift();
    if (next) return { ok: false, ...next };
    if (m.to.kind === 'email' && this.kind !== 'email_smtp')
      return { ok: false, code: 'rejected', retryable: false };
    if (m.to.kind === 'slack' && this.kind !== 'slack_webhook')
      return { ok: false, code: 'rejected', retryable: false };
    this.received.push({
      idempotency_key: m.idempotency_key,
      to: m.to,
      subject: m.subject,
      text: m.text,
    });
    return { ok: true };
  }
}
