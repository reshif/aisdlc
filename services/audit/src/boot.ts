import { readFileSync } from 'node:fs';
import { ConfigReader, ConfigRegistry, registerAuditConfig } from '@aisdlc/config';
import {
  AUDIT_RETENTION_CONFIG_KEY,
  AuditRetentionConfig,
  DEFAULT_AUDIT_RETENTION,
  PDP_POLICY_VERSION,
} from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import type { Jwk } from '@aisdlc/kernel';
import { HttpKeyCustody } from '@aisdlc/kms-local/client';
import { LoopSupervisor } from '@aisdlc/loops';
import { HttpNotary } from '@aisdlc/notary/client';
import { ConfigBundleSource, Pdp, registerPdpConfig } from '@aisdlc/pdp';
import {
  HttpErasablePayloads,
  S3ObjectStore,
  type AuditExportSignerPort,
  type ErasablePayloadsPort,
  type NotaryPort,
  type ObjectStorePort,
} from '@aisdlc/ports';
import {
  ServiceConfigError,
  databaseUrl,
  httpUrlEnv,
  jsonEnv,
  listen,
  listenConfig,
  loadServiceAuth,
  requiredEnv,
  resolveSecretRef,
  type Env,
  type RunningService,
} from '@aisdlc/service-kit';
import { z } from 'zod';
import { createAuditApp } from './app.js';
import type { RetentionRead } from './govern.js';
import { auditLoops } from './loops.js';

const Callers = z.record(
  z.string(),
  z.strictObject({
    token_ref: z.string(),
    scopes: z.array(z.enum(['read', 'export', 'govern'])),
  }),
);

const intEnv = (env: Env, name: string, dflt: number, min: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ServiceConfigError(`${name} must be an integer of at least ${min}`);
  }
  return n;
};

/** A public JWK from a pinned file, refusing anything with a private part. */
export function readPublicJwkFile(ref: string, what: string): Jwk {
  if (!ref.startsWith('file:')) throw new ServiceConfigError(`${what} is a file: reference`);
  const j = JSON.parse(readFileSync(ref.slice('file:'.length), 'utf8')) as Record<string, unknown>;
  if (j['kty'] !== 'EC' || j['crv'] !== 'P-256' || typeof j['x'] !== 'string' || 'd' in j) {
    throw new ServiceConfigError(`${what} is not a P-256 EC public JWK`);
  }
  return j as Jwk;
}

/** The retention classes in force, with the revision they come from (unreadable falls back to the default). */
export function retentionFrom(reader: ConfigReader): () => RetentionRead {
  return () => {
    const c = reader.current();
    const p = AuditRetentionConfig.safeParse(c.get(AUDIT_RETENTION_CONFIG_KEY));
    return p.success
      ? { config: p.data, rev_hash: c.revisions.factory }
      : { config: DEFAULT_AUDIT_RETENTION, rev_hash: null };
  };
}

/**
 * Starts the audit service (PLAN M19; ADR-0003 §1 Trust plane "audit"; docs/specs/audit-api.md):
 *
 *   AUDIT_DATABASE_URL       the record database as the least-privilege role `audit` (see the migration)
 *   AUDIT_CALLERS            JSON {caller: {token_ref, scopes: [read|export|govern]}} (the bff)
 *   AUDIT_NOTARY_URL, AUDIT_NOTARY_TOKEN_REF   the Notary (scopes ledger, read, audit_export): the ledger entries and
 *                            the export signatures; this service holds no key
 *   KMS_URL, KMS_TOKEN_REF   public-key reads of the Notary's and the Witness's keys (this caller may use no key); or
 *   AUDIT_NOTARY_KEY_REF, AUDIT_WITNESS_KEY_REF   file: pinned public JWKs
 *   AUDIT_CORE_URL, AUDIT_CORE_TOKEN_REF       core's erasable payloads (scope erasure)
 *   AUDIT_OBJECT_STORE_URL, AUDIT_OBJECT_STORE_ACCESS_KEY_REF, AUDIT_OBJECT_STORE_SECRET_KEY_REF   the write-once bucket
 *                            `audit-exports`
 *   AUDIT_ERASURE_INTERVAL_MS (30000), AUDIT_RETENTION_INTERVAL_MS (3600000), AUDIT_CONFIG_RELOAD_MS (5000)
 *   AUDIT_HOST (127.0.0.1), AUDIT_PORT (8480)
 *
 * `deps` replaces the ports (tests).
 */
export async function bootAudit(
  env: Env,
  deps: {
    notary?: NotaryPort & AuditExportSignerPort;
    keys?: { notary: Jwk; witness: Jwk };
    payloads?: ErasablePayloadsPort;
    objects?: ObjectStorePort;
    log?: (line: string) => void;
  } = {},
): Promise<RunningService & { supervisor: LoopSupervisor }> {
  const dbUrl = databaseUrl(env, 'AUDIT_DATABASE_URL');
  const callers = jsonEnv(env, 'AUDIT_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const listenOpts = listenConfig(env, 'AUDIT', 8480);
  const log = deps.log ?? ((l: string) => console.log(`audit: ${l}`));
  const notary =
    deps.notary ??
    new HttpNotary({
      baseUrl: httpUrlEnv(env, 'AUDIT_NOTARY_URL'),
      token: resolveSecretRef(requiredEnv(env, 'AUDIT_NOTARY_TOKEN_REF'), { env }),
    });
  let keys = deps.keys;
  if (!keys) {
    if (env['AUDIT_NOTARY_KEY_REF'] && env['AUDIT_WITNESS_KEY_REF']) {
      keys = {
        notary: readPublicJwkFile(env['AUDIT_NOTARY_KEY_REF'], 'AUDIT_NOTARY_KEY_REF'),
        witness: readPublicJwkFile(env['AUDIT_WITNESS_KEY_REF'], 'AUDIT_WITNESS_KEY_REF'),
      };
    } else {
      const custody = new HttpKeyCustody({
        baseUrl: httpUrlEnv(env, 'KMS_URL'),
        token: resolveSecretRef(requiredEnv(env, 'KMS_TOKEN_REF'), { env }),
      });
      const n = await custody.publicKey('dev:notary');
      const w = await custody.publicKey('dev:witness');
      if (!n.ok || !w.ok) throw new Error('the Notary and Witness public keys could not be read');
      keys = { notary: n.value, witness: w.value };
    }
  }
  const payloads =
    deps.payloads ??
    new HttpErasablePayloads({
      baseUrl: httpUrlEnv(env, 'AUDIT_CORE_URL'),
      token: resolveSecretRef(requiredEnv(env, 'AUDIT_CORE_TOKEN_REF'), { env }),
    });
  const objects =
    deps.objects ??
    new S3ObjectStore({
      endpoint: httpUrlEnv(env, 'AUDIT_OBJECT_STORE_URL'),
      accessKeyRef: requiredEnv(env, 'AUDIT_OBJECT_STORE_ACCESS_KEY_REF'),
      secretKeyRef: requiredEnv(env, 'AUDIT_OBJECT_STORE_SECRET_KEY_REF'),
    });
  const pool = createPool(dbUrl, 6);
  let reader: ConfigReader | undefined;
  let supervisor: LoopSupervisor | undefined;
  try {
    const have = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('audit.erasure')::text AS audit,
              to_regclass('ledger.ledger_entry')::text AS ledger,
              to_regclass('identity.principal')::text AS identity,
              to_regclass('config.genuine_publish')::text AS config`,
    );
    const missing = Object.entries(have.rows[0] ?? {})
      .filter(([, v]) => v == null)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `the ${missing.join(', ')} schema(s) are missing: run aisdlc-migrate on the record database first`,
      );
    }
    reader = await ConfigReader.create({
      pool,
      registry: registerAuditConfig(registerPdpConfig(new ConfigRegistry())),
      // this role may not fold the config read model: it reads what core folded
      catchUp: false,
      pollIntervalMs: intEnv(env, 'AUDIT_CONFIG_RELOAD_MS', 5_000, 100),
      onError: (e) => log(`config reader: ${e instanceof Error ? e.constructor.name : 'error'}`),
    });
    await reader.start();
    const pdp = new Pdp({
      source: new ConfigBundleSource(reader),
      // read-only: refuse (deny) while identity's read model is behind the record, never answer from a stale one
      entities: new IdentityPdpEntities({ pool, freshness: 'check' }),
      onError: (e) => log(`pdp: ${e instanceof Error ? e.constructor.name : 'error'}`),
    });
    const policyVersion = () => PDP_POLICY_VERSION;
    const ledger = { notary, notaryKey: keys.notary };
    const govern = { pool, ledger, payloads, policyVersion };
    const exporter = { pool, ledger, signer: notary, objects, keys, policyVersion };
    const retention = retentionFrom(reader);
    const sup = new LoopSupervisor({ log });
    supervisor = sup;
    for (const l of auditLoops(govern, retention, {
      executeIntervalMs: intEnv(env, 'AUDIT_ERASURE_INTERVAL_MS', 30_000, 100),
      retentionIntervalMs: intEnv(env, 'AUDIT_RETENTION_INTERVAL_MS', 3_600_000, 100),
      startDelayMs: 1_000,
      log,
    }))
      sup.add(l);
    const app = createAuditApp({
      pool,
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
      pdp,
      exporter,
      govern,
      objects,
      retention,
      supervisor: sup,
      log,
    });
    const url = await listen(app, listenOpts);
    sup.start();
    const r = reader;
    return {
      url,
      supervisor: sup,
      close: async () => {
        await app.close();
        await sup.stop();
        await r.stop();
        await pool.end();
      },
    };
  } catch (e) {
    await supervisor?.stop().catch(() => undefined);
    await reader?.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw e;
  }
}
