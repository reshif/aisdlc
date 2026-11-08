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
  readonly registeredReposFile: string;
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
 *   CORE_WORKER_REGISTERED_REPOS_FILE   JSON [{project_id, repo}] standing in for Projects until M7
 *   CORE_WORKER_HEAD_INTERVAL_MS (600000), CORE_WORKER_INSTALLATION_INTERVAL_MS (600000),
 *   CORE_WORKER_RULES_IN_FLIGHT_INTERVAL_MS (3600000), CORE_WORKER_RULES_IDLE_INTERVAL_MS (86400000),
 *   CORE_WORKER_RULES_TICK_MS (300000), CORE_WORKER_OUTBOX_WATCH_INTERVAL_MS (30000)
 *   CORE_WORKER_HOST / _PORT        the health and metrics endpoint, default 127.0.0.1:8360
 */
export function coreWorkerConfigFromEnv(env: Env): CoreWorkerConfig {
  const file = requiredEnv(env, 'CORE_WORKER_REGISTERED_REPOS_FILE');
  return {
    databaseUrl: databaseUrl(env, 'CORE_WORKER_DATABASE_URL'),
    codehostUrl: httpUrlEnv(env, 'CORE_WORKER_CODEHOST_URL'),
    codehostToken: resolveSecretRef(requiredEnv(env, 'CORE_WORKER_CODEHOST_TOKEN_REF'), { env }),
    registeredReposFile: file,
    headIntervalMs: intEnv(env, 'CORE_WORKER_HEAD_INTERVAL_MS', 600_000, 100),
    installationIntervalMs: intEnv(env, 'CORE_WORKER_INSTALLATION_INTERVAL_MS', 600_000, 100),
    rulesInFlightIntervalMs: intEnv(env, 'CORE_WORKER_RULES_IN_FLIGHT_INTERVAL_MS', 3_600_000, 100),
    rulesIdleIntervalMs: intEnv(env, 'CORE_WORKER_RULES_IDLE_INTERVAL_MS', 86_400_000, 100),
    rulesTickMs: intEnv(env, 'CORE_WORKER_RULES_TICK_MS', 300_000, 100),
    outboxWatchIntervalMs: intEnv(env, 'CORE_WORKER_OUTBOX_WATCH_INTERVAL_MS', 30_000, 100),
  };
}
