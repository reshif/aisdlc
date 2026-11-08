import {
  ServiceConfigError,
  databaseUrl,
  httpUrlEnv,
  jsonEnv,
  loadServiceAuth,
  requiredEnv,
  resolveSecretRef,
  type Env,
  type ServiceAuth,
} from '@aisdlc/service-kit';
import { z } from 'zod';
import type { CoreScope } from './app.js';

const Callers = z.record(
  z.string().min(1),
  z.strictObject({
    token_ref: z.string().min(1),
    scopes: z.array(z.enum(['read', 'onboard', 'settings', 'registry'])).min(1),
  }),
);

export interface CoreConfig {
  readonly databaseUrl: string;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly CoreScope[]>;
  /** The decision kernel's ledger side: absent, a settings change cannot be proposed. */
  readonly ledger: {
    readonly notaryUrl: string;
    readonly notaryToken: string;
  } | null;
}

/**
 * Reads the environment (all of it, before anything is started):
 *   CORE_DATABASE_URL        the record database; the record, ledger, decisions, config and identity
 *                            schemas must already be migrated (`aisdlc-migrate`), the core schema is
 *                            migrated at start
 *   CORE_CALLERS             JSON {caller: {token_ref, scopes: [read|onboard|settings|registry]}}
 *   CORE_HOST / _PORT        default 127.0.0.1:8370
 *   CORE_NOTARY_URL, CORE_NOTARY_TOKEN_REF, KMS_URL, KMS_TOKEN_REF
 *                            the decision kernel's Notary client and key lookup; without them a
 *                            settings change answers `unavailable` (the other routes work)
 * Every secret is an `env:NAME` or `file:PATH` reference.
 */
export function coreConfigFromEnv(env: Env): CoreConfig {
  const dbUrl = databaseUrl(env, 'CORE_DATABASE_URL');
  const callers = jsonEnv(env, 'CORE_CALLERS', Callers);
  const notary = env['CORE_NOTARY_URL'];
  return {
    databaseUrl: dbUrl,
    auth: loadServiceAuth(callers, { env }),
    callers: Object.fromEntries(
      Object.entries(callers).map(([n, c]) => [n, c.scopes as CoreScope[]]),
    ),
    ledger:
      notary === undefined || notary === ''
        ? null
        : {
            notaryUrl: httpUrlEnv(env, 'CORE_NOTARY_URL'),
            notaryToken: resolveSecretRef(requiredEnv(env, 'CORE_NOTARY_TOKEN_REF'), { env }),
          },
  };
}

export { ServiceConfigError };
