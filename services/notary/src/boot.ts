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
import { createNotaryApp } from './app.js';
import { migrateNotary } from './migrations.js';
import { NotaryService } from './service.js';

const Callers = z.record(
  z.string(),
  z.strictObject({
    token_ref: z.string(),
    scopes: z.array(z.enum(['ledger', 'checkpoint', 'read', 'evidence', 'audit_export'])),
  }),
);

/**
 * Starts the Notary from the environment: `NOTARY_DATABASE_URL`, `NOTARY_CALLERS` (JSON
 * `{caller: {token_ref, scopes}}`), `KMS_URL`, `KMS_TOKEN_REF`, `NOTARY_HOST` (127.0.0.1) and
 * `NOTARY_PORT` (8310). Every secret is an `env:NAME` or `file:PATH` reference. All
 * configuration is read before the database is touched. Migrates its own database at start.
 */
export async function bootNotary(env: Env): Promise<RunningService> {
  const dbUrl = databaseUrl(env, 'NOTARY_DATABASE_URL');
  const callers = jsonEnv(env, 'NOTARY_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const custody = httpKeyCustodyFromEnv(env);
  const listenOpts = listenConfig(env, 'NOTARY', 8310);

  const pool = createPool(dbUrl, 5);
  try {
    await migrateNotary(pool);
    const app = createNotaryApp({
      service: new NotaryService({ pool, custody }),
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
    });
    const url = await listen(app, listenOpts);
    return { url, close: () => app.close().then(() => pool.end()) };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}
