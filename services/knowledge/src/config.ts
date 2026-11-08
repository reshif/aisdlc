import { BUNDLE_DEFAULT_CAP_BYTES, KNOWLEDGE_DEFAULTS } from '@aisdlc/contracts';
import {
  ServiceConfigError,
  databaseUrl,
  httpUrlEnv,
  jsonEnv,
  loadServiceAuth,
  requiredEnv,
  resolveSecretRef,
  type Env,
  type ServiceAuth,
} from '@aisdlc/service-kit';
import { z } from 'zod';
import type { KnowledgeScope } from './app.js';

const Callers = z.record(
  z.string().min(1),
  z.strictObject({
    token_ref: z.string().min(1),
    scopes: z.array(z.enum(['census', 'security'])).min(1),
  }),
);

export interface KnowledgeConfig {
  readonly databaseUrl: string;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly KnowledgeScope[]>;
  readonly codehostUrl: string;
  readonly codehostToken: string;
  readonly identityUrl: string;
  readonly identityToken: string;
  readonly workDir: string | undefined;
  readonly gitBin: string | undefined;
  readonly bundleCapBytes: number;
  readonly maxFileBytes: number;
  readonly commitCap: number;
  readonly jobTimeoutMs: number;
  readonly maxConcurrentJobs: number;
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
 * DEC-5 condition 1: this container holds no code-host credential and no HMAC key. A variable that
 * looks like one is a configuration error (fail at start), not something to ignore. The tokens it
 * does hold are service tokens (codehost, kms-local, identity), given as `env:`/`file:` references.
 */
const FORBIDDEN_ENV =
  /^(?:GITHUB_|GH_|CODEHOST_GITHUB_|GIT_ASKPASS|GIT_CONFIG_)|(?:HMAC|FINGERPRINT)[A-Z_]*KEY|PRIVATE_KEY/i;
export function assertNoForbiddenEnv(env: Env): void {
  const bad = Object.keys(env).filter(
    (k) => FORBIDDEN_ENV.test(k) && env[k] !== undefined && env[k] !== '',
  );
  if (bad.length > 0) {
    throw new ServiceConfigError(
      `knowledge holds no code-host credential and no HMAC key: remove ${bad.sort().join(', ')} from its environment`,
    );
  }
}

/**
 * Reads the environment (all of it before anything starts):
 *   KNOWLEDGE_DATABASE_URL, KNOWLEDGE_CALLERS ({caller: {token_ref, scopes: [census|security]}})
 *   KNOWLEDGE_CODEHOST_URL, KNOWLEDGE_CODEHOST_TOKEN_REF   the codehost and our token there (census)
 *   KMS_URL, KMS_TOKEN_REF                                  kms-local, caller `knowledge`
 *   KNOWLEDGE_IDENTITY_URL, KNOWLEDGE_IDENTITY_TOKEN_REF   identity (scope read), for the human check
 *   KNOWLEDGE_WORK_DIR            job workspaces (default <tmp>/aisdlc-knowledge)
 *   KNOWLEDGE_BUNDLE_CAP_BYTES    default 268435456 (256 MiB)
 *   KNOWLEDGE_MAX_FILE_BYTES      default 5242880: a bigger blob is a coverage item
 *   KNOWLEDGE_COMMIT_CAP          default 50000: more commits is `truncated`, recorded
 *   KNOWLEDGE_JOB_TIMEOUT_MS      default 600000, for intake and scan together
 *   KNOWLEDGE_MAX_CONCURRENT_JOBS default 2
 *   KNOWLEDGE_GIT_BIN             default `git`
 *   KNOWLEDGE_HOST (127.0.0.1), KNOWLEDGE_PORT (8370)
 */
export function knowledgeConfigFromEnv(env: Env): KnowledgeConfig {
  assertNoForbiddenEnv(env);
  const callers = jsonEnv(env, 'KNOWLEDGE_CALLERS', Callers);
  return {
    databaseUrl: databaseUrl(env, 'KNOWLEDGE_DATABASE_URL'),
    auth: loadServiceAuth(callers, { env }),
    callers: Object.fromEntries(
      Object.entries(callers).map(([n, c]) => [n, c.scopes as KnowledgeScope[]]),
    ),
    codehostUrl: httpUrlEnv(env, 'KNOWLEDGE_CODEHOST_URL'),
    codehostToken: resolveSecretRef(requiredEnv(env, 'KNOWLEDGE_CODEHOST_TOKEN_REF'), { env }),
    identityUrl: httpUrlEnv(env, 'KNOWLEDGE_IDENTITY_URL'),
    identityToken: resolveSecretRef(requiredEnv(env, 'KNOWLEDGE_IDENTITY_TOKEN_REF'), { env }),
    workDir: env['KNOWLEDGE_WORK_DIR'] || undefined,
    gitBin: env['KNOWLEDGE_GIT_BIN'] || undefined,
    bundleCapBytes: intEnv(env, 'KNOWLEDGE_BUNDLE_CAP_BYTES', BUNDLE_DEFAULT_CAP_BYTES, 1),
    maxFileBytes: intEnv(env, 'KNOWLEDGE_MAX_FILE_BYTES', KNOWLEDGE_DEFAULTS.max_file_bytes, 1),
    commitCap: intEnv(env, 'KNOWLEDGE_COMMIT_CAP', KNOWLEDGE_DEFAULTS.commit_cap, 1),
    jobTimeoutMs: intEnv(env, 'KNOWLEDGE_JOB_TIMEOUT_MS', KNOWLEDGE_DEFAULTS.job_timeout_ms, 1000),
    maxConcurrentJobs: intEnv(env, 'KNOWLEDGE_MAX_CONCURRENT_JOBS', 2, 1),
  };
}
