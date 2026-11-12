import { ConfigReader, ConfigRegistry } from '@aisdlc/config';
import { STEP_UP_KEY_ID } from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { BootstrapPdpEntities } from '@aisdlc/onboarding';
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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HttpCoreClient } from './core-client.js';
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

/** `BFF_HEALTH_PEERS` (M19): `{name: http(s) base URL}`; empty or unset: none. */
function healthPeersEnv(env: Env): Record<string, string> {
  const raw = env['BFF_HEALTH_PEERS'];
  if (raw === undefined || raw === '') return {};
  const p = z.record(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), z.url()).safeParse(
    (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })(),
  );
  if (!p.success) throw new ServiceConfigError('BFF_HEALTH_PEERS is JSON {name: http(s) URL}');
  for (const [k, v] of Object.entries(p.data)) {
    if (!/^https?:$/.test(new URL(v).protocol)) {
      throw new ServiceConfigError(`BFF_HEALTH_PEERS.${k} must be http(s)`);
    }
  }
  return p.data;
}

/**
 * Starts the bff from the environment:
 *   BFF_DATABASE_URL         the record database. The record, ledger, decisions, config, identity and
 *                            directory schemas must already be migrated (`aisdlc-migrate`); the bff schema
 *                            is migrated at start
 *   BFF_PUBLIC_URL           the browser-visible base, e.g. https://factory.example (redirect URI base)
 *   BFF_OIDC_ISSUER, BFF_OIDC_CLIENT_ID, BFF_OIDC_CLIENT_SECRET_REF
 *                            the confidential client; the secret is an `env:NAME` or `file:PATH` reference
 *   KMS_URL, KMS_TOKEN_REF   kms-local, whose `bff` caller signs step-up proofs
 *   BFF_COOKIE_SECURE        `true` (default) or `false`; only local plain http may use `false`
 *   BFF_IDLE_SECONDS         idle timeout, default 1800;  BFF_ABSOLUTE_SECONDS  default 28800
 *   BFF_STEP_UP_MODE         `reauth` (default, D37) or `reconfirm` (DEC-11(c-ii): plain confirm)
 *   BFF_ALLOWED_ORIGINS      comma-separated extra origins allowed on state-changing requests
 *   BFF_PDP_SAMPLE_RATE      fraction (0..1) of other allows to log as pdp.decision, default 0
 *   BFF_CORE_URL, BFF_CORE_TOKEN_REF
 *                            core's API and the bff's service token there (scopes read, onboard, portal);
 *                            both or neither (without them the portal's /api routes answer 503)
 *   BFF_NOTIFIER_URL, BFF_NOTIFIER_TOKEN_REF
 *                            the notifier's API and the bff's service token there (scope people); both or neither
 *                            (without them /api/me/notifications* answer 503; nothing else depends on it)
 *   BFF_SANDBOX_CONTROLLER_URL, BFF_SANDBOX_CONTROLLER_TOKEN_REF
 *                            optional: the sandbox-controller's slots for the portal's Sandboxes screen (scope read)
 *   BFF_AUDIT_URL, BFF_AUDIT_TOKEN_REF   the audit service (M19, scopes read, export, govern): Govern › Audit;
 *                                     optional (without it those routes answer 503)
 *   BFF_KILLSWITCH_URL, BFF_KILLSWITCH_TOKEN_REF
 *                            the kill switch and the bff's token there (scopes act, read; RC-UI-1): the portal's kill
 *                            and release, each act with the person's own step-up proof; both or neither (else 503)
 *   BFF_HEALTH_PEERS         M19: JSON {name: base URL} of the services only the bff reaches whose liveness answer
 *                            `GET /healthz/peer/:name` relays for core-worker's health tiles (the notifier)
 *   BFF_GATE_CHECK_URL, BFF_GATE_CHECK_TOKEN_REF
 *                            gate-check's read API and the bff's token there (scope read; M14.6: the item page's
 *                            run status); both or neither (without them that status reads `unknown`)
 *   BFF_WEB_DIR              the built web bundle to serve (contains index.html); unset: API only
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
  const coreUrl = env['BFF_CORE_URL'];
  const hasCore = coreUrl !== undefined && coreUrl !== '';
  if (hasCore !== (env['BFF_CORE_TOKEN_REF'] !== undefined && env['BFF_CORE_TOKEN_REF'] !== '')) {
    throw new ServiceConfigError(
      'BFF_CORE_URL and BFF_CORE_TOKEN_REF are set together or not at all',
    );
  }
  const core = hasCore
    ? new HttpCoreClient({
        baseUrl: httpUrlEnv(env, 'BFF_CORE_URL'),
        token: resolveSecretRef(requiredEnv(env, 'BFF_CORE_TOKEN_REF'), { env }),
      })
    : undefined;
  const notifierUrl = env['BFF_NOTIFIER_URL'];
  const hasNotifier = notifierUrl !== undefined && notifierUrl !== '';
  if (
    hasNotifier !==
    (env['BFF_NOTIFIER_TOKEN_REF'] !== undefined && env['BFF_NOTIFIER_TOKEN_REF'] !== '')
  ) {
    throw new ServiceConfigError(
      'BFF_NOTIFIER_URL and BFF_NOTIFIER_TOKEN_REF are set together or not at all',
    );
  }
  const notifier = hasNotifier
    ? new HttpCoreClient({
        baseUrl: httpUrlEnv(env, 'BFF_NOTIFIER_URL'),
        token: resolveSecretRef(requiredEnv(env, 'BFF_NOTIFIER_TOKEN_REF'), { env }),
      })
    : undefined;
  const ksUrl = env['BFF_KILLSWITCH_URL'];
  const hasKs = ksUrl !== undefined && ksUrl !== '';
  if (
    hasKs !==
    (env['BFF_KILLSWITCH_TOKEN_REF'] !== undefined && env['BFF_KILLSWITCH_TOKEN_REF'] !== '')
  ) {
    throw new ServiceConfigError(
      'BFF_KILLSWITCH_URL and BFF_KILLSWITCH_TOKEN_REF are set together or not at all',
    );
  }
  const killswitch = hasKs
    ? new HttpCoreClient({
        baseUrl: httpUrlEnv(env, 'BFF_KILLSWITCH_URL'),
        token: resolveSecretRef(requiredEnv(env, 'BFF_KILLSWITCH_TOKEN_REF'), { env }),
      })
    : undefined;
  const gcUrl = env['BFF_GATE_CHECK_URL'];
  const hasGateCheck = gcUrl !== undefined && gcUrl !== '';
  if (
    hasGateCheck !==
    (env['BFF_GATE_CHECK_TOKEN_REF'] !== undefined && env['BFF_GATE_CHECK_TOKEN_REF'] !== '')
  ) {
    throw new ServiceConfigError(
      'BFF_GATE_CHECK_URL and BFF_GATE_CHECK_TOKEN_REF are set together or not at all',
    );
  }
  const gateCheck = hasGateCheck
    ? new HttpCoreClient({
        baseUrl: httpUrlEnv(env, 'BFF_GATE_CHECK_URL'),
        token: resolveSecretRef(requiredEnv(env, 'BFF_GATE_CHECK_TOKEN_REF'), { env }),
      })
    : undefined;
  const auditUrl = env['BFF_AUDIT_URL'];
  const hasAudit = auditUrl !== undefined && auditUrl !== '';
  if (
    hasAudit !== (env['BFF_AUDIT_TOKEN_REF'] !== undefined && env['BFF_AUDIT_TOKEN_REF'] !== '')
  ) {
    throw new ServiceConfigError(
      'BFF_AUDIT_URL and BFF_AUDIT_TOKEN_REF are set together or not at all',
    );
  }
  const audit = hasAudit
    ? new HttpCoreClient({
        baseUrl: httpUrlEnv(env, 'BFF_AUDIT_URL'),
        token: resolveSecretRef(requiredEnv(env, 'BFF_AUDIT_TOKEN_REF'), { env }),
      })
    : undefined;
  const scUrl = env['BFF_SANDBOX_CONTROLLER_URL'];
  const hasSc = scUrl !== undefined && scUrl !== '';
  if (
    hasSc !==
    (env['BFF_SANDBOX_CONTROLLER_TOKEN_REF'] !== undefined &&
      env['BFF_SANDBOX_CONTROLLER_TOKEN_REF'] !== '')
  ) {
    throw new ServiceConfigError(
      'BFF_SANDBOX_CONTROLLER_URL and BFF_SANDBOX_CONTROLLER_TOKEN_REF are set together or not at all',
    );
  }
  const sandboxController = hasSc
    ? new HttpCoreClient({
        baseUrl: httpUrlEnv(env, 'BFF_SANDBOX_CONTROLLER_URL'),
        token: resolveSecretRef(requiredEnv(env, 'BFF_SANDBOX_CONTROLLER_TOKEN_REF'), { env }),
      })
    : undefined;
  const webDir = env['BFF_WEB_DIR'] === '' ? undefined : env['BFF_WEB_DIR'];
  if (webDir !== undefined && !existsSync(join(webDir, 'index.html'))) {
    throw new ServiceConfigError(
      `BFF_WEB_DIR ${webDir} has no index.html: build services/web first`,
    );
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
      entities: new BootstrapPdpEntities(new IdentityPdpEntities({ pool }), { db: pool }),
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
      ...(core ? { core } : {}),
      ...(notifier ? { notifier } : {}),
      ...(killswitch ? { killswitch } : {}),
      ...(gateCheck ? { gateCheck } : {}),
      ...(audit ? { audit } : {}),
      ...(sandboxController ? { sandboxController } : {}),
      ...(webDir ? { webDir } : {}),
      healthPeers: healthPeersEnv(env),
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
