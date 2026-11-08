import { systemClock } from '@aisdlc/kernel';
import { listen, listenConfig, type Env, type RunningService } from '@aisdlc/service-kit';
import { FakeRegisteredRepos } from '@aisdlc/ports';
import { GitHubRestCodeHost } from './adapter.js';
import { createCodeHostApp } from './app.js';
import { codeHostConfigFromEnv } from './config.js';
import { HttpIdentityLinks } from './identity-client.js';
import { FileRegisteredRepos } from './registered-repos-file.js';
import { AllowListedCodeHost } from './repo-allow-list.js';
import { TokenBroker } from './token-broker.js';
import { GitHubTransport } from './transport.js';

/**
 * Starts the codehost from the environment (see `codeHostConfigFromEnv`), plus
 * `CODEHOST_HOST` (127.0.0.1) and `CODEHOST_PORT` (8350). It makes no network call at start: the
 * first token is minted by the first request that needs one.
 */
export async function bootCodeHost(env: Env): Promise<RunningService> {
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
  });
  const transport = new GitHubTransport({
    baseUrl: cfg.apiUrl,
    broker,
    mode: cfg.mode,
    log: (line) => console.log(`codehost: ${line}`),
  });
  const registered = cfg.registeredReposFile
    ? new FileRegisteredRepos(cfg.registeredReposFile)
    : new FakeRegisteredRepos().breakIt();
  const app = createCodeHostApp({
    host: new AllowListedCodeHost(
      new GitHubRestCodeHost({ transport, installationId: cfg.installationId, clock }),
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
