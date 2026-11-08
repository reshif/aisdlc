import { createPool } from '@aisdlc/db';
import { HttpKeyCustody } from '@aisdlc/kms-local/client';
import { listen, loadServiceAuth, resolveSecretRef } from '@aisdlc/service-kit';
import { z } from 'zod';
import { createWitnessApp } from './app.js';
import { migrateWitness } from './migrations.js';
import { WitnessService } from './service.js';

const Callers = z.record(z.string(), z.strictObject({ token_ref: z.string() }));
const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const pool = createPool(need('WITNESS_DATABASE_URL'), 5);
await migrateWitness(pool);
const callers = Callers.parse(JSON.parse(need('WITNESS_CALLERS')));
const custody = new HttpKeyCustody({
  baseUrl: need('KMS_URL'),
  token: resolveSecretRef(need('KMS_TOKEN_REF')),
});
const app = createWitnessApp({
  service: new WitnessService({ pool, custody }),
  auth: loadServiceAuth(callers),
  callers: Object.keys(callers),
});
const url = await listen(app, {
  host: env['WITNESS_HOST'] ?? '127.0.0.1',
  port: Number(env['WITNESS_PORT'] ?? 8320),
});
console.log(`witness listening on ${url}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(
    sig,
    () =>
      void app
        .close()
        .then(() => pool.end())
        .then(() => process.exit(0)),
  );
}
