import { SANDBOX_LABEL } from '@aisdlc/contracts';
import { DockerSandboxDriver } from './driver.js';
import { DockerApi } from './docker-api.js';

// The compose smoke client (platform/compose/smoke.sh): runs inside the stack on the coding proxy's network,
// starts ONE session of class K through the coding proxy (and one K-exec to prove the per-session internal
// network with the package mirror), then asks the proxy for a privileged container and for the rest of what a
// compromised worker would try, and exits non-zero unless every one of those was refused.
//
//   SANDBOX_PROXY       http://docker-proxy-coding:2375
//   SANDBOX_IMAGE       aisdlc/sandbox:local
//   SANDBOX_SCRATCH     the scratch directory (the same path for this container and for the daemon)
//   SANDBOX_MIRROR      the package mirror's container name
//   SANDBOX_GATEWAY     the gateway's container name (optional)

const env = process.env;
const need = (n: string): string => {
  const v = env[n];
  if (!v) throw new Error(`${n} is required`);
  return v;
};
const proxy = new URL(need('SANDBOX_PROXY'));
const scratch = need('SANDBOX_SCRATCH');
const image = need('SANDBOX_IMAGE');
const endpoint = { host: proxy.hostname, port: Number(proxy.port || 80) };
let failed = 0;
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed += 1;
};

const driver = new DockerSandboxDriver({
  endpoint,
  image,
  scratch: { local: scratch, host: scratch },
  peers: {
    mirror: need('SANDBOX_MIRROR'),
    ...(env['SANDBOX_GATEWAY'] ? { gateway: env['SANDBOX_GATEWAY'] } : {}),
  },
  trustedCommands: ['node'],
});
check(await driver.ping(), 'the coding proxy answers (daemon reachable through it)');

// 1. one K session: no NIC, read-only repo, /out
const k = await driver.run({
  session_id: 'smoke-k-0001',
  class: 'K',
  command: [
    'node',
    '-e',
    "require('fs').writeFileSync('/out/hello.txt','from K');console.log('NICS '+Object.keys(require('os').networkInterfaces()).join(','))",
  ],
  repo: [{ path: 'README.md', content: 'smoke' }],
});
check(
  k.ok && k.value.status === 'exited' && k.value.exit_code === 0,
  `a K session ran through the coding proxy (${k.ok ? k.value.status : JSON.stringify(k.error)})`,
);
check(
  k.ok && k.value.stdout.includes('NICS lo') && !k.value.stdout.includes('eth'),
  'K has no NIC (loopback only)',
);
check(
  k.ok && k.value.out.length === 1 && k.value.out[0]?.path === 'hello.txt',
  'K /out came back through the log stream',
);

// 2. one K-exec: a per-session internal network whose only peer is the package mirror
const kx = await driver.run({
  session_id: 'smoke-kx-0001',
  class: 'K-exec',
  command: [
    'node',
    '-e',
    `const http=require('http');
     const t=(u)=>new Promise(r=>http.get(u,{timeout:2500},x=>{x.resume();r(String(x.statusCode))}).on('error',e=>r(e.code)).on('timeout',function(){this.destroy();r('TIMEOUT')}));
     (async()=>console.log('MIRROR '+await t('http://package-mirror:8420/healthz')+' EXT '+await t('http://example.com/')+' META '+await t('http://169.254.169.254/')))()`,
  ],
  repo: [{ path: 'package.json', content: '{}' }],
});
check(
  kx.ok && kx.value.stdout.includes('MIRROR 200'),
  `K-exec reaches the package mirror on its internal network (${kx.ok ? kx.value.stdout.trim().slice(0, 80) : JSON.stringify(kx.error)})`,
);
check(
  kx.ok && !/EXT 2\d\d/.test(kx.value.stdout) && !/META 2\d\d/.test(kx.value.stdout),
  'K-exec reaches neither the internet nor the metadata IP',
);
check(
  kx.ok && kx.value.cleanup_errors.length === 0,
  'the session network and container were removed',
);

// 3. what a compromised worker would ask the proxy for
const api = new DockerApi(endpoint);
const body = (host: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  Image: image,
  Entrypoint: ['/usr/local/bin/aisdlc-run'],
  Cmd: ['true'],
  User: '10002:10002',
  Labels: {
    [SANDBOX_LABEL.sandbox]: '1',
    [SANDBOX_LABEL.session]: 'smoke-bad-0001',
    [SANDBOX_LABEL.class]: 'K',
  },
  HostConfig: {
    Binds: [`${scratch}/smoke-bad-0001/repo:/repo:ro`],
    Tmpfs: {
      '/out': 'rw,noexec,nosuid,nodev,size=1048576,uid=10002,gid=10002,mode=0700',
      '/work': 'rw,noexec,nosuid,nodev,size=1048576,uid=10002,gid=10002,mode=0755',
      '/tmp': 'rw,noexec,nosuid,nodev,size=1048576,uid=10002,gid=10002,mode=1777',
    },
    NetworkMode: 'none',
    Memory: 268435456,
    MemorySwap: 268435456,
    NanoCpus: 1_000_000_000,
    PidsLimit: 64,
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
    IpcMode: 'private',
    ...host,
  },
  ...over,
});
const create = (b: unknown) =>
  api.json('POST', '/containers/create?name=aisdlc-sbx-smoke-bad-0001', b);
const good = await create(body({}));
check(
  good.status === 201,
  `control: a well-formed K create body is accepted by the proxy (${good.status})`,
);
if (good.status === 201)
  await api.request('DELETE', '/containers/aisdlc-sbx-smoke-bad-0001?force=true');
const priv = await create(body({ Privileged: true }));
check(
  priv.status === 403 && /privileged/i.test(priv.message),
  `a create body with Privileged=true is refused by the proxy (${priv.status}: ${priv.message})`,
);
for (const [what, b] of [
  ['host network', body({ NetworkMode: 'host' })],
  ['host PID namespace', body({ PidMode: 'host' })],
  ['an added capability', body({ CapAdd: ['SYS_ADMIN'] })],
  [
    'the Docker socket as a bind mount',
    body({ Binds: ['/var/run/docker.sock:/var/run/docker.sock'] }),
  ],
  ['a root user', body({}, { User: 'root' })],
] as const) {
  const r = await create(b);
  check(r.status === 403, `${what}: refused (${r.status})`);
}
const exec = await api.json('POST', '/containers/aisdlc-sbx-smoke-bad-0001/exec', { Cmd: ['id'] });
check(exec.status === 403, `EXEC is refused (${exec.status})`);
const build = await api.json('POST', '/build', {});
check(build.status === 403, `BUILD is refused (${build.status})`);
const pull = await api.json('POST', '/images/create?fromImage=alpine', undefined);
check(pull.status === 403, `an image pull is refused (${pull.status})`);

if (failed > 0) {
  console.error(`sandbox smoke: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('sandbox smoke: all checks passed');
