import type { NotificationChannelPort, OutgoingNotification, SendOutcome } from '@aisdlc/ports';

// The Slack adapter behind `NotificationChannelPort` (PLAN M18): an incoming webhook. The webhook URL is the
// credential (whoever has it can post to the channel), so it is read from a mounted file by the caller, held only in
// this object, and never put in an answer, an error or a log: a failure is a code. Slack has no idempotency key for
// webhooks, so a retry after a lost answer may post twice (at least once).

export interface SlackWebhookOptions {
  readonly url: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Slack's mrkdwn treats these three as control characters. */
const escapeSlack = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class SlackWebhookChannel implements NotificationChannelPort {
  readonly kind = 'slack_webhook' as const;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(o: SlackWebhookOptions) {
    this.#url = o.url;
    this.#fetch = o.fetchImpl ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 10_000;
  }

  /** Never shows the URL (a credential). */
  toJSON(): object {
    return { kind: this.kind };
  }

  async send(m: OutgoingNotification): Promise<SendOutcome> {
    if (m.to.kind !== 'slack') return { ok: false, code: 'rejected', retryable: false };
    const mention = m.to.mention === null ? '' : `<@${m.to.mention}> `;
    const body = {
      text: `${mention}*${escapeSlack(m.subject)}*\n${escapeSlack(m.text)}`,
      unfurl_links: false,
      unfurl_media: false,
    };
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      await res.arrayBuffer().catch(() => undefined);
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { ok: false, code: timeout ? 'timeout' : 'unreachable', retryable: true };
    }
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 429) return { ok: false, code: 'rate_limited', retryable: true };
    if (res.status >= 500) return { ok: false, code: 'server_error', retryable: true };
    // 400 invalid_payload, 403 action_prohibited, 404 channel_not_found / no_service, 410 channel_is_archived
    return { ok: false, code: 'rejected', retryable: false };
  }
}
