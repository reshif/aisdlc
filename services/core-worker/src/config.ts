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
   * The stage ports behind the work driver (PLAN M9.2). `none`: the `work_driver` loop does not run.
   * `fake`: the deterministic fakes (no real stage work exists before M11-M14). Needs the Notary.
   */
  readonly stagePorts: 'none' | 'fake';
  readonly workDriverIntervalMs: number;
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
 *   CORE_WORKER_STAGE_PORTS (none | fake; default none): `fake` runs the `work_driver` loop over the
 *                                   deterministic stage-port fakes (needs the Notary); CORE_WORKER_WORK_DRIVER_INTERVAL_MS (5000)
 *   CORE_WORKER_CHECKPOINT_INTERVAL_MS (300000, 5 min), CORE_WORKER_RECONCILE_INTERVAL_MS (60000)
 *   CORE_WORKER_CARDS_INTERVAL_MS (10000)
 *   CORE_WORKER_S0_DRIVER_INTERVAL_MS (15000), CORE_WORKER_ROLE_MAP_SYNC_INTERVAL_MS (10000)
 *   CORE_WORKER_HEAD_INTERVAL_MS (600000), CORE_WORKER_INSTALLATION_INTERVAL_MS (600000),
 *   CORE_WORKER_RULES_IN_FLIGHT_INTERVAL_MS (3600000), CORE_WORKER_RULES_IDLE_INTERVAL_MS (86400000),
 *   CORE_WORKER_RULES_TICK_MS (300000), CORE_WORKER_OUTBOX_WATCH_INTERVAL_MS (30000)
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
  if (sp !== 'none' && sp !== 'fake') {
    throw new ServiceConfigError('CORE_WORKER_STAGE_PORTS must be `none` or `fake`');
  }
  const stagePorts: 'none' | 'fake' = sp;
  if (stagePorts !== 'none' && ledger === null) {
    throw new ServiceConfigError(
      'CORE_WORKER_STAGE_PORTS needs the Notary (CORE_WORKER_NOTARY_URL): gates open through the decision kernel',
    );
  }
  return {
    databaseUrl: databaseUrl(env, 'CORE_WORKER_DATABASE_URL'),
    codehostUrl: httpUrlEnv(env, 'CORE_WORKER_CODEHOST_URL'),
    codehostToken: resolveSecretRef(requiredEnv(env, 'CORE_WORKER_CODEHOST_TOKEN_REF'), { env }),
    registeredReposFile: file === undefined || file === '' ? null : file,
    knowledge,
    ledger,
    witness,
    stagePorts,
    workDriverIntervalMs: intEnv(env, 'CORE_WORKER_WORK_DRIVER_INTERVAL_MS', 5_000, 100),
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
  };
}
