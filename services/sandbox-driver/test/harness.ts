import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SANDBOX_LABEL } from '@aisdlc/contracts';
import { DockerProxy, type PolicyConfig } from '@aisdlc/docker-proxy';
import { DockerSandboxDriver, type DriverConfig } from '../src/index.js';

// A real Docker daemon, the real proxy (in this process, on a unix socket), the real image and real peers.
// This file is the TEST HARNESS: it is trusted and uses the docker CLI directly (to build the image, start the
// peers and count leftovers). The code under test (the driver) never does: it only speaks to the proxy.

export const IMAGE = 'aisdlc/sandbox:local';
const ROOT = resolve(import.meta.dirname, '../../..');
export const NODE_IMAGE = 'node:22.23.4-bookworm-slim';

export const docker = (...args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dockerTry = (...args: string[]): string => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

/** Docker is usable here (a daemon answers). Tests skip with a clear message only when it is not. */
export function dockerAvailable(): { ok: boolean; why: string } {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (r.status !== 0)
    return {
      ok: false,
      why: `no Docker daemon answers (${(r.stderr || r.error?.message || '').trim().slice(0, 120)})`,
    };
  return { ok: true, why: '' };
}

export function ensureImage(): void {
  if (dockerTry('image', 'inspect', IMAGE, '--format', '{{.Id}}') === '') {
    docker('build', '-t', IMAGE, join(ROOT, 'platform/sandbox'));
  }
}

export interface Peers {
  readonly mirror: string;
  readonly gateway: string;
  /** A canary seeded in each peer's own environment: factory-only, must never come out of a sandbox. */
  readonly canaries: string[];
}

export interface Rig {
  readonly scratchRoot: string;
  readonly proxy: DockerProxy;
  readonly proxySock: string;
  readonly peers: Peers;
  driver(over?: Partial<DriverConfig>): DockerSandboxDriver;
  policy: PolicyConfig;
  teardown(): Promise<void>;
  /** Containers, networks and volumes carrying the sandbox label, and scratch directories left: all must be empty after a run. */
  leftovers(): { containers: string[]; networks: string[]; volumes: string[]; scratch: string[] };
  volumesBefore: string[];
}

type Made = { tmp?: string; base?: string; containers: string[]; proxy?: DockerProxy };

export interface RigOptions {
  canaries: string[];
  gatewayKey: string;
  policy?: Partial<PolicyConfig>;
  /** Writes the package mirror's fixture set (M16: the probe test's wheel and its PEP 503 page). */
  fixtures?: (dir: string) => void;
}

export async function startRig(opts: RigOptions): Promise<Rig> {
  const made: Made = { containers: [] };
  try {
    return await startRigInner(opts, made);
  } catch (e) {
    // a rig that did not come up leaves nothing behind
    await made.proxy?.close().catch(() => undefined);
    if (made.containers.length > 0) dockerTry('rm', '-f', ...made.containers);
    if (made.base) dockerTry('network', 'rm', made.base);
    if (made.tmp) rmSync(made.tmp, { recursive: true, force: true });
    throw e;
  }
}

async function startRigInner(opts: RigOptions, made: Made): Promise<Rig> {
  ensureImage();
  const tmp = mkdtempSync(join(tmpdir(), 'aisdlc-sbx-'));
  made.tmp = tmp;
  chmodSync(tmp, 0o755);
  const scratchRoot = join(tmp, 'scratch');
  mkdirSync(scratchRoot, { mode: 0o755 });
  const proxySock = join(tmp, 'proxy.sock');
  const policy: PolicyConfig = {
    images: [IMAGE],
    entrypoint: ['/usr/local/bin/aisdlc-run'],
    scratchRoot,
    allowNetworks: true,
    maxSandboxes: 4,
    codingCap: 1,
    archiveGet: [],
    archivePut: [],
    maxArchiveBytes: 1024,
    ...opts.policy,
  };
  const proxy = new DockerProxy({
    policy,
    upstream: { socketPath: process.env['DOCKER_SOCK'] ?? '/var/run/docker.sock' },
  });
  made.proxy = proxy;
  await proxy.listen({ socketPath: proxySock });

  // peers: a mirror (the real service, bundled) and a stub gateway, each on a private internal base network, labelled as peers
  const suffix = Math.random().toString(16).slice(2, 8);
  const base = `aisdlc-test-peers-${suffix}`;
  docker('network', 'create', '--internal', base);
  made.base = base;
  const mirrorDir = join(tmp, 'mirror');
  mkdirSync(mirrorDir);
  // the repo's own bundler: the same single-file bundle the compose image ships
  execFileSync('node', [join(ROOT, 'scripts/bundle.mjs'), `--outdir=${mirrorDir}`, 'main'], {
    cwd: join(ROOT, 'services/package-mirror'),
    stdio: 'pipe',
  });
  chmodSync(mirrorDir, 0o755);
  chmodSync(join(mirrorDir, 'main.js'), 0o644);
  const fixtures = join(tmp, 'fixtures');
  mkdirSync(fixtures);
  opts.fixtures?.(fixtures);
  chmodSync(fixtures, 0o755);
  const mirror = `aisdlc-test-mirror-${suffix}`;
  const gateway = `aisdlc-test-gateway-${suffix}`;
  made.containers.push(mirror, gateway);
  const peerFlags = [
    '-d',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '128m',
    '--network',
    base,
  ];
  docker(
    'run',
    ...peerFlags,
    '--name',
    mirror,
    '--label',
    `${SANDBOX_LABEL.peer}=mirror`,
    '-e',
    `FACTORY_CANARY_NOTE=${opts.canaries[0] ?? 'none'}`,
    '-e',
    'PACKAGE_MIRROR_ROOT=/fixtures',
    '-e',
    'PACKAGE_MIRROR_HOST=0.0.0.0',
    '-v',
    `${mirrorDir}:/app:ro`,
    '-v',
    `${fixtures}:/fixtures:ro`,
    NODE_IMAGE,
    'node',
    '/app/main.js',
  );
  const gwScript = `
    const http=require('http');
    http.createServer((req,res)=>{
      if(req.headers['x-api-key']!==process.env.GW_EXPECTED){res.writeHead(401,{'Content-Type':'application/json'});return res.end('{"error":"no key"}');}
      res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
    }).listen(8410,'0.0.0.0');`;
  docker(
    'run',
    ...peerFlags,
    '--name',
    gateway,
    '--label',
    `${SANDBOX_LABEL.peer}=gateway`,
    '-e',
    `GW_EXPECTED=${opts.gatewayKey}`,
    '-e',
    `FACTORY_VENDOR_NOTE=${opts.canaries[1] ?? 'none'}`,
    NODE_IMAGE,
    'node',
    '-e',
    gwScript,
  );
  // wait for both to listen
  for (const [name, port] of [
    [mirror, 8420],
    [gateway, 8410],
  ] as const) {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up =
        dockerTry(
          'exec',
          name,
          'node',
          '-e',
          `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`,
        ) !== '' ||
        spawnSync('docker', [
          'exec',
          name,
          'node',
          '-e',
          `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`,
        ]).status === 0;
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) throw new Error(`${name} did not start: ${dockerTry('logs', name)}`);
  }

  const volumesBefore = dockerTry('volume', 'ls', '-q').split('\n').filter(Boolean);
  const rig: Rig = {
    scratchRoot,
    proxy,
    proxySock,
    peers: { mirror, gateway, canaries: opts.canaries },
    policy,
    volumesBefore,
    driver: (over = {}) =>
      new DockerSandboxDriver({
        endpoint: { socketPath: proxySock },
        image: IMAGE,
        scratch: { local: scratchRoot, host: scratchRoot },
        peers: { mirror, gateway },
        trustedCommands: [],
        ...over,
      }),
    leftovers: () => ({
      containers: dockerTry('ps', '-aq', '--filter', `label=${SANDBOX_LABEL.sandbox}=1`)
        .split('\n')
        .filter(Boolean),
      networks: dockerTry('network', 'ls', '-q', '--filter', `label=${SANDBOX_LABEL.sandbox}=1`)
        .split('\n')
        .filter(Boolean),
      volumes: dockerTry('volume', 'ls', '-q')
        .split('\n')
        .filter((v) => v && !volumesBefore.includes(v)),
      scratch: existsSync(scratchRoot) ? readdirSync(scratchRoot) : [],
    }),
    teardown: async () => {
      await proxy.close();
      dockerTry('rm', '-f', mirror, gateway);
      dockerTry('network', 'rm', base);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  return rig;
}

export const hostPidCount = (): number =>
  readdirSync('/proc').filter((n) => /^[0-9]+$/.test(n)).length;
export { writeFileSync };
