import { ConfigReader, ConfigRegistry, type ConfigDeps } from '@aisdlc/config';
import { createPool } from '@aisdlc/db';
import { PortError, type StepUpPort } from '@aisdlc/decisions';
import { IdentityEligibility } from '@aisdlc/identity/read';
import { err } from '@aisdlc/kernel';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { HttpNotary } from '@aisdlc/notary/client';
import { ConfigBundleSource, Pdp, RecordDecisionLog, registerPdpConfig } from '@aisdlc/pdp';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { listen, listenConfig, type Env, type RunningService } from '@aisdlc/service-kit';
import { createCoreApp } from './app.js';
import { BootstrapEligibility } from './bootstrap.js';
import { coreConfigFromEnv } from './config.js';
import { migrateCore } from './migrations.js';
import { DbProjectSettings, registerCoreConfig } from './settings.js';

/** Core runs no step-up: the proof is checked where the person authenticates (the BFF). Fail closed. */
class NoStepUp implements StepUpPort {
  async verify() {
    return err(PortError({ message: 'step-up is not available in core' }));
  }
}

/**
 * Starts core from the environment (see `coreConfigFromEnv`). All configuration is read before the
 * database is touched; the record, ledger, config and identity schemas must exist (migrated by
 * `aisdlc-migrate`), the core schema is migrated here. The PDP reads the published `pdp.bundle`
 * through a config reader, so until one is published every decision is a deny.
 */
export async function bootCore(env: Env): Promise<RunningService> {
  const cfg = coreConfigFromEnv(env);
  const listenOpts = listenConfig(env, 'CORE', 8370);
  let notary: HttpNotary | undefined;
  let notaryKey:
    Awaited<ReturnType<ReturnType<typeof httpKeyCustodyFromEnv>['publicKey']>> | undefined;
  if (cfg.ledger) {
    notary = new HttpNotary({ baseUrl: cfg.ledger.notaryUrl, token: cfg.ledger.notaryToken });
    notaryKey = await httpKeyCustodyFromEnv(env).publicKey('dev:notary');
    if (!notaryKey.ok) throw new Error(`notary public key: ${notaryKey.error.message}`);
  }

  const pool = createPool(cfg.databaseUrl, 8);
  // A pool of its own for the eligibility adapter, which catches a read model up on every call.
  const eligibilityPool = createPool(cfg.databaseUrl, 3);
  let reader: ConfigReader | undefined;
  try {
    const have = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('record.record_event')::text AS record,
              to_regclass('ledger.ledger_entry')::text AS ledger,
              to_regclass('config.config_revision')::text AS config,
              to_regclass('identity.principal')::text AS identity`,
    );
    const missing = Object.entries(have.rows[0] ?? {})
      .filter(([, v]) => v == null)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `the ${missing.join(', ')} schema(s) are missing: migrate the record database first`,
      );
    }
    await migrateCore(pool);
    const registry = registerCoreConfig(registerPdpConfig(new ConfigRegistry()));
    reader = await ConfigReader.create({
      pool,
      registry,
      onError: (e) =>
        console.error(`core: config reader: ${e instanceof Error ? e.message : String(e)}`),
    });
    await reader.start();
    const pdp = new Pdp({
      source: new ConfigBundleSource(reader),
      entities: new IdentityPdpEntities({ pool }),
      log: new RecordDecisionLog({ pool }),
      onError: (e) => console.error(`core: ${e instanceof Error ? e.message : String(e)}`),
    });
    const config: ConfigDeps | undefined =
      notary && notaryKey?.ok
        ? {
            pool,
            ledger: { notary, notaryKey: notaryKey.value },
            // The bootstrap decider (PLAN M7.4): until a project's first role map is published, the
            // requester of its first onboarding is the provisional admin of the M1 gate that
            // publishes it. Everything else is identity's answer.
            eligibility: new BootstrapEligibility(
              new IdentityEligibility({
                pool: eligibilityPool,
                settings: new DbProjectSettings({ pool: eligibilityPool, registry }),
              }),
              { pool: eligibilityPool },
            ),
            stepUp: new NoStepUp(),
            registry,
          }
        : undefined;
    const app = createCoreApp({
      pool,
      auth: cfg.auth,
      callers: cfg.callers,
      pdp,
      registry,
      ...(config ? { config } : {}),
    });
    const url = await listen(app, listenOpts);
    const r = reader;
    return {
      url,
      close: async () => {
        await app.close();
        await r.stop();
        await eligibilityPool.end();
        await pool.end();
      },
    };
  } catch (e) {
    await reader?.stop().catch(() => undefined);
    await eligibilityPool.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw e;
  }
}
