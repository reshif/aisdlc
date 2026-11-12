import {
  ConfigReader,
  ConfigRegistry,
  onboardingImageFrom,
  registerSandboxConfig,
} from '@aisdlc/config';
import { RunnerHostId, SANDBOX_IMAGE_REF } from '@aisdlc/contracts';
import { createPool } from '@aisdlc/db';
import type { SandboxPort } from '@aisdlc/ports';
import { DockerSandboxDriver } from '@aisdlc/sandbox-driver';
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
import { createControllerApp } from './app.js';
import { ConfigCaps } from './caps.js';
import { SandboxController } from './controller.js';
import { RecordGrants } from './grants.js';
import { CoreHeartbeats, HeartbeatReporter } from './heartbeat.js';

const Callers = z.record(
  z.string(),
  z.strictObject({
    token_ref: z.string(),
    scopes: z.array(z.enum(['run', 'read', 'admin'])),
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

const dirEnv = (env: Env, name: string): string => {
  const v = requiredEnv(env, name);
  if (!/^\/[A-Za-z0-9_./-]+$/.test(v) || v.includes('..') || v === '/') {
    throw new ServiceConfigError(`${name} must be a plain absolute directory`);
  }
  return v;
};

/** `SANDBOX_CONTROLLER_PROBE_IMAGES`: the digest references this host's driver may run besides its default image. */
function probeImagesEnv(env: Env): string[] {
  const list = (env['SANDBOX_CONTROLLER_PROBE_IMAGES'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const i of list) {
    if (!SANDBOX_IMAGE_REF.test(i)) {
      throw new ServiceConfigError('SANDBOX_CONTROLLER_PROBE_IMAGES holds digest references only');
    }
  }
  return list;
}

/** The driver of this host: the `DockerSandboxDriver` in front of the coding proxy (this process holds its token). */
function driverFromEnv(env: Env): SandboxPort {
  const u = new URL(httpUrlEnv(env, 'SANDBOX_CONTROLLER_PROXY_URL'));
  return new DockerSandboxDriver({
    endpoint: {
      host: u.hostname,
      port: Number(u.port || 80),
      token: resolveSecretRef(requiredEnv(env, 'SANDBOX_CONTROLLER_PROXY_TOKEN_REF'), { env }),
    },
    image: env['SANDBOX_CONTROLLER_IMAGE'] || 'aisdlc/sandbox-agent:local',
    images: probeImagesEnv(env),
    scratch: (() => {
      const d = dirEnv(env, 'SANDBOX_CONTROLLER_SCRATCH');
      return { local: d, host: d };
    })(),
    peers: {
      mirror: requiredEnv(env, 'SANDBOX_CONTROLLER_MIRROR'),
      gateway: requiredEnv(env, 'SANDBOX_CONTROLLER_GATEWAY'),
    },
    trustedCommands: [],
  });
}

/**
 * Starts the sandbox-controller (PLAN M14.2; docs/specs/sandbox-controller-api.md) from the environment:
 *
 *   SANDBOX_CONTROLLER_DATABASE_URL   the record database as the least-privilege role `sandbox_controller`: SELECT on
 *                                     the effective-config view (the caps) and on `core.admission_grant` (the grant
 *                                     a session names), nothing else
 *   SANDBOX_CONTROLLER_CALLERS        JSON {caller: {token_ref, scopes: [run|read|admin]}}
 *   SANDBOX_CONTROLLER_HOST_ID        this runner host's name in `sandbox.caps.hosts` (default `local`)
 *   SANDBOX_CONTROLLER_PROXY_URL, SANDBOX_CONTROLLER_PROXY_TOKEN_REF   the coding Docker socket proxy and this
 *                                     process's token there (the only holder of it)
 *   SANDBOX_CONTROLLER_SCRATCH        repo copies: a plain absolute directory, the same path for the daemon
 *   SANDBOX_CONTROLLER_MIRROR, SANDBOX_CONTROLLER_GATEWAY   the peers' container names
 *   SANDBOX_CONTROLLER_IMAGE          the session image (default aisdlc/sandbox-agent:local)
 *   SANDBOX_CONTROLLER_PROBE_IMAGES   M16: digest references the driver may also run (the onboarding probe image); a
 *                                     K-exec session must ALSO name the image `onboarding.sandbox_image` approves
 *   SANDBOX_CONTROLLER_BODY_LIMIT_MB  the largest session request (default 64)
 *   SANDBOX_CONTROLLER_CAPS_RELOAD_MS how often the caps are read again (default 5000); `POST /v1/admin/reload` too
 *   SANDBOX_CONTROLLER_CORE_URL, SANDBOX_CONTROLLER_CORE_TOKEN_REF   M19: core, and this host's token there (scope
 *                                     `activity` only): every running session's heartbeat is posted to
 *                                     `POST /v1/sessions/heartbeat`. Both or neither; without them no heartbeat is sent
 *                                     (a session's model calls and dispatches are then its only activity)
 *   SANDBOX_CONTROLLER_HEARTBEAT_MS   how often each running session beats (default 30000; a session also beats at start)
 *   SANDBOX_CONTROLLER_HOST (127.0.0.1), SANDBOX_CONTROLLER_PORT (8430)
 *
 * `deps.driver` replaces the Docker driver (tests).
 */
export async function bootSandboxController(
  env: Env,
  deps: { driver?: SandboxPort } = {},
): Promise<RunningService> {
  const dbUrl = databaseUrl(env, 'SANDBOX_CONTROLLER_DATABASE_URL');
  const callers = jsonEnv(env, 'SANDBOX_CONTROLLER_CALLERS', Callers);
  const auth = loadServiceAuth(callers, { env });
  const host = RunnerHostId.safeParse(env['SANDBOX_CONTROLLER_HOST_ID'] || 'local');
  if (!host.success) {
    throw new ServiceConfigError(
      'SANDBOX_CONTROLLER_HOST_ID must be [a-z0-9-], 1 to 63 characters',
    );
  }
  const bodyLimit = intEnv(env, 'SANDBOX_CONTROLLER_BODY_LIMIT_MB', 64, 1) * 1024 * 1024;
  const reloadMs = intEnv(env, 'SANDBOX_CONTROLLER_CAPS_RELOAD_MS', 5_000, 100);
  const listenOpts = listenConfig(env, 'SANDBOX_CONTROLLER', 8430);
  const driver = deps.driver ?? driverFromEnv(env);
  const coreUrl = env['SANDBOX_CONTROLLER_CORE_URL'] ?? '';
  const coreTokenRef = env['SANDBOX_CONTROLLER_CORE_TOKEN_REF'] ?? '';
  if ((coreUrl === '') !== (coreTokenRef === '')) {
    throw new ServiceConfigError(
      'SANDBOX_CONTROLLER_CORE_URL and SANDBOX_CONTROLLER_CORE_TOKEN_REF are set together or not at all',
    );
  }
  const heartbeatSink =
    coreUrl === ''
      ? null
      : new CoreHeartbeats({
          baseUrl: httpUrlEnv(env, 'SANDBOX_CONTROLLER_CORE_URL'),
          token: resolveSecretRef(coreTokenRef, { env }),
        });
  const heartbeatMs = intEnv(env, 'SANDBOX_CONTROLLER_HEARTBEAT_MS', 30_000, 1_000);

  const pool = createPool(dbUrl, 4);
  let reader: ConfigReader | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const have = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('config.genuine_publish')::text AS config,
              to_regclass('core.admission_grant')::text AS core,
              to_regclass('core.probe_grant')::text AS probe`,
    );
    const missing = Object.entries(have.rows[0] ?? {})
      .filter(([, v]) => v == null)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `the ${missing.join(', ')} schema(s) are missing: run aisdlc-migrate on the record database first`,
      );
    }
    const onError = (e: unknown) =>
      console.error(
        `sandbox-controller: config reader: ${e instanceof Error ? e.constructor.name : 'error'}`,
      );
    reader = await ConfigReader.create({
      pool,
      registry: registerSandboxConfig(new ConfigRegistry()),
      // like the gateway's, this role may not fold the config read model: it reads what core folded
      catchUp: false,
      // the reloads below are this process's own, so a failed one is seen (and the caps fall back)
      pollIntervalMs: 0,
      onError,
    });
    await reader.start();
    const caps = new ConfigCaps(reader, host.data, onError);
    const r0 = reader;
    timer = setInterval(() => void caps.reload(), reloadMs);
    timer.unref();
    const grants = new RecordGrants(pool);
    let reporter: HeartbeatReporter | undefined;
    const controller: SandboxController = new SandboxController({
      driver,
      caps,
      grants,
      hostId: host.data,
      onStart: (s) => void reporter?.beat(s),
      // M16: the image M1 approved, from the same reader; a failed last reload reads as none (fail closed)
      probeImage: () => (caps.isStale ? null : (onboardingImageFrom(r0.current())?.image ?? null)),
    });
    if (heartbeatSink !== null) {
      reporter = new HeartbeatReporter({
        sessions: () => controller.sessions(),
        grants,
        sink: heartbeatSink,
        log: (l) => console.error(l),
      });
      reporter.start(heartbeatMs);
    }
    const app = createControllerApp({
      controller,
      auth,
      callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
      reload: () => caps.reload(),
      bodyLimit,
    });
    const url = await listen(app, listenOpts);
    const r = reader;
    const t = timer;
    return {
      url,
      close: async () => {
        clearInterval(t);
        reporter?.stop();
        await app.close();
        await r.stop();
        await pool.end();
      },
    };
  } catch (e) {
    if (timer) clearInterval(timer);
    await reader?.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw e;
  }
}
