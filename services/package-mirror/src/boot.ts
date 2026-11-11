import {
  ServiceConfigError,
  listenConfig,
  requiredEnv,
  type RunningService,
} from '@aisdlc/service-kit';
import { createMirror } from './server.js';

/** `PACKAGE_MIRROR_ROOT` (the directory served), `PACKAGE_MIRROR_HOST` and `PACKAGE_MIRROR_PORT` (default 8420). */
export async function bootMirror(env: Record<string, string | undefined>): Promise<RunningService> {
  const root = requiredEnv(env, 'PACKAGE_MIRROR_ROOT');
  if (!root.startsWith('/')) throw new ServiceConfigError('PACKAGE_MIRROR_ROOT must be absolute');
  const { host, port } = listenConfig(env, 'PACKAGE_MIRROR', 8420);
  const server = createMirror({ root, log: (l) => console.log(`package-mirror ${l}`) });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
