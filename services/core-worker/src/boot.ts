import { ConfigReader, ConfigRegistry, registerGatewayConfig } from '@aisdlc/config';
import {
  DbRegisteredRepos,
  DbWorkInFlight,
  GatewayAgentKeys,
  HttpKnowledge,
  HttpRoleMapReconciler,
  RefusingStepUp,
  agentStagePorts,
  cardDepsFrom,
  cardsLoop,
  identityEligibility,
  killHoldersLoop,
  gatewayTriggersLoop,
  killObserverLoop,
  registerCoreConfig,
  constitutionFrom,
  roleMapSyncLoop,
  s0DriverLoop,
  maintenanceFrom,
  s0SettingsFrom,
  workDriverLoop,
  workSettingsFrom,
} from '@aisdlc/core/worker';
import { createPool } from '@aisdlc/db';
import { checkpointerLoop, reconcilerLoop } from './ledger-loops.js';
import type { Jwk } from '@aisdlc/kernel';
import {
  LoopSupervisor,
  defaultBranchHeadLoop,
  effectiveRulesLoop,
  installationLoop,
  outboxWatchLoop,
  type WorkInFlightPort,
} from '@aisdlc/loops';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { GatewayAdminClient } from '@aisdlc/gateway/client';
import { HttpKillState, KillswitchClient } from '@aisdlc/killswitch/client';
import { HttpNotary } from '@aisdlc/notary/client';
import { HttpWitness } from '@aisdlc/witness/client';
import {
  FakeCapacity,
  FakeStagePorts,
  FileRegisteredRepos,
  RunKeyVault,
  type CapacityPort,
  type StagePorts,
} from '@aisdlc/ports';
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
 * M9.2: "work in flight" is the work engine's: a repo with an item in S6 or S7 holding an agent
 * lease or session (`DbWorkInFlight`, over the `work_item` read model), so effective rules are
 * polled hourly while agent work runs. An unreadable read model polls at the faster rate. The
 * `work_driver` loop (PLAN M9.2) executes the commands the lifecycle interpreter issues, through the
 * outbox, behind the stage ports. Until the real ports exist (M11-M14) the only implementation is the
 * deterministic fake, which does no work: so the loop runs only when asked for with
 * `CORE_WORKER_STAGE_PORTS=fake`, and needs the Notary (it opens gates through the decision kernel).
 */
export async function bootCoreWorker(
  env: Env,
  deps: {
    workInFlight?: WorkInFlightPort;
    stagePorts?: StagePorts;
    /** Who says how many HELD items may go on (M9.3). Until M13.1 the fake grants nothing. */
    capacity?: CapacityPort;
    log?: (line: string) => void;
  } = {},
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
    // One config reader for the process: MM-2 (the maintenance flag) and the business calendar are read
    // from it by the work driver, the S0 driver and the decision kernel's probe.
    const registry = registerGatewayConfig(registerCoreConfig(new ConfigRegistry()));
    const ensureReader = async (): Promise<ConfigReader> => {
      if (!reader) {
        reader = await ConfigReader.create({
          pool,
          registry,
          onError: (e) => log(`config reader: ${e instanceof Error ? e.message : String(e)}`),
        });
        await reader.start();
      }
      return reader;
    };
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
          { ...poll, workInFlight: deps.workInFlight ?? new DbWorkInFlight(pool) },
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
    if (ledger && cfg.witness) {
      // PLAN M8.0b: the reconciler finishes what a crashed writer left (rows the Notary signed and the
      // record never saw), and the checkpointer has the Notary sign a tree head over the ledger and the
      // Witness co-sign it. Neither holds a key; a failed round is a failed tick (backoff, health).
      supervisor
        .add(
          reconcilerLoop({
            pool,
            deps: { notary: ledger.notary, notaryKey: ledger.notaryKey },
            intervalMs: cfg.reconcileIntervalMs,
            startDelayMs: 3_000,
          }),
        )
        .add(
          checkpointerLoop({
            pool,
            deps: {
              notary: ledger.notary,
              witness: new HttpWitness({ baseUrl: cfg.witness.url, token: cfg.witness.token }),
            },
            intervalMs: cfg.checkpointIntervalMs,
            startDelayMs: 4_000,
          }),
        );
    }
    // AR9: the kill switch is its own service. This process reads it (admission), pushes the holders of
    // every project to it, and records its journal; nothing of it runs inside core.
    const killClient = cfg.killswitch
      ? new KillswitchClient({ baseUrl: cfg.killswitch.url, token: cfg.killswitch.token })
      : null;
    const killState = cfg.killswitch
      ? new HttpKillState({ baseUrl: cfg.killswitch.url, token: cfg.killswitch.token })
      : undefined;
    if (killClient) {
      supervisor.add(
        killHoldersLoop(
          { pool, eligibility: identityEligibility(readPool, registry), link: killClient },
          { intervalMs: cfg.killHoldersIntervalMs, startDelayMs: 1_500 },
        ),
      );
      if (ledger) {
        // The kill switch's public key, pinned from key custody: a journal is checked against it, never
        // against a key the kill switch hands out itself.
        const ksKey = await httpKeyCustodyFromEnv(env).publicKey('dev:killswitch');
        if (!ksKey.ok) throw new Error(`kill switch public key: ${ksKey.error.message}`);
        supervisor.add(
          killObserverLoop(
            { pool, ledger, link: killClient, key: ksKey.value },
            { intervalMs: cfg.killObserverIntervalMs, startDelayMs: 3_500 },
          ),
        );
      }
    }
    if (cfg.stagePorts !== 'none') {
      if (!ledger)
        throw new Error(
          'CORE_WORKER_STAGE_PORTS needs the Notary (gates are opened through the decision kernel)',
        );
      const rd = await ensureReader();
      // M12: with `agents`, S2 and S3 run with real agents; the key secrets pass from the driver to the
      // planning port through this one in-process vault and go nowhere else
      const vault = new RunKeyVault();
      const baseStagePorts = deps.stagePorts ?? new FakeStagePorts();
      if (cfg.stagePorts === 'agents' && (!cfg.gateway || !cfg.knowledge)) {
        throw new Error('CORE_WORKER_STAGE_PORTS=agents needs the gateway and knowledge');
      }
      const stagePorts =
        cfg.stagePorts === 'agents' && cfg.gateway && cfg.knowledge
          ? agentStagePorts({
              pool,
              base: baseStagePorts,
              gatewayUrl: cfg.gateway.url,
              keys: vault,
              knowledge: cfg.knowledge,
              constitution: constitutionFrom(rd),
            })
          : baseStagePorts;
      supervisor.add(
        workDriverLoop(
          {
            pool,
            ports: stagePorts,
            ...(cfg.stagePorts === 'agents' ? { vault } : {}),
            capacity: deps.capacity ?? new FakeCapacity(),
            ...(killState ? { kill: killState } : {}),
            // M11.2: every agent-acted stage command gets a per-Unit key minted from the agent's contract
            ...(cfg.gateway
              ? {
                  keys: new GatewayAgentKeys(
                    new GatewayAdminClient({ baseUrl: cfg.gateway.url, token: cfg.gateway.token }),
                    { extraModels: cfg.agentExtraModels },
                  ),
                }
              : {}),
            settings: workSettingsFrom(rd),
            decisions: {
              pool,
              ledger,
              eligibility: identityEligibility(readPool, registry),
              stepUp: new RefusingStepUp(),
              maintenance: maintenanceFrom(rd),
            },
          },
          {
            intervalMs: cfg.workDriverIntervalMs,
            startDelayMs: 2_500,
            onPass: (r) => {
              if (r.items_created + r.gates_recorded + r.dispatched + r.failed + r.dead > 0) {
                log(
                  `work_driver: items ${r.items_created}, gates ${r.gates_recorded}, commands ${r.dispatched} ok / ${r.failed} retry / ${r.dead} dead`,
                );
              }
            },
          },
        ),
      );
    }
    if (cfg.stagePorts !== 'none') {
      // ET1 from the model gateway (M10.3): a spent per-Unit budget is the item's D1 handoff. It reads
      // the record only; the gateway has no route to core and core none to the gateway.
      supervisor.add(
        gatewayTriggersLoop(
          { pool },
          { startDelayMs: 3_000, intervalMs: cfg.gatewayTriggersIntervalMs },
        ),
      );
    }
    if (cfg.knowledge || cfg.identity) {
      const rd = await ensureReader();
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
              settings: s0SettingsFrom(rd),
              maintenance: maintenanceFrom(rd),
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
              settings: s0SettingsFrom(rd),
              maintenance: maintenanceFrom(rd),
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
    const app = createCoreWorkerApp(supervisor, killState ? { kill: killState } : {});
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
