import {
  followSettings,
  ConfigReader,
  ConfigRegistry,
  registerGatewayConfig,
  type ConfigDeps,
} from '@aisdlc/config';
import { AUDIT_BUCKET, EVIDENCE_BUCKET } from '@aisdlc/contracts';
import { PgProofStore, SignedStepUp } from '@aisdlc/bff/stepup';
import { createPool } from '@aisdlc/db';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { HttpNotary } from '@aisdlc/notary/client';
import { ConfigBundleSource, Pdp, RecordDecisionLog, registerPdpConfig } from '@aisdlc/pdp';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { BootstrapPdpEntities } from '@aisdlc/onboarding';
import {
  HttpCodeHostReads,
  S3ObjectStore,
  VaultSecretStore,
  fetchGithubAppReport,
} from '@aisdlc/ports';
import { listen, listenConfig, type Env, type RunningService } from '@aisdlc/service-kit';
import { createCoreApp } from './app.js';
import { HttpAdmissionVerdict } from './floor-live.js';
import { BootstrapEligibility } from './bootstrap.js';
import { IdentityFactoryAdmins } from './factory-m1.js';
import { cardDepsFrom, identityEligibility } from './card-wiring.js';
import { HttpAccessGrants, HttpKnowledge } from './clients.js';
import { assistantDepsFrom } from './conversation/wire.js';
import { consoleDepsFrom } from './onboarding-console/wire.js';
import { CensusGrounding } from './planning/grounding.js';
import { coreConfigFromEnv } from './config.js';
import { s0SettingsFrom } from './driver.js';
import { instructionTemplateFrom } from './cards/light.js';
import { lightTestsFrom } from './cards/spikes.js';
import { mergeBypassFrom } from './drift/routes.js';
import { migrateCore } from './migrations.js';
import { maintenanceFrom, registerCoreConfig } from './settings.js';
import { workSettingsFrom } from './work-control.js';
import { gateTimersOf } from './settings-v2.js';

/**
 * Starts core from the environment (see `coreConfigFromEnv`). All configuration is read before the
 * database is touched; the record, ledger, config and identity schemas must exist (migrated by
 * `aisdlc-migrate`), the core schema is migrated here. The PDP reads the published `pdp.bundle`
 * through a config reader, so until one is published every decision is a deny.
 */
/** A service's App report (`GET /v1/app`), or `null` when the service is not configured. */
const reportOf = (r: { url: string; token: string } | null) =>
  r === null ? null : () => fetchGithubAppReport({ baseUrl: r.url, token: r.token });

export async function bootCore(env: Env): Promise<RunningService> {
  const cfg = coreConfigFromEnv(env);
  const listenOpts = listenConfig(env, 'CORE', 8380);
  let notary: HttpNotary | undefined;
  let notaryKey:
    Awaited<ReturnType<ReturnType<typeof httpKeyCustodyFromEnv>['publicKey']>> | undefined;
  let custody: ReturnType<typeof httpKeyCustodyFromEnv> | undefined;
  if (cfg.ledger) {
    notary = new HttpNotary({ baseUrl: cfg.ledger.notaryUrl, token: cfg.ledger.notaryToken });
    custody = httpKeyCustodyFromEnv(env);
    notaryKey = await custody.publicKey('dev:notary');
    if (!notaryKey.ok) throw new Error(`notary public key: ${notaryKey.error.message}`);
  }

  const pool = createPool(cfg.databaseUrl, 8);
  // A pool of its own for the eligibility adapter, which catches a read model up on every call.
  const eligibilityPool = createPool(cfg.databaseUrl, 3);
  // And one for the card layer's identity link reads (it is called inside decision transactions).
  const linksPool = createPool(cfg.databaseUrl, 2);
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
    const registry = registerGatewayConfig(
      registerCoreConfig(registerPdpConfig(new ConfigRegistry())),
    );
    reader = await ConfigReader.create({
      pool,
      registry,
      onError: (e) =>
        console.error(`core: config reader: ${e instanceof Error ? e.message : String(e)}`),
    });
    await reader.start();
    // Portal v2: the catalogue's settings releases and the approvals table, followed on every revision
    await followSettings({
      reader,
      pool,
      onError: (e) =>
        console.error(`core: settings: ${e instanceof Error ? e.message : String(e)}`),
    });
    const pdp = new Pdp({
      source: new ConfigBundleSource(reader),
      entities: new BootstrapPdpEntities(new IdentityPdpEntities({ pool }), { db: pool }),
      log: new RecordDecisionLog({ pool }),
      onError: (e) => console.error(`core: ${e instanceof Error ? e.message : String(e)}`),
    });
    const stepUp = custody
      ? new SignedStepUp({
          // Only the public key is ever read from kms-local here.
          custody,
          store: new PgProofStore(pool),
        })
      : undefined;
    const config: ConfigDeps | undefined =
      notary && notaryKey?.ok && stepUp
        ? {
            pool,
            ledger: { notary, notaryKey: notaryKey.value },
            // The bootstrap decider (PLAN M7.4): until a project's first role map is published, the
            // requester of its first onboarding is the provisional admin of the M1 gate that
            // publishes it. Everything else is identity's answer.
            eligibility: new BootstrapEligibility(
              // M15.5: a factory revision's M1 is decided under `factory.m1_policy`
              identityEligibility(eligibilityPool, registry),
              { pool: eligibilityPool },
            ),
            stepUp,
            // Owner decision 2026-11-13: the factory admin's override, asked of identity by the kernel itself
            admins: new IdentityFactoryAdmins(eligibilityPool),
            registry,
            maintenance: maintenanceFrom(reader),
            // portal v2 (`gates.timers`, H8): read on every open and prepare
            ...gateTimersOf(reader),
          }
        : undefined;
    const cards =
      config && cfg.cards
        ? cardDepsFrom({
            pool,
            readPool: linksPool,
            registry,
            ledger: config.ledger,
            eligibility: identityEligibility(eligibilityPool, registry),
            stepUp: config.stepUp,
            ...(config.admins ? { admins: config.admins } : {}),
            knowledge: new HttpKnowledge({
              baseUrl: cfg.cards.knowledge.url,
              token: cfg.cards.knowledge.token,
            }),
            source: new HttpCodeHostReads({
              baseUrl: cfg.cards.codehost.url,
              token: cfg.cards.codehost.token,
            }),
            settings: s0SettingsFrom(reader),
            instructionTemplate: instructionTemplateFrom(reader),
            lightTests: lightTestsFrom(reader),
            maintenance: maintenanceFrom(reader),
          })
        : undefined;
    // the assistant (M18): knowledge's census and search, the gateway's admin API and messages, the code host's head
    const assistant =
      cfg.assistant && cfg.cards
        ? assistantDepsFrom({
            pool,
            knowledge: cfg.cards.knowledge,
            codehost: cfg.cards.codehost,
            gateway: cfg.assistant.gateway,
            extraModels: cfg.assistant.extraModels,
          })
        : undefined;
    // the onboarding console: the same gateway and knowledge as the assistant, the cards' deps for what it reads
    const onboardingConsole =
      cfg.assistant && cfg.cards && cards
        ? consoleDepsFrom({
            cards,
            knowledge: cfg.cards.knowledge,
            gateway: cfg.assistant.gateway,
            extraModels: cfg.assistant.extraModels,
          })
        : undefined;
    const app = createCoreApp({
      pool,
      auth: cfg.auth,
      callers: cfg.callers,
      pdp,
      registry,
      ...(config ? { config } : {}),
      ...(cards ? { cards } : {}),
      ...(assistant ? { assistant } : {}),
      ...(onboardingConsole ? { console: onboardingConsole } : {}),
      ...(cfg.objectStore ? { objects: new S3ObjectStore(cfg.objectStore) } : {}),
      // portal v2 N15: the write-only secret API's store
      ...(cfg.vault ? { secretStore: new VaultSecretStore(cfg.vault) } : {}),
      // Delete means delete (docs/specs/deletion.md): the purge login and the store credential that lifts a hold
      ...(cfg.deletion && config
        ? {
            deletion: {
              purgePool: createPool(cfg.deletion.databaseUrl, 2),
              ledger: config.ledger,
              ...(cfg.deletion.objectStore
                ? {
                    // the two write-once buckets the deletion purges, known without a request: its credential may
                    // lift a hold and delete a version there, never create or configure a bucket
                    objects: new S3ObjectStore({
                      ...cfg.deletion.objectStore,
                      knownBuckets: {
                        [EVIDENCE_BUCKET]: 'write_once',
                        [AUDIT_BUCKET]: 'write_once',
                      },
                    }),
                  }
                : {}),
            },
          }
        : {}),
      // P2-4: the GitHub Apps panel asks the services that hold the keys (never a key itself)
      githubApps: {
        codehost: reportOf(cfg.cards?.codehost ?? null),
        pushBroker: reportOf(cfg.pushBroker),
        rules: cards ? cards.source : null,
      },
      // M16: a drift restore re-attests the per-repo bypass list in force
      ...(reader ? { bypass: mergeBypassFrom(reader) } : {}),
      // P2-16: the clarifying deadline is counted on the S0 calendar, as the work driver's timers are
      ...(reader ? { workSettings: workSettingsFrom(reader) } : {}),
      ...(cfg.admissionUrl
        ? { kill: new HttpAdmissionVerdict({ baseUrl: cfg.admissionUrl }) }
        : {}),
      // P1-6: identity's `grant` scope, which writes what an approved access M1 decided
      ...(cfg.identity
        ? {
            grants: new HttpAccessGrants({
              baseUrl: cfg.identity.url,
              token: cfg.identity.token,
            }),
          }
        : {}),
      // B5 (M12.5): a hand-written plan is made against the merged head knowledge's census names
      ...(cfg.cards
        ? {
            grounding: new CensusGrounding(
              new HttpKnowledge({
                baseUrl: cfg.cards.knowledge.url,
                token: cfg.cards.knowledge.token,
              }),
            ),
          }
        : {}),
    });
    const url = await listen(app, listenOpts);
    const r = reader;
    return {
      url,
      close: async () => {
        await app.close();
        await r.stop();
        await linksPool.end();
        await eligibilityPool.end();
        await pool.end();
      },
    };
  } catch (e) {
    await reader?.stop().catch(() => undefined);
    await linksPool.end().catch(() => undefined);
    await eligibilityPool.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw e;
  }
}
