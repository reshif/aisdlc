import { ConfigReader, ConfigRegistry } from '@aisdlc/config';
import { STEP_UP_KEY_ID } from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { ConfigBundleSource, Pdp, RecordDecisionLog, registerPdpConfig } from '@aisdlc/pdp';
import {
  ServiceConfigError,
  databaseUrl,
  httpUrlEnv,
  listen,
  listenConfig,
  requiredEnv,
  resolveSecretRef,
  type Env,
  type RunningService,
} from '@aisdlc/service-kit';
import {
  DEFAULT_ABSOLUTE_SECONDS,
  DEFAULT_IDLE_SECONDS,
  createBffApp,
  type StepUpMode,
} from './app.js';
import { migrateBff } from './migrations.js';
import { HttpOidcClient } from './oidc/http-client.js';
import { PgProofStore } from './stepup/store.js';
import { StepUpIssuer } from './stepup/issuer.js';

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
 * Starts the bff from the environment:
 *   BFF_DATABASE_URL         the record database. The record, ledger, decisions, config, identity and
 *                            directory schemas must already be migrated (they are other services'); the
 *                            bff schema is migrated at start
 *   BFF_PUBLIC_URL           the browser-visible base, e.g. https://factory.example (redirect URI base)
 *   BFF_OIDC_ISSUER, BFF_OIDC_CLIENT_ID, BFF_OIDC_CLIENT_SECRET_REF
 *                            the confidential client; the secret is an `env:NAME` or `file:PATH` reference
 *   KMS_URL, KMS_TOKEN_REF   kms-local, whose `bff` caller signs step-up proofs
 *   BFF_COOKIE_SECURE        `true` (default) or `false`; only local plain http may use `false`
 *   BFF_IDLE_SECONDS         idle timeout, default 1800;  BFF_ABSOLUTE_SECONDS  default 28800
 *   BFF_STEP_UP_MODE         `reauth` (default, D37) or `reconfirm` (DEC-11(c-ii): plain confirm)
 *   BFF_ALLOWED_ORIGINS      comma-separated extra origins allowed on state-changing requests
 *   BFF_PDP_SAMPLE_RATE      fraction (0..1) of other allows to log as pdp.decision, default 0
 *   BFF_HOST / BFF_PORT      default 127.0.0.1:8340
 * All configuration is read, and every secret resolved, before the database is touched.
 */
export async function bootBff(env: Env): Promise<RunningService> {
  const dbUrl = databaseUrl(env, 'BFF_DATABASE_URL');
  const publicUrl = httpUrlEnv(env, 'BFF_PUBLIC_URL').replace(/\/$/, '');
  const issuer = httpUrlEnv(env, 'BFF_OIDC_ISSUER');
  const clientId = requiredEnv(env, 'BFF_OIDC_CLIENT_ID');
  const clientSecret = resolveSecretRef(requiredEnv(env, 'BFF_OIDC_CLIENT_SECRET_REF'), { env });
  const custody = httpKeyCustodyFromEnv(env);
  const secureRaw = env['BFF_COOKIE_SECURE'] ?? 'true';
  if (secureRaw !== 'true' && secureRaw !== 'false') {
    throw new ServiceConfigError('BFF_COOKIE_SECURE must be true or false');
  }
  const cookieSecure = secureRaw === 'true';
  if (!cookieSecure && !publicUrl.startsWith('http://')) {
    throw new ServiceConfigError('BFF_COOKIE_SECURE=false is only for a plain http BFF_PUBLIC_URL');
  }
  const idleSeconds = intEnv(env, 'BFF_IDLE_SECONDS', DEFAULT_IDLE_SECONDS, 1);
  const absoluteSeconds = intEnv(env, 'BFF_ABSOLUTE_SECONDS', DEFAULT_ABSOLUTE_SECONDS, 1);
  const modeRaw = env['BFF_STEP_UP_MODE'] ?? 'reauth';
  if (modeRaw !== 'reauth' && modeRaw !== 'reconfirm') {
    throw new ServiceConfigError('BFF_STEP_UP_MODE must be reauth or reconfirm');
  }
  const stepUpMode: StepUpMode = modeRaw;
  const allowedOrigins = (env['BFF_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const sampleRaw = Number(env['BFF_PDP_SAMPLE_RATE'] ?? 0);
  if (!(sampleRaw >= 0 && sampleRaw <= 1)) {
    throw new ServiceConfigError('BFF_PDP_SAMPLE_RATE must be between 0 and 1');
  }
  const listenOpts = listenConfig(env, 'BFF', 8340);

  const pool = createPool(dbUrl, 10);
  let reader: ConfigReader | undefined;
  try {
    const have = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('record.record_event')::text AS record,
              to_regclass('ledger.ledger_entry')::text AS ledger,
              to_regclass('config.config_revision')::text AS config,
              to_regclass('identity.principal')::text AS identity,
              to_regclass('directory.principal')::text AS directory`,
    );
    const missing = Object.entries(have.rows[0] ?? {})
      .filter(([, v]) => v == null)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `the ${missing.join(', ')} schema(s) are missing: migrate the record database first`,
      );
    }
    await migrateBff(pool);
    reader = await ConfigReader.create({
      pool,
      registry: registerPdpConfig(new ConfigRegistry()),
      onError: (e) =>
        console.error(`bff: config reader: ${e instanceof Error ? e.message : String(e)}`),
    });
    await reader.start();
    const pdp = new Pdp({
      source: new ConfigBundleSource(reader),
      entities: new IdentityPdpEntities({ pool }),
      log: new RecordDecisionLog({ pool }),
      sampleRate: sampleRaw,
      onError: (e) => console.error(`bff: ${e instanceof Error ? e.message : String(e)}`),
    });
    const app = createBffApp({
      pool,
      oidc: new HttpOidcClient({ issuer, client_id: clientId, client_secret: clientSecret }),
      pdp,
      stepUp: new StepUpIssuer({ custody, store: new PgProofStore(pool), keyId: STEP_UP_KEY_ID }),
      publicUrl,
      allowedOrigins,
      cookieSecure,
      idleSeconds,
      absoluteSeconds,
      stepUpMode,
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
