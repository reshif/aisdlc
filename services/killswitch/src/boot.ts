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
import { createKillswitchApp } from './app.js';
import { migrateKillswitch } from './migrations.js';
import { KILLSWITCH_KEY_ID, KillService } from './service.js';

const Callers = z.record(
  z.string(),
  z.strictObject({
    token_ref: z.string(),
    scopes: z.array(z.enum(['act', 'read', 'sync'])),
  }),
);
const Admins = z.array(z.string().min(1));

/**
 * Starts the kill switch from the environment: `KILLSWITCH_DATABASE_URL` (its OWN database),
 * `KILLSWITCH_CALLERS` (JSON `{caller: {token_ref, scopes}}`), `KILLSWITCH_FACTORY_ADMINS` (JSON list of
 * principal ids: the only people who may kill the fleet), `KMS_URL`, `KMS_TOKEN_REF` (its own key,
 * `dev:killswitch`), `KILLSWITCH_HOST` (127.0.0.1) and `KILLSWITCH_PORT` (8400). It reads nothing of
 * core's and has no URL of core's: AR9. All configuration is read before the database is touched.
 */
export async function bootKillswitch(env: Env): Promise<RunningService> {
  const dbUrl = databaseUrl(env, 'KILLSWITCH_DATABASE_URL');
  const callers = jsonEnv(env, 'KILLSWITCH_CALLERS', Callers);
  const admins = jsonEnv(env, 'KILLSWITCH_FACTORY_ADMINS', Admins);
  const auth = loadServiceAuth(callers, { env });
  const custody = httpKeyCustodyFromEnv(env);
  const listenOpts = listenConfig(env, 'KILLSWITCH', 8400);

  const pool = createPool(dbUrl, 5);
  try {
    await migrateKillswitch(pool);
    const service = new KillService({ pool, custody, keyId: KILLSWITCH_KEY_ID });
    const seeded = await service.seedFactoryAdmins(admins);
    if (!seeded.ok) throw new Error(`cannot seed the factory admins: ${seeded.error.message}`);
    const app = createKillswitchApp({
      service,
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
    });
    // Kills enforced while the KMS was away are signed as soon as it is back.
    const timer = setInterval(
      () => void service.backfillSignatures().catch(() => undefined),
      5_000,
    );
    timer.unref();
    void service.backfillSignatures().catch(() => undefined);
    const url = await listen(app, listenOpts);
    return {
      url,
      close: () => {
        clearInterval(timer);
        return app.close().then(() => pool.end());
      },
    };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}
