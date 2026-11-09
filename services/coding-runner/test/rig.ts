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
import { startFakeMessagesServer, type FakeMessagesServer } from '@aisdlc/gateway';
import { DockerSandboxDriver, type DriverConfig } from '@aisdlc/sandbox-driver';

// A real Docker daemon, the real allow-list proxy (in this process, on a unix socket), the real W image and real
// peers: a package mirror (the real service) and a gateway peer that is a TCP relay to a fake Messages server
// running in THIS process (the FakeProvider's `ScriptStep`s drive the model). This file is the trusted harness: it
// uses the docker CLI directly; the code under test never does.

export const ROOT = resolve(import.meta.dirname, '../../..');
export const AGENT_IMAGE = process.env['SANDBOX_AGENT_IMAGE'] ?? 'aisdlc/sandbox-agent:local';
export const BASE_IMAGE = process.env['SANDBOX_IMAGE'] ?? 'aisdlc/sandbox:local';
const NODE_IMAGE = 'node:22.23.4-bookworm-slim';

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dockerTry = (...args: string[]): string => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

export function dockerAvailable(): { ok: boolean; why: string } {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return r.status === 0
    ? { ok: true, why: '' }
    : { ok: false, why: `no Docker daemon answers (${(r.stderr || '').trim().slice(0, 120)})` };
}

/** Builds the base and W images when missing or when the runner bundle changed (the W image carries the runner's sha as a label). */
export function ensureImages(): void {
  if (dockerTry('image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}') === '') {
    docker('build', '-t', BASE_IMAGE, join(ROOT, 'platform/sandbox'));
  }
  execFileSync('node', ['../../scripts/bundle.mjs', 'runner'], {
    cwd: join(ROOT, 'services/coding-runner'),
    stdio: 'pipe',
  });
  const r = spawnSync('bash', [join(ROOT, 'platform/sandbox/build-agent.sh'), '--check'], {
    encoding: 'utf8',
  });
  if (r.status !== 0)
    execFileSync('bash', [join(ROOT, 'platform/sandbox/build-agent.sh'), '--no-bundle'], {
      stdio: 'pipe',
    });
}

export interface Rig {
  readonly scratchRoot: string;
  readonly proxy: DockerProxy;
  readonly model: FakeMessagesServer;
  readonly apiKey: string;
  readonly peers: { mirror: string; gateway: string };
  driver(over?: Partial<DriverConfig>): DockerSandboxDriver;
  leftovers(): { containers: string[]; networks: string[]; volumes: string[]; scratch: string[] };
  teardown(): Promise<void>;
}

export async function startRig(o: { apiKey: string }): Promise<Rig> {
  ensureImages();
  const made: {
    tmp?: string;
    base?: string;
    containers: string[];
    proxy?: DockerProxy;
    model?: FakeMessagesServer;
  } = { containers: [] };
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'aisdlc-coding-'));
    made.tmp = tmp;
    chmodSync(tmp, 0o755);
    const scratchRoot = join(tmp, 'scratch');
    mkdirSync(scratchRoot, { mode: 0o755 });
    const sock = join(tmp, 'proxy.sock');
    const policy: PolicyConfig = {
      images: [AGENT_IMAGE, BASE_IMAGE],
      entrypoint: ['/usr/local/bin/aisdlc-run'],
      scratchRoot,
      allowNetworks: true,
      maxSandboxes: 4,
      codingCap: 1,
      archiveGet: [],
      archivePut: [],
      maxArchiveBytes: 1024,
    };
    const proxy = new DockerProxy({
      policy,
      upstream: { socketPath: process.env['DOCKER_SOCK'] ?? '/var/run/docker.sock' },
    });
    made.proxy = proxy;
    await proxy.listen({ socketPath: sock });

    // the model: a fake Messages server in this process (the key it accepts is the Unit's), reachable from a relay container
    const model = await startFakeMessagesServer({ apiKey: o.apiKey, host: '0.0.0.0' });
    made.model = model;
    const port = new URL(model.url).port;

    const suffix = Math.random().toString(16).slice(2, 8);
    const base = `aisdlc-test-peers-${suffix}`;
    docker('network', 'create', '--internal', base);
    made.base = base;
    const mirrorDir = join(tmp, 'mirror');
    mkdirSync(mirrorDir);
    execFileSync('node', [join(ROOT, 'scripts/bundle.mjs'), `--outdir=${mirrorDir}`, 'main'], {
      cwd: join(ROOT, 'services/package-mirror'),
      stdio: 'pipe',
    });
    chmodSync(mirrorDir, 0o755);
    chmodSync(join(mirrorDir, 'main.js'), 0o644);
    const fixtures = join(tmp, 'fixtures');
    mkdirSync(fixtures);
    chmodSync(fixtures, 0o755);
    const relayJs = join(tmp, 'relay.js');
    writeFileSync(
      relayJs,
      `const net=require('net');const [h,p]=process.env.TARGET.split(':');
net.createServer(c=>{const u=net.connect(+p,h);c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());}).listen(8410,'0.0.0.0');`,
    );
    chmodSync(relayJs, 0o644);
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
    ];
    docker(
      'run',
      ...peerFlags,
      '--network',
      base,
      '--name',
      mirror,
      '--label',
      `${SANDBOX_LABEL.peer}=mirror`,
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
    docker(
      'run',
      ...peerFlags,
      '--network',
      base,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--name',
      gateway,
      '--label',
      `${SANDBOX_LABEL.peer}=gateway`,
      '-e',
      `TARGET=host.docker.internal:${port}`,
      '-v',
      `${relayJs}:/relay.js:ro`,
      NODE_IMAGE,
      'node',
      '/relay.js',
    );
    // the relay is the one peer that can reach the host (it stands for the gateway's own route to the world)
    docker('network', 'connect', 'bridge', gateway);
    for (const [name, p] of [
      [mirror, 8420],
      [gateway, 8410],
    ] as const) {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        up =
          spawnSync('docker', [
            'exec',
            name,
            'node',
            '-e',
            `require('net').connect(${p},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`,
          ]).status === 0;
        if (!up) await new Promise((r) => setTimeout(r, 250));
      }
      if (!up) throw new Error(`${name} did not start: ${dockerTry('logs', name)}`);
    }

    const volumesBefore = dockerTry('volume', 'ls', '-q').split('\n').filter(Boolean);
    return {
      scratchRoot,
      proxy,
      model,
      apiKey: o.apiKey,
      peers: { mirror, gateway },
      driver: (over = {}) =>
        new DockerSandboxDriver({
          endpoint: { socketPath: sock },
          image: AGENT_IMAGE,
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
        await model.stop();
        dockerTry('rm', '-f', mirror, gateway);
        dockerTry('network', 'rm', base);
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await made.proxy?.close().catch(() => undefined);
    await made.model?.stop().catch(() => undefined);
    if (made.containers.length > 0) dockerTry('rm', '-f', ...made.containers);
    if (made.base) dockerTry('network', 'rm', made.base);
    if (made.tmp) rmSync(made.tmp, { recursive: true, force: true });
    throw e;
  }
}
