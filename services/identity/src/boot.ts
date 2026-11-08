import { readFileSync } from 'node:fs';
import { ProjectSettings, type ProjectId } from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import { err, type Result } from '@aisdlc/kernel';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { HttpNotary } from '@aisdlc/notary/client';
import {
  FakeProjectSettings,
  SeedIdentityProvider,
  projectSettingsError,
  type ProjectSettingsError,
  type ProjectSettingsPort,
  type ProjectSettingsView,
} from '@aisdlc/ports';
import {
  ServiceConfigError,
  databaseUrl,
  httpUrlEnv,
  jsonEnv,
  listen,
  listenConfig,
  loadServiceAuth,
  requiredEnv,
  resolveSecretRef,
  type Env,
  type RunningService,
} from '@aisdlc/service-kit';
import { z } from 'zod';
import { startAccessSyncLoop } from './access-sync.js';
import { createIdentityApp, type IdentityScope } from './app.js';
import { migrateIdentity } from './migrations.js';

const Callers = z.record(
  z.string(),
  z.strictObject({
    token_ref: z.string(),
    scopes: z.array(z.enum(['read', 'write', 'reconcile', 'sync'])),
  }),
);

const SettingsFile = z.array(
  z.strictObject({ settings: ProjectSettings, tier: z.enum(['T0', 'T1', 'T2']).nullable() }),
);

/** No Projects service until M7: without a fixture file every settings lookup is refused (fail closed). */
class UnavailableSettings implements ProjectSettingsPort {
  async get(project: ProjectId): Promise<Result<ProjectSettingsView, ProjectSettingsError>> {
    return err(
      projectSettingsError(
        'unavailable',
        `no project settings source is configured (asked for ${project})`,
      ),
    );
  }
}

function settingsFromEnv(env: Env): ProjectSettingsPort {
  const file = env['IDENTITY_PROJECT_SETTINGS_FILE'];
  if (file === undefined || file === '') return new UnavailableSettings();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new ServiceConfigError(`IDENTITY_PROJECT_SETTINGS_FILE ${file} is not readable JSON`, {
      cause,
    });
  }
  const parsed = SettingsFile.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceConfigError(`IDENTITY_PROJECT_SETTINGS_FILE: ${parsed.error.message}`);
  }
  const fake = new FakeProjectSettings();
  for (const v of parsed.data) fake.set(v.settings, v.tier);
  return fake;
}

/**
 * Starts the identity service from the environment:
 *   IDENTITY_DATABASE_URL    the record database; the record and ledger schemas must already be migrated,
 *                            the identity schema is migrated at start
 *   IDENTITY_CALLERS         JSON {caller: {token_ref, scopes: [read|write|reconcile|sync]}}
 *   IDENTITY_HOST / _PORT    default 127.0.0.1:8330
 *   NOTARY_URL, IDENTITY_NOTARY_TOKEN_REF, KMS_URL, KMS_TOKEN_REF
 *                            the access-sync loop's Notary client and key lookup (required unless
 *                            IDENTITY_ACCESS_SYNC=off, which only a test environment should set)
 *   IDENTITY_SYNC_INTERVAL_MS  access-sync tick, default 5000
 *   IDENTITY_IDP_SEED_FILE   JSON seed for the local identity provider (optional)
 *   IDENTITY_PROJECT_SETTINGS_FILE  JSON [{settings, tier}] standing in for Projects until M7 (optional)
 * Every secret is an `env:NAME` or `file:PATH` reference. All configuration is read before the
 * database is touched.
 */
export async function bootIdentity(env: Env): Promise<RunningService> {
  const dbUrl = databaseUrl(env, 'IDENTITY_DATABASE_URL');
  const callers = jsonEnv(env, 'IDENTITY_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const listenOpts = listenConfig(env, 'IDENTITY', 8330);
  const settings = settingsFromEnv(env);
  const seed = env['IDENTITY_IDP_SEED_FILE'];
  const idp = seed ? SeedIdentityProvider.fromFile(seed) : undefined;
  const syncOn = env['IDENTITY_ACCESS_SYNC'] !== 'off';
  const interval = Number(env['IDENTITY_SYNC_INTERVAL_MS'] ?? 5000);
  if (!Number.isInteger(interval) || interval < 100) {
    throw new ServiceConfigError('IDENTITY_SYNC_INTERVAL_MS must be an integer of at least 100');
  }
  let notary: HttpNotary | undefined;
  let notaryKey:
    Awaited<ReturnType<ReturnType<typeof httpKeyCustodyFromEnv>['publicKey']>> | undefined;
  if (syncOn) {
    notary = new HttpNotary({
      baseUrl: httpUrlEnv(env, 'NOTARY_URL'),
      token: resolveSecretRef(requiredEnv(env, 'IDENTITY_NOTARY_TOKEN_REF'), { env }),
    });
    notaryKey = await httpKeyCustodyFromEnv(env).publicKey('dev:notary');
    if (!notaryKey.ok) throw new Error(`notary public key: ${notaryKey.error.message}`);
  }

  const pool = createPool(dbUrl, 8);
  try {
    // The record and the ledger are core's: their migrations ship in their own packages and are run
    // by whoever owns the record database (a bundle cannot find another package's migrations
    // directory). Identity migrates only its own schema, and refuses to start without theirs.
    const have = await pool.query<{ record: string | null; ledger: string | null }>(
      `SELECT to_regclass('record.record_event')::text AS record,
              to_regclass('ledger.ledger_entry')::text AS ledger`,
    );
    if (have.rows[0]?.record == null || have.rows[0]?.ledger == null) {
      throw new Error(
        'the record and ledger schemas are missing: migrate the record database first',
      );
    }
    await migrateIdentity(pool);
    const ledger = notary && notaryKey?.ok ? { notary, notaryKey: notaryKey.value } : undefined;
    const loop = ledger
      ? startAccessSyncLoop(
          { pool, ledger },
          {
            intervalMs: interval,
            onError: (e) => console.error(`identity: access-sync: [${e.code}] ${e.message}`),
          },
        )
      : undefined;
    const app = createIdentityApp({
      pool,
      auth,
      callers: Object.fromEntries(
        Object.entries(callers).map(([n, c]) => [n, c.scopes as IdentityScope[]]),
      ),
      settings,
      idp,
      ledger,
      ...(loop ? { onWrite: () => void loop.runOnce() } : {}),
    });
    const url = await listen(app, listenOpts);
    return {
      url,
      close: async () => {
        await app.close();
        await loop?.stop();
        await pool.end();
      },
    };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}
