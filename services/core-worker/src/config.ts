import { z } from 'zod';
import {
  ServiceConfigError,
  databaseUrl,
  httpUrlEnv,
  requiredEnv,
  resolveSecretRef,
  type Env,
} from '@aisdlc/service-kit';

export interface CoreWorkerConfig {
  readonly databaseUrl: string;
  readonly codehostUrl: string;
  readonly codehostToken: string;
  /** A JSON file standing in for core's registered repos; `null`: core's own read model. */
  readonly registeredReposFile: string | null;
  /** The S0 step driver (PLAN M7.2): knowledge's API; `null`: the driver does not run. */
  readonly knowledge: { readonly url: string; readonly token: string } | null;
  /** The role-map sync (PLAN M7.1): identity's API; `null`: the sync does not run. */
  readonly identity: { readonly url: string; readonly token: string } | null;
  /**
   * The decision kernel's ledger side (PLAN M8.0): the Notary and the key lookup. With it and
   * knowledge, the onboarding cards loop runs; without it, cards open through core's sync route.
   */
  readonly ledger: { readonly notaryUrl: string; readonly notaryToken: string } | null;
  /**
   * The ledger reconciler and the checkpointer (PLAN M8.0b): the Witness's API (scope `cosign`).
   * Needs `ledger` (the Notary). `null`: neither loop runs.
   */
  readonly witness: { readonly url: string; readonly token: string } | null;
  /**
   * The kill switch (PLAN M9.6, AR9): its API (scopes `read` and `sync`). With it, the work driver asks it
   * before it admits agent work, core's holders are pushed to it, and its journal is recorded as facts
   * and (with the Notary) ledger entries. REQUIRED when the work driver runs: agent work without a kill
   * switch to ask is not admitted (fail closed).
   */
  readonly killswitch: { readonly url: string; readonly token: string } | null;
  /**
   * The stage ports behind the work driver (PLAN M9.2). `none`: the `work_driver` loop does not run.
   * `fake`: the deterministic fakes (no real stage work exists before M11-M14). Needs the Notary.
   */
  readonly stagePorts: 'none' | 'fake' | 'agents';
  /**
   * The model gateway's admin API (scope `admin`, PLAN M11.2): the work driver mints each agent-acted
   * stage command's per-Unit virtual key through it. Required with the stage ports: no key, no agent run.
   */
  readonly gateway: { readonly url: string; readonly token: string } | null;
  /** Model ids added to every minted key's allow-list (`CORE_WORKER_AGENT_EXTRA_MODELS`). */
  readonly agentExtraModels: readonly string[];
  /**
   * S6 with real coding sessions (PLAN M13.3, M13.4): the allow-list Docker proxy of the coding worker and what a session
   * needs on it. `null`: 6.1 to 6.5 stay over the stage-port fakes. Needs `stagePorts: 'agents'`.
   */
  readonly sandbox: {
    readonly proxyUrl: string;
    /** This worker's bearer token at the proxy (a `file:` reference like every other service token). */
    readonly proxyToken: string;
    readonly image: string;
    /** The scratch directory for repo copies: the same path for this process and for the daemon. */
    readonly scratch: string;
    /** The container names of the two peers a session network attaches. */
    readonly mirror: string;
    readonly gateway: string;
    readonly storeDir: string;
    /** The gateway's model id for the coder. */
    readonly model: string;
  } | null;
  /**
   * M14.2: S6's sessions through the sandbox-controller (`HttpSandbox`), which owns the driver, the class ceilings and
   * the caps of its runner host; admission's H2 also reads its free slots. Exclusive with `sandbox` (the in-process
   * driver). Needs `stagePorts: 'agents'`.
   */
  readonly sandboxController: {
    readonly url: string;
    /** This worker's bearer token at the controller (scopes `run`, `read`). */
    readonly token: string;
    readonly storeDir: string;
    readonly model: string;
  } | null;
  /**
   * 6.6 through the Push Broker (PLAN M13.6): with `CORE_WORKER_PUSH_BROKER=1` (and a sandbox) the codehost's `push` route is
   * asked for the Unit's patch (this worker's codehost token needs the scope `push`). Off: 6.6 stays over the stage-port fake.
   */
  readonly pushBroker: boolean;
  /**
   * M14.3: S7 7.1 to 7.5 through the verify service (`CORE_WORKER_VERIFY_URL`, this worker's token there with the
   * scopes `run` and `read`), and 7.6 (M14.4): the Evidence Pack signed by the Notary (this worker's Notary token needs
   * the scope `evidence`) and stored in the object store. Needs `stagePorts: 'agents'`, the Notary and `objectStore`.
   */
  readonly verify: { readonly url: string; readonly token: string } | null;
  /**
   * M15.3: S8b follows gate-relay's record (`CORE_WORKER_RELEASE=gate-relay`): a release is done only when gate-relay
   * deployed the approved G5 and the deployment is healthy; refused or rolled back is RELHOLD (B16 adds the NEW linked
   * rollback item). Off: S8b stays over the stage-port fake. Needs a stage-port mode other than `none`.
   */
  readonly releaseViaGateRelay: boolean;
  /**
   * M14.6: `exceptions` scripts the S7 fakes to raise the exception gates one after another (`scriptVerifyExceptions`:
   * Q1, X2, E2 on the first item to reach S7, E6 on the second) for the compose e2e. Only with FACTORY_ENV=local, the
   * stage-port fakes and no verify service.
   */
  readonly fakeVerify: 'default' | 'exceptions';
  /**
   * M14.4: the S3-compatible object store the Evidence Packs go to (`CORE_WORKER_OBJECT_STORE_URL`), with its
   * credentials as `file:`/`env:` references, resolved by the adapter (never held in this config).
   */
  readonly objectStore: {
    readonly endpoint: string;
    readonly accessKeyRef: string;
    readonly secretKeyRef: string;
  } | null;
  /**
   * M16: the GitHub issue twin (OB §6.5 "new `tracker` role, issues:write + metadata:read"). Its OWN App is held by the
   * codehost (user decision 2026-11-12: core-worker keeps no route out); core-worker calls the codehost's tracker routes.
   * With it (and knowledge, for the re-check) the `issue_twin` loop files approved batches and polls their twins.
   * `null`: the loop does not run and approved twins stay `pending`.
   */
  readonly tracker: {
    /** The login the codehost's tracker App writes as; its calls go through the codehost (scope `tracker`). */
    readonly login: string;
  } | null;
  readonly issueTwinIntervalMs: number;
  readonly workDriverIntervalMs: number;
  /**
   * M15.4 9.5: one in how many mode-E merges the audit sample draws (`CORE_WORKER_AUDIT_SAMPLE_ONE_IN`, default 1: every
   * one, until a catalogue release names a rate; more audit, never less).
   */
  readonly auditSampleOneIn: number;
  readonly killHoldersIntervalMs: number;
  readonly killObserverIntervalMs: number;
  /** How often the gateway's ET1 events become item triggers (M10.3). */
  readonly gatewayTriggersIntervalMs: number;
  readonly reconcileIntervalMs: number;
  readonly checkpointIntervalMs: number;
  readonly cardsIntervalMs: number;
  readonly s0DriverIntervalMs: number;
  readonly roleMapSyncIntervalMs: number;
  readonly headIntervalMs: number;
  readonly installationIntervalMs: number;
  readonly rulesInFlightIntervalMs: number;
  readonly rulesIdleIntervalMs: number;
  readonly rulesTickMs: number;
  readonly outboxWatchIntervalMs: number;
  /** M19: the services whose `/healthz` the `health_snapshot` loop reads (name -> base URL and path). */
  readonly healthTargets: Readonly<
    Record<string, { readonly url: string; readonly path?: string }>
  >;
  readonly healthIntervalMs: number;
}

const HealthTargets = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  z.union([
    z.string(),
    z.strictObject({
      url: z.string(),
      path: z
        .string()
        .regex(/^\/[A-Za-z0-9/_.-]*$/)
        .optional(),
    }),
  ]),
);

/** `CORE_WORKER_HEALTH_TARGETS`: JSON `{name: url | {url, path}}`; each URL plain http(s). */
function healthTargetsEnv(env: Env): CoreWorkerConfig['healthTargets'] {
  const raw = env['CORE_WORKER_HEALTH_TARGETS'];
  if (raw === undefined || raw === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ServiceConfigError('CORE_WORKER_HEALTH_TARGETS must be JSON');
  }
  const p = HealthTargets.safeParse(json);
  if (!p.success) {
    throw new ServiceConfigError(
      'CORE_WORKER_HEALTH_TARGETS is {name: url | {url, path}} with names [a-z0-9-]',
    );
  }
  const out: Record<string, { url: string; path?: string }> = {};
  for (const [name, t] of Object.entries(p.data)) {
    const url = typeof t === 'string' ? t : t.url;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ServiceConfigError(`CORE_WORKER_HEALTH_TARGETS.${name} is not a URL`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new ServiceConfigError(`CORE_WORKER_HEALTH_TARGETS.${name} must be http(s)`);
    }
    out[name] = typeof t === 'string' || t.path === undefined ? { url } : { url, path: t.path };
  }
  return out;
}

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
 * Reads the environment (all of it, before anything is started):
 *   CORE_WORKER_DATABASE_URL        the record database; the record schema must already be migrated
 *                                   (`aisdlc-migrate`)
 *   CORE_WORKER_CODEHOST_URL, CORE_WORKER_CODEHOST_TOKEN_REF   the codehost and this worker's
 *                                   service token there (scopes census and posture)
 *   CORE_WORKER_REGISTERED_REPOS_FILE   JSON [{project_id, repo}] for a development setup; without
 *                                   it the polls read the repos that have an S0 record from core's own
 *                                   read model (the core schema must be migrated)
 *   CORE_WORKER_KNOWLEDGE_URL, CORE_WORKER_KNOWLEDGE_TOKEN_REF   knowledge's API (scope `census`);
 *                                   with them the S0 step driver runs (it also needs the codehost
 *                                   scopes census and posture and the core schema)
 *   CORE_WORKER_IDENTITY_URL, CORE_WORKER_IDENTITY_TOKEN_REF   identity's API (scope `reconcile`);
 *                                   with them a published project role map is reconciled
 *   CORE_WORKER_NOTARY_URL, CORE_WORKER_NOTARY_TOKEN_REF, KMS_URL, KMS_TOKEN_REF   the Notary (scope
 *                                   `ledger`) and the key lookup: with them AND knowledge (scopes `census`
 *                                   and `security`) the `onboarding_cards` loop runs (it also needs the
 *                                   codehost scopes census and posture). Notary without knowledge is an error
 *   CORE_WORKER_WITNESS_URL, CORE_WORKER_WITNESS_TOKEN_REF   the Witness's API: with it AND the Notary the
 *                                   `ledger_reconciler` and `checkpointer` loops run (the checkpoint is
 *                                   co-signed by the Witness). The Witness without the Notary is an error
 *   CORE_WORKER_KILLSWITCH_URL, CORE_WORKER_KILLSWITCH_TOKEN_REF   the kill switch (scopes `read`, `sync`): the
 *                                   work driver asks it before admitting agent work (an unreachable one
 *                                   means no new agent work), the holders of every project are pushed to
 *                                   it, and its journal is recorded (with the Notary, also in the ledger).
 *                                   Required with CORE_WORKER_STAGE_PORTS
 *   CORE_WORKER_GATEWAY_URL, CORE_WORKER_GATEWAY_TOKEN_REF   the model gateway's admin API (scope `admin`): the
 *                                   work driver mints a per-Unit virtual key for every agent-acted stage
 *                                   command from the agent's contract. Required with CORE_WORKER_STAGE_PORTS
 *   CORE_WORKER_SANDBOX_PROXY_URL, CORE_WORKER_SANDBOX_PROXY_TOKEN_REF   the coding worker's Docker socket proxy (PLAN M13.2) and this
 *                                   worker's bearer token there; with them (and CORE_WORKER_STAGE_PORTS=agents) S6 6.1 to 6.5 run
 *                                   real sessions: CORE_WORKER_SANDBOX_IMAGE (aisdlc/sandbox-agent:local), CORE_WORKER_SANDBOX_SCRATCH
 *                                   (a plain absolute directory, the same path for the daemon), CORE_WORKER_SANDBOX_MIRROR and
 *                                   CORE_WORKER_SANDBOX_GATEWAY (the peers' container names), CORE_WORKER_SESSION_STORE (the workspace
 *                                   store), CORE_WORKER_CODER_MODEL (claude-sonnet-5-5). The owner allow-list is config
 *                                   `sandbox.exec_allowed_repos` (M1-gated): a repo not on it is BLOCKED, never run (DEC-18)
 *   CORE_WORKER_SANDBOX_CONTROLLER_URL, CORE_WORKER_SANDBOX_CONTROLLER_TOKEN_REF   (M14.2) the sandbox-controller: S6's
 *                                   sessions go to it (it holds the proxy token, the ceilings and the caps) instead of a
 *                                   driver in this process, and H2 reads its free slots. Not with CORE_WORKER_SANDBOX_PROXY_URL.
 *                                   CORE_WORKER_SESSION_STORE and CORE_WORKER_CODER_MODEL as above
 *   CORE_WORKER_PUSH_BROKER         `1`: 6.6 asks the codehost's Push Broker (route `push`, scope `push`) to write the Unit's patch
 *                                   as a commit on agent/<item>/<unit> and a Draft PR; needs the sandbox. Default off
 *   CORE_WORKER_AGENT_EXTRA_MODELS  comma-separated model ids added to every key's allow-list (the local
 *                                   deployment routes everything to `fake-model`); default none
 *   CORE_WORKER_RELEASE             `gate-relay` (M15.3): S8b reads gate-relay's record of the approved G5's deployment
 *                                   (healthy: released; refused or rolled back: RELHOLD, B16's NEW item); default the fake
 *   CORE_WORKER_VERIFY_URL, CORE_WORKER_VERIFY_TOKEN_REF   (M14.3) the verify service (scopes `run`, `read`): S7's
 *                                   7.1 to 7.5 run there and 7.6 signs and stores the Evidence Pack (M14.4). Needs
 *                                   CORE_WORKER_STAGE_PORTS=agents, the Notary (scope `evidence`) and the object store;
 *                                   without it S7 stays over the stage-port fakes
 *   CORE_WORKER_FAKE_VERIFY (default | exceptions; default default) (M14.6) `exceptions` scripts S7's fakes to raise
 *                                   Q1, X2, E2 (first item in S7) and E6 (second) for the compose e2e; FACTORY_ENV=local
 *                                   only, with the stage ports and without CORE_WORKER_VERIFY_URL
 *   CORE_WORKER_OBJECT_STORE_URL, CORE_WORKER_OBJECT_STORE_ACCESS_KEY_REF, CORE_WORKER_OBJECT_STORE_SECRET_KEY_REF
 *                                   (M14.4) the S3-compatible object store of the Evidence Packs (write-once bucket)
 *   CORE_WORKER_STAGE_PORTS (none | fake | agents; default none): `fake` runs the `work_driver` loop over the
 *                                   deterministic stage-port fakes (needs the Notary); `agents` (M12) runs S2 and S3 with real agents
 *                                   (the planning port calls the gateway's `/v1/messages` under each run's own key; it also needs
 *                                   CORE_WORKER_KNOWLEDGE_URL, whose token should carry scope `search`, and the prompts beside the
 *                                   bundle) and every other step over the fakes; CORE_WORKER_WORK_DRIVER_INTERVAL_MS (5000)
 *   CORE_WORKER_CHECKPOINT_INTERVAL_MS (300000, 5 min), CORE_WORKER_RECONCILE_INTERVAL_MS (60000)
 *   CORE_WORKER_CARDS_INTERVAL_MS (10000)
 *   CORE_WORKER_S0_DRIVER_INTERVAL_MS (15000), CORE_WORKER_ROLE_MAP_SYNC_INTERVAL_MS (10000)
 *   CORE_WORKER_HEAD_INTERVAL_MS (600000), CORE_WORKER_INSTALLATION_INTERVAL_MS (600000),
 *   CORE_WORKER_RULES_IN_FLIGHT_INTERVAL_MS (3600000), CORE_WORKER_RULES_IDLE_INTERVAL_MS (86400000),
 *   CORE_WORKER_RULES_TICK_MS (300000), CORE_WORKER_OUTBOX_WATCH_INTERVAL_MS (30000)
 *   CORE_WORKER_TRACKER_LOGIN       (M16) the login the codehost's tracker App writes as: the `issue_twin` loop runs
 *                                   through the codehost's tracker routes (scope `tracker`, the codehost token; core-worker
 *                                   holds no GitHub credential and has no route out) every CORE_WORKER_ISSUE_TWIN_INTERVAL_MS (600000)
 *   CORE_WORKER_HEALTH_TARGETS      (M19) JSON {name: url | {url, path}}: the services whose liveness answer
 *                                   (default path /healthz) the `health_snapshot` loop reads every
 *                                   CORE_WORKER_HEALTH_INTERVAL_MS (30000), with this process's own loops, into
 *                                   `core.health_snapshot` (the Operate › Health tiles). A service not named reads unknown
 *   CORE_WORKER_HOST / _PORT        the health and metrics endpoint, default 127.0.0.1:8360
 */
export function coreWorkerConfigFromEnv(env: Env): CoreWorkerConfig {
  const file = env['CORE_WORKER_REGISTERED_REPOS_FILE'];
  const remote = (name: string) => {
    const url = env[`CORE_WORKER_${name}_URL`];
    if (url === undefined || url === '') return null;
    return {
      url: httpUrlEnv(env, `CORE_WORKER_${name}_URL`),
      token: resolveSecretRef(requiredEnv(env, `CORE_WORKER_${name}_TOKEN_REF`), { env }),
    };
  };
  const knowledge = remote('KNOWLEDGE');
  const notaryUrl = env['CORE_WORKER_NOTARY_URL'];
  const ledger =
    notaryUrl === undefined || notaryUrl === ''
      ? null
      : {
          notaryUrl: httpUrlEnv(env, 'CORE_WORKER_NOTARY_URL'),
          notaryToken: resolveSecretRef(requiredEnv(env, 'CORE_WORKER_NOTARY_TOKEN_REF'), { env }),
        };
  if (ledger !== null && knowledge === null) {
    throw new ServiceConfigError(
      'CORE_WORKER_NOTARY_URL is for the onboarding cards, which also need CORE_WORKER_KNOWLEDGE_URL',
    );
  }
  const witness = remote('WITNESS');
  if (witness !== null && ledger === null) {
    throw new ServiceConfigError(
      'CORE_WORKER_WITNESS_URL checkpoints the Notary ledger, which also needs CORE_WORKER_NOTARY_URL',
    );
  }
  const sp = env['CORE_WORKER_STAGE_PORTS'] ?? 'none';
  if (sp !== 'none' && sp !== 'fake' && sp !== 'agents') {
    throw new ServiceConfigError('CORE_WORKER_STAGE_PORTS must be `none`, `fake` or `agents`');
  }
  const stagePorts: 'none' | 'fake' | 'agents' = sp;
  const killswitch = remote('KILLSWITCH');
  if (stagePorts !== 'none' && killswitch === null) {
    throw new ServiceConfigError(
      'CORE_WORKER_STAGE_PORTS needs the kill switch (CORE_WORKER_KILLSWITCH_URL): agent work is not admitted without one to ask',
    );
  }
  const gateway = remote('GATEWAY');
  if (stagePorts !== 'none' && gateway === null) {
    throw new ServiceConfigError(
      'CORE_WORKER_STAGE_PORTS needs the model gateway (CORE_WORKER_GATEWAY_URL): an agent step is not run without a key minted for it',
    );
  }
  if (stagePorts !== 'none' && ledger === null) {
    throw new ServiceConfigError(
      'CORE_WORKER_STAGE_PORTS needs the Notary (CORE_WORKER_NOTARY_URL): gates open through the decision kernel',
    );
  }
  if (stagePorts === 'agents' && knowledge === null) {
    throw new ServiceConfigError(
      'CORE_WORKER_STAGE_PORTS=agents needs knowledge (CORE_WORKER_KNOWLEDGE_URL): S2 is grounded on its census',
    );
  }
  const proxyUrl = env['CORE_WORKER_SANDBOX_PROXY_URL'];
  const dir = (name: string, d?: string): string => {
    const v = env[name] ?? d;
    if (v === undefined || !/^\/[A-Za-z0-9_./-]+$/.test(v) || v.includes('..') || v === '/') {
      throw new ServiceConfigError(`${name} must be a plain absolute directory`);
    }
    return v;
  };
  const sandbox =
    proxyUrl === undefined || proxyUrl === ''
      ? null
      : {
          proxyUrl: httpUrlEnv(env, 'CORE_WORKER_SANDBOX_PROXY_URL'),
          proxyToken: resolveSecretRef(requiredEnv(env, 'CORE_WORKER_SANDBOX_PROXY_TOKEN_REF'), {
            env,
          }),
          image: env['CORE_WORKER_SANDBOX_IMAGE'] || 'aisdlc/sandbox-agent:local',
          scratch: dir('CORE_WORKER_SANDBOX_SCRATCH'),
          mirror: requiredEnv(env, 'CORE_WORKER_SANDBOX_MIRROR'),
          gateway: requiredEnv(env, 'CORE_WORKER_SANDBOX_GATEWAY'),
          storeDir: dir('CORE_WORKER_SESSION_STORE', '/var/lib/aisdlc/sessions'),
          model: env['CORE_WORKER_CODER_MODEL'] || 'claude-sonnet-5-5',
        };
  if (sandbox !== null && stagePorts !== 'agents') {
    throw new ServiceConfigError(
      'CORE_WORKER_SANDBOX_PROXY_URL runs real coding sessions, which need CORE_WORKER_STAGE_PORTS=agents',
    );
  }
  const controllerUrl = env['CORE_WORKER_SANDBOX_CONTROLLER_URL'];
  const sandboxController =
    controllerUrl === undefined || controllerUrl === ''
      ? null
      : {
          url: httpUrlEnv(env, 'CORE_WORKER_SANDBOX_CONTROLLER_URL'),
          token: resolveSecretRef(requiredEnv(env, 'CORE_WORKER_SANDBOX_CONTROLLER_TOKEN_REF'), {
            env,
          }),
          storeDir: dir('CORE_WORKER_SESSION_STORE', '/var/lib/aisdlc/sessions'),
          model: env['CORE_WORKER_CODER_MODEL'] || 'claude-sonnet-5-5',
        };
  if (sandboxController !== null && sandbox !== null) {
    throw new ServiceConfigError(
      'CORE_WORKER_SANDBOX_CONTROLLER_URL and CORE_WORKER_SANDBOX_PROXY_URL are exclusive: sessions go through the controller or an in-process driver',
    );
  }
  if (sandboxController !== null && stagePorts !== 'agents') {
    throw new ServiceConfigError(
      'CORE_WORKER_SANDBOX_CONTROLLER_URL runs real coding sessions, which need CORE_WORKER_STAGE_PORTS=agents',
    );
  }
  const pushBroker = env['CORE_WORKER_PUSH_BROKER'] === '1';
  if (pushBroker && sandbox === null && sandboxController === null) {
    throw new ServiceConfigError(
      'CORE_WORKER_PUSH_BROKER=1 needs the sandbox (6.6 pushes what 6.1 to 6.5 built)',
    );
  }
  const verifyUrl = env['CORE_WORKER_VERIFY_URL'];
  const verify =
    verifyUrl === undefined || verifyUrl === ''
      ? null
      : {
          url: httpUrlEnv(env, 'CORE_WORKER_VERIFY_URL'),
          token: resolveSecretRef(requiredEnv(env, 'CORE_WORKER_VERIFY_TOKEN_REF'), { env }),
        };
  if (verify !== null && stagePorts !== 'agents') {
    throw new ServiceConfigError(
      'CORE_WORKER_VERIFY_URL runs S7 with the verify service, which needs CORE_WORKER_STAGE_PORTS=agents',
    );
  }
  const releaseMode = env['CORE_WORKER_RELEASE'] ?? '';
  if (releaseMode !== '' && releaseMode !== 'gate-relay') {
    throw new ServiceConfigError('CORE_WORKER_RELEASE is `gate-relay` or unset');
  }
  const releaseViaGateRelay = releaseMode === 'gate-relay';
  if (releaseViaGateRelay && stagePorts === 'none') {
    throw new ServiceConfigError('CORE_WORKER_RELEASE=gate-relay needs CORE_WORKER_STAGE_PORTS');
  }
  const objUrl = env['CORE_WORKER_OBJECT_STORE_URL'];
  const objectStore =
    objUrl === undefined || objUrl === ''
      ? null
      : {
          endpoint: httpUrlEnv(env, 'CORE_WORKER_OBJECT_STORE_URL'),
          accessKeyRef: requiredEnv(env, 'CORE_WORKER_OBJECT_STORE_ACCESS_KEY_REF'),
          secretKeyRef: requiredEnv(env, 'CORE_WORKER_OBJECT_STORE_SECRET_KEY_REF'),
        };
  if (verify !== null && (objectStore === null || ledger === null)) {
    throw new ServiceConfigError(
      'CORE_WORKER_VERIFY_URL signs and stores the 7.6 Evidence Pack: it needs CORE_WORKER_NOTARY_URL and CORE_WORKER_OBJECT_STORE_URL',
    );
  }
  const fv = env['CORE_WORKER_FAKE_VERIFY'] ?? 'default';
  if (fv !== 'default' && fv !== 'exceptions') {
    throw new ServiceConfigError('CORE_WORKER_FAKE_VERIFY must be `default` or `exceptions`');
  }
  if (fv === 'exceptions') {
    if (env['FACTORY_ENV'] !== 'local') {
      throw new ServiceConfigError(
        'CORE_WORKER_FAKE_VERIFY=exceptions runs only with FACTORY_ENV=local',
      );
    }
    if (stagePorts === 'none' || verify !== null) {
      throw new ServiceConfigError(
        'CORE_WORKER_FAKE_VERIFY=exceptions scripts the S7 fakes: it needs CORE_WORKER_STAGE_PORTS and no CORE_WORKER_VERIFY_URL',
      );
    }
  }
  const fakeVerify: 'default' | 'exceptions' = fv;
  // M16 (user decision 2026-11-12): core-worker keeps NO route out; the tracker App is the codehost's to hold. The
  // login is the one the codehost's tracker App writes as (`<slug>[bot]`): set, the loop runs through the codehost.
  const trackerLogin = env['CORE_WORKER_TRACKER_LOGIN'];
  let tracker: CoreWorkerConfig['tracker'] = null;
  if (trackerLogin !== undefined && trackerLogin !== '') {
    if (!/^[A-Za-z0-9-]+(\[bot\])?$/.test(trackerLogin)) {
      throw new ServiceConfigError('CORE_WORKER_TRACKER_LOGIN is a GitHub login (`<slug>[bot]`)');
    }
    if (knowledge === null) {
      throw new ServiceConfigError(
        'CORE_WORKER_TRACKER_LOGIN runs the issue twin, whose re-check needs CORE_WORKER_KNOWLEDGE_URL',
      );
    }
    tracker = { login: trackerLogin };
  }
  return {
    databaseUrl: databaseUrl(env, 'CORE_WORKER_DATABASE_URL'),
    codehostUrl: httpUrlEnv(env, 'CORE_WORKER_CODEHOST_URL'),
    codehostToken: resolveSecretRef(requiredEnv(env, 'CORE_WORKER_CODEHOST_TOKEN_REF'), { env }),
    registeredReposFile: file === undefined || file === '' ? null : file,
    knowledge,
    ledger,
    witness,
    killswitch,
    stagePorts,
    gateway,
    sandbox,
    sandboxController,
    pushBroker,
    verify,
    releaseViaGateRelay,
    fakeVerify,
    objectStore,
    tracker,
    issueTwinIntervalMs: intEnv(env, 'CORE_WORKER_ISSUE_TWIN_INTERVAL_MS', 600_000, 100),
    agentExtraModels: (env['CORE_WORKER_AGENT_EXTRA_MODELS'] ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m !== ''),
    workDriverIntervalMs: intEnv(env, 'CORE_WORKER_WORK_DRIVER_INTERVAL_MS', 5_000, 100),
    auditSampleOneIn: intEnv(env, 'CORE_WORKER_AUDIT_SAMPLE_ONE_IN', 1, 1),
    killHoldersIntervalMs: intEnv(env, 'CORE_WORKER_KILL_HOLDERS_INTERVAL_MS', 10_000, 100),
    killObserverIntervalMs: intEnv(env, 'CORE_WORKER_KILL_OBSERVER_INTERVAL_MS', 5_000, 100),
    gatewayTriggersIntervalMs: intEnv(env, 'CORE_WORKER_GATEWAY_TRIGGERS_INTERVAL_MS', 2_000, 100),
    reconcileIntervalMs: intEnv(env, 'CORE_WORKER_RECONCILE_INTERVAL_MS', 60_000, 100),
    checkpointIntervalMs: intEnv(env, 'CORE_WORKER_CHECKPOINT_INTERVAL_MS', 300_000, 100),
    cardsIntervalMs: intEnv(env, 'CORE_WORKER_CARDS_INTERVAL_MS', 10_000, 100),
    identity: remote('IDENTITY'),
    s0DriverIntervalMs: intEnv(env, 'CORE_WORKER_S0_DRIVER_INTERVAL_MS', 15_000, 100),
    roleMapSyncIntervalMs: intEnv(env, 'CORE_WORKER_ROLE_MAP_SYNC_INTERVAL_MS', 10_000, 100),
    headIntervalMs: intEnv(env, 'CORE_WORKER_HEAD_INTERVAL_MS', 600_000, 100),
    installationIntervalMs: intEnv(env, 'CORE_WORKER_INSTALLATION_INTERVAL_MS', 600_000, 100),
    rulesInFlightIntervalMs: intEnv(env, 'CORE_WORKER_RULES_IN_FLIGHT_INTERVAL_MS', 3_600_000, 100),
    rulesIdleIntervalMs: intEnv(env, 'CORE_WORKER_RULES_IDLE_INTERVAL_MS', 86_400_000, 100),
    rulesTickMs: intEnv(env, 'CORE_WORKER_RULES_TICK_MS', 300_000, 100),
    outboxWatchIntervalMs: intEnv(env, 'CORE_WORKER_OUTBOX_WATCH_INTERVAL_MS', 30_000, 100),
    healthTargets: healthTargetsEnv(env),
    healthIntervalMs: intEnv(env, 'CORE_WORKER_HEALTH_INTERVAL_MS', 30_000, 100),
  };
}
