import { ConfigReader, ConfigRegistry, registerGatewayConfig } from '@aisdlc/config';
import { AnthropicDefaultModels, GatewayEnvironment } from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import { HttpKillState } from '@aisdlc/killswitch/client';
import { FakeProvider, type ModelProviderPort } from '@aisdlc/ports';
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
import { AnthropicProvider } from './anthropic-provider.js';
import { createGatewayApp } from './app.js';
import { migrateGateway } from './migrations.js';
import { GatewayService } from './service.js';

const Callers = z.record(
  z.string(),
  z.strictObject({ token_ref: z.string(), scopes: z.array(z.enum(['admin', 'read'])) }),
);

/**
 * One adapter this process holds. `key_ref` is a SECRET REFERENCE (`file:/run/secrets/...`), read once
 * here and held by the adapter alone; `base_url` is where that key may be sent. Neither is ever in the
 * routing config, in a response, a log line, an error or the record.
 */
const Adapters = z.record(
  z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('anthropic'),
      key_ref: z.string().min(1),
      base_url: z.string().url().optional(),
      models: AnthropicDefaultModels.optional(),
    }),
    z.strictObject({ kind: z.literal('fake'), tools_capable: z.boolean().optional() }),
  ]),
);

/**
 * Starts the gateway from the environment:
 *
 *   GATEWAY_DATABASE_URL         the record database (the gateway writes `gateway.*` record events and reads config)
 *   GATEWAY_ENVIRONMENT          local | staging | prod: which routes apply
 *   GATEWAY_CALLERS              JSON {caller: {token_ref, scopes: [admin|read]}} for the admin API
 *   GATEWAY_PROVIDER_ADAPTERS    JSON {provider_id: {kind:'anthropic', key_ref, base_url?, models?} | {kind:'fake'}}
 *   GATEWAY_KILLSWITCH_URL, GATEWAY_KILLSWITCH_TOKEN_REF   the kill switch it asks before every call
 *   GATEWAY_MAX_PROVIDER_CALLS   hard ceiling of vendor calls per process (default 1000)
 *   GATEWAY_HOST (127.0.0.1), GATEWAY_PORT (8410)
 *
 * All configuration (and every key file) is read before the database is touched.
 */
export async function bootGateway(env: Env): Promise<RunningService> {
  const dbUrl = databaseUrl(env, 'GATEWAY_DATABASE_URL');
  const environment = GatewayEnvironment.safeParse(requiredEnv(env, 'GATEWAY_ENVIRONMENT'));
  if (!environment.success) {
    throw new ServiceConfigError('GATEWAY_ENVIRONMENT must be local, staging or prod');
  }
  const callers = jsonEnv(env, 'GATEWAY_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const adapterSpec = jsonEnv(env, 'GATEWAY_PROVIDER_ADAPTERS', Adapters);
  const killUrl = httpUrlEnv(env, 'GATEWAY_KILLSWITCH_URL');
  const killToken = resolveSecretRef(requiredEnv(env, 'GATEWAY_KILLSWITCH_TOKEN_REF'), { env });
  const maxRaw = env['GATEWAY_MAX_PROVIDER_CALLS'];
  const maxProviderCalls = maxRaw === undefined || maxRaw === '' ? 1000 : Number(maxRaw);
  if (!Number.isInteger(maxProviderCalls) || maxProviderCalls < 0) {
    throw new ServiceConfigError('GATEWAY_MAX_PROVIDER_CALLS must be a non-negative integer');
  }
  const listenOpts = listenConfig(env, 'GATEWAY', 8410);

  const adapters = new Map<string, ModelProviderPort>();
  for (const [id, a] of Object.entries(adapterSpec)) {
    if (a.kind === 'fake') {
      // A deterministic fake answering for a real route would be a silent downgrade in production.
      if (environment.data === 'prod') {
        throw new ServiceConfigError(
          'the fake provider is not allowed with GATEWAY_ENVIRONMENT=prod',
        );
      }
      adapters.set(id, new FakeProvider({ tools_capable: a.tools_capable ?? true }));
    } else {
      // A key that cannot be read (or is too short to be one) is a start-up error, never a fallback.
      const key = resolveSecretRef(a.key_ref, { env });
      adapters.set(
        id,
        new AnthropicProvider({
          apiKey: key,
          ...(a.base_url ? { baseUrl: a.base_url } : {}),
          ...(a.models ? { models: a.models } : {}),
        }),
      );
    }
  }

  const pool = createPool(dbUrl, 10);
  let reader: ConfigReader | undefined;
  try {
    const have = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('record.record_event')::text AS record,
              to_regclass('ledger.ledger_entry')::text AS ledger,
              to_regclass('config.config_revision')::text AS config`,
    );
    const missing = Object.entries(have.rows[0] ?? {})
      .filter(([, v]) => v == null)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `the ${missing.join(', ')} schema(s) are missing: migrate the record database first`,
      );
    }
    await migrateGateway(pool);
    reader = await ConfigReader.create({
      pool,
      registry: registerGatewayConfig(new ConfigRegistry()),
      onError: (e) =>
        console.error(
          `gateway: config reader: ${e instanceof Error ? e.constructor.name : 'error'}`,
        ),
    });
    await reader.start();
    const service = new GatewayService({
      pool,
      config: reader,
      adapters,
      kill: new HttpKillState({ baseUrl: killUrl, token: killToken, timeoutMs: 2_000 }),
      environment: environment.data,
      maxProviderCalls,
    });
    const app = createGatewayApp({
      service,
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
    });
    const url = await listen(app, listenOpts);
    const r = reader;
    return {
      url,
      close: async () => {
        await app.close();
        await r.stop();
        await pool.end();
      },
    };
  } catch (e) {
    await reader?.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw e;
  }
}
