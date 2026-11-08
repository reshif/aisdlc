import { readFileSync } from 'node:fs';
import {
  ServiceConfigError,
  httpUrlEnv,
  jsonEnv,
  loadServiceAuth,
  requiredEnv,
  resolveSecretRef,
  type Env,
  type ServiceAuth,
} from '@aisdlc/service-kit';
import { BUNDLE_DEFAULT_CAP_BYTES, BUNDLE_DEFAULT_TIMEOUT_MS } from '@aisdlc/contracts';
import { z } from 'zod';
import type { CodeHostMode } from './allow-list.js';
import type { CodeHostScope } from './app.js';
import { AppKey } from './app-key.js';

const Callers = z.record(
  z.string().min(1),
  z.strictObject({
    token_ref: z.string().min(1),
    scopes: z.array(z.enum(['census', 'posture', 'codeowners_sync'])).min(1),
  }),
);

export interface CodeHostConfig {
  readonly appKey: AppKey;
  readonly appId: string;
  readonly installationId: number;
  readonly apiUrl: string;
  readonly mode: CodeHostMode;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly CodeHostScope[]>;
  readonly identityUrl: string;
  readonly identityToken: string;
  readonly registeredReposFile: string | null;
  /** Where git clones from (`https://github.com`); the token goes there in a header. */
  readonly gitUrl: string;
  readonly bundleCapBytes: number;
  readonly bundleTimeoutMs: number;
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

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Reads the environment (all configuration is read before anything is started):
 *   CODEHOST_GITHUB_APP_ID, CODEHOST_GITHUB_INSTALLATION_ID
 *   CODEHOST_GITHUB_APP_KEY_REF   `file:/path/to/app-key.pem` (an env: reference is refused)
 *   CODEHOST_GITHUB_API_URL       default https://api.github.com; plain http only to loopback (tests)
 *   CODEHOST_MODE                 `census` (default and the only mode)
 *   CODEHOST_CALLERS              JSON {caller: {token_ref, scopes: [census|posture|codeowners_sync]}}
 *   CODEHOST_IDENTITY_URL, CODEHOST_IDENTITY_TOKEN_REF   identity API and the codehost's token there
 *   CODEHOST_GIT_URL              default https://github.com; plain http only to loopback (tests)
 *   CODEHOST_BUNDLE_CAP_BYTES     default 268435456 (256 MiB); CODEHOST_BUNDLE_TIMEOUT_MS  default 180000
 *   CODEHOST_REGISTERED_REPOS_FILE  JSON [{project_id, repo}] standing in for Projects until M7;
 *                                 without it no repo is registered, so none is allowed
 */
export function codeHostConfigFromEnv(env: Env): CodeHostConfig {
  const appId = requiredEnv(env, 'CODEHOST_GITHUB_APP_ID');
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(appId)) {
    throw new ServiceConfigError('CODEHOST_GITHUB_APP_ID is not an app or client id');
  }
  const installationId = Number(requiredEnv(env, 'CODEHOST_GITHUB_INSTALLATION_ID'));
  if (!Number.isInteger(installationId) || installationId < 1) {
    throw new ServiceConfigError('CODEHOST_GITHUB_INSTALLATION_ID must be a positive integer');
  }
  const apiUrl = env['CODEHOST_GITHUB_API_URL']
    ? httpUrlEnv(env, 'CODEHOST_GITHUB_API_URL')
    : 'https://api.github.com';
  const u = new URL(apiUrl);
  if (u.protocol !== 'https:' && !LOOPBACK.has(u.hostname)) {
    throw new ServiceConfigError(
      'CODEHOST_GITHUB_API_URL must be https (plain http only to loopback): it carries credentials',
    );
  }
  const gitUrl = (
    env['CODEHOST_GIT_URL'] ? httpUrlEnv(env, 'CODEHOST_GIT_URL') : 'https://github.com'
  ).replace(/\/+$/, '');
  const gu = new URL(gitUrl);
  if (gu.protocol !== 'https:' && !LOOPBACK.has(gu.hostname)) {
    throw new ServiceConfigError(
      'CODEHOST_GIT_URL must be https (plain http only to loopback): it carries credentials',
    );
  }
  const mode = env['CODEHOST_MODE'] ?? 'census';
  if (mode !== 'census') throw new ServiceConfigError('CODEHOST_MODE must be census');
  const callers = jsonEnv(env, 'CODEHOST_CALLERS', Callers);
  const file = env['CODEHOST_REGISTERED_REPOS_FILE'];
  if (file !== undefined && file !== '') {
    try {
      readFileSync(file, 'utf8');
    } catch (cause) {
      throw new ServiceConfigError(`CODEHOST_REGISTERED_REPOS_FILE ${file} is not readable`, {
        cause,
      });
    }
  }
  return {
    appKey: AppKey.fromRef(requiredEnv(env, 'CODEHOST_GITHUB_APP_KEY_REF'), { env }),
    appId,
    installationId,
    apiUrl,
    mode,
    auth: loadServiceAuth(callers, { env }),
    callers: Object.fromEntries(
      Object.entries(callers).map(([n, c]) => [n, c.scopes as CodeHostScope[]]),
    ),
    identityUrl: httpUrlEnv(env, 'CODEHOST_IDENTITY_URL'),
    identityToken: resolveSecretRef(requiredEnv(env, 'CODEHOST_IDENTITY_TOKEN_REF'), { env }),
    registeredReposFile: file === undefined || file === '' ? null : file,
    gitUrl,
    bundleCapBytes: intEnv(env, 'CODEHOST_BUNDLE_CAP_BYTES', BUNDLE_DEFAULT_CAP_BYTES, 1),
    bundleTimeoutMs: intEnv(env, 'CODEHOST_BUNDLE_TIMEOUT_MS', BUNDLE_DEFAULT_TIMEOUT_MS, 1000),
  };
}
