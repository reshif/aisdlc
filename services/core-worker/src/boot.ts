import {
  ConfigReader,
  ConfigRegistry,
  onboardingImageFrom,
  registerGatewayConfig,
} from '@aisdlc/config';
import {
  AdmissionCapacity,
  DbPrincipalLinks,
  DbProjectSettings,
  DbRegisteredRepos,
  GatewayEnvelope,
  ReferenceSnapshots,
  DbWorkInFlight,
  GatewayAgentKeys,
  HttpKnowledge,
  HttpRoleMapReconciler,
  RefusingStepUp,
  agentStagePorts,
  CorePush,
  buildStagePorts,
  verifyStagePorts,
  releaseStagePorts,
  execAllowedReposFrom,
  cardDepsFrom,
  cardsLoop,
  identityEligibility,
  killHoldersLoop,
  gatewayTriggersLoop,
  killObserverLoop,
  mergeReviewLoop,
  issueTwinLoop,
  CensusGapRecheck,
  auditSampleLoop,
  learnLoop,
  closeOutStagePorts,
  mergeReconcileLoop,
  DbWatchedPulls,
  registerCoreConfig,
  constitutionFrom,
  roleMapSyncLoop,
  s0DriverLoop,
  maintenanceFrom,
  s0SettingsFrom,
  instructionTemplateFrom,
  probeFilesOf,
  probeLoop,
  packLoop,
  lightTestsFrom,
  workDriverLoop,
  workSettingsFrom,
  healthSnapshotLoop,
} from '@aisdlc/core/worker';
import { AppKey, GitHubIssueTracker } from '@aisdlc/codehost';
import { createPool } from '@aisdlc/db';
import {
  HttpBundleSource,
  HttpCodeHostPush,
  HttpSandbox,
  S3ObjectStore,
  type SandboxPort,
} from '@aisdlc/ports';
import { DockerSandboxDriver } from '@aisdlc/sandbox-driver';
import { HttpVerify } from '@aisdlc/verify';
import { checkpointerLoop, reconcilerLoop } from './ledger-loops.js';
import type { Jwk } from '@aisdlc/kernel';
import {
  LoopSupervisor,
  agentPullsLoop,
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
  scriptVerifyExceptions,
  FileRegisteredRepos,
  RunKeyVault,
  type CapacityPort,
  type StagePorts,
} from '@aisdlc/ports';
import { listen, listenConfig, type Env, type RunningService } from '@aisdlc/service-kit';

const proxyEndpoint = (url: string): { host: string; port: number } => {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 80) };
};
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
    if (wantsCore) {
      // M19: HealthSnapshot. This process's own loops and every configured service's liveness answer, every 30 s
      // into `core.health_snapshot` (a reading, never a fact; the read applies the two-minute rule).
      supervisor.add(
        healthSnapshotLoop(
          { pool, own: () => supervisor.health(), targets: cfg.healthTargets },
          { intervalMs: cfg.healthIntervalMs, startDelayMs: 2_500 },
        ),
      );
    }
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
      const fakes = deps.stagePorts ?? new FakeStagePorts();
      // M14.6: the compose e2e's scripted S7 (FACTORY_ENV=local only, checked by the config)
      const baseStagePorts =
        cfg.fakeVerify === 'exceptions' && fakes instanceof FakeStagePorts
          ? scriptVerifyExceptions(fakes)
          : fakes;
      if (cfg.stagePorts === 'agents' && (!cfg.gateway || !cfg.knowledge)) {
        throw new Error('CORE_WORKER_STAGE_PORTS=agents needs the gateway and knowledge');
      }
      const agentPorts =
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
      // M13.3, M13.4: with a sandbox proxy, 6.1 to 6.5 run real coding sessions (the DEC-18 owner allow-list and B1 in
      // front of every session), and HUMAN-WAIT's snapshots are of the session's real workspace. M14.2: with the
      // sandbox-controller, the same sessions go to it over HTTP (it owns the driver, the ceilings and the caps; this
      // process holds no proxy token) and H2 reads its free slots
      const sc = cfg.sandboxController;
      const controller = sc ? new HttpSandbox({ baseUrl: sc.url, token: sc.token }) : null;
      const session: { sandbox: SandboxPort; storeDir: string; model: string } | null =
        sc && controller
          ? { sandbox: controller, storeDir: sc.storeDir, model: sc.model }
          : cfg.sandbox
            ? {
                sandbox: new DockerSandboxDriver({
                  endpoint: {
                    ...proxyEndpoint(cfg.sandbox.proxyUrl),
                    token: cfg.sandbox.proxyToken,
                  },
                  image: cfg.sandbox.image,
                  scratch: { local: cfg.sandbox.scratch, host: cfg.sandbox.scratch },
                  peers: { mirror: cfg.sandbox.mirror, gateway: cfg.sandbox.gateway },
                  trustedCommands: [],
                }),
                storeDir: cfg.sandbox.storeDir,
                model: cfg.sandbox.model,
              }
            : null;
      const built =
        session && cfg.knowledge
          ? buildStagePorts({
              pool,
              base: agentPorts,
              sandbox: session.sandbox,
              storeDir: session.storeDir,
              keys: vault,
              bundles: new HttpBundleSource({ baseUrl: cfg.codehostUrl, token: cfg.codehostToken }),
              knowledge: new HttpKnowledge({
                baseUrl: cfg.knowledge.url,
                token: cfg.knowledge.token,
              }),
              execAllowedRepos: execAllowedReposFrom(rd),
              model: session.model,
              // M13.6: the Push Broker's client, with the record first and the receipt in the record and the ledger
              ...(cfg.pushBroker
                ? {
                    deps: { pool, ...(ledger ? { ledger } : {}) },
                    ...(ledger
                      ? {
                          push: new CorePush(
                            { pool, ledger },
                            new HttpCodeHostPush({
                              baseUrl: cfg.codehostUrl,
                              token: cfg.codehostToken,
                            }),
                          ),
                        }
                      : {}),
                  }
                : {}),
            })
          : null;
      const beforeVerify = built ? built.stagePorts : agentPorts;
      // M14.3: S7 7.1 to 7.5 through the verify service (its kits through the sandbox-controller); M14.4: 7.6 here, the
      // Evidence Pack signed by the Notary's evidence purpose and stored in the object store's write-once bucket
      const verifying = Boolean(cfg.verify && cfg.knowledge && cfg.objectStore && ledger);
      const afterVerify =
        cfg.verify && cfg.knowledge && cfg.objectStore && ledger
          ? verifyStagePorts({
              pool,
              ledger,
              signer: ledger.notary,
              objects: new S3ObjectStore({
                endpoint: cfg.objectStore.endpoint,
                accessKeyRef: cfg.objectStore.accessKeyRef,
                secretKeyRef: cfg.objectStore.secretKeyRef,
              }),
              base: beforeVerify,
              client: new HttpVerify({ baseUrl: cfg.verify.url, token: cfg.verify.token }),
              keys: vault,
              constitution: constitutionFrom(rd),
              execAllowedRepos: execAllowedReposFrom(rd),
              knowledge: new HttpKnowledge({
                baseUrl: cfg.knowledge.url,
                token: cfg.knowledge.token,
              }),
              ...(built ? { store: built.store } : {}),
            })
          : beforeVerify;
      // M15.3: S8b through gate-relay's record (the deployment of an approved G5, its health; B16 on a rollback)
      const released = cfg.releaseViaGateRelay
        ? releaseStagePorts({ pool, base: afterVerify, deps: { pool } })
        : afterVerify;
      // M15.4: 9.3 records the close-out (record + ledger) wherever the ledger is
      const stagePorts = ledger ? closeOutStagePorts({ pool, ledger, base: released }) : released;
      // M13.1: 6.0 admission (a lease epoch, an approver slot, capacity, the envelope reserved in the gateway)
      // and the capacity port behind it, which frees the held items only when their next admission can succeed
      const admissionBase = cfg.gateway
        ? {
            settings: new DbProjectSettings({ pool, registry }),
            envelope: new GatewayEnvelope(
              new GatewayAdminClient({ baseUrl: cfg.gateway.url, token: cfg.gateway.token }),
            ),
            snapshots: built ? built.snapshots : new ReferenceSnapshots(),
            ...(controller ? { slots: controller } : {}),
          }
        : null;
      const realCapacity = admissionBase ? new AdmissionCapacity({ pool, ...admissionBase }) : null;
      supervisor.add(
        workDriverLoop(
          {
            pool,
            ports: stagePorts,
            ...(admissionBase && realCapacity && !deps.capacity
              ? { admission: { ...admissionBase, attempted: realCapacity.attempted } }
              : {}),
            ...(cfg.stagePorts === 'agents' ? { vault } : {}),
            // M15.1: with S7's Evidence Packs, G4 opens with its review (mode C or E, the pack of exactly each PR head,
            // CODEOWNERS at the base through the codehost, the owners' principals through identity's links)
            ...(verifying ? { review: { source, links: new DbPrincipalLinks(readPool) } } : {}),
            capacity: deps.capacity ?? realCapacity ?? new FakeCapacity(),
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
    if (cfg.tracker && cfg.knowledge) {
      // M16: the GitHub issue twin, through its OWN App (issues:write, metadata:read): files the approved batches
      // and polls their twins; the re-check is knowledge's census at exactly the head the poll recorded.
      const t = cfg.tracker;
      supervisor.add(
        issueTwinLoop(
          {
            pool,
            tracker: new GitHubIssueTracker({
              baseUrl: t.apiUrl,
              appId: t.appId,
              installationId: t.installationId,
              appKey: AppKey.fromRef(t.appKeyRef),
              login: t.login,
              plainHttpHosts: t.plainHttpHosts,
              log: (line) => log(`issue_twin: ${line}`),
            }),
            recheck: new CensusGapRecheck({
              pool,
              knowledge: new HttpKnowledge({
                baseUrl: cfg.knowledge.url,
                token: cfg.knowledge.token,
              }),
            }),
          },
          {
            intervalMs: cfg.issueTwinIntervalMs,
            startDelayMs: 4_000,
            onReport: (r) => {
              if (r.filed + r.reconciled + r.verified + r.unverified + r.lost > 0) {
                log(
                  `issue_twin: filed ${r.filed}, reconciled ${r.reconciled}, verified ${r.verified}, unverified ${r.unverified}, lost ${r.lost}`,
                );
              }
            },
          },
        ),
      );
    }
    if (ledger) {
      // M14.5: the X4 review of every merge gate-check recorded without aisdlc/gate passing (a bypass by a listed
      // person, or an unauthorised merge). gate-check has no route to core: it records, this loop opens the cards.
      const rd = await ensureReader();
      const decisions = {
        pool,
        ledger,
        eligibility: identityEligibility(readPool, registry),
        stepUp: new RefusingStepUp(),
        maintenance: maintenanceFrom(rd),
      };
      const links = new DbPrincipalLinks(readPool);
      supervisor.add(mergeReviewLoop({ decisions, links }, { startDelayMs: 3_500 }));
      // M15.4 9.5: the mode-E audit sample, drawn from the close-out records off the closing chain
      supervisor.add(
        auditSampleLoop({ pool, sampleOneIn: cfg.auditSampleOneIn }, { startDelayMs: 5_000 }),
      );
      // M15.5 9.4 Learn: close-out evidence into META proposals (M1, M2, M3, M5, M6), each a card the project admins
      // decide; only a decided M5 (read from the ledger) promotes autonomy or lifts B19
      supervisor.add(learnLoop({ pool, decisions }, { startDelayMs: 6_000 }));
      if (cfg.pushBroker) {
        // M15.2 8.2: a person merges an agent PR on the host. The poll records what the host says of every agent PR
        // of an item in flight (record first, the Push Broker's read-only `pr_status`); the reconcile then completes
        // S8 for exactly the approved head, opens X4 for any other merge, and takes B15a or B15b at 8.2.
        supervisor
          .add(
            agentPullsLoop(
              {
                pool,
                source: new HttpCodeHostPush({
                  baseUrl: cfg.codehostUrl,
                  token: cfg.codehostToken,
                }),
                watched: new DbWatchedPulls(pool),
              },
              { startDelayMs: 4_000 },
            ),
          )
          .add(mergeReconcileLoop({ pool, decisions, links }, { startDelayMs: 4_500 }));
      }
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
      if (cfg.knowledge && cfg.sandboxController) {
        // M16: the onboarding probe (LF3) of every record waiting at card 2, in a K-exec session through the
        // sandbox-controller only (it starts nothing without the probe grant core records first, and runs only the
        // image `onboarding.sandbox_image` approves); DEC-18's allow-list and B1 are checked before anything runs
        const sc = cfg.sandboxController;
        supervisor.add(
          probeLoop(
            {
              pool,
              knowledge: new HttpKnowledge({
                baseUrl: cfg.knowledge.url,
                token: cfg.knowledge.token,
              }),
              probe: {
                sandbox: new HttpSandbox({ baseUrl: sc.url, token: sc.token }),
                files: probeFilesOf(
                  new HttpBundleSource({ baseUrl: cfg.codehostUrl, token: cfg.codehostToken }),
                ),
                image: () => onboardingImageFrom(rd.current()),
                execAllowedRepos: execAllowedReposFrom(rd),
              },
            },
            { intervalMs: cfg.cardsIntervalMs * 3, startDelayMs: 5_000 },
          ),
        );
      }
      if (cfg.knowledge && ledger) {
        // Cards 1, 2 (M16), 4, 5 and the security card (PLAN M7.3): opened, applied and withdrawn as the S0
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
              instructionTemplate: instructionTemplateFrom(rd),
              lightTests: lightTestsFrom(rd),
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
      if (cfg.knowledge && ledger) {
        // M16 R2b: the affirmed pack's git projection. After card 2 is applied the pack is rendered from the record and
        // recorded first, X2 opens on the S0 record bound to its patch hash, and only once X2 is approved in the ledger
        // is the Push Broker asked for a draft PR (with CORE_WORKER_PUSH_BROKER=1; otherwise it waits at x2_approved)
        supervisor.add(
          packLoop(
            {
              cards: cardDepsFrom({
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
                instructionTemplate: instructionTemplateFrom(rd),
                lightTests: lightTestsFrom(rd),
                maintenance: maintenanceFrom(rd),
              }),
              push: { pool, ledger },
              ...(cfg.pushBroker
                ? {
                    broker: new HttpCodeHostPush({
                      baseUrl: cfg.codehostUrl,
                      token: cfg.codehostToken,
                    }),
                  }
                : {}),
            },
            { intervalMs: cfg.cardsIntervalMs * 2, startDelayMs: 6_000 },
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
