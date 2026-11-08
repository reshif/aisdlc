import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CodeHostNotOk } from '@aisdlc/contracts';
import { manualClock, type ManualClock } from '@aisdlc/kernel';
import { FakeRegisteredRepos, emptySeed, type CodeHostSeed } from '@aisdlc/ports';
import { type CodeHostHarness } from '@aisdlc/ports/testing';
import { GitHubRestCodeHost } from './adapter.js';
import { AppKey } from './app-key.js';
import { FakeGitHubServer, generateTestAppKey } from './fake-github-server.js';
import { TokenBroker } from './token-broker.js';
import { GitHubTransport } from './transport.js';
import type { CodeHostMode } from './allow-list.js';

export * from './fake-github-server.js';

export interface TestCodeHost {
  readonly server: FakeGitHubServer;
  readonly broker: TokenBroker;
  readonly transport: GitHubTransport;
  readonly rest: GitHubRestCodeHost;
  readonly clock: ManualClock;
  readonly registered: FakeRegisteredRepos;
  /** The App key's PEM and the file it was read from: the secret the tests grep for. */
  readonly keyPem: string;
  readonly keyFile: string;
  /** Log lines the transport wrote. */
  readonly logs: string[];
  stop(): Promise<void>;
}

export const TEST_APP_ID = '123456';

/** A fake GitHub HTTP server, a real App key in a temp file, and the real broker, transport and adapter over them. */
export async function startTestCodeHost(
  opts: { seed?: CodeHostSeed; mode?: CodeHostMode; tokenTtlMs?: number; timeoutMs?: number } = {},
): Promise<TestCodeHost> {
  const seed = opts.seed ?? emptySeed();
  // Frozen at the real current time, so a separate process (the bundle) agrees with it to within seconds.
  const clock = manualClock(new Date());
  const keys = generateTestAppKey();
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-codehost-'));
  const keyFile = join(dir, 'app-key.pem');
  writeFileSync(keyFile, keys.privatePem, { mode: 0o600 });
  const server = await new FakeGitHubServer({
    appId: TEST_APP_ID,
    appPublicKeyPem: keys.publicPem,
    clock,
    seed,
    ...(opts.tokenTtlMs === undefined ? {} : { tokenTtlMs: opts.tokenTtlMs }),
  }).start();
  const broker = new TokenBroker({
    appKey: AppKey.fromRef(`file:${keyFile}`),
    appId: TEST_APP_ID,
    installationId: seed.installation.installation_id,
    baseUrl: server.baseUrl,
    mode: opts.mode ?? 'census',
    clock,
  });
  const logs: string[] = [];
  const transport = new GitHubTransport({
    baseUrl: server.baseUrl,
    broker,
    mode: opts.mode ?? 'census',
    log: (l) => logs.push(l),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  const rest = new GitHubRestCodeHost({
    transport,
    installationId: seed.installation.installation_id,
    clock,
  });
  const registered = new FakeRegisteredRepos();
  return {
    server,
    broker,
    transport,
    rest,
    clock,
    registered,
    keyPem: keys.privatePem,
    keyFile,
    logs,
    async stop() {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A `CodeHostHarness` over the REST adapter and the fake GitHub HTTP server, for the contract suite. */
export async function restHarness(seed: CodeHostSeed): Promise<CodeHostHarness> {
  const t = await startTestCodeHost({ seed });
  return {
    port: t.rest,
    requests: () => t.server.apiRequests.map((r) => ({ method: r.method as 'GET', path: r.path })),
    breakAll: (as: CodeHostNotOk | null) => {
      if (as === null) t.server.answerNormally();
      else t.server.answerWith(as.state === 'unknown' ? 500 : 403);
    },
    stop: () => t.stop(),
  };
}
