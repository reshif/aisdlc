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
    scopes: z
      .array(
        z.enum([
          'read',
          'onboard',
          'settings',
          'registry',
          'portal',
          'work',
          'ops',
          'integrations',
          'evals',
          'push_guard',
          'activity',
        ]),
      )
      .min(1),
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
  /** The onboarding cards' remotes (PLAN M8.0): knowledge (scopes census, security) and the codehost reads. */
  readonly cards: {
    readonly knowledge: { readonly url: string; readonly token: string };
    readonly codehost: { readonly url: string; readonly token: string };
  } | null;
  /**
   * The assistant (PLAN M18): the model gateway's admin API (scopes `admin` and `read`; budget groups and per-ask
   * keys) and its `/v1/messages`. Needs the cards' knowledge (the census head, and the `search` scope for the tool).
   */
  readonly assistant: {
    readonly gateway: { readonly url: string; readonly token: string };
    /** Model ids the deployment routes that the assistant's contract does not name (the local `fake-model`). */
    readonly extraModels: readonly string[];
  } | null;
  /** M14.6: the object store of the Evidence Packs, read back for the portal's pack viewer (credentials as references). */
  readonly objectStore: {
    readonly endpoint: string;
    readonly accessKeyRef: string;
    readonly secretKeyRef: string;
  } | null;
  /** M19: core-worker's read-only `/admission` (the kill switch's verdict, for the floor's kill banner). */
  readonly admissionUrl: string | null;
}

/**
 * Reads the environment (all of it, before anything is started):
 *   CORE_DATABASE_URL        the record database; the record, ledger, decisions, config and identity
 *                            schemas must already be migrated (`aisdlc-migrate`), the core schema is
 *                            migrated at start
 *   CORE_CALLERS             JSON {caller: {token_ref, scopes: [read|onboard|settings|registry|portal|work]}}
 *   CORE_HOST / _PORT        default 127.0.0.1:8380
 *   CORE_NOTARY_URL, CORE_NOTARY_TOKEN_REF, KMS_URL, KMS_TOKEN_REF
 *                            the decision kernel's Notary client and key lookup; without them a
 *                            settings change answers `unavailable` (the other routes work)
 *   CORE_KNOWLEDGE_URL, CORE_KNOWLEDGE_TOKEN_REF   knowledge's API (scopes `census` and `security`), and
 *   CORE_CODEHOST_URL, CORE_CODEHOST_TOKEN_REF     the codehost's reads (scopes `census` and `posture`):
 *                            together with the ledger they switch the onboarding cards on (prepare, view,
 *                            decide); with neither, the card routes answer `unavailable`. One without the
 *                            other, or either without the ledger, is a configuration error
 *   CORE_GATEWAY_URL, CORE_GATEWAY_TOKEN_REF   the model gateway (scopes `admin`, `read`): switches the assistant on
 *                            (M18); needs the knowledge above. CORE_ASSISTANT_EXTRA_MODELS: comma-separated model ids
 *                            the deployment's routes serve (the local `fake-model`)
 *   CORE_OBJECT_STORE_URL, CORE_OBJECT_STORE_ACCESS_KEY_REF, CORE_OBJECT_STORE_SECRET_KEY_REF   (M14.6) the
 *                            S3-compatible store of the signed Evidence Packs: the portal's pack viewer reads them
 *                            back (and checks them); without it the viewer shows the record's facts only
 *   CORE_ADMISSION_URL       (M19) core-worker's read-only `/admission`: the kill switch's verdict the floor shows
 *                            (core has no route to the kill switch); without it the floor reads killed (AR9)
 * Every secret is an `env:NAME` or `file:PATH` reference.
 */
export function coreConfigFromEnv(env: Env): CoreConfig {
  const dbUrl = databaseUrl(env, 'CORE_DATABASE_URL');
  const callers = jsonEnv(env, 'CORE_CALLERS', Callers);
  const notary = env['CORE_NOTARY_URL'];
  const remote = (name: string) => {
    const url = env[`CORE_${name}_URL`];
    if (url === undefined || url === '') return null;
    return {
      url: httpUrlEnv(env, `CORE_${name}_URL`),
      token: resolveSecretRef(requiredEnv(env, `CORE_${name}_TOKEN_REF`), { env }),
    };
  };
  const knowledge = remote('KNOWLEDGE');
  const codehost = remote('CODEHOST');
  if ((knowledge === null) !== (codehost === null)) {
    throw new ServiceConfigError(
      'the onboarding cards need both CORE_KNOWLEDGE_URL and CORE_CODEHOST_URL: set both or neither',
    );
  }
  const gateway = remote('GATEWAY');
  if (gateway !== null && knowledge === null) {
    throw new ServiceConfigError(
      'the assistant needs knowledge: set CORE_KNOWLEDGE_URL with CORE_GATEWAY_URL',
    );
  }
  if (knowledge !== null && (notary === undefined || notary === '')) {
    throw new ServiceConfigError('the onboarding cards need the ledger: set CORE_NOTARY_URL');
  }
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
    cards: knowledge !== null && codehost !== null ? { knowledge, codehost } : null,
    assistant:
      gateway === null
        ? null
        : {
            gateway,
            extraModels: (env['CORE_ASSISTANT_EXTRA_MODELS'] ?? '')
              .split(',')
              .map((x) => x.trim())
              .filter((x) => /^[A-Za-z0-9_.:-]{1,64}$/.test(x)),
          },
    objectStore:
      env['CORE_OBJECT_STORE_URL'] === undefined || env['CORE_OBJECT_STORE_URL'] === ''
        ? null
        : {
            endpoint: httpUrlEnv(env, 'CORE_OBJECT_STORE_URL'),
            accessKeyRef: requiredEnv(env, 'CORE_OBJECT_STORE_ACCESS_KEY_REF'),
            secretKeyRef: requiredEnv(env, 'CORE_OBJECT_STORE_SECRET_KEY_REF'),
          },
    admissionUrl:
      env['CORE_ADMISSION_URL'] === undefined || env['CORE_ADMISSION_URL'] === ''
        ? null
        : httpUrlEnv(env, 'CORE_ADMISSION_URL'),
  };
}

export { ServiceConfigError };
