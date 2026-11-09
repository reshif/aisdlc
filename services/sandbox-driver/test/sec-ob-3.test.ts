import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { SANDBOX_PROFILES, type SandboxClass } from '@aisdlc/contracts';
import type { SandboxRun } from '@aisdlc/ports';
import { RULES_VERSION, makeCanary } from '@aisdlc/secrets-rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable, hostPidCount, startRig, type Rig } from './harness.js';
import { hostileRepo } from './hostile-repo.js';

// SEC-OB-3 (onboarding-roadmap §10.1): a seeded hostile repo trying DNS, HTTP, the metadata IP, env reads and
// out-of-tree writes is contained, and the canaries fire. This is the evidence for DEC-18(b) (whether the
// container-class sandbox may run a repository's code). The repository is SYNTHETIC: built in this test, run in
// a real container through the real driver and the real allow-list proxy against the local Docker daemon. No
// real repository's code is ever run. Any escape is a test failure. The result is written to a scratch directory;
// `npm run evidence:sec-ob-3` points it at docs/evidence/sec-ob-3.{json,md}.

const docker = dockerAvailable();
if (!docker.ok) console.warn(`SEC-OB-3 hostile probe SKIPPED: ${docker.why}`);

// Tests never rewrite the committed evidence: the report goes to a scratch directory unless
// `SEC_OB_3_EVIDENCE_DIR` says otherwise. `npm run evidence:sec-ob-3` regenerates docs/evidence on demand.
const EVIDENCE_IS_SCRATCH = !process.env['SEC_OB_3_EVIDENCE_DIR'];
const EVIDENCE =
  process.env['SEC_OB_3_EVIDENCE_DIR'] !== undefined && process.env['SEC_OB_3_EVIDENCE_DIR'] !== ''
    ? resolve(process.env['SEC_OB_3_EVIDENCE_DIR'])
    : mkdtempSync(join(tmpdir(), 'sec-ob-3-evidence-'));

interface Row {
  id: string;
  session: string;
  class: SandboxClass;
  attempt: string;
  expected: string;
  observed: string;
  contained: boolean;
}
const rows: Row[] = [];
const outputs: string[] = []; // everything that came out of any sandbox, for the canary sweep
let rig: Rig;
let listener: net.Server;
let hostHits = 0;
let hostAddr = '';
const CANARIES = [
  makeCanary('sec-ob-3:peer-a'),
  makeCanary('sec-ob-3:peer-b'),
  makeCanary('sec-ob-3:host-env'),
  makeCanary('sec-ob-3:host-file'),
];
const HOST_SECRET_ENV = 'SEC_OB_3_HOST_ONLY_NOTE';

const text = (r: SandboxRun) =>
  `${r.stdout}\n${r.stderr}\n${r.out.map((o) => Buffer.from(o.content).toString('latin1')).join('\n')}`;

async function runSession(
  cls: SandboxClass,
  id: string,
  command: string[],
  over: { limits?: Record<string, number>; env?: Record<string, string> } = {},
): Promise<SandboxRun> {
  const d = rig.driver({ trustedCommands: ['node'] });
  const r = await d.run({
    session_id: id,
    class: cls,
    command,
    repo: hostileRepo(),
    env: { HOST_PROBE_ADDR: hostAddr, HOST_SCRATCH: rig.scratchRoot, ...(over.env ?? {}) },
    ...(over.limits ? { limits: over.limits } : {}),
  });
  if (!r.ok) throw new Error(`${id}: ${r.error.code}: ${r.error.message}`);
  outputs.push(text(r.value));
  expect(r.value.cleanup_errors, `${id} left something behind`).toEqual([]);
  return r.value;
}

function parseReport(r: SandboxRun): Array<{
  id: string;
  escaped: boolean;
  observed: string;
  reached?: boolean;
  wrote?: boolean;
  nics?: string[];
}> {
  const f = r.out.find((o) => o.path === 'report.json');
  if (!f)
    throw new Error(
      `no /out/report.json (status ${r.status}, exit ${String(r.exit_code)}, ${r.detail ?? ''}): ${r.stderr.slice(0, 300)}`,
    );
  return (JSON.parse(Buffer.from(f.content).toString('utf8')) as { attempts: never[] }).attempts;
}

const DESC: Record<string, { attempt: string; blocked: string }> = {
  dns_external_name: {
    attempt: 'DNS lookup of an external name (example.com)',
    blocked: 'lookup fails: no resolver and no route',
  },
  dns_direct_resolver: {
    attempt: 'DNS query straight to 8.8.8.8',
    blocked: 'no answer: no route out',
  },
  http_external_host: { attempt: 'HTTP GET to an external host by name', blocked: 'no connection' },
  http_external_ip: { attempt: 'HTTP GET to an external IP (1.1.1.1)', blocked: 'no connection' },
  http_gateway_without_key: {
    attempt: 'HTTP to the model gateway without a key',
    blocked: 'gateway is not a peer: name does not resolve',
  },
  cloud_metadata_ip: {
    attempt: 'HTTP to the cloud metadata IP 169.254.169.254',
    blocked: 'no connection',
  },
  host_listener: {
    attempt: 'TCP to a listener on the Docker host (docker0 address)',
    blocked: 'no connection; the host listener sees 0 hits',
  },
  default_route: {
    attempt: 'look for a default route out of the network',
    blocked: 'no default route',
  },
  internal_service_names: {
    attempt: 'resolve other factory service names (docker-proxy, postgres, kms-local, core, ...)',
    blocked: 'none resolve',
  },
  mirror_write: {
    attempt: 'PUT a file to the package mirror',
    blocked: 'mirror is read-only (405) or unreachable',
  },
  mirror_other_ports: {
    attempt: 'connect to other ports of the mirror peer (22, 2375, 5432, 8300, 8410)',
    blocked: 'all closed',
  },
  env_read: {
    attempt: 'read the process environment for credentials and canaries',
    blocked: 'no credential-shaped name, no canary',
  },
  proc_1_environ: {
    attempt: 'read /proc/1/environ',
    blocked: 'only the session own env: no credential, no canary',
  },
  proc_all_environ: {
    attempt: 'read /proc/*/environ of every visible process',
    blocked: 'own pid namespace only: no credential, no canary',
  },
  fs_walk_for_canaries: {
    attempt: 'walk the whole readable filesystem for factory canaries',
    blocked: 'no canary on any readable file',
  },
  write_outside_tree: {
    attempt:
      'write outside the repo tree and /out (/repo, /etc, /usr, /bin, /, /var/run, /proc, /sys, the host scratch path)',
    blocked: 'every target refused (read-only root and mount)',
  },
  docker_socket: {
    attempt: 'find or connect to a Docker socket (5 paths, 3 directories)',
    blocked: 'no socket path exists',
  },
  privileges: {
    attempt: 'privileges: uid, capabilities, mount, chown, no-new-privs, seccomp',
    blocked: 'non-root, no capabilities, mount and chown refused, no-new-privs, seccomp on',
  },
};

async function pidDeltaSettled(before: number): Promise<number> {
  let now = hostPidCount();
  for (let i = 0; i < 20 && now > before + 15; i++) {
    await new Promise((r) => setTimeout(r, 500));
    now = hostPidCount();
  }
  return now - before;
}

describe.skipIf(!docker.ok)('SEC-OB-3: the synthetic hostile repo is contained', () => {
  beforeAll(async () => {
    process.env[HOST_SECRET_ENV] = CANARIES[2] as string; // a factory secret in THIS process: must never reach a sandbox
    rig = await startRig({
      canaries: [CANARIES[0] as string, CANARIES[1] as string],
      gatewayKey: 'vk_sec_ob_3_0123456789',
    });
    listener = net.createServer((s) => {
      hostHits += 1;
      s.destroy();
    });
    await new Promise<void>((r) => listener.listen(0, '0.0.0.0', r));
    const gw = execFileSync(
      'docker',
      ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'],
      { encoding: 'utf8' },
    ).trim();
    hostAddr = `${gw}:${(listener.address() as net.AddressInfo).port}`;
    // a factory secret in a file on the host, next to the scratch root
    writeFileSync(join(rig.scratchRoot, '..', 'host-secret.txt'), `canary=${CANARIES[3]}\n`);
  });
  afterAll(async () => {
    delete process.env[HOST_SECRET_ENV];
    await new Promise((r) => listener?.close(r));
    await rig?.teardown();
    mkdirSync(EVIDENCE, { recursive: true });
    writeEvidence();
  });

  for (const cls of ['K-exec', 'K'] as const) {
    it(`${cls}: the main probe (network, host, env, /proc, writes, Docker socket, privileges)`, async () => {
      const r = await runSession(cls, `sob3-main-${cls.toLowerCase()}`, [
        'node',
        'probe.js',
        'main',
      ]);
      expect(r.status).toBe('exited');
      expect(r.exit_code).toBe(0);
      // fix #25: K and K-exec have an /out, and the probe's report came out of it
      const rep = parseReport(r);
      const byId = new Map(rep.map((x) => [x.id, x]));
      const session = `${cls} / node probe.js main`;
      for (const [id, d] of Object.entries(DESC)) {
        const x = byId.get(id);
        expect(x, `${cls}: attempt ${id} is in the report`).toBeDefined();
        rows.push({
          id: `${cls}:${id}`,
          session,
          class: cls,
          attempt: d.attempt,
          expected: d.blocked,
          observed: x?.observed ?? '(missing)',
          contained: x !== undefined && !x.escaped,
        });
      }
      // the peers: the mirror is the one thing a K-exec session reaches, and K reaches nothing
      const mirror = byId.get('mirror_reachable');
      const wantMirror = cls === 'K-exec';
      rows.push({
        id: `${cls}:mirror_reachable`,
        session,
        class: cls,
        attempt: 'HTTP to the package mirror (the one allowed peer)',
        expected: wantMirror ? 'reachable (control: mirror only)' : 'unreachable (no NIC)',
        observed: mirror?.observed ?? '(missing)',
        contained: mirror?.reached === wantMirror,
      });
      const nics = byId.get('network_interfaces')?.nics ?? [];
      rows.push({
        id: `${cls}:network_interfaces`,
        session,
        class: cls,
        attempt: 'list network interfaces',
        expected: wantMirror
          ? 'loopback and exactly one internal interface'
          : 'loopback only (no NIC)',
        observed: nics.join(','),
        contained: wantMirror ? nics.length === 2 && nics.includes('lo') : nics.join(',') === 'lo',
      });
      const wrote = byId.get('write_repo_tree');
      rows.push({
        id: `${cls}:write_repo_tree`,
        session,
        class: cls,
        attempt: 'write into the repo tree',
        expected: wantMirror
          ? 'a disposable working copy in /work is writable; the mounted repo stays read-only'
          : 'refused: the repo is read-only',
        observed: wrote?.observed ?? '(missing)',
        contained: wantMirror ? wrote?.wrote === true : wrote?.wrote === false,
      });
      // what the host saw
      expect(hostHits, 'the host listener saw a connection from a sandbox').toBe(0);
      for (const row of rows.filter((x) => x.class === cls))
        expect(row.contained, `${row.id}: ${row.observed}`).toBe(true);
    });
  }

  it('the output scan fires on a planted canary in /out, and in the logs, and withholds /out', async () => {
    const inOut = await runSession('K-exec', 'sob3-plant-out', ['node', 'probe.js', 'plant']);
    const inLog = await runSession('K-exec', 'sob3-plant-log', [
      'node',
      'probe.js',
      'plant',
      'stdout',
    ]);
    const fired = (r: SandboxRun) => r.out_scan.canary && r.quarantined && r.out.length === 0;
    rows.push({
      id: 'K-exec:plant_canary_out',
      session: 'K-exec / node probe.js plant',
      class: 'K-exec',
      attempt: 'plant a factory canary (AISDLC_CANARY_ pattern) into /out',
      expected: 'the output scan fires and /out is withheld (quarantined)',
      observed: `canary ${inOut.out_scan.canary ? 'detected' : 'MISSED'}, quarantined ${inOut.quarantined}, files returned ${inOut.out.length}, findings ${inOut.out_scan.findings.map((f) => `${f.path}:${f.rule_id}`).join(',')}`,
      contained: fired(inOut),
    });
    rows.push({
      id: 'K-exec:plant_canary_log',
      session: 'K-exec / node probe.js plant stdout',
      class: 'K-exec',
      attempt: 'print a factory canary to the log stream (and plant it in /out)',
      expected: 'the output scan fires on the logs too, and /out is withheld',
      observed: `canary ${inLog.out_scan.canary ? 'detected' : 'MISSED'}, quarantined ${inLog.quarantined}, findings ${inLog.out_scan.findings.map((f) => `${f.path}:${f.rule_id}`).join(',')}`,
      contained: fired(inLog) && inLog.out_scan.findings.some((f) => f.path === 'stdout'),
    });
    expect(fired(inOut)).toBe(true);
    expect(fired(inLog)).toBe(true);
    // and the canaries the factory really holds (host env, host file, the peers' environments) never came out
    for (const o of outputs)
      for (const c of CANARIES)
        expect(o.includes(c), 'a seeded factory canary left a sandbox').toBe(false);
    rows.push({
      id: 'K-exec:seeded_canaries_not_exfiltrated',
      session: 'all sessions',
      class: 'K-exec',
      attempt: `4 factory canaries seeded where a sandbox must not reach (host process env, a host file beside the scratch root, the gateway peer env, the mirror peer env) searched for in every sandbox's /out, stdout and stderr`,
      expected: 'none found',
      observed: `none found in ${outputs.length} sessions' output`,
      contained: true,
    });
  });

  it('pids: a bounded spawn loop and a real fork bomb stop at the pid limit; the host is unharmed', async () => {
    const before = hostPidCount();
    const r = await runSession('K-exec', 'sob3-pids', ['node', 'probe.js', 'pids'], {
      limits: { pids: 64 },
    });
    const m = /PIDS (\{.*\})/.exec(r.stdout);
    const p = JSON.parse(m?.[1] ?? '{}') as { spawned?: number; error?: string | null };
    rows.push({
      id: 'K-exec:pids_spawn_loop',
      session: 'K-exec (pids 64) / node probe.js pids',
      class: 'K-exec',
      attempt: 'spawn processes in a loop until the system says no (limit 64 pids)',
      expected: 'stops below the pids limit with EAGAIN',
      observed: `spawned ${p.spawned} processes, error ${String(p.error)}`,
      contained: typeof p.spawned === 'number' && p.spawned < 64 && p.error !== null,
    });
    const bomb = await runSession('K-exec', 'sob3-bomb', ['bash', '-c', ':(){ :|:& };:'], {
      limits: { pids: 64, time_s: 6 },
    });
    const delta = await pidDeltaSettled(before);
    rows.push({
      id: 'K-exec:fork_bomb',
      session: 'K-exec (pids 64, 6 s) / bash fork bomb',
      class: 'K-exec',
      attempt: 'a real fork bomb :(){ :|:& };:',
      expected:
        'capped at 64 pids; the container is killed at the time limit or exits; the host process count returns to normal',
      observed: `status ${bomb.status}, host process count change ${delta}, container removed`,
      contained:
        ['timed_out', 'killed', 'exited', 'oom_killed'].includes(bomb.status) && delta <= 15,
    });
    expect(rows.find((x) => x.id === 'K-exec:pids_spawn_loop')?.contained).toBe(true);
    expect(rows.find((x) => x.id === 'K-exec:fork_bomb')?.contained).toBe(true);
  });

  it('memory: a blow-up past the limit is killed by the kernel and the run is void', async () => {
    const r = await runSession('K-exec', 'sob3-mem', ['node', 'probe.js', 'mem'], {
      limits: { memory_mb: 128, time_s: 60 },
    });
    const allocs = [...r.stdout.matchAll(/ALLOC (\d+) MiB/g)].map((x) => Number(x[1]));
    const last = allocs.at(-1) ?? 0;
    const killed =
      r.status === 'oom_killed' ||
      (r.status === 'exited' && (r.exit_code ?? 0) >= 128) ||
      r.status === 'killed';
    rows.push({
      id: 'K-exec:memory_blowup',
      session: 'K-exec (128 MiB) / node probe.js mem',
      class: 'K-exec',
      attempt: 'allocate and touch memory without end (limit 128 MiB, no swap)',
      expected: 'killed by the kernel before 128 MiB is passed; the run is void or exits by signal',
      observed: `status ${r.status}, exit ${String(r.exit_code)}, last progress ${last} MiB`,
      contained: killed && last <= 128,
    });
    expect(
      rows.find((x) => x.id === 'K-exec:memory_blowup')?.contained,
      JSON.stringify(r.detail),
    ).toBe(true);
  });

  it('time: a long sleep is killed at the time limit and the container is removed', async () => {
    const t0 = Date.now();
    const r = await runSession('K-exec', 'sob3-sleep', ['sleep', '600'], { limits: { time_s: 3 } });
    const took = Date.now() - t0;
    rows.push({
      id: 'K-exec:long_sleep',
      session: 'K-exec (3 s) / sleep 600',
      class: 'K-exec',
      attempt: 'sleep for 600 s (limit 3 s)',
      expected:
        'killed at the limit (status timed_out), the container is removed, the run returns promptly',
      observed: `status ${r.status} after ${Math.round(took / 1000)} s`,
      contained: r.status === 'timed_out' && took < 60_000,
    });
    expect(r.status).toBe('timed_out');
  });

  it('space: /out, /work and /tmp are size-capped tmpfs', async () => {
    const r = await runSession('K-exec', 'sob3-fill', ['node', 'probe.js', 'fill'], {
      limits: { out_bytes: 1_048_576, work_bytes: 8 * 1024 * 1024 },
    });
    const f = JSON.parse(/FILL (\{.*\})/.exec(r.stdout)?.[1] ?? '{}') as Record<
      string,
      { written: number; error: string | null }
    >;
    const within = (k: string, cap: number) =>
      (f[k]?.written ?? Infinity) <= cap && f[k]?.error === 'ENOSPC';
    rows.push({
      id: 'K-exec:output_flood',
      session: 'K-exec (out 1 MiB, work 8 MiB) / node probe.js fill',
      class: 'K-exec',
      attempt: 'write 1 GiB each to /out, /work and /tmp',
      expected: 'ENOSPC at the cap (/out 1 MiB, /work 8 MiB, /tmp 8 MiB)',
      observed: `/out ${f['out']?.written}B ${f['out']?.error}, /work ${f['work']?.written}B ${f['work']?.error}, /tmp ${f['tmp']?.written}B ${f['tmp']?.error}`,
      contained:
        within('out', 1_048_576) &&
        within('work', 8 * 1024 * 1024) &&
        within('tmp', 8 * 1024 * 1024),
    });
    expect(rows.find((x) => x.id === 'K-exec:output_flood')?.contained).toBe(true);
  });

  it('links in /out are never followed: only plain files come back', async () => {
    const r = await runSession('K-exec', 'sob3-links', ['node', 'probe.js', 'links']);
    const paths = r.out.map((o) => o.path).sort();
    const leaked = r.out.some(
      (o) =>
        /root:|SHELL=|PATH=/.test(Buffer.from(o.content).toString('latin1')) &&
        o.path !== 'ok.txt' &&
        o.path !== 'hardlink',
    );
    rows.push({
      id: 'K-exec:out_symlinks',
      session: 'K-exec / node probe.js links',
      class: 'K-exec',
      attempt:
        'leave symlinks in /out to /etc/passwd, /proc/1/environ and ../../etc/shadow, and a hard link to /etc/hostname',
      expected: 'links are skipped, never followed; only regular files are returned',
      observed: `files returned: ${paths.join(',')}`,
      contained: !leaked && !paths.some((p) => /link$/.test(p)) && paths.includes('ok.txt'),
    });
    expect(rows.find((x) => x.id === 'K-exec:out_symlinks')?.contained).toBe(true);
  });

  it('nothing persists between sessions, and the host scratch path is invisible', async () => {
    const r = await runSession('K-exec', 'sob3-persist', [
      'node',
      '-e',
      `const fs=require('fs');console.log('PERSIST '+JSON.stringify(['/tmp/marker','/work/marker','/work/repo/written-by-probe',process.env.HOST_SCRATCH].map(p=>fs.existsSync(p))))`,
    ]);
    const m = JSON.parse(/PERSIST (\[.*\])/.exec(r.stdout)?.[1] ?? '[]') as boolean[];
    rows.push({
      id: 'K-exec:persistence',
      session: 'K-exec / a later session',
      class: 'K-exec',
      attempt:
        'look for files an earlier hostile session wrote (/tmp, /work, the working copy) and for the host scratch directory',
      expected: 'none exist (tmpfs is gone with the container; the host path is not mounted)',
      observed: `exists: /tmp ${m[0]}, /work ${m[1]}, working copy ${m[2]}, host scratch ${m[3]}`,
      contained: m.length === 4 && m.every((x) => x === false),
    });
    expect(rows.find((x) => x.id === 'K-exec:persistence')?.contained).toBe(true);
  });

  it('through the proxy itself: a compromised worker cannot ask Docker for more', async () => {
    const call = (method: string, path: string, body?: unknown) =>
      new Promise<number>((resolveP, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
          {
            socketPath: rig.proxySock,
            method,
            path,
            headers: payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : { 'Content-Length': 0 },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolveP(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(payload);
      });
    const base = (over: Record<string, unknown> = {}, host: Record<string, unknown> = {}) => {
      const p = SANDBOX_PROFILES['K-exec'];
      return {
        Image: 'aisdlc/sandbox:local',
        Entrypoint: ['/usr/local/bin/aisdlc-run'],
        Cmd: ['true'],
        User: '10002:10002',
        Labels: {
          'aisdlc.sandbox': '1',
          'aisdlc.sandbox.session': 'sob3-proxy01',
          'aisdlc.sandbox.class': 'K-exec',
        },
        HostConfig: {
          Binds: [`${rig.scratchRoot}/sob3-proxy01/repo:/repo:ro`],
          Tmpfs: {
            '/out': 'rw,noexec,nosuid,nodev,size=1048576,uid=10002,gid=10002,mode=0700',
            '/work': 'rw,exec,nosuid,nodev,size=1048576,uid=10002,gid=10002,mode=0755',
            '/tmp': 'rw,exec,nosuid,nodev,size=1048576,uid=10002,gid=10002,mode=1777',
          },
          NetworkMode: 'aisdlc-sbx-net-sob3-proxy01',
          Memory: p.limits.memory_mb * 1024 * 1024,
          MemorySwap: p.limits.memory_mb * 1024 * 1024,
          NanoCpus: 1e9,
          PidsLimit: 64,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
          IpcMode: 'private',
          ...host,
        },
        ...over,
      };
    };
    const q = '/containers/create?name=aisdlc-sbx-sob3-proxy01';
    const cases: Array<[string, string, Promise<number>]> = [
      [
        'a privileged container',
        'create body with Privileged=true',
        call('POST', q, base({}, { Privileged: true })),
      ],
      [
        'a container on the host network',
        'create body with NetworkMode=host',
        call('POST', q, base({}, { NetworkMode: 'host' })),
      ],
      [
        'the host PID namespace',
        'create body with PidMode=host',
        call('POST', q, base({}, { PidMode: 'host' })),
      ],
      [
        'an added capability',
        'create body with CapAdd=[SYS_ADMIN]',
        call('POST', q, base({}, { CapAdd: ['SYS_ADMIN'] })),
      ],
      [
        'a device',
        'create body with a /dev/sda device',
        call(
          'POST',
          q,
          base(
            {},
            {
              Devices: [
                { PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' },
              ],
            },
          ),
        ),
      ],
      [
        'the Docker socket bind-mounted',
        'create body binding /var/run/docker.sock',
        call('POST', q, base({}, { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] })),
      ],
      [
        'the host root bind-mounted',
        'create body binding / (outside the scratch root)',
        call('POST', q, base({}, { Binds: ['/:/host'] })),
      ],
      [
        'seccomp unconfined',
        'create body with seccomp=unconfined',
        call('POST', q, base({}, { SecurityOpt: ['no-new-privileges', 'seccomp=unconfined'] })),
      ],
      ['a root user', 'create body with User=root', call('POST', q, base({ User: 'root' }))],
      [
        'a writable root filesystem',
        'create body with ReadonlyRootfs=false',
        call('POST', q, base({}, { ReadonlyRootfs: false })),
      ],
      [
        'no memory limit',
        'create body without Memory',
        call('POST', q, base({}, { Memory: 0, MemorySwap: 0 })),
      ],
      [
        'a different image',
        'create body with image alpine:latest',
        call('POST', q, base({ Image: 'alpine:latest' })),
      ],
      [
        'exec in a container',
        'POST /containers/<id>/exec',
        call('POST', `/containers/${rig.peers.mirror}/exec`, { Cmd: ['id'] }),
      ],
      ['a build', 'POST /build', call('POST', '/build', {})],
      [
        'an image pull',
        'POST /images/create?fromImage=alpine',
        call('POST', '/images/create?fromImage=alpine'),
      ],
      ['a volume', 'POST /volumes/create', call('POST', '/volumes/create', { Name: 'x' })],
      [
        'starting a container that is not a sandbox',
        'POST /containers/<mirror peer>/start',
        call('POST', `/containers/${rig.peers.mirror}/start`),
      ],
      [
        'removing a container that is not a sandbox',
        'DELETE /containers/<gateway peer>',
        call('DELETE', `/containers/${rig.peers.gateway}?force=true`),
      ],
      [
        'a non-internal network',
        'POST /networks/create with Internal=false',
        call('POST', '/networks/create', {
          Name: 'aisdlc-sbx-net-sob3-proxy01',
          Internal: false,
          Labels: { 'aisdlc.sandbox': '1', 'aisdlc.sandbox.session': 'sob3-proxy01' },
        }),
      ],
    ];
    for (const [what, attempt, status] of cases) {
      const s = await status;
      rows.push({
        id: `proxy:${what.replace(/\W+/g, '_')}`,
        session: 'the docker-proxy (coding instance)',
        class: 'K-exec',
        attempt: `ask the proxy for ${what}: ${attempt}`,
        expected: 'refused (HTTP 4xx), the daemon never sees it',
        observed: `HTTP ${s}`,
        contained: s >= 400 && s < 500,
      });
    }
    // a REAL session network (created through the proxy, internal and labelled): the wrong peer under an alias that
    // is not its own, something that is no peer, and the default bridge are all refused
    const net2 = 'aisdlc-sbx-net-sob3-proxy02';
    const created = await call('POST', '/networks/create', {
      Name: net2,
      Internal: true,
      Labels: { 'aisdlc.sandbox': '1', 'aisdlc.sandbox.session': 'sob3-proxy02' },
    });
    expect(created).toBe(201);
    const attach = (net: string, container: string, alias: string) =>
      call('POST', `/networks/${net}/connect`, {
        Container: container,
        EndpointConfig: { Aliases: [alias] },
      });
    for (const [what, attempt, s] of [
      [
        'a peer under another peer alias',
        'POST /networks/<session net>/connect: the mirror as "gateway"',
        await attach(net2, rig.peers.mirror, 'gateway'),
      ],
      [
        'a container that is no peer',
        'POST /networks/<session net>/connect: a stranger as "gateway"',
        await attach(net2, 'postgres', 'gateway'),
      ],
      [
        'the default bridge',
        'POST /networks/bridge/connect: attach a peer to the non-internal bridge',
        await attach('bridge', rig.peers.mirror, 'package-mirror'),
      ],
    ] as const) {
      rows.push({
        id: `proxy:${what.replace(/\W+/g, '_')}`,
        session: 'the docker-proxy (coding instance)',
        class: 'K-exec',
        attempt: `ask the proxy for ${what}: ${attempt}`,
        expected: 'refused (HTTP 4xx), the daemon never sees it',
        observed: `HTTP ${s}`,
        contained: s >= 400 && s < 500,
      });
    }
    expect(await call('DELETE', `/networks/${net2}`)).toBe(204);
    expect(rows.filter((x) => x.id.startsWith('proxy:')).every((x) => x.contained)).toBe(true);
    // nothing the daemon would have made exists
    expect(rig.leftovers()).toEqual({ containers: [], networks: [], volumes: [], scratch: [] });
  });

  it('every attempt is contained, and nothing is left behind', () => {
    const escaped = rows.filter((r) => !r.contained);
    expect(escaped, `escapes:\n${escaped.map((e) => `${e.id}: ${e.observed}`).join('\n')}`).toEqual(
      [],
    );
    expect(hostHits).toBe(0);
    expect(rig.leftovers()).toEqual({ containers: [], networks: [], volumes: [], scratch: [] });
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });
});

function writeEvidence(): void {
  if (rows.length === 0) return;
  const escaped = rows.filter((r) => !r.contained).length;
  const dockerServer = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  }).trim();
  const report = {
    id: 'SEC-OB-3',
    title: 'Hostile-probe repository is contained by the container-class sandbox',
    decision_served: 'DEC-18(b): whether repository code may run in the container-class sandbox',
    method:
      'A synthetic hostile repository built by the test (never a real repository) is run in real containers through the real driver and the real allow-list docker proxy against the local Docker daemon. The attacker view (probe.js) and the host view (listener hits, leftovers, seeded canaries, process counts) are both checked.',
    environment: {
      docker_server: dockerServer,
      image: 'aisdlc/sandbox:local (node 22.23.4 bookworm-slim, uid 10002)',
      isolation: 'container-class (not VM-class, D40)',
      shared_ruleset: RULES_VERSION,
    },
    profiles: { K: SANDBOX_PROFILES.K, 'K-exec': SANDBOX_PROFILES['K-exec'] },
    summary: { attempts: rows.length, contained: rows.length - escaped, escaped },
    attempts: rows.map((r, i) => ({ n: i + 1, ...r })),
  };
  const dir = EVIDENCE;
  writeFileSync(join(dir, 'sec-ob-3.json'), `${JSON.stringify(report, null, 2)}\n`);
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [
    '# SEC-OB-3: hostile-probe evidence',
    '',
    'Generated by `services/sandbox-driver/test/sec-ob-3.test.ts` (run `npx vitest run --project sandbox-driver sec-ob-3`). Machine-readable twin: `sec-ob-3.json`.',
    '',
    `**Result: ${rows.length - escaped} of ${rows.length} attempts contained, ${escaped} escaped.** Docker ${dockerServer}, image \`aisdlc/sandbox:local\`, container-class isolation (not VM-class, D40).`,
    '',
    'What was run: a SYNTHETIC hostile repository, built by the test itself. No real repository and no real repository code is involved. Its test command (`probe.js`) tries DNS, HTTP, the cloud metadata IP, the Docker host, the model gateway without a key, reading env and /proc, writing outside the repo tree and /out, finding the Docker socket, privilege use, a fork bomb, a memory blow-up, a long sleep, an output flood, links in /out, and planting factory canaries (`AISDLC_CANARY_`) into /out and the logs. It ran in class K-exec (mirror-only network) and class K (no NIC), through `DockerSandboxDriver` and the allow-list `docker-proxy`, against the local Docker daemon. A second group asks the proxy directly for what a compromised worker would (privileged, host network, the socket, exec, build, pull).',
    '',
    'How to read the table: "Contained" is `yes` when the forbidden thing did NOT work (or, for a control, when the expected allowed thing did). The host side is checked as well as the probe\'s own report: the host listener saw 0 connections, the four factory canaries seeded outside the sandbox (host environment, host file, gateway peer, mirror peer) were found nowhere in any sandbox output, and no container, network, volume or scratch directory was left behind.',
    '',
    '| # | Attempt | Class | Expected | Observed | Contained |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (r, i) =>
        `| ${i + 1} | ${esc(r.attempt)} | ${r.class} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.contained ? 'yes' : '**NO**'} |`,
    ),
    '',
    '## What this does and does not show',
    '',
    '- It shows the container-class sandbox as configured here (read-only root, all capabilities dropped, no-new-privileges, default seccomp, non-root, memory/pids/cpu/time limits, size-capped tmpfs, per-session internal network with the mirror as the only peer, no Docker socket, no credential) stops each attempt above. It is the evidence DEC-18(b) asked for; the decision is not made here.',
    '- It does not show VM-class isolation. A kernel or runtime escape is out of scope for any container; that is why the decision is a human gate (DEC-18) and why real repositories still do not run here until it is taken.',
    '- Output that comes back from a sandbox (its exit code, logs, `/out`) is the word of the code that ran. The driver caps and scans it; it is never trusted for more than that.',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'sec-ob-3.md'), md);
  if (EVIDENCE_IS_SCRATCH) rmSync(dir, { recursive: true, force: true });
}
