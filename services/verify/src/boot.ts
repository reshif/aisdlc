import { readPrompt } from '@aisdlc/agents/files';
import { GitBundleFiles } from '@aisdlc/build';
import { createPool } from '@aisdlc/db';
import { err, ok } from '@aisdlc/kernel';
import { HttpBundleSource, HttpSandbox, type SandboxPort } from '@aisdlc/ports';
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
import {
  GatewayReviewer,
  NoHoldouts,
  VerifyRunner,
  type HoldoutPort,
  type RepoFilesPort,
  type ReviewerPort,
} from '@aisdlc/verify';
import { z } from 'zod';
import { createVerifyApp } from './app.js';
import { VerifyService } from './service.js';

const Callers = z.record(
  z.string(),
  z.strictObject({ token_ref: z.string(), scopes: z.array(z.enum(['run', 'read'])) }),
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

/** The repo at a commit from the code host's bundle route (this service's token there has the scope `census`). */
export function bundleFiles(o: { baseUrl: string; token: string }): RepoFilesPort {
  const g = new GitBundleFiles(new HttpBundleSource(o));
  return {
    files: async (repo, sha) => {
      const r = await g.files(repo, sha);
      if (r.ok) return ok(r.value);
      return err({
        code: r.error.code === 'unavailable' ? 'unavailable' : 'not_found',
        message: r.error.message,
      });
    },
  };
}

/**
 * Starts the verify service (the plan's `cvw`; PLAN M14.3, ADR-0003 §1 Control plane; docs/specs/verify-api.md):
 *
 *   VERIFY_DATABASE_URL     the record database as the least-privilege role `verify`: its own table and its own
 *                           `verify:` record streams, nothing else
 *   VERIFY_CALLERS          JSON {caller: {token_ref, scopes: [run|read]}}
 *   VERIFY_SANDBOX_CONTROLLER_URL, VERIFY_SANDBOX_CONTROLLER_TOKEN_REF   the sandbox-controller (scope `run`): every kit
 *                           session goes there, naming the item's admission grant
 *   VERIFY_CODEHOST_URL, VERIFY_CODEHOST_TOKEN_REF   the code host's bundle route (scope `census`): the repo at the
 *                           base commit and at the Unit head
 *   VERIFY_GATEWAY_URL      the model gateway's `/v1/messages` (7.3 and 7.5's reviewer, under the run's own key; this
 *                           service holds no key of its own)
 *   VERIFY_TEST_TIME_S      seconds per test session (default: the O class ceiling)
 *   VERIFY_BODY_LIMIT_MB    the largest request (default 4)
 *   VERIFY_HOST (127.0.0.1), VERIFY_PORT (8440)
 *
 * `deps` replaces the ports (tests). Holdouts: none bound until a holdout store exists (`NoHoldouts`).
 */
export async function bootVerify(
  env: Env,
  deps: {
    sandbox?: SandboxPort;
    files?: RepoFilesPort;
    reviewer?: ReviewerPort;
    holdouts?: HoldoutPort;
  } = {},
): Promise<RunningService> {
  const dbUrl = databaseUrl(env, 'VERIFY_DATABASE_URL');
  const callers = jsonEnv(env, 'VERIFY_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const listenOpts = listenConfig(env, 'VERIFY', 8440);
  const bodyLimit = intEnv(env, 'VERIFY_BODY_LIMIT_MB', 4, 1) * 1024 * 1024;
  const testTime = env['VERIFY_TEST_TIME_S'];
  const sandbox =
    deps.sandbox ??
    new HttpSandbox({
      baseUrl: httpUrlEnv(env, 'VERIFY_SANDBOX_CONTROLLER_URL'),
      token: resolveSecretRef(requiredEnv(env, 'VERIFY_SANDBOX_CONTROLLER_TOKEN_REF'), { env }),
    });
  const files =
    deps.files ??
    bundleFiles({
      baseUrl: httpUrlEnv(env, 'VERIFY_CODEHOST_URL'),
      token: resolveSecretRef(requiredEnv(env, 'VERIFY_CODEHOST_TOKEN_REF'), { env }),
    });
  const reviewer =
    deps.reviewer ?? new GatewayReviewer({ baseUrl: httpUrlEnv(env, 'VERIFY_GATEWAY_URL') });
  const runner = new VerifyRunner({
    sandbox,
    files,
    reviewer,
    holdouts: deps.holdouts ?? new NoHoldouts(),
    prompt: readPrompt,
    ...(testTime ? { testTimeS: intEnv(env, 'VERIFY_TEST_TIME_S', 900, 1) } : {}),
  });
  const pool = createPool(dbUrl, 4);
  try {
    const have = await pool.query<{ t: string | null }>(
      `SELECT to_regclass('verify.check_result')::text AS t`,
    );
    if (have.rows[0]?.t == null) {
      throw new Error(
        'the verify schema is missing: run aisdlc-migrate on the record database first',
      );
    }
    const app = createVerifyApp({
      service: new VerifyService({ pool, runner }),
      pool,
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
      bodyLimit,
      log: (l) => console.error(`verify: ${l}`),
    });
    const url = await listen(app, listenOpts);
    return {
      url,
      close: async () => {
        await app.close();
        await pool.end();
      },
    };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}
