import { systemClock } from '@aisdlc/kernel';
import { listen, listenConfig, type Env, type RunningService } from '@aisdlc/service-kit';
import { FakeRegisteredRepos, FileRegisteredRepos, HttpRegisteredRepos } from '@aisdlc/ports';
import { GitHubRestCodeHost } from './adapter.js';
import { createCodeHostApp } from './app.js';
import { codeHostConfigFromEnv, codeHostRegistryConfigFromEnv } from './config.js';
import { HttpIdentityLinks } from './identity-client.js';
import { RegistryHostSelector, reportHealth } from './registry-runtime.js';
import { AllowListedCodeHost } from './repo-allow-list.js';
import { TokenBroker } from './token-broker.js';
import { GitHubTransport } from './transport.js';

/**
 * Starts the codehost from the environment (see `codeHostConfigFromEnv`), plus
 * `CODEHOST_HOST` (127.0.0.1) and `CODEHOST_PORT` (8350). It makes no network call at start, and runs `git` only when a bundle is asked for: the
 * first token is minted by the first request that needs one.
 */
/**
 * The structured request log (M8.5): one JSON line per request to GitHub, `codehost: ghreq {...}`,
 * with the method, the path template, the status and the role. `live-census.sh` groups these.
 */
const requestLog = (e: { method: string; path: string; status: number; auth: string }): void =>
  console.log(`codehost: ghreq ${JSON.stringify(e)}`);

export async function bootCodeHost(env: Env): Promise<RunningService> {
  if (env['CODEHOST_REGISTRY_INTEGRATION']) return bootCodeHostFromRegistry(env);
  const cfg = codeHostConfigFromEnv(env);
  const listenOpts = listenConfig(env, 'CODEHOST', 8350);
  const clock = systemClock;
  const broker = new TokenBroker({
    appKey: cfg.appKey,
    appId: cfg.appId,
    installationId: cfg.installationId,
    baseUrl: cfg.apiUrl,
    mode: cfg.mode,
    clock,
    onMint: (e) => requestLog(e),
  });
  const transport = new GitHubTransport({
    baseUrl: cfg.apiUrl,
    broker,
    mode: cfg.mode,
    log: (line) => console.log(`codehost: ${line}`),
    onRequest: (e) => requestLog(e),
  });
  const registered = cfg.core
    ? new HttpRegisteredRepos({ baseUrl: cfg.core.url, token: cfg.core.token })
    : cfg.registeredReposFile
      ? new FileRegisteredRepos(cfg.registeredReposFile)
      : new FakeRegisteredRepos().breakIt();
  const app = createCodeHostApp({
    host: new AllowListedCodeHost(
      new GitHubRestCodeHost({
        transport,
        installationId: cfg.installationId,
        clock,
        git: {
          broker,
          gitBaseUrl: cfg.gitUrl,
          capBytes: cfg.bundleCapBytes,
          timeoutMs: cfg.bundleTimeoutMs,
          log: (line) => console.log(`codehost: ${line}`),
          onFetch: (e) => requestLog(e),
        },
      }),
      registered,
    ),
    identity: new HttpIdentityLinks({ baseUrl: cfg.identityUrl, token: cfg.identityToken }),
    auth: cfg.auth,
    callers: cfg.callers,
    broker,
    clock,
  });
  const url = await listen(app, listenOpts);
  return { url, close: () => app.close() };
}

/**
 * Registry mode (see `codeHostRegistryConfigFromEnv`): the GitHub App is the integration row named by
 * `CODEHOST_REGISTRY_INTEGRATION`, read from core, followed by config revision (a poll and
 * `POST /v1/admin/reload`) with no restart, and reported on (health per integration). It makes no call to
 * GitHub at start. Until the row is readable and enabled every read answers `unknown`.
 */
async function bootCodeHostFromRegistry(env: Env): Promise<RunningService> {
  const cfg = codeHostRegistryConfigFromEnv(env);
  const listenOpts = listenConfig(env, 'CODEHOST', 8350);
  const selector = new RegistryHostSelector({
    integrationId: cfg.integrationId,
    core: cfg.core,
    policy: { env, secretRefs: new Set(cfg.secretRefs), egressHosts: new Set(cfg.egressHosts) },
    registered: new HttpRegisteredRepos({ baseUrl: cfg.core.url, token: cfg.core.token }),
    bundleCapBytes: cfg.bundleCapBytes,
    bundleTimeoutMs: cfg.bundleTimeoutMs,
    log: (line) => console.log(`codehost: ${line}`),
    requestLog,
  });
  const report = async (): Promise<void> => {
    await reportHealth(cfg.core, selector.health());
  };
  const tick = async (force = false): Promise<void> => {
    await selector.sync({ force });
    await report();
  };
  await tick().catch(() => undefined);
  const timers = [
    setInterval(() => void selector.sync().catch(() => undefined), cfg.registryIntervalMs),
    setInterval(() => void report().catch(() => undefined), cfg.healthIntervalMs),
  ];
  for (const t of timers) t.unref();
  const app = createCodeHostApp({
    runtime: selector,
    identity: new HttpIdentityLinks({ baseUrl: cfg.identityUrl, token: cfg.identityToken }),
    auth: cfg.auth,
    callers: cfg.callers,
    clock: systemClock,
    reload: async ({ force }) => {
      await tick(force);
      return selector.current;
    },
  });
  const url = await listen(app, listenOpts);
  return {
    url,
    close: async () => {
      for (const t of timers) clearInterval(t);
      await app.close();
    },
  };
}
