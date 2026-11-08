import { createPool } from '@aisdlc/db';
import { loadServiceAuth, listen, resolveSecretRef } from '@aisdlc/service-kit';
import { HttpKeyCustody } from '@aisdlc/kms-local/client';
import { z } from 'zod';
import { createNotaryApp } from './app.js';
import { migrateNotary } from './migrations.js';
import { NotaryService } from './service.js';

const Callers = z.record(
  z.string(),
  z.strictObject({
    token_ref: z.string(),
    scopes: z.array(z.enum(['ledger', 'checkpoint', 'read'])),
  }),
);
const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const pool = createPool(need('NOTARY_DATABASE_URL'), 5);
await migrateNotary(pool);
const callers = Callers.parse(JSON.parse(need('NOTARY_CALLERS')));
const custody = new HttpKeyCustody({
  baseUrl: need('KMS_URL'),
  token: resolveSecretRef(need('KMS_TOKEN_REF')),
});
const app = createNotaryApp({
  service: new NotaryService({ pool, custody }),
  auth: loadServiceAuth(callers),
  callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
});
const url = await listen(app, {
  host: env['NOTARY_HOST'] ?? '127.0.0.1',
  port: Number(env['NOTARY_PORT'] ?? 8310),
});
console.log(`notary listening on ${url}`);
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
