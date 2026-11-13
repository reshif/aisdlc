import { ConfigReader, ConfigRegistry, registerGatewayConfig } from '@aisdlc/config';
import { GatewayEnvironment, type IntegrationHealthReport } from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import { recordHealth } from '@aisdlc/integrations';
import { HttpKillState } from '@aisdlc/killswitch/client';
import {
  ServiceConfigError,
  httpUrlEnv,
  jsonEnv,
  listen,
  listenConfig,
  loadServiceAuth,
  requiredEnv,
  resolveSecretRef,
  databaseUrl,
  type Env,
  type RunningService,
} from '@aisdlc/service-kit';
import { z } from 'zod';
import { RegistryAdapters, healthOfStatus } from './adapters.js';
import { createGatewayApp, type ReloadResult } from './app.js';
import { GatewayService } from './service.js';

const Callers = z.record(
  z.string(),
  z.strictObject({
    token_ref: z.string(),
    scopes: z.array(z.enum(['admin', 'read', 'operate'])),
  }),
);

const Refs = z.array(z.string().min(1)).max(32);
const Hosts = z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(32);

const intEnv = (env: Env, name: string, dflt: number, min: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ServiceConfigError(`${name} must be an integer of at least ${min}`);
  }
  return n;
};

/**
 * Starts the gateway from the environment:
 *
 *   GATEWAY_DATABASE_URL         the record database, as the least-privilege role `gateway` (the gateway writes
 *                                `gateway.*` record events and reads the published config; it cannot read anything else)
 *   GATEWAY_ENVIRONMENT          local | staging | prod: which routes apply
 *   GATEWAY_CALLERS              JSON {caller: {token_ref, scopes: [admin|read|operate]}} for the admin API
 *   GATEWAY_SECRET_REFS          JSON ["file:/run/secrets/anthropic-api-key", ...]: the key references this deployment
 *                                lets a registry row name (its mounted files). The registry holds references only
 *   GATEWAY_EGRESS_HOSTS         JSON ["api.anthropic.com", ...]: the hosts a vendor key may be sent to
 *   GATEWAY_KILLSWITCH_URL, GATEWAY_KILLSWITCH_TOKEN_REF   the kill switch it asks before every call
 *   GATEWAY_MAX_PROVIDER_CALLS   hard ceiling of vendor calls per process (default 1000)
 *   GATEWAY_RESERVATION_MAX_AGE_MS  a budget reservation still open after this is abandoned by the sweep (default 900000)
 *   GATEWAY_SWEEP_INTERVAL_MS    how often the sweep runs (default 60000)
 *   GATEWAY_HEALTH_INTERVAL_MS   how often it reports integration health (default 30000; a report older than 2 minutes reads unknown)
 *   GATEWAY_HOST (127.0.0.1), GATEWAY_PORT (8410)
 *
 * The providers themselves (adapter, base URL, key reference, models) are rows of the integration registry,
 * read from the published config and followed by revision without a restart. All configuration (and every
 * key file the registry names at start) is read before the database is touched; the schema is the
 * `aisdlc-migrate` job's, not this process's (it has no right to change it).
 */
export async function bootGateway(env: Env): Promise<RunningService> {
  const dbUrl = databaseUrl(env, 'GATEWAY_DATABASE_URL');
  const environment = GatewayEnvironment.safeParse(requiredEnv(env, 'GATEWAY_ENVIRONMENT'));
  if (!environment.success) {
    throw new ServiceConfigError('GATEWAY_ENVIRONMENT must be local, staging or prod');
  }
  const callers = jsonEnv(env, 'GATEWAY_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const secretRefs = env['GATEWAY_SECRET_REFS'] ? jsonEnv(env, 'GATEWAY_SECRET_REFS', Refs) : [];
  const egressHosts = env['GATEWAY_EGRESS_HOSTS']
    ? jsonEnv(env, 'GATEWAY_EGRESS_HOSTS', Hosts)
    : [];
  const killUrl = httpUrlEnv(env, 'GATEWAY_KILLSWITCH_URL');
  const killToken = resolveSecretRef(requiredEnv(env, 'GATEWAY_KILLSWITCH_TOKEN_REF'), { env });
  const maxProviderCalls = intEnv(env, 'GATEWAY_MAX_PROVIDER_CALLS', 1000, 0);
  const reservationMaxAgeMs = intEnv(env, 'GATEWAY_RESERVATION_MAX_AGE_MS', 900_000, 1_000);
  const sweepEveryMs = intEnv(env, 'GATEWAY_SWEEP_INTERVAL_MS', 60_000, 100);
  const healthEveryMs = intEnv(env, 'GATEWAY_HEALTH_INTERVAL_MS', 30_000, 100);
  const listenOpts = listenConfig(env, 'GATEWAY', 8410);

  const pool = createPool(dbUrl, 10);
  let reader: ConfigReader | undefined;
  const timers: NodeJS.Timeout[] = [];
  try {
    const have = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('record.record_event')::text AS record,
              to_regclass('config.genuine_publish')::text AS config,
              to_regclass('gateway.reservation')::text AS gateway,
              to_regclass('integrations.integration_health')::text AS integrations`,
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
      registry: registerGatewayConfig(new ConfigRegistry()),
      // The gateway's role may not write the config read model: it reads what core and core-worker
      // (and every publish) have folded.
      catchUp: false,
      onError: (e) =>
        console.error(
          `gateway: config reader: ${e instanceof Error ? e.constructor.name : 'error'}`,
        ),
    });
    const adapters = new RegistryAdapters(
      {
        env,
        environment: environment.data,
        secretRefs: new Set(secretRefs),
        egressHosts: new Set(egressHosts),
      },
      reader,
    );
    adapters.sync();
    reader.subscribe(() => {
      const st = adapters.sync();
      console.log(
        `gateway: registry revision ${adapters.revision?.slice(0, 12) ?? 'none'}: ${st.map((x) => `${x.integration_id}=${x.state}`).join(' ') || 'no providers'}`,
      );
    });
    await reader.start();
    const service = new GatewayService({
      pool,
      config: reader,
      adapters,
      kill: new HttpKillState({ baseUrl: killUrl, token: killToken, timeoutMs: 2_000 }),
      environment: environment.data,
      maxProviderCalls,
      reservationMaxAgeMs,
    });

    // IntegrationHealth: the shared shape, one report per enabled provider, from what the adapters and
    // the calls showed (never a probe of the vendor).
    const report = async (): Promise<void> => {
      const reports: IntegrationHealthReport['reports'] = adapters.status().map((st) => {
        const built = st.state === 'built' ? service.providerEvidence(st.integration_id) : null;
        const h = built ? { state: built.state, detail: built.detail } : healthOfStatus(st);
        return { integration_id: st.integration_id, state: h.state, detail_code: h.detail };
      });
      await recordHealth(pool, { reporter: 'gateway', reports }, new Date());
    };
    const every = (ms: number, fn: () => Promise<unknown>, what: string) => {
      const t = setInterval(() => {
        fn().catch((e: unknown) =>
          console.error(`gateway: ${what}: ${e instanceof Error ? e.constructor.name : 'error'}`),
        );
      }, ms);
      t.unref();
      timers.push(t);
    };
    every(sweepEveryMs, () => service.sweepReservations(), 'reservation sweep');
    every(healthEveryMs, report, 'health report');
    await report().catch(() => undefined);

    const snapshot = (): ReloadResult => ({
      revision: adapters.revision,
      integrations: adapters.status().map((x) => ({
        integration_id: x.integration_id,
        adapter: x.adapter,
        state: x.state,
        detail: x.detail,
      })),
    });
    const app = createGatewayApp({
      service,
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
      reload: async ({ force }) => {
        await reader?.refresh();
        adapters.sync({ force });
        await report().catch(() => undefined);
        return snapshot();
      },
      integrations: snapshot,
      bounds: { secret_refs: secretRefs, egress_hosts: egressHosts },
    });
    const url = await listen(app, listenOpts);
    const r = reader;
    return {
      url,
      close: async () => {
        for (const t of timers) clearInterval(t);
        await app.close();
        await r.stop();
        await pool.end();
      },
    };
  } catch (e) {
    for (const t of timers) clearInterval(t);
    await reader?.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw e;
  }
}
