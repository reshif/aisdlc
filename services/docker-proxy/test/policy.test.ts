import { SANDBOX_LABEL, SandboxClassValues } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { route, validateConnect, validateCreate, validateNetworkCreate } from '../src/index.js';
import { SCRATCH, cfg, validBody, type Body } from './helpers.js';

const q = (name = 'aisdlc-sbx-sess-000001') => new Map([['name', name]]);
const create = (body: unknown, c = cfg()) => validateCreate(body, q(), c);
const refused = (body: unknown, c = cfg()) => {
  const d = create(body, c);
  return d.allow ? null : d.reason;
};
/** Apply a mutation to a fresh valid body. */
const mutated = (f: (b: Body) => void, cls: 'K' | 'W' = 'K') => {
  const b = validBody(cls);
  f(b);
  return b;
};

describe('routes: only the verbs the driver needs', () => {
  const allowed: Array<[string, string]> = [
    ['GET', '/_ping'],
    ['POST', '/containers/create?name=aisdlc-sbx-sess-000001'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/start'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/wait?condition=not-running'],
    ['GET', '/containers/aisdlc-sbx-sess-000001/logs?stdout=1&stderr=1&follow=0'],
    ['GET', '/containers/aisdlc-sbx-sess-000001/json'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/kill?signal=KILL'],
    ['GET', '/containers/aisdlc-sbx-sess-000001/archive?path=/out'],
    ['PUT', '/containers/aisdlc-sbx-sess-000001/archive?path=/repo'],
    ['DELETE', '/containers/aisdlc-sbx-sess-000001?force=true&v=true'],
    ['POST', '/networks/create'],
    ['POST', '/networks/aisdlc-sbx-net-sess-000001/connect'],
    ['POST', '/networks/aisdlc-sbx-net-sess-000001/disconnect'],
    ['DELETE', '/networks/aisdlc-sbx-net-sess-000001'],
    ['GET', '/v1.47/_ping'],
    ['POST', '/v1.47/containers/create?name=aisdlc-sbx-sess-000001'],
  ];
  it.each(allowed)('allows %s %s', (m, u) => {
    expect(route(m, u).allow).toBe(true);
  });

  const refusedRoutes: Array<[string, string]> = [
    // exec, build, images, the rest of the API: refused, always
    ['POST', '/containers/aisdlc-sbx-sess-000001/exec'],
    ['POST', '/exec/abcdef123456/start'],
    ['POST', '/exec/abcdef123456/resize'],
    ['POST', '/build'],
    ['POST', '/images/create?fromImage=alpine'],
    ['POST', '/v1.47/images/create?fromImage=alpine'],
    ['GET', '/images/json'],
    ['POST', '/images/load'],
    ['POST', '/commit?container=x'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/attach'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/update'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/rename'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/stop'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/restart'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/pause'],
    ['GET', '/containers/json'],
    ['POST', '/containers/prune'],
    ['POST', '/networks/prune'],
    ['GET', '/networks'],
    ['POST', '/volumes/create'],
    ['GET', '/volumes'],
    ['GET', '/info'],
    ['GET', '/version'],
    ['GET', '/events'],
    ['POST', '/swarm/init'],
    ['GET', '/plugins'],
    ['POST', '/session'],
    ['POST', '/grpc'],
    ['GET', '/system/df'],
    ['DELETE', '/images/alpine'],
    // a bare create path with another method, other methods on allowed paths
    ['GET', '/containers/create'],
    ['PUT', '/containers/create'],
    ['GET', '/containers/aisdlc-sbx-sess-000001/start'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/logs'],
    ['DELETE', '/containers/aisdlc-sbx-sess-000001/kill'],
    ['GET', '/networks/aisdlc-sbx-net-sess-000001'],
    // names that are not session names, and the host's own containers by name
    ['POST', '/containers/postgres/start'],
    ['DELETE', '/containers/gateway'],
    ['DELETE', '/networks/bridge'],
    ['DELETE', '/networks/host'],
    ['POST', '/networks/aisdlc-smoke_app/connect'],
    // path tricks
    ['POST', '/containers/create/../exec'],
    ['POST', '/containers//create'],
    ['POST', '/containers/create/'],
    ['POST', '/containers/%63reate'],
    ['POST', '/containers/CREATE'],
    ['POST', '/Containers/create'],
    ['POST', '/containers/aisdlc-sbx-sess-000001%2fexec/start'],
    ['POST', '/v1.47/../containers/create'],
    ['POST', '/v1.4/containers/create'],
    ['POST', '/containers/create;x'],
    // query abuse
    ['POST', '/containers/create?name=a&name=b'],
    ['POST', '/containers/create?name=x&platform=linux/arm64'],
    ['DELETE', '/containers/aisdlc-sbx-sess-000001?link=true'],
    ['POST', '/containers/aisdlc-sbx-sess-000001/kill?signal=HUP'],
    ['GET', '/containers/aisdlc-sbx-sess-000001/logs?since=0'],
  ];
  it.each(refusedRoutes)('refuses %s %s', (m, u) => {
    const r = route(m, u);
    if (r.allow) {
      // an allowed route must at least fail its parameter check (kill signal) rather than pass silently
      expect(['container_kill'].includes(r.value.kind)).toBe(true);
      expect(r.value.query.get('signal')).toBe('HUP');
    } else {
      expect(r.status).toBe(403);
    }
  });
});

describe('create: the valid body passes for every class', () => {
  it.each(SandboxClassValues)('class %s', (cls) => {
    const d = validateCreate(validBody(cls), q(), cfg());
    expect(d.allow, d.allow ? '' : d.reason).toBe(true);
  });
  it("the forwarded body is the proxy's own rebuild, with the same limits", () => {
    const d = create(validBody('K'));
    expect(d.allow).toBe(true);
    if (!d.allow) return;
    const out = JSON.parse(d.value.body);
    expect(out.HostConfig.CapDrop).toEqual(['ALL']);
    expect(out.HostConfig.ReadonlyRootfs).toBe(true);
    expect(out.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(out.Labels[SANDBOX_LABEL.sandbox]).toBe('1');
  });
});

describe('create: refusals (each one alone is enough)', () => {
  const cases: Array<[string, (b: Body) => void, RegExp]> = [
    ['Privileged', (b) => (b.HostConfig.Privileged = true), /privileged/i],
    [
      'Privileged false is also an unknown key here',
      (b) => (b.HostConfig.Privileged = false),
      /privileged/i,
    ],
    [
      'lower-case privileged (Go decodes field names case-insensitively)',
      (b) => (b.HostConfig.privileged = true),
      /privileged/i,
    ],
    ['upper-case PRIVILEGED', (b) => (b.HostConfig.PRIVILEGED = true), /privileged/i],
    ['PidMode host', (b) => (b.HostConfig.PidMode = 'host'), /PID/],
    ['IpcMode host', (b) => (b.HostConfig.IpcMode = 'host'), /IpcMode/],
    ['IpcMode shareable', (b) => (b.HostConfig.IpcMode = 'shareable'), /IpcMode/],
    ['UTSMode host', (b) => (b.HostConfig.UTSMode = 'host'), /UTS/],
    ['UsernsMode host', (b) => (b.HostConfig.UsernsMode = 'host'), /user namespace/],
    ['NetworkMode host', (b) => (b.HostConfig.NetworkMode = 'host'), /NIC|session network/],
    ['NetworkMode bridge', (b) => (b.HostConfig.NetworkMode = 'bridge'), /NIC|session network/],
    [
      'NetworkMode of another container',
      (b) => (b.HostConfig.NetworkMode = 'container:db'),
      /NIC|session network/,
    ],
    ['CapAdd', (b) => (b.HostConfig.CapAdd = ['SYS_ADMIN']), /capabilities/],
    ['CapAdd empty', (b) => (b.HostConfig.CapAdd = []), /capabilities/],
    ['CapDrop missing', (b) => delete b.HostConfig.CapDrop, /CapDrop/],
    ['CapDrop not ALL', (b) => (b.HostConfig.CapDrop = ['NET_RAW']), /CapDrop/],
    ['ReadonlyRootfs false', (b) => (b.HostConfig.ReadonlyRootfs = false), /ReadonlyRootfs/],
    ['ReadonlyRootfs missing', (b) => delete b.HostConfig.ReadonlyRootfs, /ReadonlyRootfs/],
    [
      'seccomp unconfined',
      (b) => (b.HostConfig.SecurityOpt = ['no-new-privileges', 'seccomp=unconfined']),
      /SecurityOpt/,
    ],
    [
      'apparmor unconfined',
      (b) => (b.HostConfig.SecurityOpt = ['no-new-privileges', 'apparmor=unconfined']),
      /SecurityOpt/,
    ],
    [
      'label disable',
      (b) => (b.HostConfig.SecurityOpt = ['no-new-privileges', 'label=disable']),
      /SecurityOpt/,
    ],
    [
      'no-new-privileges:false',
      (b) => (b.HostConfig.SecurityOpt = ['no-new-privileges:false']),
      /SecurityOpt/,
    ],
    ['SecurityOpt missing', (b) => delete b.HostConfig.SecurityOpt, /SecurityOpt/],
    [
      'device',
      (b) =>
        (b.HostConfig.Devices = [
          { PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' },
        ]),
      /devices/,
    ],
    ['device cgroup rule', (b) => (b.HostConfig.DeviceCgroupRules = ['a *:* rwm']), /devices/],
    [
      'docker socket bind',
      (b) => (b.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']),
      /Binds/,
    ],
    [
      'docker socket bind next to the repo',
      (b) => b.HostConfig.Binds.push('/var/run/docker.sock:/var/run/docker.sock'),
      /Binds/,
    ],
    ['bind of /', (b) => (b.HostConfig.Binds = ['/:/host']), /Binds/],
    ['bind outside the scratch root', (b) => (b.HostConfig.Binds = ['/etc:/repo:ro']), /Binds/],
    [
      'bind with traversal out of the scratch root',
      (b) => (b.HostConfig.Binds = [`${SCRATCH}/../../etc:/repo:ro`]),
      /Binds/,
    ],
    [
      'bind of the scratch root itself',
      (b) => (b.HostConfig.Binds = [`${SCRATCH}:/repo:ro`]),
      /Binds/,
    ],
    [
      'bind of another session',
      (b) => (b.HostConfig.Binds = [`${SCRATCH}/sess-999999/repo:/repo:ro`]),
      /Binds/,
    ],
    [
      'bind read-write',
      (b) => (b.HostConfig.Binds = [`${SCRATCH}/sess-000001/repo:/repo`]),
      /Binds/,
    ],
    [
      'bind rw explicit',
      (b) => (b.HostConfig.Binds = [`${SCRATCH}/sess-000001/repo:/repo:rw`]),
      /Binds/,
    ],
    [
      'bind to the socket path',
      (b) => (b.HostConfig.Binds = [`${SCRATCH}/sess-000001/repo:/var/run/docker.sock:ro`]),
      /Binds/,
    ],
    ['no binds', (b) => delete b.HostConfig.Binds, /Binds/],
    [
      'Mounts (bind)',
      (b) => (b.HostConfig.Mounts = [{ Type: 'bind', Source: '/', Target: '/host' }]),
      /mounts/i,
    ],
    [
      'Mounts (volume)',
      (b) => (b.HostConfig.Mounts = [{ Type: 'volume', Source: 'x', Target: '/v' }]),
      /mounts/i,
    ],
    ['Volumes in the container config', (b) => (b.Volumes = { '/v': {} }), /volumes/i],
    ['Tmpfs at another target', (b) => (b.HostConfig.Tmpfs['/etc'] = 'rw,size=1000'), /Tmpfs/],
    [
      'Tmpfs without a size',
      (b) => (b.HostConfig.Tmpfs['/out'] = 'rw,noexec,nosuid,nodev,uid=10002,gid=10002,mode=0700'),
      /size/,
    ],
    [
      'Tmpfs /out above the class ceiling',
      (b) =>
        (b.HostConfig.Tmpfs['/out'] =
          'rw,noexec,nosuid,nodev,size=999999999999,uid=10002,gid=10002,mode=0700'),
      /ceiling|size/,
    ],
    [
      'Tmpfs /out executable',
      (b) =>
        (b.HostConfig.Tmpfs['/out'] =
          'rw,exec,nosuid,nodev,size=1000000,uid=10002,gid=10002,mode=0700'),
      /noexec/,
    ],
    [
      'Tmpfs as root',
      (b) =>
        (b.HostConfig.Tmpfs['/out'] = 'rw,noexec,nosuid,nodev,size=1000000,uid=0,gid=0,mode=0700'),
      /uid/,
    ],
    [
      'Tmpfs with an unknown option',
      (b) =>
        (b.HostConfig.Tmpfs['/out'] =
          'rw,noexec,nosuid,nodev,size=1000000,uid=10002,gid=10002,suid'),
      /not on the allow-list/,
    ],
    ['Memory missing', (b) => delete b.HostConfig.Memory, /Memory/],
    [
      'Memory above the class ceiling',
      (b) => (b.HostConfig.Memory = b.HostConfig.MemorySwap = 64 * 1024 ** 3),
      /Memory/,
    ],
    ['Memory zero (unlimited)', (b) => (b.HostConfig.Memory = 0), /Memory/],
    ['swap allowed', (b) => (b.HostConfig.MemorySwap = b.HostConfig.Memory * 2), /MemorySwap/],
    ['swap unlimited', (b) => (b.HostConfig.MemorySwap = -1), /MemorySwap/],
    ['PidsLimit missing', (b) => delete b.HostConfig.PidsLimit, /PidsLimit/],
    ['PidsLimit unlimited', (b) => (b.HostConfig.PidsLimit = -1), /PidsLimit/],
    ['PidsLimit above the ceiling', (b) => (b.HostConfig.PidsLimit = 100000), /PidsLimit/],
    ['NanoCpus missing', (b) => delete b.HostConfig.NanoCpus, /NanoCpus/],
    ['NanoCpus above the ceiling', (b) => (b.HostConfig.NanoCpus = 64e9), /NanoCpus/],
    ['LogConfig missing (unbounded host disk)', (b) => delete b.HostConfig.LogConfig, /LogConfig/],
    [
      'LogConfig without rotation',
      (b) => (b.HostConfig.LogConfig = { Type: 'json-file', Config: {} }),
      /LogConfig/,
    ],
    [
      'LogConfig to syslog',
      (b) => (b.HostConfig.LogConfig = { Type: 'syslog', Config: {} }),
      /LogConfig/,
    ],
    [
      'Ulimit memlock',
      (b) => (b.HostConfig.Ulimits = [{ Name: 'memlock', Soft: -1, Hard: -1 }]),
      /Ulimits/,
    ],
    ['AutoRemove', (b) => (b.HostConfig.AutoRemove = true), /auto-remove/],
    ['Runtime', (b) => (b.HostConfig.Runtime = 'nvidia'), /runtime/],
    ['Sysctls', (b) => (b.HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' }), /sysctls/],
    [
      'PortBindings',
      (b) => (b.HostConfig.PortBindings = { '80/tcp': [{ HostPort: '80' }] }),
      /ports/,
    ],
    ['Dns', (b) => (b.HostConfig.Dns = ['8.8.8.8']), /DNS/],
    ['VolumesFrom', (b) => (b.HostConfig.VolumesFrom = ['postgres']), /volumes/],
    ['CgroupParent', (b) => (b.HostConfig.CgroupParent = '/'), /cgroup/],
    ['User root', (b) => (b.User = 'root'), /non-root/],
    ['User 0', (b) => (b.User = '0:0'), /non-root/],
    ['User missing', (b) => delete b.User, /non-root/],
    ['User another non-root uid', (b) => (b.User = '1000:1000'), /non-root/],
    ['Image not on the list', (b) => (b.Image = 'alpine:latest'), /image/],
    [
      'Image by digest of another image',
      (b) => (b.Image = 'aisdlc/sandbox@sha256:' + 'a'.repeat(64)),
      /image/,
    ],
    ['Entrypoint overridden', (b) => (b.Entrypoint = ['/bin/sh']), /Entrypoint/],
    ['Entrypoint missing', (b) => delete b.Entrypoint, /Entrypoint/],
    ['no Labels', (b) => delete b.Labels, /Labels/],
    ['no sandbox label', (b) => delete b.Labels[SANDBOX_LABEL.sandbox], /label/],
    ['no session label', (b) => delete b.Labels[SANDBOX_LABEL.session], /label/],
    ['no class label', (b) => delete b.Labels[SANDBOX_LABEL.class], /label/],
    ['unknown class label', (b) => (b.Labels[SANDBOX_LABEL.class] = 'root'), /class/],
    [
      'the peer label (compose sets it)',
      (b) => (b.Labels[SANDBOX_LABEL.peer] = 'gateway'),
      /compose/,
    ],
    ['an extra label', (b) => (b.Labels['com.docker.compose.project'] = 'x'), /allow-list/],
    ['Tty', (b) => (b.Tty = true), /Tty/],
    ['OpenStdin', (b) => (b.OpenStdin = true), /OpenStdin/],
    ['AttachStdin', (b) => (b.AttachStdin = true), /AttachStdin/],
    ['Healthcheck', (b) => (b.Healthcheck = { Test: ['CMD', 'x'] }), /Healthcheck/],
    ['ExposedPorts', (b) => (b.ExposedPorts = { '80/tcp': {} }), /ExposedPorts/],
    ['NetworkingConfig', (b) => (b.NetworkingConfig = { EndpointsConfig: {} }), /NetworkingConfig/],
    ['MacAddress', (b) => (b.MacAddress = 'aa:bb:cc:dd:ee:ff'), /MacAddress/],
    ['WorkingDir /', (b) => (b.WorkingDir = '/'), /WorkingDir/],
    ['Env with a key', (b) => b.Env.push('ANTHROPIC_API_KEY=x'), /Env refused/],
    ['Env with a token', (b) => b.Env.push('GITHUB_TOKEN=x'), /Env refused/],
    ['Env with a canary name', (b) => b.Env.push('AISDLC_CANARY_X=x'), /Env refused/],
    ['Env with another AISDLC_ name', (b) => b.Env.push('AISDLC_ADMIN=1'), /Env refused/],
    [
      'Env gateway key on a class without one',
      (b) => b.Env.push('AISDLC_GATEWAY_KEY=vk_abcdefgh1234'),
      /gateway key/,
    ],
    ['Env twice', (b) => b.Env.push('LANG=C'), /twice/],
    ['Env without =', (b) => b.Env.push('NOEQUALS'), /NAME=value/],
    ['Cmd missing', (b) => delete b.Cmd, /Cmd/],
    ['Cmd not strings', (b) => (b.Cmd = [1]), /Cmd/],
    ['body is an array', () => undefined, /object/],
  ];
  it.each(cases)('%s', (_name, mutate, why) => {
    const b = _name === 'body is an array' ? [] : mutated(mutate);
    const reason = refused(b);
    expect(reason, _name).not.toBeNull();
    expect(reason, _name).toMatch(why);
  });

  it('a K-class body cannot ask for a network, a W-class body must name its own session network', () => {
    expect(
      refused(mutated((b) => (b.HostConfig.NetworkMode = 'aisdlc-sbx-net-sess-000001'))),
    ).toMatch(/NIC/);
    expect(
      refused(mutated((b) => (b.HostConfig.NetworkMode = 'aisdlc-sbx-net-sess-999999'), 'W')),
    ).toMatch(/session network/);
    expect(refused(mutated((b) => (b.HostConfig.NetworkMode = 'none'), 'W'))).toMatch(
      /session network/,
    );
  });
  it('the narrow (cvw) proxy starts network-less sandboxes only', () => {
    expect(refused(validBody('K'), cfg({ allowNetworks: false }))).toBeNull();
    expect(refused(validBody('K-exec'), cfg({ allowNetworks: false }))).toMatch(/network-less/);
    expect(refused(validBody('W'), cfg({ allowNetworks: false }))).toMatch(/network-less/);
  });
  it('the container name must be the session name', () => {
    const d = validateCreate(validBody('K'), new Map([['name', 'postgres']]), cfg());
    expect(!d.allow && d.reason).toMatch(/name must be/);
    expect(validateCreate(validBody('K'), new Map(), cfg()).allow).toBe(false);
  });
  it('K gets no exec tmpfs; K-exec may', () => {
    expect(
      refused(
        mutated(
          (b) =>
            (b.HostConfig.Tmpfs['/work'] = b.HostConfig.Tmpfs['/work'].replace('noexec', 'exec')),
        ),
      ),
    ).toMatch(/exec is not allowed/);
  });
});

describe('networks', () => {
  const body = (over: Body = {}) => ({
    Name: 'aisdlc-sbx-net-sess-000001',
    Driver: 'bridge',
    Internal: true,
    Labels: { [SANDBOX_LABEL.sandbox]: '1', [SANDBOX_LABEL.session]: 'sess-000001' },
    ...over,
  });
  it('creates an internal session bridge and nothing else', () => {
    expect(validateNetworkCreate(body(), cfg()).allow).toBe(true);
    for (const [name, over] of [
      ['not internal', { Internal: false }],
      ['Internal missing', { Internal: undefined }],
      ['other driver', { Driver: 'host' }],
      ['macvlan', { Driver: 'macvlan' }],
      ['other name', { Name: 'bridge2' }],
      ['name of another prefix', { Name: 'aisdlc-smoke_app' }],
      ['attachable', { Attachable: true }],
      ['ipv6', { EnableIPv6: true }],
      ['options', { Options: { 'com.docker.network.bridge.host_binding_ipv4': '0.0.0.0' } }],
      ['ConfigFrom', { ConfigFrom: { Network: 'x' } }],
      ['IPAM', { IPAM: { Config: [{ Subnet: '10.0.0.0/8' }] } }],
      [
        'label mismatch',
        { Labels: { [SANDBOX_LABEL.sandbox]: '1', [SANDBOX_LABEL.session]: 'sess-999999' } },
      ],
      ['no labels', { Labels: undefined }],
    ] as Array<[string, Body]>) {
      expect(validateNetworkCreate(body(over), cfg()).allow, name).toBe(false);
    }
  });
  it('the narrow proxy creates and connects nothing', () => {
    expect(validateNetworkCreate(body(), cfg({ allowNetworks: false })).allow).toBe(false);
    expect(
      validateConnect(
        { Container: 'x', EndpointConfig: { Aliases: ['gateway'] } },
        'connect',
        cfg({ allowNetworks: false }),
      ).allow,
    ).toBe(false);
  });
  it('connects a peer under its fixed alias only', () => {
    const ok = validateConnect(
      { Container: 'aisdlc-gateway', EndpointConfig: { Aliases: ['gateway'] } },
      'connect',
      cfg(),
    );
    expect(ok.allow && ok.value.peer).toBe('gateway');
    const mirror = validateConnect(
      { Container: 'm', EndpointConfig: { Aliases: ['package-mirror'] } },
      'connect',
      cfg(),
    );
    expect(mirror.allow && mirror.value.peer).toBe('mirror');
    for (const b of [
      { Container: 'x', EndpointConfig: { Aliases: ['evil'] } },
      { Container: 'x', EndpointConfig: { Aliases: ['gateway', 'package-mirror'] } },
      {
        Container: 'x',
        EndpointConfig: { Aliases: ['gateway'], IPAMConfig: { IPv4Address: '10.0.0.5' } },
      },
      { Container: 'x', EndpointConfig: { Aliases: ['gateway'], Links: ['db'] } },
      { Container: '../x', EndpointConfig: { Aliases: ['gateway'] } },
      { Container: 'x' },
    ]) {
      expect(validateConnect(b, 'connect', cfg()).allow, JSON.stringify(b)).toBe(false);
    }
  });
});
