import {
  SANDBOX_GID,
  SANDBOX_LABEL,
  SANDBOX_NAME_PREFIX,
  SANDBOX_OWNER,
  SANDBOX_PEER_ALIAS,
  SANDBOX_PROFILES,
  SANDBOX_SESSION_ID,
  SANDBOX_UID,
  SandboxClass,
  SandboxPeer,
  sandboxEnvViolations,
  type SandboxClass as SandboxClassT,
} from '@aisdlc/contracts';

// The allow-list of the Docker socket proxy (PLAN M13.2; RV §3.4). Pure functions: a request in, a decision out.
//
// The rule of the whole file: NOTHING is allowed unless it is named here. A route that is not in `route()` is
// refused (EXEC, BUILD, image pull, volumes, swarm, plugins, commit, attach, update, rename, prune, events,
// system, everything). A create body is checked key by key against an allow-list of keys with exact-case
// names (Docker's JSON decoder matches field names case-insensitively, so `{"privileged": true}` would reach
// the daemon as `Privileged`: an allow-list of exact names refuses it as an unknown key instead of letting a
// deny-list miss it), and the body that is forwarded is the one this file re-serialised, never the client's
// bytes. A body that asks for more than its class's profile ceiling is refused.

export interface PolicyConfig {
  /** Images a sandbox may be created from, exact references. A pull is never allowed, so the image must exist. */
  readonly images: readonly string[];
  /** The one entrypoint (the in-image wrapper `aisdlc-run`, which ships `/out` through the log stream). */
  readonly entrypoint: readonly string[];
  /** The directory (as the DAEMON sees it) a bind mount may come from: `<root>/<session>/repo`, read-only, nothing else. */
  readonly scratchRoot: string;
  /** The `cvw` instance: false (no network verbs; every sandbox is `NetworkMode: none`). The coding instance: true. */
  readonly allowNetworks: boolean;
  /** At most this many sandbox containers exist at once (created, running or paused). */
  readonly maxSandboxes: number;
  /** At most this many containers of a coding class (`W`) exist at once (RV §3.4). */
  readonly codingCap: number;
  /** Archive paths a client may read / write (exact). Empty by default: the driver ships `/out` through the log stream and mounts the repo read-only. */
  readonly archiveGet: readonly string[];
  readonly archivePut: readonly string[];
  /** Cap on an archive upload. */
  readonly maxArchiveBytes: number;
  /**
   * M19: this proxy instance's name (`DOCKER_PROXY_OWNER`, default `local`). It labels everything it creates with it
   * (`SANDBOX_LABEL.owner`), and it lists, inspects, stops and removes only what carries it: one runner host's sweep
   * after a crash never reaches another host's sandboxes on the same daemon.
   */
  readonly owner?: string;
}

/** The owner a proxy labels with and answers for. */
export const ownerOf = (cfg: PolicyConfig): string => cfg.owner ?? 'local';

export type Decision<T = unknown> =
  | { readonly allow: true; readonly value: T }
  | { readonly allow: false; readonly status: number; readonly reason: string };

const allow = <T>(value: T): Decision<T> => ({ allow: true, value });
const deny = (reason: string, status = 403): Decision<never> => ({ allow: false, status, reason });

// ---------------------------------------------------------------------------------------------- routes

export type RouteKind =
  | 'ping'
  | 'container_create'
  | 'container_start'
  | 'container_wait'
  | 'container_kill'
  | 'container_logs'
  | 'container_inspect'
  | 'container_archive_get'
  | 'container_archive_put'
  | 'container_delete'
  | 'network_create'
  | 'network_connect'
  | 'network_disconnect'
  | 'network_delete'
  /** M19: this proxy's own sandboxes (the filter is the proxy's, never the client's): the sweep after a crash. */
  | 'container_list'
  | 'network_list';

export interface Route {
  readonly kind: RouteKind;
  /** The container or network named in the path, if any. */
  readonly id: string | null;
  /** The path as the daemon will see it (without the query), version prefix kept. */
  readonly path: string;
  readonly query: ReadonlyMap<string, string>;
}

const VERSION = /^\/v1\.\d{2}(?=\/)/;
const CONTAINER_ID = /^(?:[a-f0-9]{12,64}|aisdlc-sbx-[a-z0-9][a-z0-9-]{5,47})$/;
const NETWORK_ID = /^(?:[a-f0-9]{12,64}|aisdlc-sbx-net-[a-z0-9][a-z0-9-]{5,47})$/;
/** A path is matched as raw text. No decoding, no normalisation: whatever does not match a route verbatim is refused. */
const SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;

/**
 * Maps a request to a route, or refuses it. Strict by construction: a path with `%`, `..`, `//`, a trailing
 * slash or any character outside `[A-Za-z0-9_./-]` never reaches a route; a query parameter a route does not
 * list is refused; a parameter may appear once.
 */
export function route(method: string, rawUrl: string): Decision<Route> {
  const q = rawUrl.indexOf('?');
  const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const rawQuery = q === -1 ? '' : rawUrl.slice(q + 1);
  if (!SAFE_PATH.test(rawPath) || rawPath.includes('//') || rawPath.includes('..')) {
    return deny('path refused');
  }
  if (rawPath.length > 256) return deny('path too long');
  const query = new Map<string, string>();
  if (rawQuery !== '') {
    for (const part of rawQuery.split('&')) {
      const eq = part.indexOf('=');
      const k = eq === -1 ? part : part.slice(0, eq);
      const v = eq === -1 ? '' : part.slice(eq + 1);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(k) || !/^[A-Za-z0-9_.\-/,:]{0,256}$/.test(v)) {
        return deny('query refused');
      }
      if (query.has(k)) return deny(`query parameter ${k} twice`);
      query.set(k, v);
    }
  }
  const path = rawPath.replace(VERSION, '');
  const only = (
    kind: RouteKind,
    id: string | null,
    allowedParams: readonly string[],
  ): Decision<Route> => {
    for (const k of query.keys()) {
      if (!allowedParams.includes(k)) return deny(`query parameter ${k} is not allowed on ${kind}`);
    }
    return allow({ kind, id, path: rawPath, query });
  };
  const seg = path.split('/');
  // seg[0] is ''
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/_ping') return only('ping', null, []);
  }
  if (method === 'GET' && path === '/containers/json') return only('container_list', null, ['all']);
  if (method === 'GET' && path === '/networks') return only('network_list', null, []);
  if (seg[1] === 'containers') {
    if (method === 'POST' && seg.length === 3 && seg[2] === 'create') {
      return only('container_create', null, ['name']);
    }
    const id = seg[2];
    if (id !== undefined && id !== 'create' && seg.length >= 3) {
      if (!CONTAINER_ID.test(id)) return deny('container reference refused');
      if (seg.length === 3 && method === 'DELETE')
        return only('container_delete', id, ['force', 'v']);
      const verb = seg[3];
      if (seg.length === 4 && verb !== undefined) {
        if (method === 'POST' && verb === 'start') return only('container_start', id, []);
        if (method === 'POST' && verb === 'wait') return only('container_wait', id, ['condition']);
        if (method === 'POST' && verb === 'kill') return only('container_kill', id, ['signal']);
        if (method === 'GET' && verb === 'logs') {
          return only('container_logs', id, ['stdout', 'stderr', 'follow', 'timestamps', 'tail']);
        }
        if (method === 'GET' && verb === 'json') return only('container_inspect', id, []);
        if (method === 'GET' && verb === 'archive')
          return only('container_archive_get', id, ['path']);
        if (method === 'PUT' && verb === 'archive') {
          return only('container_archive_put', id, ['path', 'noOverwriteDirNonDir']);
        }
      }
    }
  }
  if (seg[1] === 'networks') {
    if (method === 'POST' && seg.length === 3 && seg[2] === 'create')
      return only('network_create', null, []);
    const id = seg[2];
    if (id !== undefined && id !== 'create' && id !== 'prune') {
      if (!NETWORK_ID.test(id)) return deny('network reference refused');
      if (seg.length === 3 && method === 'DELETE') return only('network_delete', id, []);
      if (seg.length === 4 && method === 'POST' && seg[3] === 'connect')
        return only('network_connect', id, []);
      if (seg.length === 4 && method === 'POST' && seg[3] === 'disconnect') {
        return only('network_disconnect', id, []);
      }
    }
  }
  return deny(`${method} ${path.split('/').slice(0, 3).join('/')} is not on the allow-list`);
}

// ---------------------------------------------------------------------------------------------- small checks

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const MIB = 1024 * 1024;

/** The keys of `o` that are not in `allowedKeys`, as a refusal naming the first (and the explicit reason for the dangerous ones). */
const DANGEROUS: Readonly<Record<string, string>> = {
  Privileged: 'privileged containers are refused',
  CapAdd: 'adding capabilities is refused',
  Devices: 'devices are refused',
  DeviceCgroupRules: 'devices are refused',
  DeviceRequests: 'devices are refused',
  PidMode: 'the host PID namespace is refused',
  IpcMode: 'the host IPC namespace is refused',
  UTSMode: 'the host UTS namespace is refused',
  UsernsMode: 'user namespace overrides are refused',
  Sysctls: 'sysctls are refused',
  VolumesFrom: 'volumes-from is refused',
  Volumes: 'volumes are refused',
  Mounts: 'mounts are refused (tmpfs and the one read-only repo bind are separate keys)',
  Runtime: 'runtime overrides are refused',
  CgroupParent: 'cgroup parents are refused',
  Cgroup: 'cgroup overrides are refused',
  Links: 'links are refused',
  PortBindings: 'published ports are refused',
  PublishAllPorts: 'published ports are refused',
  Dns: 'DNS overrides are refused',
  ExtraHosts: 'extra hosts are refused',
  StorageOpt: 'storage options are refused',
  Isolation: 'isolation overrides are refused',
  AutoRemove: 'auto-remove is refused (the driver removes what it made)',
  OomKillDisable: 'disabling the OOM killer is refused',
};
function unknownKey(o: Obj, allowedKeys: readonly string[], where: string): string | null {
  for (const k of Object.keys(o)) {
    if (allowedKeys.includes(k)) continue;
    const exact = DANGEROUS[k];
    const lower = Object.keys(DANGEROUS).find((d) => d.toLowerCase() === k.toLowerCase());
    return `${where}.${k}: ${exact ?? (lower ? DANGEROUS[lower] : 'not on the allow-list')}`;
  }
  return null;
}

const sessionNet = (session: string) => `${SANDBOX_NAME_PREFIX}net-${session}`;
const sessionName = (session: string) => `${SANDBOX_NAME_PREFIX}${session}`;

// ---------------------------------------------------------------------------------------------- create container

export interface CreatePlan {
  /** The re-serialised body to forward. */
  readonly body: string;
  /** The query to forward (only `name`). */
  readonly name: string;
  readonly session: string;
  readonly class: SandboxClassT;
}

const CONTAINER_KEYS = [
  'Image',
  'Cmd',
  'Entrypoint',
  'Env',
  'User',
  'WorkingDir',
  'Labels',
  'HostConfig',
  'StopTimeout',
  'AttachStdin',
  'AttachStdout',
  'AttachStderr',
  'Tty',
  'OpenStdin',
  'StdinOnce',
] as const;

const HOST_KEYS = [
  'Binds',
  'Tmpfs',
  'NetworkMode',
  'Memory',
  'MemorySwap',
  'NanoCpus',
  'PidsLimit',
  'ReadonlyRootfs',
  'CapDrop',
  'SecurityOpt',
  'Ulimits',
  'LogConfig',
  'Init',
  'IpcMode',
] as const;

const TMPFS_TARGETS = ['/out', '/work', '/tmp'] as const;

/** `size=16777216,uid=10002,...` checked option by option; `null` when fine, else why not. */
function tmpfsOptions(
  target: string,
  opts: string,
  maxBytes: number,
  wantExec: boolean,
): string | null {
  let size = 0;
  const seen = new Set<string>();
  for (const part of opts.split(',')) {
    const [k, v] = part.split('=') as [string, string | undefined];
    if (seen.has(k)) return `Tmpfs ${target}: option ${k} twice`;
    seen.add(k);
    switch (k) {
      case 'rw':
      case 'nosuid':
      case 'nodev':
        if (v !== undefined) return `Tmpfs ${target}: option ${k} takes no value`;
        break;
      case 'noexec':
      case 'exec':
        if (v !== undefined) return `Tmpfs ${target}: option ${k} takes no value`;
        break;
      case 'size':
        if (v === undefined || !/^[0-9]{1,12}$/.test(v))
          return `Tmpfs ${target}: size must be bytes`;
        size = Number(v);
        break;
      case 'uid':
        if (v !== String(SANDBOX_UID)) return `Tmpfs ${target}: uid must be ${SANDBOX_UID}`;
        break;
      case 'gid':
        if (v !== String(SANDBOX_GID)) return `Tmpfs ${target}: gid must be ${SANDBOX_GID}`;
        break;
      case 'mode':
        if (v !== '0700' && v !== '1777' && v !== '0755')
          return `Tmpfs ${target}: mode ${String(v)} refused`;
        break;
      default:
        return `Tmpfs ${target}: option ${k} is not on the allow-list`;
    }
  }
  if (size <= 0) return `Tmpfs ${target}: a size is required`;
  if (size > maxBytes) return `Tmpfs ${target}: size ${size} is above the ceiling ${maxBytes}`;
  if (target === '/out' && (seen.has('exec') || !seen.has('noexec')))
    return 'Tmpfs /out must be noexec';
  if (!wantExec && seen.has('exec')) return `Tmpfs ${target}: exec is not allowed for this class`;
  if (!seen.has('nosuid') || !seen.has('nodev'))
    return `Tmpfs ${target}: nosuid and nodev are required`;
  return null;
}

/**
 * Validates a `POST /containers/create`. The refusal text names the first thing wrong. Everything the profile
 * of the class fixes (network, memory, pids, cpus, tmpfs sizes, exec) is checked against that ceiling.
 */
export function validateCreate(
  rawBody: unknown,
  query: ReadonlyMap<string, string>,
  cfg: PolicyConfig,
): Decision<CreatePlan> {
  if (!isObj(rawBody)) return deny('the body must be a JSON object');
  const unknown = unknownKey(rawBody, CONTAINER_KEYS, 'body');
  if (unknown) return deny(unknown);
  const body = rawBody;

  // identity: labels first, everything else is checked against the class they name
  const labels = body['Labels'];
  if (!isObj(labels)) return deny('Labels are required');
  for (const k of Object.keys(labels)) {
    if (k === SANDBOX_LABEL.peer) return deny(`label ${k} is set by compose only`);
    if (k !== SANDBOX_LABEL.sandbox && k !== SANDBOX_LABEL.session && k !== SANDBOX_LABEL.class) {
      return deny(`label ${k} is not on the allow-list`);
    }
  }
  if (labels[SANDBOX_LABEL.sandbox] !== '1')
    return deny(`label ${SANDBOX_LABEL.sandbox}=1 is required`);
  const session = labels[SANDBOX_LABEL.session];
  if (typeof session !== 'string' || !SANDBOX_SESSION_ID.test(session)) {
    return deny(`label ${SANDBOX_LABEL.session} must be a session id`);
  }
  const cls = SandboxClass.safeParse(labels[SANDBOX_LABEL.class]);
  if (!cls.success) return deny(`label ${SANDBOX_LABEL.class} must be a sandbox class`);
  const profile = SANDBOX_PROFILES[cls.data];
  const name = query.get('name');
  if (name !== sessionName(session))
    return deny(`the container name must be ${sessionName(session)}`);

  const image = body['Image'];
  if (typeof image !== 'string' || !cfg.images.includes(image)) {
    return deny('the image is not on the allow-list (a pull is never allowed)');
  }
  const ep = body['Entrypoint'];
  if (
    !Array.isArray(ep) ||
    ep.length !== cfg.entrypoint.length ||
    ep.some((e, i) => e !== cfg.entrypoint[i])
  ) {
    return deny('Entrypoint must be the sandbox wrapper');
  }
  const cmd = body['Cmd'];
  if (
    !Array.isArray(cmd) ||
    cmd.length < 1 ||
    cmd.length > 64 ||
    cmd.some((c) => typeof c !== 'string' || c.length > 4096 || c.includes('\0'))
  ) {
    return deny('Cmd must be 1 to 64 strings');
  }
  if (body['User'] !== `${SANDBOX_UID}:${SANDBOX_GID}`) {
    return deny(`User must be ${SANDBOX_UID}:${SANDBOX_GID} (non-root)`);
  }
  const wd = body['WorkingDir'];
  if (wd !== undefined && wd !== '/work' && wd !== '/repo')
    return deny('WorkingDir must be /work or /repo');
  for (const k of ['AttachStdin', 'Tty', 'OpenStdin', 'StdinOnce'] as const) {
    if (body[k] !== undefined && body[k] !== false) return deny(`${k} must be false`);
  }
  const st = body['StopTimeout'];
  if (st !== undefined && !isInt(st, 0, 10)) return deny('StopTimeout must be 0 to 10');

  // environment: names against the class (no credential, no reserved name), values bounded
  const envList = body['Env'];
  if (envList !== undefined) {
    if (!Array.isArray(envList) || envList.length > 48)
      return deny('Env must be at most 48 strings');
    const env: Record<string, string> = {};
    for (const e of envList) {
      if (typeof e !== 'string' || e.length > 8192 || e.includes('\0'))
        return deny('Env entry refused');
      const i = e.indexOf('=');
      if (i < 1) return deny('Env entries are NAME=value');
      const n = e.slice(0, i);
      if (n in env) return deny(`Env ${n} twice`);
      env[n] = e.slice(i + 1);
    }
    const bad = sandboxEnvViolations(env, cls.data, true);
    if (bad.length > 0) return deny(`Env refused: ${bad.join('; ')}`);
  }

  // host config
  const host = body['HostConfig'];
  if (!isObj(host)) return deny('HostConfig is required');
  const hu = unknownKey(host, HOST_KEYS, 'HostConfig');
  if (hu) return deny(hu);
  if (host['ReadonlyRootfs'] !== true) return deny('HostConfig.ReadonlyRootfs must be true');
  const capDrop = host['CapDrop'];
  if (!Array.isArray(capDrop) || capDrop.length !== 1 || capDrop[0] !== 'ALL') {
    return deny('HostConfig.CapDrop must be exactly ["ALL"]');
  }
  const sec = host['SecurityOpt'];
  if (
    !Array.isArray(sec) ||
    sec.length === 0 ||
    sec.some((s) => s !== 'no-new-privileges' && s !== 'no-new-privileges:true')
  ) {
    return deny(
      'HostConfig.SecurityOpt must be no-new-privileges only (the default seccomp profile stays; unconfined is refused)',
    );
  }
  if (host['IpcMode'] !== 'private') return deny('HostConfig.IpcMode must be "private"');
  const init = host['Init'];
  if (init !== undefined && typeof init !== 'boolean')
    return deny('HostConfig.Init must be a boolean');

  // resource limits are REQUIRED and bounded by the class's ceiling
  const lim = profile.limits;
  const mem = host['Memory'];
  if (!isInt(mem, 64 * MIB, lim.memory_mb * MIB)) {
    return deny(
      `HostConfig.Memory is required and at most ${lim.memory_mb} MiB for class ${cls.data}`,
    );
  }
  if (host['MemorySwap'] !== mem) return deny('HostConfig.MemorySwap must equal Memory (no swap)');
  const cpus = host['NanoCpus'];
  if (!isInt(cpus, 10_000_000, lim.cpus * 1_000_000_000)) {
    return deny(
      `HostConfig.NanoCpus is required and at most ${lim.cpus} CPUs for class ${cls.data}`,
    );
  }
  if (!isInt(host['PidsLimit'], 16, lim.pids)) {
    return deny(`HostConfig.PidsLimit is required and at most ${lim.pids} for class ${cls.data}`);
  }
  const ulimits = host['Ulimits'];
  if (ulimits !== undefined) {
    if (!Array.isArray(ulimits) || ulimits.length > 2) return deny('HostConfig.Ulimits refused');
    for (const u of ulimits) {
      if (!isObj(u) || unknownKey(u, ['Name', 'Soft', 'Hard'], 'Ulimit'))
        return deny('HostConfig.Ulimits entry refused');
      const ok =
        (u['Name'] === 'nofile' && isInt(u['Soft'], 1, 4096) && isInt(u['Hard'], 1, 4096)) ||
        (u['Name'] === 'core' && u['Soft'] === 0 && u['Hard'] === 0);
      if (!ok) return deny('HostConfig.Ulimits: only nofile (at most 4096) and core=0');
    }
  }
  // the log stream is the only place a sandbox's output is kept on the host: bound it, or one spamming test fills the disk
  const log = host['LogConfig'];
  if (
    !isObj(log) ||
    unknownKey(log, ['Type', 'Config'], 'LogConfig') ||
    log['Type'] !== 'json-file' ||
    !isObj(log['Config'])
  ) {
    return deny('HostConfig.LogConfig must be json-file with a bounded size');
  }
  const lc = log['Config'];
  const maxSize = /^([0-9]{1,3})m$/.exec(String(lc['max-size']));
  const maxFile = lc['max-file'];
  if (
    unknownKey(lc, ['max-size', 'max-file'], 'LogConfig.Config') ||
    !maxSize ||
    Number(maxSize[1]) < 1 ||
    Number(maxSize[1]) > 128 ||
    (maxFile !== '1' && maxFile !== '2')
  ) {
    return deny('HostConfig.LogConfig.Config needs max-size (1m..128m) and max-file (1 or 2)');
  }

  // network
  const nm = host['NetworkMode'];
  if (profile.network === 'none') {
    if (nm !== 'none') return deny(`class ${cls.data} has no NIC: NetworkMode must be "none"`);
  } else {
    if (!cfg.allowNetworks)
      return deny(
        `this proxy starts only network-less sandboxes; class ${cls.data} needs a session network`,
      );
    if (nm !== sessionNet(session))
      return deny(`NetworkMode must be the session network ${sessionNet(session)}`);
  }

  // the repo: one read-only bind, from the scratch root, for this session, to /repo
  const binds = host['Binds'];
  const wantBind = `${cfg.scratchRoot}/${session}/repo:/repo:ro`;
  if (!Array.isArray(binds) || binds.length !== 1 || binds[0] !== wantBind) {
    return deny(
      `HostConfig.Binds must be exactly ["${wantBind}"] (a read-only copy under the scratch root; no other bind, never the Docker socket)`,
    );
  }
  // writable scratch: tmpfs only, sized
  const tmpfs = host['Tmpfs'];
  if (!isObj(tmpfs)) return deny('HostConfig.Tmpfs is required (/out, /work, /tmp)');
  for (const t of Object.keys(tmpfs)) {
    if (!(TMPFS_TARGETS as readonly string[]).includes(t))
      return deny(`Tmpfs ${t} is not on the allow-list`);
  }
  for (const t of TMPFS_TARGETS) {
    const opts = tmpfs[t];
    if (typeof opts !== 'string') return deny(`Tmpfs ${t} is required`);
    const max = t === '/out' ? lim.out_bytes : lim.work_bytes;
    const why = tmpfsOptions(t, opts, max, profile.exec);
    if (why) return deny(why);
  }

  // rebuild the body from the validated pieces only
  const clean = {
    Image: image,
    Entrypoint: [...(ep as string[])],
    Cmd: [...(cmd as string[])],
    ...(envList !== undefined ? { Env: [...(envList as string[])] } : {}),
    User: body['User'],
    ...(wd !== undefined ? { WorkingDir: wd } : {}),
    Labels: {
      [SANDBOX_LABEL.sandbox]: '1',
      [SANDBOX_LABEL.session]: session,
      [SANDBOX_LABEL.class]: cls.data,
      [SANDBOX_LABEL.owner]: ownerOf(cfg),
    },
    ...(st !== undefined ? { StopTimeout: st } : {}),
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      Binds: [wantBind],
      Tmpfs: Object.fromEntries(TMPFS_TARGETS.map((t) => [t, tmpfs[t]])),
      NetworkMode: nm,
      Memory: mem,
      MemorySwap: mem,
      NanoCpus: cpus,
      PidsLimit: host['PidsLimit'],
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ...(ulimits !== undefined ? { Ulimits: ulimits } : {}),
      LogConfig: { Type: 'json-file', Config: { 'max-size': lc['max-size'], 'max-file': maxFile } },
      ...(init !== undefined ? { Init: init } : {}),
      IpcMode: 'private',
    },
  };
  return allow({ body: JSON.stringify(clean), name, session, class: cls.data });
}

// ---------------------------------------------------------------------------------------------- networks

export interface NetworkCreatePlan {
  readonly body: string;
  readonly session: string;
}

/** `POST /networks/create`: a per-session `--internal` bridge, labelled, and nothing else. */
export function validateNetworkCreate(
  rawBody: unknown,
  cfg: PolicyConfig,
): Decision<NetworkCreatePlan> {
  if (!cfg.allowNetworks) return deny('this proxy does not create networks');
  if (!isObj(rawBody)) return deny('the body must be a JSON object');
  const u = unknownKey(
    rawBody,
    ['Name', 'Driver', 'Internal', 'Labels', 'CheckDuplicate', 'Attachable', 'EnableIPv6'],
    'body',
  );
  if (u) return deny(u);
  const nameRe = new RegExp(
    `^${SANDBOX_NAME_PREFIX}net-(${SANDBOX_SESSION_ID.source.slice(1, -1)})$`,
  );
  const m = typeof rawBody['Name'] === 'string' ? nameRe.exec(rawBody['Name']) : null;
  if (!m) return deny(`Name must be ${SANDBOX_NAME_PREFIX}net-<session>`);
  const session = m[1] as string;
  if (rawBody['Driver'] !== undefined && rawBody['Driver'] !== 'bridge')
    return deny('Driver must be bridge');
  if (rawBody['Internal'] !== true)
    return deny('Internal must be true: a session network has no route out');
  for (const k of ['Attachable', 'EnableIPv6'] as const) {
    if (rawBody[k] !== undefined && rawBody[k] !== false) return deny(`${k} must be false`);
  }
  const labels = rawBody['Labels'];
  if (
    !isObj(labels) ||
    Object.keys(labels).length !== 2 ||
    labels[SANDBOX_LABEL.sandbox] !== '1' ||
    labels[SANDBOX_LABEL.session] !== session
  ) {
    return deny(
      `Labels must be exactly ${SANDBOX_LABEL.sandbox}=1 and ${SANDBOX_LABEL.session}=${session}`,
    );
  }
  return allow({
    session,
    body: JSON.stringify({
      Name: rawBody['Name'],
      Driver: 'bridge',
      Internal: true,
      Attachable: false,
      EnableIPv6: false,
      CheckDuplicate: true,
      Labels: {
        [SANDBOX_LABEL.sandbox]: '1',
        [SANDBOX_LABEL.session]: session,
        [SANDBOX_LABEL.owner]: ownerOf(cfg),
      },
    }),
  });
}

export interface ConnectPlan {
  readonly body: string;
  /** The container to be looked up: its `aisdlc.sandbox.peer` label must name the peer whose alias this is. */
  readonly container: string;
  readonly peer: SandboxPeer | null;
  readonly alias: string | null;
}

/** `POST /networks/{id}/connect|disconnect`: a peer container (gateway, mirror) onto or off a session network, under its fixed alias. */
export function validateConnect(
  rawBody: unknown,
  verb: 'connect' | 'disconnect',
  cfg: PolicyConfig,
): Decision<ConnectPlan> {
  if (!cfg.allowNetworks) return deny('this proxy does not connect networks');
  if (!isObj(rawBody)) return deny('the body must be a JSON object');
  const u = unknownKey(
    rawBody,
    verb === 'connect' ? ['Container', 'EndpointConfig'] : ['Container', 'Force'],
    'body',
  );
  if (u) return deny(u);
  const c = rawBody['Container'];
  if (typeof c !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(c))
    return deny('Container refused');
  if (verb === 'disconnect') {
    if (rawBody['Force'] !== undefined && typeof rawBody['Force'] !== 'boolean')
      return deny('Force must be a boolean');
    return allow({
      container: c,
      peer: null,
      alias: null,
      body: JSON.stringify({ Container: c, Force: rawBody['Force'] === true }),
    });
  }
  const ep = rawBody['EndpointConfig'];
  if (!isObj(ep) || unknownKey(ep, ['Aliases'], 'EndpointConfig'))
    return deny('EndpointConfig.Aliases is required');
  const aliases = ep['Aliases'];
  if (!Array.isArray(aliases) || aliases.length !== 1 || typeof aliases[0] !== 'string') {
    return deny('exactly one alias');
  }
  const peer = (Object.keys(SANDBOX_PEER_ALIAS) as SandboxPeer[]).find(
    (p) => SANDBOX_PEER_ALIAS[p] === aliases[0],
  );
  if (!peer) return deny(`alias ${aliases[0]} is not a peer alias`);
  return allow({
    container: c,
    peer,
    alias: aliases[0],
    body: JSON.stringify({ Container: c, EndpointConfig: { Aliases: [aliases[0]] } }),
  });
}

/** What an inspect of a peer must say for it to be attached: the compose label names this very peer. */
export function peerLabelOk(labels: unknown, peer: SandboxPeer): boolean {
  return isObj(labels) && SandboxPeer.safeParse(labels[SANDBOX_LABEL.peer]).data === peer;
}

/** The sandbox label on an inspected container or network. */
export function isSandboxLabelled(labels: unknown): boolean {
  return isObj(labels) && labels[SANDBOX_LABEL.sandbox] === '1';
}

/** M19: the sandbox label AND this proxy's owner label (what a proxy may touch). */
export function isOwnedBy(labels: unknown, owner: string): boolean {
  return isSandboxLabelled(labels) && isObj(labels) && labels[SANDBOX_LABEL.owner] === owner;
}

/** M19: `all` on a list is `true`, `1` or absent; the filter is never the client's. */
export function validateList(q: ReadonlyMap<string, string>): Decision {
  const all = q.get('all');
  return all === undefined || all === 'true' || all === '1'
    ? allow(undefined)
    : deny('all must be true');
}

/** M19: a valid owner name, or a configuration error. */
export const validOwner = (o: string): boolean => SANDBOX_OWNER.test(o);

// ---------------------------------------------------------------------------------------------- the rest

export function validateWaitCondition(q: ReadonlyMap<string, string>): Decision {
  const c = q.get('condition');
  return c === undefined || c === 'not-running' || c === 'next-exit' || c === 'removed'
    ? allow(undefined)
    : deny('condition refused');
}

export function validateKill(q: ReadonlyMap<string, string>): Decision {
  const s = q.get('signal');
  return s === undefined || s === 'KILL' || s === 'SIGKILL' ? allow(undefined) : deny('only KILL');
}

export function validateLogs(q: ReadonlyMap<string, string>): Decision {
  for (const [k, v] of q) {
    if (k === 'tail') {
      if (v !== 'all' && !/^[0-9]{1,9}$/.test(v)) return deny('tail refused');
    } else if (v !== '0' && v !== '1' && v !== 'true' && v !== 'false')
      return deny(`${k} must be a boolean`);
  }
  return allow(undefined);
}

export function validateDelete(q: ReadonlyMap<string, string>): Decision {
  for (const [k, v] of q) {
    if ((k === 'force' || k === 'v') && (v === 'true' || v === '1' || v === 'false' || v === '0'))
      continue;
    return deny(`${k}=${v} refused`);
  }
  return allow(undefined);
}

export function validateArchive(
  verb: 'get' | 'put',
  q: ReadonlyMap<string, string>,
  cfg: PolicyConfig,
): Decision {
  const p = q.get('path');
  const list = verb === 'get' ? cfg.archiveGet : cfg.archivePut;
  if (p === undefined || !list.includes(p))
    return deny(`archive ${verb} of ${p ?? '(no path)'} is not allowed`);
  const no = q.get('noOverwriteDirNonDir');
  if (no !== undefined && no !== 'true' && no !== '1') return deny('noOverwriteDirNonDir refused');
  return allow(undefined);
}

/** True when a container list entry or counted label says this container still occupies a sandbox slot. */
export const OCCUPIES_SLOT = new Set(['created', 'running', 'restarting', 'paused']);
