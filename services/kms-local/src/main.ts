import { listen } from '@aisdlc/service-kit';
import { createKmsApp } from './app.js';
import { kmsOptionsFromEnv } from './main-config.js';

// kms-local is a stand-in for a cloud KMS and serves only `dev:` keys, so a process that is not
// in local mode does not start (the app also refuses per request, as a second layer).
if (process.env['FACTORY_ENV'] !== 'local') {
  console.error('kms-local refuses to start unless FACTORY_ENV=local');
  process.exit(1);
}
const app = createKmsApp(kmsOptionsFromEnv(process.env));
const url = await listen(app, {
  host: process.env['KMS_HOST'] ?? '127.0.0.1',
  port: Number(process.env['KMS_PORT'] ?? 8300),
});
console.log(`kms-local listening on ${url}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => void app.close().then(() => process.exit(0)));
}
