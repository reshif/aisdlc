import { readFileSync } from 'node:fs';
import { AppKey } from '@aisdlc/codehost';
import {
  ConfigReader,
  ConfigRegistry,
  loadSettingsReleases,
  registerGateCheckConfig,
} from '@aisdlc/config';
import { createPool } from '@aisdlc/db';
import { HttpKeyCustody } from '@aisdlc/kms-local/client';
import { LoopSupervisor } from '@aisdlc/loops';
import { S3ObjectStore, type GateCheckHostPort } from '@aisdlc/ports';
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
import { createGateCheckApp } from './app.js';
import { GateChecker, type NotaryKeyPort, type PackBytesPort } from './checker.js';
import { RecordFacts } from './facts.js';
import { GitHubChecksHost } from './github.js';
import { bypassFrom, gateCheckLoops } from './loops.js';
import { CustodyNotaryKey, StaticNotaryKey, parsePublicJwk } from './notary-key.js';
import { RecordGateCheckStore } from './store.js';

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
  const pinned = env['GATE_CHECK_NOTARY_KEY_REF'];
  if (pinned) {
    if (!pinned.startsWith('file:'))
      throw new ServiceConfigError('GATE_CHECK_NOTARY_KEY_REF is a file: reference');
    try {
      return new StaticNotaryKey(
        parsePublicJwk(readFileSync(pinned.slice('file:'.length), 'utf8')),
      );
    } catch (e) {
      throw new ServiceConfigError(
        `GATE_CHECK_NOTARY_KEY_REF: ${e instanceof Error ? e.message : 'unreadable'}`,
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

function hostFromEnv(env: Env): GateCheckHostPort {
  const installation = Number(requiredEnv(env, 'GATE_CHECK_INSTALLATION_ID'));
  if (!Number.isInteger(installation) || installation < 1) {
    throw new ServiceConfigError('GATE_CHECK_INSTALLATION_ID must be a positive integer');
  }
  return new GitHubChecksHost({
    baseUrl: env['GATE_CHECK_GITHUB_API_URL'] || 'https://api.github.com',
    appId: requiredEnv(env, 'GATE_CHECK_APP_ID'),
    installationId: installation,
    appKey: AppKey.fromRef(requiredEnv(env, 'GATE_CHECK_APP_KEY_REF'), { env }),
    plainHttpHosts: env['GATE_CHECK_GITHUB_PLAIN_HTTP_HOSTS']
      ? jsonEnv(env, 'GATE_CHECK_GITHUB_PLAIN_HTTP_HOSTS', Hosts)
      : [],
    log: (l) => console.log(`gate-check: github ${l}`),
  });
}

/**
 * Starts gate-check (PLAN M14.5; ADR-0003 §1 Integration plane; docs/specs/gate-check-api.md) from the environment:
 *
 *   GATE_CHECK_DATABASE_URL          the record database as the least-privilege role `gate_check` (see the migration)
 *   GATE_CHECK_CALLERS               JSON {caller: {token_ref, scopes: [read]}} (the bff, for the portal)
 *   GATE_CHECK_APP_ID, GATE_CHECK_INSTALLATION_ID, GATE_CHECK_APP_KEY_REF (file:)   gate-check's OWN GitHub App: its
 *                                    key is in no other container, and the codehost's key is not here
 *   GATE_CHECK_GITHUB_API_URL        default https://api.github.com; plain http only to loopback or a host in
 *   GATE_CHECK_GITHUB_PLAIN_HTTP_HOSTS (JSON list; the compose stack's fake GitHub)
 *   GATE_CHECK_PUSH_BROKER_LOGIN     the Push Broker App's bot login (`<slug>[bot]`): who authors agent PRs
 *   GATE_CHECK_OBJECT_STORE_URL, GATE_CHECK_OBJECT_STORE_ACCESS_KEY_REF, GATE_CHECK_OBJECT_STORE_SECRET_KEY_REF
 *                                    the signed Evidence Packs (read only)
 *   GATE_CHECK_NOTARY_KEY_REF        file: a pinned public JWK of the Notary; else KMS_URL and KMS_TOKEN_REF (a
 *                                    public-key read of `dev:notary`)
 *   GATE_CHECK_VERDICT_INTERVAL_MS (15000), GATE_CHECK_MERGE_INTERVAL_MS (60000), GATE_CHECK_CONFIG_RELOAD_MS (5000)
 *   GATE_CHECK_HOST (127.0.0.1), GATE_CHECK_PORT (8450)
 *
 * `deps` replaces the ports (tests).
 */
export async function bootGateCheck(
  env: Env,
  deps: {
    host?: GateCheckHostPort;
    packs?: PackBytesPort;
    notaryKey?: NotaryKeyPort;
    log?: (line: string) => void;
  } = {},
): Promise<RunningService & { supervisor: LoopSupervisor }> {
  const dbUrl = databaseUrl(env, 'GATE_CHECK_DATABASE_URL');
  const callers = jsonEnv(env, 'GATE_CHECK_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const listenOpts = listenConfig(env, 'GATE_CHECK', 8450);
  const brokerLogin = requiredEnv(env, 'GATE_CHECK_PUSH_BROKER_LOGIN');
  if (!/^[A-Za-z0-9-]+\[bot\]$/.test(brokerLogin)) {
    throw new ServiceConfigError('GATE_CHECK_PUSH_BROKER_LOGIN is an App bot login, `<slug>[bot]`');
  }
  const host = deps.host ?? hostFromEnv(env);
  const packs =
    deps.packs ??
    new S3ObjectStore({
      endpoint: httpUrlEnv(env, 'GATE_CHECK_OBJECT_STORE_URL'),
      accessKeyRef: requiredEnv(env, 'GATE_CHECK_OBJECT_STORE_ACCESS_KEY_REF'),
      secretKeyRef: requiredEnv(env, 'GATE_CHECK_OBJECT_STORE_SECRET_KEY_REF'),
    });
  const notaryKey = deps.notaryKey ?? notaryKeyFromEnv(env);
  const log = deps.log ?? ((l: string) => console.log(`gate-check: ${l}`));
  const pool = createPool(dbUrl, 4);
  let reader: ConfigReader | undefined;
  let supervisor: LoopSupervisor | undefined;
  try {
    const have = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('gatecheck.verdict')::text AS gatecheck,
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
    reader = await ConfigReader.create({
      pool,
      registry: registerGateCheckConfig(new ConfigRegistry()),
      // this role may not fold the config read model: it reads what core folded
      catchUp: false,
      pollIntervalMs: intEnv(env, 'GATE_CHECK_CONFIG_RELOAD_MS', 5_000, 100),
      onError: (e) => log(`config reader: ${e instanceof Error ? e.constructor.name : 'error'}`),
    });
    await reader.start();
    const facts = new RecordFacts(pool);
    const checker = new GateChecker({
      host,
      facts,
      packs,
      notaryKey,
      brokerLogin,
      bypass: bypassFrom(reader),
      loadCatalogueReleases: async () => {
        await loadSettingsReleases(pool);
      },
      store: new RecordGateCheckStore(pool),
    });
    const sup = new LoopSupervisor({ log });
    supervisor = sup;
    for (const l of gateCheckLoops(checker, facts, {
      verdictIntervalMs: intEnv(env, 'GATE_CHECK_VERDICT_INTERVAL_MS', 15_000, 100),
      mergeIntervalMs: intEnv(env, 'GATE_CHECK_MERGE_INTERVAL_MS', 60_000, 100),
      startDelayMs: 500,
      onWrite: (repo, n) => log(`${repo}: ${n} check run(s) written`),
    }))
      sup.add(l);
    const app = createGateCheckApp({
      supervisor: sup,
      pool,
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
      ...(host instanceof GitHubChecksHost ? { appReport: () => host.report() } : {}),
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
