import {
  ServiceConfigError,
  listen,
  listenConfig,
  type Env,
  type RunningService,
} from '@aisdlc/service-kit';
import { createKmsApp } from './app.js';
import { kmsOptionsFromEnv } from './main-config.js';

/**
 * Starts kms-local from the environment: `FACTORY_ENV` (must be `local`), `KMS_DIR`,
 * `KMS_CALLERS`, `KMS_HOST` (127.0.0.1), `KMS_PORT` (8300).
 */
export async function bootKms(env: Env): Promise<RunningService> {
  // kms-local is a stand-in for a cloud KMS and serves only `dev:` keys, so a process that is not
  // in local mode does not start (the app also refuses per request, as a second layer).
  if (env['FACTORY_ENV'] !== 'local') {
    throw new ServiceConfigError('kms-local refuses to start unless FACTORY_ENV=local');
  }
  const listenOpts = listenConfig(env, 'KMS', 8300);
  const app = createKmsApp(kmsOptionsFromEnv(env));
  const url = await listen(app, listenOpts);
  return { url, close: () => app.close() };
}
