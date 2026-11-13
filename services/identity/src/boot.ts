import { readFileSync } from 'node:fs';
import { ConfigReader, ConfigRegistry } from '@aisdlc/config';
import { ProjectSettings, type ProjectId } from '@aisdlc/contracts';
import { ConfigBundleSource, Pdp, RecordDecisionLog, registerPdpConfig } from '@aisdlc/pdp';
import { createPool } from '@aisdlc/db';
import { err, type Result } from '@aisdlc/kernel';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { HttpNotary } from '@aisdlc/notary/client';
import {
  FakeProjectSettings,
  HttpProjectSettings,
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
import { IDENTITY_SCOPES, createIdentityApp, type IdentityScope } from './app.js';
import { migrateIdentity } from './migrations.js';
import { IdentityPdpEntities } from './pdp-entities.js';

const Callers = z.record(
  z.string(),
  z.strictObject({
    token_ref: z.string(),
    scopes: z.array(z.enum(IDENTITY_SCOPES)),
  }),
);

const SettingsFile = z.array(
  z.strictObject({ settings: ProjectSettings, tier: z.enum(['T0', 'T1', 'T2']).nullable() }),
);

/** Without a settings source every lookup is refused (fail closed). */
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
  const coreUrl = env['IDENTITY_CORE_URL'];
  if (coreUrl !== undefined && coreUrl !== '') {
    if (file !== undefined && file !== '') {
      throw new ServiceConfigError(
        'IDENTITY_CORE_URL and IDENTITY_PROJECT_SETTINGS_FILE are two sources for the same thing: set one',
      );
    }
    // Projects live in core (PLAN M7.1): the settings in force are core's, read over its HTTP API.
    return new HttpProjectSettings({
      baseUrl: httpUrlEnv(env, 'IDENTITY_CORE_URL'),
      token: resolveSecretRef(requiredEnv(env, 'IDENTITY_CORE_TOKEN_REF'), { env }),
    });
  }
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
 *   IDENTITY_CALLERS         JSON {caller: {token_ref, scopes: [read|write|reconcile|sync|codeowners|grant|admin]}}
 *                            (`grant`: core alone, the decided grant path of P1-6; `admin`: the bff, a person's
 *                            writes decided by the PDP, which then runs here over the published bundle)
 *   IDENTITY_HOST / _PORT    default 127.0.0.1:8330
 *   NOTARY_URL, IDENTITY_NOTARY_TOKEN_REF, KMS_URL, KMS_TOKEN_REF
 *                            the access-sync loop's Notary client and key lookup (required unless
 *                            IDENTITY_ACCESS_SYNC=off, which only a test environment should set)
 *   IDENTITY_SYNC_INTERVAL_MS  access-sync tick, default 5000
 *   IDENTITY_IDP_SEED_FILE   JSON seed for the local identity provider (optional)
 *   IDENTITY_CORE_URL, IDENTITY_CORE_TOKEN_REF  core's API (scope `read`): where the project settings
 *                            come from (PLAN M7.1)
 *   IDENTITY_PROJECT_SETTINGS_FILE  JSON [{settings, tier}] for a development setup without core
 *                            (optional; not together with IDENTITY_CORE_URL)
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
    // by `aisdlc-migrate` (a bundle cannot find another package's migrations directory, so that
    // one CLI embeds the SQL of every schema). Identity migrates only its own schema, and refuses to start without theirs.
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
    // Portal v2 gap G6: a person's writes (scope `admin`) are the PDP's to decide, over the published bundle.
    const wantsPdp = Object.values(callers).some((c) => c.scopes.includes('admin'));
    const reader = wantsPdp
      ? await ConfigReader.create({
          pool,
          registry: registerPdpConfig(new ConfigRegistry()),
          onError: (e) =>
            console.error(`identity: config reader: ${e instanceof Error ? e.message : String(e)}`),
        })
      : undefined;
    await reader?.start();
    const pdp = reader
      ? new Pdp({
          source: new ConfigBundleSource(reader),
          entities: new IdentityPdpEntities({ pool }),
          log: new RecordDecisionLog({ pool }),
          onError: (e) => console.error(`identity: ${e instanceof Error ? e.message : String(e)}`),
        })
      : undefined;
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
      ...(pdp
        ? { decide: (principal, action, resource) => pdp.decide({ principal, action, resource }) }
        : {}),
    });
    const url = await listen(app, listenOpts);
    return {
      url,
      close: async () => {
        await app.close();
        await loop?.stop();
        await reader?.stop();
        await pool.end();
      },
    };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}
