import { ConfigReader, ConfigRegistry, registerNotificationsConfig } from '@aisdlc/config';
import { FileSecretRef } from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import { LoopSupervisor, type LoopSpec } from '@aisdlc/loops';
import {
  ServiceConfigError,
  databaseUrl,
  httpUrlEnv,
  jsonEnv,
  listen,
  listenConfig,
  loadServiceAuth,
  type Env,
  type RunningService,
} from '@aisdlc/service-kit';
import { z } from 'zod';
import { createNotifierApp } from './app.js';
import { boundedChannelFactory, channelsFrom, type ChannelFactory } from './channels.js';
import { deliverOnce, DEFAULT_RETRY, type DeliverDeps, type RetryPolicy } from './deliver.js';
import { raiseOnce, type RaiseDeps } from './raise.js';
import { IdentityRecipients, type RecipientsPort } from './recipients.js';

const Callers = z.record(
  z.string(),
  z.strictObject({ token_ref: z.string(), scopes: z.array(z.enum(['people'])) }),
);
const Hosts = z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(20);
// a file: or a vault: reference (the same shape a channel row may carry: FileSecretRef in contracts)
const Refs = z.array(FileSecretRef).max(40);

const intEnv = (env: Env, name: string, dflt: number, min: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ServiceConfigError(`${name} must be an integer of at least ${min}`);
  }
  return n;
};

/** The notifier's two loops, supervised like every loop (backoff, health, logs, metrics). */
export function notifierLoops(
  raise: RaiseDeps,
  deliver: DeliverDeps,
  o: {
    readonly raiseIntervalMs?: number;
    readonly deliverIntervalMs?: number;
    readonly log?: (l: string) => void;
  } = {},
): LoopSpec[] {
  const r = o.raiseIntervalMs ?? 2_000;
  const d = o.deliverIntervalMs ?? 5_000;
  return [
    {
      name: 'notify_raise',
      intervalMs: r,
      retry: { baseMs: Math.min(5_000, r), maxMs: Math.max(r, 60_000) },
      tick: async () => {
        const rep = await raiseOnce(raise);
        if (rep.raised > 0) o.log?.(`raised ${rep.raised} notification(s)`);
      },
    },
    {
      name: 'notify_deliver',
      intervalMs: d,
      startDelayMs: 500,
      retry: { baseMs: Math.min(5_000, d), maxMs: Math.max(d, 60_000) },
      tick: async () => {
        const rep = await deliverOnce(deliver);
        // counts only: never a channel, an address or a message
        if (rep.delivered + rep.failed + rep.given_up > 0)
          o.log?.(`delivered ${rep.delivered}, retrying ${rep.failed}, given up ${rep.given_up}`);
      },
    },
  ];
}

/**
 * Starts the notifier (PLAN M18; ADR-0003 §1 Integration plane; docs/specs/notifier-api.md) from the environment:
 *
 *   NOTIFIER_DATABASE_URL        the record database as the least-privilege role `notifier` (see the migration)
 *   NOTIFIER_CALLERS             JSON {caller: {token_ref, scopes: [people]}} (the bff)
 *   NOTIFIER_PORTAL_URL          the portal's base URL, for the link in every message
 *   NOTIFIER_SECRET_REFS         JSON list of the file: or vault: references a channel row may name (default: none)
 *   NOTIFIER_EGRESS_HOSTS        JSON list of the hosts a webhook or a relay may be (default: hooks.slack.com)
 *   NOTIFIER_PLAIN_HOSTS         JSON list: of those, the ones reachable without TLS (default: none)
 *   NOTIFIER_RAISE_INTERVAL_MS (2000), NOTIFIER_DELIVER_INTERVAL_MS (5000), NOTIFIER_CONFIG_RELOAD_MS (5000)
 *   NOTIFIER_MAX_ATTEMPTS (6), NOTIFIER_RETRY_BASE_MS (30000), NOTIFIER_RETRY_MAX_MS (3600000)
 *   NOTIFIER_MAX_SOURCE_AGE_MS (86400000)   an older event is not notified (a restart does not flood)
 *   NOTIFIER_HOST (127.0.0.1), NOTIFIER_PORT (8460)
 *
 * `deps` replaces the ports (tests).
 */
export async function bootNotifier(
  env: Env,
  deps: {
    factory?: ChannelFactory;
    recipients?: RecipientsPort;
    log?: (line: string) => void;
  } = {},
): Promise<RunningService & { supervisor: LoopSupervisor }> {
  const dbUrl = databaseUrl(env, 'NOTIFIER_DATABASE_URL');
  const callers = jsonEnv(env, 'NOTIFIER_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const portalUrl = httpUrlEnv(env, 'NOTIFIER_PORTAL_URL').replace(/\/+$/, '');
  const listenOpts = listenConfig(env, 'NOTIFIER', 8460);
  const list = <T>(name: string, schema: z.ZodType<T[]>, dflt: T[]): T[] =>
    env[name] ? jsonEnv(env, name, schema) : dflt;
  const secretRefs = new Set(list('NOTIFIER_SECRET_REFS', Refs, []));
  const egressHosts = new Set(list('NOTIFIER_EGRESS_HOSTS', Hosts, ['hooks.slack.com']));
  const plainHosts = new Set(list('NOTIFIER_PLAIN_HOSTS', Hosts, []));
  for (const h of plainHosts) {
    if (!egressHosts.has(h)) {
      throw new ServiceConfigError(`NOTIFIER_PLAIN_HOSTS: ${h} is not in NOTIFIER_EGRESS_HOSTS`);
    }
  }
  const retry: RetryPolicy = {
    maxAttempts: intEnv(env, 'NOTIFIER_MAX_ATTEMPTS', DEFAULT_RETRY.maxAttempts, 1),
    baseDelayMs: intEnv(env, 'NOTIFIER_RETRY_BASE_MS', DEFAULT_RETRY.baseDelayMs, 10),
    maxDelayMs: intEnv(env, 'NOTIFIER_RETRY_MAX_MS', DEFAULT_RETRY.maxDelayMs, 10),
  };
  const log = deps.log ?? ((l: string) => console.log(`notifier: ${l}`));
  const pool = createPool(dbUrl, 6);
  let reader: ConfigReader | undefined;
  let supervisor: LoopSupervisor | undefined;
  try {
    const have = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('notifier.delivery')::text AS notifier,
              to_regclass('identity.binding')::text AS identity,
              to_regclass('config.genuine_publish')::text AS config`,
    );
    const missing = Object.entries(have.rows[0] ?? {})
      .filter(([, v]) => v == null)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `the ${missing.join(', ')} schema(s) are missing: run aisdlc-migrate on the record database first`,
      );
    }
    reader = await ConfigReader.create({
      pool,
      registry: registerNotificationsConfig(new ConfigRegistry()),
      // this role may not fold the config read model: it reads what core folded
      catchUp: false,
      pollIntervalMs: intEnv(env, 'NOTIFIER_CONFIG_RELOAD_MS', 5_000, 100),
      onError: (e) => log(`config reader: ${e instanceof Error ? e.constructor.name : 'error'}`),
    });
    await reader.start();
    const channels = channelsFrom(reader);
    const recipients = deps.recipients ?? new IdentityRecipients(pool);
    const factory = deps.factory ?? boundedChannelFactory({ secretRefs, egressHosts, plainHosts });
    const sup = new LoopSupervisor({ log });
    supervisor = sup;
    for (const l of notifierLoops(
      {
        pool,
        recipients,
        channels,
        maxSourceAgeMs: intEnv(env, 'NOTIFIER_MAX_SOURCE_AGE_MS', 24 * 3600_000, 1000),
      },
      { pool, recipients, channels, factory, portalUrl, retry },
      {
        raiseIntervalMs: intEnv(env, 'NOTIFIER_RAISE_INTERVAL_MS', 2_000, 50),
        deliverIntervalMs: intEnv(env, 'NOTIFIER_DELIVER_INTERVAL_MS', 5_000, 50),
        log,
      },
    ))
      sup.add(l);
    const app = createNotifierApp({
      supervisor: sup,
      pool,
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
      channels,
    });
    const url = await listen(app, listenOpts);
    sup.start();
    const r = reader;
    return {
      url,
      supervisor: sup,
      close: async () => {
        await app.close();
        await sup.stop();
        await r.stop();
        await pool.end();
      },
    };
  } catch (e) {
    await supervisor?.stop().catch(() => undefined);
    await reader?.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw e;
  }
}
