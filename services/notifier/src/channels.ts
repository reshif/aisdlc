import { readFileSync } from 'node:fs';
import type { ConfigReader } from '@aisdlc/config';
import {
  NOTIFICATIONS_CONFIG_KEY,
  NotificationChannels,
  type DeliveryErrorCode,
  type NotificationChannelRow,
} from '@aisdlc/contracts';
import type { NotificationChannelPort } from '@aisdlc/ports';
import { resolveSecretRef } from '@aisdlc/service-kit';
import { SlackWebhookChannel } from './slack.js';
import { SmtpEmailChannel } from './smtp.js';

// From a published channel row to a channel port (PLAN M18). The row is config (M1-gated), but what it may make the
// notifier do is bounded by the deployment, as the gateway's rows are (gateway-api §5-6):
//
//   NOTIFIER_SECRET_REFS    the only key files a row may name (a revision cannot make the notifier read another file)
//   NOTIFIER_EGRESS_HOSTS   the only hosts a webhook URL or an SMTP relay may be (a revision cannot send anywhere new)
//   NOTIFIER_PLAIN_HOSTS    of those, the ones reachable without TLS (a local relay, a test sink); never with a password
//
// A row that breaks a bound is not built: its deliveries fail with a code (`secret_unavailable`, `egress_refused`)
// and nothing else is affected. The credential is read from its file at each build (a rotated file is picked up) and
// lives only inside the adapter.

export interface ChannelBounds {
  readonly secretRefs: ReadonlySet<string>;
  readonly egressHosts: ReadonlySet<string>;
  readonly plainHosts: ReadonlySet<string>;
  /** Reads a mounted secret (tests: a map). */
  readonly readFile?: (path: string) => string;
  readonly fetchImpl?: typeof fetch;
  readonly smtpTimeoutMs?: number;
  readonly smtpCa?: string;
}

export type Built =
  | { readonly ok: true; readonly port: NotificationChannelPort }
  | { readonly ok: false; readonly code: DeliveryErrorCode };

/** Builds the port of one row; tests replace it with fakes. */
export type ChannelFactory = (row: NotificationChannelRow) => Built;

/** The published channel rows, or `null` when they cannot be read (every delivery then waits: `config_unreadable`). */
export function channelsFrom(reader: ConfigReader): () => NotificationChannelRow[] | null {
  return () => {
    try {
      const c = reader.current();
      if (c.rejected.includes(NOTIFICATIONS_CONFIG_KEY)) return null;
      const v = c.get(NOTIFICATIONS_CONFIG_KEY);
      if (v === undefined) return [];
      const p = NotificationChannels.safeParse(v);
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  };
}

function secret(ref: string | null, b: ChannelBounds): string | null {
  if (ref === null || !b.secretRefs.has(ref)) return null;
  if (ref.startsWith('vault:')) {
    // primed from Vault at start and refreshed on a timer (service-kit); absent until the owner pastes it
    try {
      const v = resolveSecretRef(ref, { minLength: 1 });
      return v === '' ? null : v;
    } catch {
      return null;
    }
  }
  if (!ref.startsWith('file:')) return null;
  try {
    const v = (b.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(ref.slice(5)).trim();
    return v === '' ? null : v;
  } catch {
    return null;
  }
}

/** The deployment-bounded factory of the real adapters. */
export function boundedChannelFactory(b: ChannelBounds): ChannelFactory {
  return (row) => {
    if (row.kind === 'slack_webhook') {
      const url = secret(row.webhook_ref, b);
      if (url === null) return { ok: false, code: 'secret_unavailable' };
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return { ok: false, code: 'secret_unavailable' };
      }
      const host = u.hostname.toLowerCase();
      const plain = u.protocol === 'http:' && b.plainHosts.has(host);
      if (!b.egressHosts.has(host) || (u.protocol !== 'https:' && !plain) || u.username !== '') {
        return { ok: false, code: 'egress_refused' };
      }
      return {
        ok: true,
        port: new SlackWebhookChannel({
          url: u.toString(),
          ...(b.fetchImpl ? { fetchImpl: b.fetchImpl } : {}),
        }),
      };
    }
    if (!b.egressHosts.has(row.host)) return { ok: false, code: 'egress_refused' };
    if (row.tls === 'none' && !b.plainHosts.has(row.host))
      return { ok: false, code: 'egress_refused' };
    let auth: { user: string; pass: string } | null = null;
    if (row.username_ref !== null && row.password_ref !== null) {
      const user = secret(row.username_ref, b);
      const pass = secret(row.password_ref, b);
      if (user === null || pass === null) return { ok: false, code: 'secret_unavailable' };
      auth = { user, pass };
    }
    return {
      ok: true,
      port: new SmtpEmailChannel({
        host: row.host,
        port: row.port,
        tls: row.tls,
        from: row.from,
        auth,
        ...(b.smtpTimeoutMs === undefined ? {} : { timeoutMs: b.smtpTimeoutMs }),
        ...(b.smtpCa === undefined ? {} : { tlsOptions: { ca: b.smtpCa } }),
      }),
    };
  };
}
