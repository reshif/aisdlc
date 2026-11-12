import { readFileSync } from 'node:fs';
import { AppKey } from '@aisdlc/codehost';
import { createPool } from '@aisdlc/db';
import {
  CustodyNotaryKey,
  StaticNotaryKey,
  parsePublicJwk,
  type NotaryKeyPort,
  type PackBytesPort,
} from '@aisdlc/gate-check';
import { HttpKeyCustody } from '@aisdlc/kms-local/client';
import { LoopSupervisor } from '@aisdlc/loops';
import { S3ObjectStore, type GateRelayHostPort } from '@aisdlc/ports';
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
import { createGateRelayApp } from './app.js';
import { RecordRelayFacts } from './facts.js';
import { GitHubDeploymentsHost } from './github.js';
import { gateRelayLoops } from './loops.js';
import { GateRelay } from './relay.js';
import { RecordGateRelayStore } from './store.js';

const Callers = z.record(
  z.string(),
  z.strictObject({ token_ref: z.string(), scopes: z.array(z.enum(['read'])) }),
);
const Hosts = z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(10);

const intEnv = (env: Env, name: string, dflt: number, min: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ServiceConfigError(`${name} must be an integer of at least ${min}`);
  }
  return n;
};

function notaryKeyFromEnv(env: Env): NotaryKeyPort {
  const pinned = env['GATE_RELAY_NOTARY_KEY_REF'];
  if (pinned) {
    if (!pinned.startsWith('file:'))
      throw new ServiceConfigError('GATE_RELAY_NOTARY_KEY_REF is a file: reference');
    try {
      return new StaticNotaryKey(
        parsePublicJwk(readFileSync(pinned.slice('file:'.length), 'utf8')),
      );
    } catch (e) {
      throw new ServiceConfigError(
        `GATE_RELAY_NOTARY_KEY_REF: ${e instanceof Error ? e.message : 'unreadable'}`,
      );
    }
  }
  return new CustodyNotaryKey(
    new HttpKeyCustody({
      baseUrl: httpUrlEnv(env, 'KMS_URL'),
      token: resolveSecretRef(requiredEnv(env, 'KMS_TOKEN_REF'), { env }),
    }),
  );
}

function hostFromEnv(env: Env): GateRelayHostPort {
  const installation = Number(requiredEnv(env, 'GATE_RELAY_INSTALLATION_ID'));
  if (!Number.isInteger(installation) || installation < 1) {
    throw new ServiceConfigError('GATE_RELAY_INSTALLATION_ID must be a positive integer');
  }
  return new GitHubDeploymentsHost({
    baseUrl: env['GATE_RELAY_GITHUB_API_URL'] || 'https://api.github.com',
    appId: requiredEnv(env, 'GATE_RELAY_APP_ID'),
    installationId: installation,
    appKey: AppKey.fromRef(requiredEnv(env, 'GATE_RELAY_APP_KEY_REF'), { env }),
    plainHttpHosts: env['GATE_RELAY_GITHUB_PLAIN_HTTP_HOSTS']
      ? jsonEnv(env, 'GATE_RELAY_GITHUB_PLAIN_HTTP_HOSTS', Hosts)
      : [],
    log: (l) => console.log(`gate-relay: github ${l}`),
  });
}

/**
 * Starts gate-relay (PLAN M15.3; ADR-0003 §1 Integration plane; docs/specs/gate-relay-api.md) from the environment:
 *
 *   GATE_RELAY_DATABASE_URL          the record database as the least-privilege role `gate_relay` (see the migration)
 *   GATE_RELAY_CALLERS               JSON {caller: {token_ref, scopes: [read]}} (the bff, for the portal)
 *   GATE_RELAY_APP_ID, GATE_RELAY_INSTALLATION_ID, GATE_RELAY_APP_KEY_REF (file:)   gate-relay's OWN GitHub App
 *                                    (`deployments: write`, metadata read): its key is in no other container
 *   GATE_RELAY_GITHUB_API_URL        default https://api.github.com; plain http only to loopback or a host in
 *   GATE_RELAY_GITHUB_PLAIN_HTTP_HOSTS (JSON list; the compose stack's fake GitHub)
 *   GATE_RELAY_OBJECT_STORE_URL, GATE_RELAY_OBJECT_STORE_ACCESS_KEY_REF, GATE_RELAY_OBJECT_STORE_SECRET_KEY_REF
 *                                    the signed Evidence Packs (read only)
 *   GATE_RELAY_NOTARY_KEY_REF        file: a pinned public JWK of the Notary; else KMS_URL and KMS_TOKEN_REF
 *   GATE_RELAY_CONSUME_INTERVAL_MS (15000), GATE_RELAY_HEALTH_INTERVAL_MS (30000)
 *   GATE_RELAY_HOST (127.0.0.1), GATE_RELAY_PORT (8460)
 *
 * `deps` replaces the ports (tests).
 */
export async function bootGateRelay(
  env: Env,
  deps: {
    host?: GateRelayHostPort;
    packs?: PackBytesPort;
    notaryKey?: NotaryKeyPort;
    log?: (line: string) => void;
  } = {},
): Promise<RunningService & { supervisor: LoopSupervisor }> {
  const dbUrl = databaseUrl(env, 'GATE_RELAY_DATABASE_URL');
  const callers = jsonEnv(env, 'GATE_RELAY_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const listenOpts = listenConfig(env, 'GATE_RELAY', 8460);
  const host = deps.host ?? hostFromEnv(env);
  const packs =
    deps.packs ??
    new S3ObjectStore({
      endpoint: httpUrlEnv(env, 'GATE_RELAY_OBJECT_STORE_URL'),
      accessKeyRef: requiredEnv(env, 'GATE_RELAY_OBJECT_STORE_ACCESS_KEY_REF'),
      secretKeyRef: requiredEnv(env, 'GATE_RELAY_OBJECT_STORE_SECRET_KEY_REF'),
    });
  const notaryKey = deps.notaryKey ?? notaryKeyFromEnv(env);
  const log = deps.log ?? ((l: string) => console.log(`gate-relay: ${l}`));
  const pool = createPool(dbUrl, 4);
  let supervisor: LoopSupervisor | undefined;
  try {
    const have = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('gaterelay.deploy_marker')::text AS gaterelay,
              to_regclass('gatecheck.merge')::text AS gatecheck,
              to_regclass('core.evidence_pack')::text AS core,
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
    const relay = new GateRelay({
      host,
      facts: new RecordRelayFacts(pool),
      packs,
      notaryKey,
      store: new RecordGateRelayStore(pool),
    });
    const sup = new LoopSupervisor({ log });
    supervisor = sup;
    for (const l of gateRelayLoops(relay, {
      consumeIntervalMs: intEnv(env, 'GATE_RELAY_CONSUME_INTERVAL_MS', 15_000, 100),
      healthIntervalMs: intEnv(env, 'GATE_RELAY_HEALTH_INTERVAL_MS', 30_000, 100),
      startDelayMs: 500,
      onRelease: (n) => log(`${n} release(s) deployed`),
    }))
      sup.add(l);
    const app = createGateRelayApp({
      supervisor: sup,
      pool,
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
    });
    const url = await listen(app, listenOpts);
    sup.start();
    return {
      url,
      supervisor: sup,
      close: async () => {
        await app.close();
        await sup.stop();
        await pool.end();
      },
    };
  } catch (e) {
    await supervisor?.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw e;
  }
}
