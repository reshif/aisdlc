import { CODING_SESSION_CAP } from '@aisdlc/contracts';
import {
  ServiceConfigError,
  listenConfig,
  loadServiceAuth,
  requiredEnv,
  type RunningService,
} from '@aisdlc/service-kit';
import { validOwner, type PolicyConfig } from './policy.js';
import { DockerProxy } from './proxy.js';

export type ProxyMode = 'cvw' | 'coding';

export const SANDBOX_ENTRYPOINT = ['/usr/local/bin/aisdlc-run'] as const;

const csv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/**
 * `DOCKER_PROXY_MODE` is `cvw` (narrow: network-less sandboxes only) or `coding` (adds the per-session
 * internal networks). `DOCKER_PROXY_UPSTREAM` is the daemon socket (default /var/run/docker.sock; this is
 * the only process of the stack that mounts it). `DOCKER_PROXY_IMAGES` and `DOCKER_PROXY_SCRATCH_ROOT` say
 * which image and which host directory a create may name. Listens on `DOCKER_PROXY_SOCKET` (a unix socket)
 * or on `DOCKER_PROXY_HOST`:`DOCKER_PROXY_PORT` (an internal network). `DOCKER_PROXY_OWNER` (M19, default `local`) names
 * this instance: it labels what it creates with it and lists, inspects and removes only what carries it.
 */
export function policyFromEnv(env: Record<string, string | undefined>): {
  mode: ProxyMode;
  policy: PolicyConfig;
} {
  const mode = requiredEnv(env, 'DOCKER_PROXY_MODE');
  if (mode !== 'cvw' && mode !== 'coding')
    throw new ServiceConfigError('DOCKER_PROXY_MODE must be cvw or coding');
  const images = csv(env['DOCKER_PROXY_IMAGES']);
  if (images.length === 0) throw new ServiceConfigError('DOCKER_PROXY_IMAGES is required');
  const scratchRoot = requiredEnv(env, 'DOCKER_PROXY_SCRATCH_ROOT');
  if (
    !/^\/[A-Za-z0-9_./-]+$/.test(scratchRoot) ||
    scratchRoot.includes('..') ||
    scratchRoot.endsWith('/') ||
    scratchRoot === '/'
  ) {
    throw new ServiceConfigError(
      'DOCKER_PROXY_SCRATCH_ROOT must be a plain absolute directory, not /',
    );
  }
  // M19: what this instance labels its sandboxes with, and the only ones it answers for
  const owner = env['DOCKER_PROXY_OWNER'] || 'local';
  if (!validOwner(owner)) {
    throw new ServiceConfigError('DOCKER_PROXY_OWNER must be [a-z0-9.-], 1 to 63 characters');
  }
  const num = (name: string, d: number): number => {
    const v = env[name];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 64)
      throw new ServiceConfigError(`${name} must be 1 to 64`);
    return n;
  };
  return {
    mode,
    policy: {
      images,
      entrypoint: [...SANDBOX_ENTRYPOINT],
      scratchRoot,
      allowNetworks: mode === 'coding',
      maxSandboxes: num('DOCKER_PROXY_MAX_SANDBOXES', 4),
      codingCap: num('DOCKER_PROXY_CODING_CAP', CODING_SESSION_CAP),
      archiveGet: [],
      archivePut: [],
      maxArchiveBytes: 256 * 1024 * 1024,
      owner,
    },
  };
}

/**
 * `DOCKER_PROXY_CALLERS` is `name=file:/run/secrets/tok-name,other=env:NAME`: one bearer token per calling service,
 * resolved here from references (never a literal). Required for a TCP listener.
 */
export function callersFromEnv(env: Record<string, string | undefined>) {
  const refs: Record<string, { token_ref: string }> = {};
  for (const part of csv(env['DOCKER_PROXY_CALLERS'])) {
    const i = part.indexOf('=');
    const name = part.slice(0, i);
    const ref = part.slice(i + 1);
    if (i < 1 || !/^[a-z][a-z0-9-]{0,40}$/.test(name) || !/^(file|env):/.test(ref)) {
      throw new ServiceConfigError(
        'DOCKER_PROXY_CALLERS is name=file:PATH or name=env:NAME, comma separated',
      );
    }
    refs[name] = { token_ref: ref };
  }
  if (Object.keys(refs).length === 0) return undefined;
  return loadServiceAuth(refs, { env });
}

export async function bootDockerProxy(
  env: Record<string, string | undefined>,
  log: (l: string) => void = (l) => console.log(l),
): Promise<RunningService> {
  const { mode, policy } = policyFromEnv(env);
  const socketPath = env['DOCKER_PROXY_UPSTREAM'] || '/var/run/docker.sock';
  const auth = callersFromEnv(env);
  const proxy = new DockerProxy({
    ...(auth ? { auth } : {}),
    policy,
    upstream: { socketPath },
    log: (l) => log(`docker-proxy[${mode}] ${l}`),
  });
  const sock = env['DOCKER_PROXY_SOCKET'];
  if (sock) {
    await proxy.listen({ socketPath: sock });
    return { url: `unix:${sock} (${mode})`, close: () => proxy.close() };
  }
  if (auth === undefined) {
    throw new ServiceConfigError(
      'DOCKER_PROXY_CALLERS is required: a TCP listener needs per-caller bearer tokens',
    );
  }
  const { host, port } = listenConfig(env, 'DOCKER_PROXY', 2375);
  await proxy.listen({ host, port });
  return { url: `http://${host}:${port} (${mode})`, close: () => proxy.close() };
}
