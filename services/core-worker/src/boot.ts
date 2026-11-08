import { ConfigReader, ConfigRegistry } from '@aisdlc/config';
import {
  DbRegisteredRepos,
  HttpKnowledge,
  HttpRoleMapReconciler,
  RefusingStepUp,
  cardDepsFrom,
  cardsLoop,
  identityEligibility,
  registerCoreConfig,
  roleMapSyncLoop,
  s0DriverLoop,
  s0SettingsFrom,
} from '@aisdlc/core/worker';
import { createPool } from '@aisdlc/db';
import type { Jwk } from '@aisdlc/kernel';
import {
  LoopSupervisor,
  FakeWorkInFlight,
  defaultBranchHeadLoop,
  effectiveRulesLoop,
  installationLoop,
  outboxWatchLoop,
  type WorkInFlightPort,
} from '@aisdlc/loops';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { HttpNotary } from '@aisdlc/notary/client';
import { FileRegisteredRepos } from '@aisdlc/ports';
import { listen, listenConfig, type Env, type RunningService } from '@aisdlc/service-kit';
import { createCoreWorkerApp } from './app.js';
import { HttpCodeHostReads } from './codehost-client.js';
import { coreWorkerConfigFromEnv } from './config.js';

/**
 * Starts core-worker (PLAN §5: the one process that hosts every loop), with the code-host poll
 * loops and the outbox dead-letter alert so far (M5.4). More loops (inbox, relay, reconciler,
 * checkpointer, ...) are `supervisor.add(...)` calls here as their milestones land.
 *
 * M7 adds the S0 step driver and the role-map sync (both from `@aisdlc/core/worker`), when knowledge
 * and identity are configured; without a registered-repos file the polls read core's own repos.
 *
 * M8.0 adds the onboarding cards loop (`cardsLoop`), when the Notary and knowledge are configured
 * too: its decision kernel is the Notary, the identity read model (plain eligibility, bootstrap
 * decider on) and the codehost's reads; it never takes a decision itself (its step-up refuses).
 *
 * Until the work engine exists (M9) there is no source of "work in flight": the fake says none, so
 * effective rules are polled nightly. That is the slower, never the faster, rate, so the real port
 * must be wired in before agent work can start (M9.1 owns that).
 */
export async function bootCoreWorker(
  env: Env,
  deps: { workInFlight?: WorkInFlightPort; log?: (line: string) => void } = {},
): Promise<RunningService> {
  const cfg = coreWorkerConfigFromEnv(env);
  const listenOpts = listenConfig(env, 'CORE_WORKER', 8360);
  const log = deps.log ?? ((line: string) => console.log(`core-worker: ${line}`));
  // The ledger side of the cards: the Notary's public key is read once, at start (a lookup, no signing).
  let ledger: { notary: HttpNotary; notaryKey: Jwk } | undefined;
  if (cfg.ledger) {
    const key = await httpKeyCustodyFromEnv(env).publicKey('dev:notary');
    if (!key.ok) throw new Error(`notary public key: ${key.error.message}`);
    ledger = {
      notary: new HttpNotary({ baseUrl: cfg.ledger.notaryUrl, token: cfg.ledger.notaryToken }),
      notaryKey: key.value,
    };
  }
  const pool = createPool(cfg.databaseUrl, 6);
  // For the card layer's identity reads, which run while a decision transaction holds a connection.
  const readPool = createPool(cfg.databaseUrl, 3);
  let reader: ConfigReader | undefined;
  try {
    const have = await pool.query<{ record: string | null }>(
      `SELECT to_regclass('record.record_event')::text AS record`,
    );
    if (have.rows[0]?.record == null) {
      throw new Error('the record schema is missing: migrate the record database first');
    }
    const wantsCore = cfg.registeredReposFile === null || cfg.knowledge || cfg.identity;
    if (wantsCore) {
      // Core's schema ships with core (`aisdlc-migrate` applies it): this process only checks.
      const core = await pool.query<{ core: string | null }>(
        `SELECT to_regclass('core.s0_record')::text AS core`,
      );
      if (core.rows[0]?.core == null) {
        throw new Error('the core schema is missing: migrate the record database first');
      }
    }
    const supervisor = new LoopSupervisor({ log });
    const source = new HttpCodeHostReads({ baseUrl: cfg.codehostUrl, token: cfg.codehostToken });
    const poll = {
      pool,
      source,
      registered: cfg.registeredReposFile
        ? new FileRegisteredRepos(cfg.registeredReposFile)
        : new DbRegisteredRepos(pool),
    };
    supervisor
      .add(defaultBranchHeadLoop(poll, { intervalMs: cfg.headIntervalMs }))
      .add(installationLoop(poll, { intervalMs: cfg.installationIntervalMs, startDelayMs: 1_000 }))
      .add(
        effectiveRulesLoop(
          { ...poll, workInFlight: deps.workInFlight ?? new FakeWorkInFlight() },
          {
            inFlightIntervalMs: cfg.rulesInFlightIntervalMs,
            idleIntervalMs: cfg.rulesIdleIntervalMs,
            tickMs: cfg.rulesTickMs,
            startDelayMs: 2_000,
          },
        ),
      )
      .add(
        outboxWatchLoop({
          pool,
          intervalMs: cfg.outboxWatchIntervalMs,
          setAlert: (k, a) => supervisor.setAlert(k, a),
        }),
      );
    if (cfg.knowledge || cfg.identity) {
      const registry = registerCoreConfig(new ConfigRegistry());
      reader = await ConfigReader.create({
        pool,
        registry,
        onError: (e) => log(`config reader: ${e instanceof Error ? e.message : String(e)}`),
      });
      await reader.start();
      if (cfg.knowledge) {
        supervisor.add(
          s0DriverLoop(
            {
              pool,
              source,
              knowledge: new HttpKnowledge({
                baseUrl: cfg.knowledge.url,
                token: cfg.knowledge.token,
              }),
              settings: s0SettingsFrom(reader),
            },
            {
              intervalMs: cfg.s0DriverIntervalMs,
              startDelayMs: 1_000,
              // Only what happened: a record that needed nothing is not a log line.
              onOutcome: (o) => {
                if (o.action !== 'none') log(`s0_driver: ${o.s0_id}: ${o.action}`);
              },
            },
          ),
        );
      }
      if (cfg.knowledge && ledger) {
        // Cards 1, 4, 5 and the security card (PLAN M7.3): opened, applied and withdrawn as the S0
        // records move. The scoped bootstrap grant is the card layer's (`bootstrap: true`).
        supervisor.add(
          cardsLoop(
            cardDepsFrom({
              pool,
              readPool,
              registry,
              ledger,
              eligibility: identityEligibility(readPool, registry),
              stepUp: new RefusingStepUp(),
              knowledge: new HttpKnowledge({
                baseUrl: cfg.knowledge.url,
                token: cfg.knowledge.token,
              }),
              source,
              settings: s0SettingsFrom(reader),
            }),
            {
              intervalMs: cfg.cardsIntervalMs,
              startDelayMs: 2_000,
              onSync: (id, changed) => {
                if (changed > 0) log(`cards: ${id}: ${changed} change(s)`);
              },
            },
          ),
        );
      }
      if (cfg.identity) {
        supervisor.add(
          roleMapSyncLoop(
            {
              pool,
              registry,
              reconciler: new HttpRoleMapReconciler({
                baseUrl: cfg.identity.url,
                token: cfg.identity.token,
              }),
            },
            { intervalMs: cfg.roleMapSyncIntervalMs, startDelayMs: 1_000 },
          ),
        );
      }
    }
    const app = createCoreWorkerApp(supervisor);
    const url = await listen(app, listenOpts);
    supervisor.start();
    return {
      url,
      close: async () => {
        await app.close();
        await supervisor.stop();
        await reader?.stop();
        await readPool.end();
        await pool.end();
      },
    };
  } catch (e) {
    await reader?.stop().catch(() => undefined);
    await readPool.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw e;
  }
}
