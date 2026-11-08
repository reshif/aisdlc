import { createPool } from '@aisdlc/db';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import {
  databaseUrl,
  jsonEnv,
  listen,
  listenConfig,
  loadServiceAuth,
  type Env,
  type RunningService,
} from '@aisdlc/service-kit';
import { z } from 'zod';
import { createWitnessApp } from './app.js';
import { migrateWitness } from './migrations.js';
import { WitnessService } from './service.js';

const Callers = z.record(z.string(), z.strictObject({ token_ref: z.string() }));

/**
 * Starts the Witness from the environment: `WITNESS_DATABASE_URL`, `WITNESS_CALLERS` (JSON
 * `{caller: {token_ref}}`; every listed caller may ask for co-signatures), `KMS_URL`,
 * `KMS_TOKEN_REF`, `WITNESS_HOST` (127.0.0.1) and `WITNESS_PORT` (8320). Every secret is an
 * `env:NAME` or `file:PATH` reference. Migrates its own database at start.
 */
export async function bootWitness(env: Env): Promise<RunningService> {
  const dbUrl = databaseUrl(env, 'WITNESS_DATABASE_URL');
  const callers = jsonEnv(env, 'WITNESS_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const custody = httpKeyCustodyFromEnv(env);
  const listenOpts = listenConfig(env, 'WITNESS', 8320);

  const pool = createPool(dbUrl, 5);
  try {
    await migrateWitness(pool);
    const app = createWitnessApp({
      service: new WitnessService({ pool, custody }),
      auth,
      callers: Object.keys(callers),
    });
    const url = await listen(app, listenOpts);
    return { url, close: () => app.close().then(() => pool.end()) };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}
