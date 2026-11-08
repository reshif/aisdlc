import {
  jsonEnv,
  loadServiceAuth,
  requiredEnv,
  ServiceConfigError,
  type SecretRefDeps,
} from '@aisdlc/service-kit';
import { z } from 'zod';
import type { KmsAppOptions } from './app.js';
import { DEFAULT_KEY_ALLOW_LIST } from './keys.js';

const CallersConfig = z.record(
  z.string().min(1),
  z.strictObject({ token_ref: z.string().min(1), keys: z.array(z.string()).optional() }),
);

/**
 * Reads the environment: `FACTORY_ENV`, `KMS_DIR`, and `KMS_CALLERS`, a JSON object
 * `{"notary": {"token_ref": "file:/run/secrets/kms_notary"}, ...}`. A caller's `keys` default to
 * the allow-list in RV §2 (notary: dev:notary, witness: dev:witness, knowledge:
 * dev:fingerprint-hmac); a caller with no default must list its keys.
 */
export function kmsOptionsFromEnv(
  env: Record<string, string | undefined>,
  deps: SecretRefDeps = {},
): KmsAppOptions {
  const dir = requiredEnv(env, 'KMS_DIR');
  const parsed = { data: jsonEnv(env, 'KMS_CALLERS', CallersConfig) };
  const allow: Record<string, readonly string[]> = {};
  for (const [name, c] of Object.entries(parsed.data)) {
    const keys = c.keys ?? DEFAULT_KEY_ALLOW_LIST[name];
    if (!keys) throw new ServiceConfigError(`caller ${name} has no default keys; list them`);
    allow[name] = keys;
  }
  return {
    dir,
    factoryEnv: env['FACTORY_ENV'],
    auth: loadServiceAuth(parsed.data, { env, ...deps }),
    allow,
  };
}
