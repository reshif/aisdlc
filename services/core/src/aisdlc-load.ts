import { ConfigRegistry, registerGatewayConfig } from '@aisdlc/config';
import { PrincipalId } from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import { systemClock } from '@aisdlc/kernel';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { HttpNotary } from '@aisdlc/notary/client';
import { registerPdpConfig } from '@aisdlc/pdp';
import {
  databaseUrl,
  httpUrlEnv,
  requiredEnv,
  resolveSecretRef,
  type Env,
} from '@aisdlc/service-kit';
import { BffSession, CoreCaller, itemWithGrant, runLoad } from './load/run.js';
import { boundProjects, seedLoad } from './load/seed.js';
import { registerCoreConfig } from './settings.js';

// aisdlc-load (PLAN M19): the load test's two steps on a running local-prod stack (platform/compose/load.sh runs them
// as the one-shot `load` service; FACTORY_ENV=local only, it refuses anything else).
//
//   aisdlc-load seed   N projects with an active PRR and published settings, the factory's coding cap; waits until
//                      identity has bound every role map (core-worker's role-map sync)
//   aisdlc-load run    the items, the people, the reads; prints one line `LOAD_REPORT {json}` on stdout
//   aisdlc-load item   the runner-killed drill's item: its Unit holds an active admission grant (it waits at G4);
//                      prints `LOAD_ITEM {item_id, grant}`
//
//   LOAD_DATABASE_URL                  the record database (a `file:` reference), as core's role
//   LOAD_NOTARY_URL, LOAD_NOTARY_TOKEN_REF, KMS_URL, KMS_TOKEN_REF   seed: the decisions are signed by the Notary
//   LOAD_CORE_URL, LOAD_CORE_TOKEN_REF run: core's API with the bff's token (the person in `on_behalf_of`)
//   LOAD_BFF_URL, LOAD_BFF_PUBLIC_URL, LOAD_OIDC_URL, LOAD_OIDC_PUBLIC_URL   run: the portal session (optional)
//   LOAD_PROJECTS (4), LOAD_ITEMS (30 per project), LOAD_CODING_CAP (4), LOAD_CONCURRENCY (8),
//   LOAD_DEADLINE_S (2400), LOAD_SAMPLE_MS (2000), LOAD_BURST (5), LOAD_REQUESTER (alice), LOAD_APPROVER (bob),
//   LOAD_REQUESTER_SUBJECT (the requester's dev IdP subject, for the portal session)

/** The dev IdP's subject of the requester (platform/compose/config/idp-seed.json: principal `alice`). */
const ALICE_SUBJECT = '00000000-0000-4000-8000-000000000001';

const int = (env: Env, name: string, d: number, min: number, max: number): number => {
  const v = env[name];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be ${min} to ${max}`);
  return n;
};

async function main(env: Env): Promise<number> {
  if (env['FACTORY_ENV'] !== 'local') {
    console.error('aisdlc-load: FACTORY_ENV=local only (it writes PRRs no onboarding decided)');
    return 2;
  }
  const cmd = process.argv[2];
  const n = int(env, 'LOAD_PROJECTS', 4, 1, 20);
  const projects = Array.from({ length: n }, (_, i) => `load-${i + 1}`);
  const people = {
    requester: PrincipalId.parse(env['LOAD_REQUESTER'] || 'alice'),
    approver: PrincipalId.parse(env['LOAD_APPROVER'] || 'bob'),
  };
  const log = (l: string) => console.error(l);
  const pool = createPool(databaseUrl(env, 'LOAD_DATABASE_URL'), 6);
  try {
    if (cmd === 'seed') {
      const key = await httpKeyCustodyFromEnv(env).publicKey('dev:notary');
      if (!key.ok) throw new Error(`notary public key: ${key.error.message}`);
      const registry = registerGatewayConfig(
        registerCoreConfig(registerPdpConfig(new ConfigRegistry())),
      );
      const made = await seedLoad(
        {
          pool,
          clock: systemClock,
          config: {
            pool,
            registry,
            ledger: {
              notary: new HttpNotary({
                baseUrl: httpUrlEnv(env, 'LOAD_NOTARY_URL'),
                token: resolveSecretRef(requiredEnv(env, 'LOAD_NOTARY_TOKEN_REF'), { env }),
              }),
              notaryKey: key.value,
            },
          },
          log,
        },
        { projects, people, codingCap: int(env, 'LOAD_CODING_CAP', 4, 1, 8) },
      );
      log(`aisdlc-load seed: ${made.length} project(s) made, ${n - made.length} already there`);
      const until = Date.now() + 180_000;
      for (;;) {
        const bound = await boundProjects(pool, projects);
        if (bound.length === projects.length) break;
        if (Date.now() > until) {
          throw new Error(
            `identity bound ${bound.length} of ${projects.length} role maps in 180 s`,
          );
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      log('aisdlc-load seed: identity has bound every role map');
      return 0;
    }
    if (cmd === 'item') {
      // the runner-killed drill: one item whose Unit holds an active grant (it waits at G4)
      const core = new CoreCaller(
        httpUrlEnv(env, 'LOAD_CORE_URL'),
        resolveSecretRef(requiredEnv(env, 'LOAD_CORE_TOKEN_REF'), { env }),
      );
      const got = await itemWithGrant(
        { pool, core, bff: null },
        { project: projects[0] as string, people, deadlineMs: 300_000, log },
      );
      console.log(`LOAD_ITEM ${JSON.stringify(got)}`);
      return 0;
    }
    if (cmd === 'run') {
      const core = new CoreCaller(
        httpUrlEnv(env, 'LOAD_CORE_URL'),
        resolveSecretRef(requiredEnv(env, 'LOAD_CORE_TOKEN_REF'), { env }),
      );
      let bff: BffSession | null = null;
      if (env['LOAD_BFF_URL']) {
        const map: Array<[string, string]> = [
          [env['LOAD_BFF_PUBLIC_URL'] ?? '', env['LOAD_BFF_URL']],
          [env['LOAD_OIDC_PUBLIC_URL'] ?? '', env['LOAD_OIDC_URL'] ?? ''],
        ].filter(([a, b]) => a !== '' && b !== '') as Array<[string, string]>;
        const rewrite = (u: string) => {
          for (const [from, to] of map) if (u.startsWith(from)) return to + u.slice(from.length);
          return u;
        };
        bff = new BffSession(env['LOAD_BFF_URL'], rewrite);
        await bff.signIn(env['LOAD_REQUESTER_SUBJECT'] || ALICE_SUBJECT);
        log('aisdlc-load run: signed in at the bff');
      }
      const report = await runLoad(
        { pool, core, bff },
        {
          projects,
          itemsPerProject: int(env, 'LOAD_ITEMS', 30, 1, 200),
          people,
          concurrency: int(env, 'LOAD_CONCURRENCY', 8, 1, 64),
          deadlineMs: int(env, 'LOAD_DEADLINE_S', 2400, 60, 86_400) * 1000,
          sampleMs: int(env, 'LOAD_SAMPLE_MS', 2000, 100, 60_000),
          burst: int(env, 'LOAD_BURST', 5, 1, 1000),
          log,
        },
      );
      console.log(`LOAD_REPORT ${JSON.stringify({ projects, ...report })}`);
      return 0;
    }
    console.error('usage: aisdlc-load seed | run | item');
    return 2;
  } catch (e) {
    console.error(`aisdlc-load: failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

process.exit(await main(process.env));
