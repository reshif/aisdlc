import type { DeliveryErrorCode, NotificationChannelRow } from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { systemClock, type Clock } from '@aisdlc/kernel';
import type { NotificationAddress, SendOutcome } from '@aisdlc/ports';
import type pg from 'pg';
import type { ChannelFactory } from './channels.js';
import type { RecipientsPort } from './recipients.js';
import { allowedClass, renderNotification, renderingSecrets } from './render.js';
import {
  claimDue,
  preferencesOf,
  recordDelivered,
  recordFailed,
  type ClaimedDelivery,
} from './store.js';

// The delivery loop (PLAN M18): at least once, with retries and backoff. Each pending delivery is claimed (SKIP
// LOCKED), rendered at the class its channel and its person allow, sent through the channel port under its delivery
// id (the idempotency key), and its outcome recorded in the same transaction. A failure is a code and a retry time,
// never a message from the channel; out of attempts (or a permanent refusal) it is given up. Nothing here is on the
// factory's path: a channel that is down only delays its own deliveries (best effort; the inbox is the record).

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 30_000,
  maxDelayMs: 3_600_000,
};

/** The wait after the `attempt`-th failure: base * 2^(attempt-1), capped. */
export const backoffMs = (p: RetryPolicy, attempt: number): number =>
  Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.max(0, attempt - 1));

export interface DeliverDeps {
  readonly pool: pg.Pool;
  readonly recipients: RecipientsPort;
  readonly channels: () => NotificationChannelRow[] | null;
  readonly factory: ChannelFactory;
  /** The portal's base URL, for the link in every message. */
  readonly portalUrl: string;
  readonly retry?: RetryPolicy;
  readonly clock?: Clock;
  /** Deliveries per pass (default 50). */
  readonly batch?: number;
}

export interface DeliverReport {
  readonly delivered: number;
  readonly failed: number;
  readonly given_up: number;
}

type Attempt =
  | { readonly ok: true; readonly rendered_class: 'D0' | 'D1' }
  | { readonly ok: false; readonly code: DeliveryErrorCode; readonly retryable: boolean };

const fail = (code: DeliveryErrorCode, retryable: boolean): Attempt => ({
  ok: false,
  code,
  retryable,
});

async function attempt(d: DeliverDeps, c: ClaimedDelivery): Promise<Attempt> {
  const rows = d.channels();
  if (rows === null) return fail('config_unreadable', true);
  const row = rows.find((r) => r.channel_id === c.channel_id);
  if (!row) return fail('channel_unknown', false);
  if (!row.enabled) return fail('channel_disabled', false);
  if (!(await d.recipients.isActiveHuman(c.principal_id))) return fail('no_address', false);
  let to: NotificationAddress;
  if (row.kind === 'email_smtp') {
    const address = await d.recipients.email(c.principal_id);
    if (address === null) return fail('no_address', false);
    to = { kind: 'email', address };
  } else {
    const { preferences } = await preferencesOf(d.pool, c.principal_id);
    to = { kind: 'slack', mention: preferences.slack_member_id };
  }
  const cls = allowedClass(row.data_class_max, c.data_class);
  const rendered = renderNotification(c.content, cls, d.portalUrl);
  if (renderingSecrets(rendered).length > 0) return fail('content_refused', false);
  const built = d.factory(row);
  if (!built.ok) return fail(built.code, built.code === 'secret_unavailable');
  let out: SendOutcome;
  try {
    out = await built.port.send({
      idempotency_key: c.delivery_id,
      to,
      subject: rendered.subject,
      text: rendered.text,
    });
  } catch {
    // an adapter is not supposed to throw; if one does, its message is not trusted to be free of a secret
    out = { ok: false, code: 'unreachable', retryable: true };
  }
  return out.ok ? { ok: true, rendered_class: rendered.rendered_class } : out;
}

/** One pass: up to `batch` due deliveries, each in its own transaction. */
export async function deliverOnce(d: DeliverDeps): Promise<DeliverReport> {
  const clock = d.clock ?? systemClock;
  const policy = d.retry ?? DEFAULT_RETRY;
  let delivered = 0;
  let failed = 0;
  let given_up = 0;
  for (let i = 0; i < (d.batch ?? 50); i++) {
    const done = await withTransaction(d.pool, async (tx) => {
      const c = await claimDue(tx, clock.now());
      if (c === null) return false;
      const a = await attempt(d, c);
      const n = c.attempts + 1;
      const now = clock.now();
      if (a.ok) {
        await recordDelivered(
          tx,
          c.principal_id,
          {
            delivery_id: c.delivery_id,
            notification_id: c.notification_id,
            channel_id: c.channel_id,
            attempt: n,
            rendered_class: a.rendered_class,
            delivered_at: now.toISOString(),
          },
          clock,
        );
        delivered += 1;
        return true;
      }
      const again = a.retryable && n < policy.maxAttempts;
      await recordFailed(
        tx,
        c.principal_id,
        {
          delivery_id: c.delivery_id,
          notification_id: c.notification_id,
          channel_id: c.channel_id,
          attempt: n,
          error_code: a.code,
          retry_at: again ? new Date(now.getTime() + backoffMs(policy, n)).toISOString() : null,
          failed_at: now.toISOString(),
        },
        clock,
      );
      if (again) failed += 1;
      else given_up += 1;
      return true;
    });
    if (!done) break;
  }
  return { delivered, failed, given_up };
}
