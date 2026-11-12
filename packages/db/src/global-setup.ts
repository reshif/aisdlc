import { CLUSTER_URL_ENV } from './testing.js';
import { startTestCluster, type TestCluster } from './test-cluster.js';

// Every Vitest project that needs a database runs this globalSetup, in one process but (Vitest
// loads each project's setup files separately) not in one module instance, so the state is kept on
// `globalThis`. The projects of one run share ONE throwaway cluster, started by the first setup and
// stopped by the last teardown: every test database has a unique name (`createTestDatabase`), and a
// shared server is what the projects already get with DATABASE_URL set (CI), so nothing depends on a
// cluster of its own. One cluster instead of one per project saves an initdb and a start per project.
// The signal listeners are installed once (more than ten would be a MaxListenersExceededWarning).
const REGISTRY = Symbol.for('aisdlc.db.test-clusters');
type Registry = {
  shared: Promise<TestCluster> | undefined;
  users: number;
  running: Set<TestCluster>;
  hooked: boolean;
};
const registry = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= {
  shared: undefined,
  users: 0,
  running: new Set<TestCluster>(),
  hooked: false,
}) as Registry;

/** Vitest globalSetup: with DATABASE_URL set do nothing, else share one throwaway cluster. */
export default async function setup(): Promise<() => Promise<void>> {
  if (process.env['DATABASE_URL']) return async () => undefined;
  registry.users += 1;
  if (registry.shared === undefined) {
    const starting = startTestCluster().then((c) => {
      registry.running.add(c);
      return c;
    });
    registry.shared = starting;
    // A failed start is not kept: the next setup tries again.
    starting.catch(() => {
      if (registry.shared === starting) registry.shared = undefined;
    });
  }
  let cluster: TestCluster;
  try {
    cluster = await registry.shared;
  } catch (e) {
    registry.users -= 1;
    throw e;
  }
  process.env[CLUSTER_URL_ENV] = cluster.url;
  if (!registry.hooked) {
    registry.hooked = true;
    const kill = (): void => {
      for (const c of registry.running) void c.stop();
    };
    process.once('SIGINT', kill);
    process.once('SIGTERM', kill);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    registry.users -= 1;
    if (registry.users > 0) return;
    registry.shared = undefined;
    registry.running.delete(cluster);
    await cluster.stop();
  };
}
