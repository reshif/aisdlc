import { CLUSTER_URL_ENV } from '../src/testing.js';
import { startTestCluster, type TestCluster } from '../src/test-cluster.js';

let cluster: TestCluster | undefined;

/** Vitest globalSetup: with DATABASE_URL set do nothing, else start one throwaway cluster. */
export default async function setup(): Promise<() => Promise<void>> {
  if (!process.env['DATABASE_URL']) {
    cluster = await startTestCluster();
    process.env[CLUSTER_URL_ENV] = cluster.url;
    const kill = (): void => {
      void cluster?.stop();
    };
    process.once('SIGINT', kill);
    process.once('SIGTERM', kill);
  }
  return async () => {
    await cluster?.stop();
    cluster = undefined;
  };
}
