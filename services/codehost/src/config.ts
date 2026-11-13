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
    scopes: z
      .array(z.enum(['census', 'posture', 'codeowners_sync', 'reload', 'push', 'tracker']))
      .min(1),
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
  /** Core's API, the source of the registered repos (PLAN M7.1); `null`: the file, or nothing. */
  readonly core: { readonly url: string; readonly token: string } | null;
  /** Where git clones from (`https://github.com`); the token goes there in a header. */
  readonly gitUrl: string;
  readonly bundleCapBytes: number;
  readonly bundleTimeoutMs: number;
  /** The identity commits are made under in `push` mode (the App's bot, never a person). */
  readonly committer: { readonly name: string; readonly email: string };
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
 *   CODEHOST_MODE                 `census` (default: reads only), or `push` (M13.6: adds the Push Broker's writes with the
 *                                 `docs` role; needs CODEHOST_CORE_URL, which answers for leases and X2 decisions)
 *   CODEHOST_COMMITTER_NAME, CODEHOST_COMMITTER_EMAIL   the commit identity in push mode (default aisdlc[bot])
 *   CODEHOST_CALLERS              JSON {caller: {token_ref, scopes: [census|posture|codeowners_sync]}}
 *   CODEHOST_IDENTITY_URL, CODEHOST_IDENTITY_TOKEN_REF   identity API and the codehost's token there
 *   CODEHOST_GIT_URL              default https://github.com; plain http only to loopback (tests)
 *   CODEHOST_GITHUB_PLAIN_HTTP_HOSTS  JSON ["host"]: hosts besides loopback the two URLs above may name over plain http (the
 *                                 compose stack's fake GitHub, reached from the Push Broker's own container on its own
 *                                 network); never needed for GitHub itself
 *   CODEHOST_BUNDLE_CAP_BYTES     default 268435456 (256 MiB); CODEHOST_BUNDLE_TIMEOUT_MS  default 180000
 *   CODEHOST_CORE_URL, CODEHOST_CORE_TOKEN_REF   core's API (scope `registry`): the repos that have an
 *                                 S0 record or request (PLAN M7.1)
 *   CODEHOST_REGISTERED_REPOS_FILE  JSON [{project_id, repo}] for a development setup without core
 *                                 (not together with CODEHOST_CORE_URL); with neither no repo is
 *                                 registered, so none is allowed
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
  const plainHosts = new Set(
    env['CODEHOST_GITHUB_PLAIN_HTTP_HOSTS']
      ? jsonEnv(
          env,
          'CODEHOST_GITHUB_PLAIN_HTTP_HOSTS',
          z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]*$/)).max(8),
        )
      : [],
  );
  const plainOk = (h: string): boolean => LOOPBACK.has(h) || plainHosts.has(h);
  const apiUrl = env['CODEHOST_GITHUB_API_URL']
    ? httpUrlEnv(env, 'CODEHOST_GITHUB_API_URL')
    : 'https://api.github.com';
  const u = new URL(apiUrl);
  if (u.protocol !== 'https:' && !plainOk(u.hostname)) {
    throw new ServiceConfigError(
      'CODEHOST_GITHUB_API_URL must be https (plain http only to loopback): it carries credentials',
    );
  }
  const gitUrl = (
    env['CODEHOST_GIT_URL'] ? httpUrlEnv(env, 'CODEHOST_GIT_URL') : 'https://github.com'
  ).replace(/\/+$/, '');
  const gu = new URL(gitUrl);
  if (gu.protocol !== 'https:' && !plainOk(gu.hostname)) {
    throw new ServiceConfigError(
      'CODEHOST_GIT_URL must be https (plain http only to loopback): it carries credentials',
    );
  }
  const mode = env['CODEHOST_MODE'] ?? 'census';
  if (mode !== 'census' && mode !== 'push') {
    throw new ServiceConfigError('CODEHOST_MODE must be census or push');
  }
  const callers = jsonEnv(env, 'CODEHOST_CALLERS', Callers);
  const file = env['CODEHOST_REGISTERED_REPOS_FILE'];
  const coreUrl = env['CODEHOST_CORE_URL'];
  if (mode === 'push' && (coreUrl === undefined || coreUrl === '')) {
    throw new ServiceConfigError(
      'CODEHOST_MODE=push needs CODEHOST_CORE_URL: the Unit owner answers for leases and X2 decisions',
    );
  }
  if (coreUrl !== undefined && coreUrl !== '' && file !== undefined && file !== '') {
    throw new ServiceConfigError(
      'CODEHOST_CORE_URL and CODEHOST_REGISTERED_REPOS_FILE are two sources for the same thing: set one',
    );
  }
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
    core:
      coreUrl === undefined || coreUrl === ''
        ? null
        : {
            url: httpUrlEnv(env, 'CODEHOST_CORE_URL'),
            token: resolveSecretRef(requiredEnv(env, 'CODEHOST_CORE_TOKEN_REF'), { env }),
          },
    gitUrl,
    bundleCapBytes: intEnv(env, 'CODEHOST_BUNDLE_CAP_BYTES', BUNDLE_DEFAULT_CAP_BYTES, 1),
    bundleTimeoutMs: intEnv(env, 'CODEHOST_BUNDLE_TIMEOUT_MS', BUNDLE_DEFAULT_TIMEOUT_MS, 1000),
    committer: {
      name: env['CODEHOST_COMMITTER_NAME'] || 'aisdlc[bot]',
      email: env['CODEHOST_COMMITTER_EMAIL'] || 'aisdlc@users.noreply.github.com',
    },
  };
}

/**
 * Registry mode (PLAN M10.4): the GitHub App is a row of the integration registry, not environment.
 *   CODEHOST_REGISTRY_INTEGRATION  the integration id of the row to serve (e.g. `github-app`); selects this mode
 *   CODEHOST_CORE_URL, CODEHOST_CORE_TOKEN_REF   REQUIRED: core's API, where the registry is read (scope `registry`),
 *                                 health is reported (scope `integrations`) and the registered repos come from
 *   CODEHOST_SECRET_REFS          JSON ["file:/run/secrets/github-app.pem"]: the key references this deployment lets a row name
 *   CODEHOST_EGRESS_HOSTS         JSON ["api.github.com", "github.com"]: the hosts the App's credentials may be sent to
 *   CODEHOST_REGISTRY_INTERVAL_MS poll of the registry (default 30000), CODEHOST_HEALTH_INTERVAL_MS report of health (30000)
 * plus CODEHOST_CALLERS, CODEHOST_IDENTITY_*, CODEHOST_BUNDLE_*; NOT the CODEHOST_GITHUB_* variables (they are the legacy mode).
 */
export interface CodeHostRegistryConfig {
  readonly integrationId: string;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly CodeHostScope[]>;
  readonly identityUrl: string;
  readonly identityToken: string;
  readonly core: { readonly url: string; readonly token: string };
  readonly secretRefs: readonly string[];
  readonly egressHosts: readonly string[];
  readonly registryIntervalMs: number;
  readonly healthIntervalMs: number;
  readonly bundleCapBytes: number;
  readonly bundleTimeoutMs: number;
}

export function codeHostRegistryConfigFromEnv(env: Env): CodeHostRegistryConfig {
  const id = requiredEnv(env, 'CODEHOST_REGISTRY_INTEGRATION');
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(id)) {
    throw new ServiceConfigError('CODEHOST_REGISTRY_INTEGRATION is not an integration id');
  }
  for (const legacy of [
    'CODEHOST_GITHUB_APP_ID',
    'CODEHOST_GITHUB_INSTALLATION_ID',
    'CODEHOST_GITHUB_APP_KEY_REF',
  ]) {
    if (env[legacy]) {
      throw new ServiceConfigError(
        `${legacy} and CODEHOST_REGISTRY_INTEGRATION are two sources for the same thing: the registry row replaces it`,
      );
    }
  }
  const callers = jsonEnv(env, 'CODEHOST_CALLERS', Callers);
  const refs = env['CODEHOST_SECRET_REFS']
    ? jsonEnv(env, 'CODEHOST_SECRET_REFS', z.array(z.string().min(1)).max(32))
    : [];
  const hosts = env['CODEHOST_EGRESS_HOSTS']
    ? jsonEnv(env, 'CODEHOST_EGRESS_HOSTS', z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(32))
    : [];
  return {
    integrationId: id,
    auth: loadServiceAuth(callers, { env }),
    callers: Object.fromEntries(
      Object.entries(callers).map(([n, c]) => [n, c.scopes as CodeHostScope[]]),
    ),
    identityUrl: httpUrlEnv(env, 'CODEHOST_IDENTITY_URL'),
    identityToken: resolveSecretRef(requiredEnv(env, 'CODEHOST_IDENTITY_TOKEN_REF'), { env }),
    core: {
      url: httpUrlEnv(env, 'CODEHOST_CORE_URL'),
      token: resolveSecretRef(requiredEnv(env, 'CODEHOST_CORE_TOKEN_REF'), { env }),
    },
    secretRefs: refs,
    egressHosts: hosts,
    registryIntervalMs: intEnv(env, 'CODEHOST_REGISTRY_INTERVAL_MS', 30_000, 100),
    healthIntervalMs: intEnv(env, 'CODEHOST_HEALTH_INTERVAL_MS', 30_000, 100),
    bundleCapBytes: intEnv(env, 'CODEHOST_BUNDLE_CAP_BYTES', BUNDLE_DEFAULT_CAP_BYTES, 1),
    bundleTimeoutMs: intEnv(env, 'CODEHOST_BUNDLE_TIMEOUT_MS', BUNDLE_DEFAULT_TIMEOUT_MS, 1000),
  };
}

/**
 * M16 (user decision 2026-11-12): the issue twin's tracker App, held by the codehost like every GitHub credential
 * (core-worker keeps no route out). Its OWN App, never the read App or the Push Broker's (`TRACKER_APP_PERMISSIONS`:
 * issues write, metadata read). Read in both modes:
 *   CODEHOST_TRACKER_APP_ID            empty or absent: no tracker (the `tracker` routes answer not_implemented)
 *   CODEHOST_TRACKER_INSTALLATION_ID   its installation
 *   CODEHOST_TRACKER_APP_KEY_REF       `file:` reference to its private key (never the codehost App's key)
 *   CODEHOST_TRACKER_LOGIN             the login it writes as (`<slug>[bot]`)
 *   CODEHOST_TRACKER_API_URL           default https://api.github.com; plain http only to loopback (the fake GitHub)
 */
export interface CodeHostTrackerConfig {
  readonly appId: string;
  readonly installationId: number;
  readonly appKeyRef: string;
  readonly login: string;
  readonly apiUrl: string;
}

export function trackerConfigFromEnv(env: Env): CodeHostTrackerConfig | null {
  const appId = env['CODEHOST_TRACKER_APP_ID'];
  if (appId === undefined || appId === '') return null;
  if (!/^[1-9][0-9]*$/.test(appId)) {
    throw new ServiceConfigError('CODEHOST_TRACKER_APP_ID must be a positive integer');
  }
  const installationId = Number(requiredEnv(env, 'CODEHOST_TRACKER_INSTALLATION_ID'));
  if (!Number.isInteger(installationId) || installationId < 1) {
    throw new ServiceConfigError('CODEHOST_TRACKER_INSTALLATION_ID must be a positive integer');
  }
  const appKeyRef = requiredEnv(env, 'CODEHOST_TRACKER_APP_KEY_REF');
  if (!appKeyRef.startsWith('file:')) {
    throw new ServiceConfigError('CODEHOST_TRACKER_APP_KEY_REF must be a file: reference');
  }
  if (env['CODEHOST_GITHUB_APP_KEY_REF'] === appKeyRef) {
    throw new ServiceConfigError("the tracker App has its own key, never the codehost App's");
  }
  const apiUrl = env['CODEHOST_TRACKER_API_URL']
    ? httpUrlEnv(env, 'CODEHOST_TRACKER_API_URL')
    : 'https://api.github.com';
  const u = new URL(apiUrl);
  if (u.protocol !== 'https:' && !LOOPBACK.has(u.hostname)) {
    throw new ServiceConfigError(
      'CODEHOST_TRACKER_API_URL must be https (plain http only to loopback): it carries credentials',
    );
  }
  return {
    appId,
    installationId,
    appKeyRef,
    login: requiredEnv(env, 'CODEHOST_TRACKER_LOGIN'),
    apiUrl,
  };
}
