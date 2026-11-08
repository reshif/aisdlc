import { createPool } from '@aisdlc/db';
import { httpKeyCustodyFromEnv } from '@aisdlc/kms-local/client';
import { listen, listenConfig, type Env, type RunningService } from '@aisdlc/service-kit';
import { createKnowledgeApp } from './app.js';
import { knowledgeConfigFromEnv } from './config.js';
import { kmsFingerprinter } from './fingerprint.js';
import { HttpBundleSource } from './http-bundle.js';
import { migrateKnowledge } from './migrations.js';
import { HttpPrincipalDirectory } from './principals.js';
import { JobRunner } from './runner.js';

/**
 * Starts knowledge from the environment (see `knowledgeConfigFromEnv`). It refuses to start with a
 * code-host credential or an HMAC key in its environment (DEC-5 condition 1), without the record
 * schema, and makes no network call to the codehost, kms-local or identity until a job or a state
 * change needs one. Jobs a previous process left unfinished are marked `error` and their workspaces
 * removed.
 */
export async function bootKnowledge(env: Env): Promise<RunningService> {
  const cfg = knowledgeConfigFromEnv(env);
  const listenOpts = listenConfig(env, 'KNOWLEDGE', 8370);
  // Reads KMS_URL and KMS_TOKEN_REF: a client of kms-local, never the key.
  const custody = httpKeyCustodyFromEnv(env);
  const pool = createPool(cfg.databaseUrl, 8);
  try {
    const have = await pool.query<{ record: string | null }>(
      `SELECT to_regclass('record.record_event')::text AS record`,
    );
    if (have.rows[0]?.record == null) {
      throw new Error('the record schema is missing: migrate the record database first');
    }
    await migrateKnowledge(pool);
    const runner = new JobRunner({
      pool,
      source: new HttpBundleSource({ baseUrl: cfg.codehostUrl, token: cfg.codehostToken }),
      fingerprinter: kmsFingerprinter(custody),
      ...(cfg.workDir ? { workRoot: cfg.workDir } : {}),
      ...(cfg.gitBin ? { gitBin: cfg.gitBin } : {}),
      bundleCapBytes: cfg.bundleCapBytes,
      maxFileBytes: cfg.maxFileBytes,
      commitCap: cfg.commitCap,
      jobTimeoutMs: cfg.jobTimeoutMs,
      maxConcurrent: cfg.maxConcurrentJobs,
      ...(cfg.urlAllowList ? { urlAllowList: cfg.urlAllowList } : {}),
      log: (line) => console.log(line),
    });
    const recovered = await runner.recover();
    if (recovered > 0)
      console.log(`knowledge: ${recovered} unfinished job(s) from a previous run marked error`);
    const app = createKnowledgeApp({
      pool,
      auth: cfg.auth,
      callers: cfg.callers,
      runner,
      principals: new HttpPrincipalDirectory({
        baseUrl: cfg.identityUrl,
        token: cfg.identityToken,
      }),
    });
    const url = await listen(app, listenOpts);
    return {
      url,
      close: async () => {
        await app.close();
        await runner.idle();
        await pool.end();
      },
    };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}
