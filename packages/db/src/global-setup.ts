import { CLUSTER_URL_ENV } from './testing.js';
import { startTestCluster, type TestCluster } from './test-cluster.js';

// Every Vitest project that needs a database runs this globalSetup, in one process but (Vitest
// loads each project's setup files separately) not in one module instance, so the clusters still
// running are kept on `globalThis`, and the signal listeners are installed once for all of them.
// Without that, more than ten projects add more than ten listeners (a MaxListenersExceededWarning).
const REGISTRY = Symbol.for('aisdlc.db.test-clusters');
type Registry = { running: Set<TestCluster>; hooked: boolean };
const registry = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= {
  running: new Set<TestCluster>(),
  hooked: false,
}) as Registry;

/** Vitest globalSetup: with DATABASE_URL set do nothing, else start one throwaway cluster. */
export default async function setup(): Promise<() => Promise<void>> {
  let mine: TestCluster | undefined;
  if (!process.env['DATABASE_URL']) {
    mine = await startTestCluster();
    registry.running.add(mine);
    process.env[CLUSTER_URL_ENV] = mine.url;
    if (!registry.hooked) {
      registry.hooked = true;
      const kill = (): void => {
        for (const c of registry.running) void c.stop();
      };
      process.once('SIGINT', kill);
      process.once('SIGTERM', kill);
    }
  }
  return async () => {
    if (mine) registry.running.delete(mine);
    await mine?.stop();
    mine = undefined;
  };
}
