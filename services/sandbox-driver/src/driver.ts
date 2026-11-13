import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import {
  SANDBOX_GATEWAY_KEY_ENV,
  SANDBOX_GATEWAY_URL_ENV,
  SANDBOX_GID,
  SANDBOX_LABEL,
  SANDBOX_NAME_PREFIX,
  SANDBOX_PEER_ALIAS,
  SANDBOX_SESSION_ID,
  SANDBOX_UID,
  SECRET_ENV_NAME,
  SANDBOX_WRAPPER_ENV,
  type SandboxLimits,
  type SandboxPeer,
  type SandboxProfile,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  CodingGate,
  outFileOf,
  peersOf,
  preflightSpec,
  sandboxError,
  scanSandboxOutput,
  type PreflightOptions,
  type SandboxError,
  type SandboxPort,
  type SandboxRun,
  type SandboxSpec,
  type SandboxStatus,
} from '@aisdlc/ports';
import { scanText } from '@aisdlc/secrets-rules';
import { DockerApi, type Endpoint } from './docker-api.js';
import { demux, extractOutBlock } from './frames.js';
import { materialiseRepo, removeScratch, type ScratchRoot } from './scratch.js';
import { readTar } from './tar.js';

// DockerSandboxDriver: the SandboxPort adapter that runs a session as a container (PLAN M13.2; RV §3.4).
//
// It talks to Docker ONLY through an allow-list socket proxy (services/docker-proxy): there is no code path to
// /var/run/docker.sock here. For each session it
//   1. writes the repo copy to `<scratch>/<session>/repo` (a fresh directory; no symlinks; no exec bit where the
//      class runs no repo code) and bind-mounts it READ-ONLY at /repo;
//   2. for a class with a network, creates a per-session `--internal` network and attaches ONLY the peers the
//      class allows (the gateway for a class with a key, the package mirror for a class that may install);
//      class K has no NIC at all (`NetworkMode: none`);
//   3. creates the container with everything the proxy demands (read-only root, all capabilities dropped,
//      no-new-privileges, non-root, memory/swap/pids/cpu limits, a bounded log, tmpfs scratch) and checks what
//      the daemon says it created: no credential in the environment, none of the hardening missing;
//   4. waits under the time limit (killing the container at the limit), reads the bounded log stream, takes
//      `/out` out of it (the wrapper ships it as one tar between two markers: tmpfs is invisible to `docker cp`),
//      reads the tar with a strict reader and scans the result (factory canaries and the shared secret rules);
//   5. removes the container, the network and the scratch directory, whatever happened, and reports anything it
//      could not remove.
// Everything the container says is untrusted bytes: capped, parsed strictly, never executed or interpreted.

export interface DriverConfig {
  readonly endpoint: Endpoint;
  /** The sandbox image (it must exist: a pull is never allowed). */
  readonly image: string;
  /**
   * Further images a session may name (`SandboxSpec.image`, by digest): the onboarding probe's (M16). A spec that
   * names any other image is refused before anything is made; the socket proxy keeps its own list.
   */
  readonly images?: readonly string[];
  /**
   * M16 part 3 (LF4): the image id (`sha256:...`) a container of a class must be made from, checked on the daemon's own
   * answer after the create (`Image` of the container's inspect) and before it starts; `undefined`: no check for the
   * class. A mismatch (an empty id included) is refused `image_unverified` and nothing runs.
   */
  readonly expectImageId?: (cls: SandboxSpec['class']) => string | undefined;
  readonly scratch: ScratchRoot;
  /** Container names of the peers a session network may attach, by role. A class that needs a peer not named here does not run. */
  readonly peers: Partial<Record<SandboxPeer, string>>;
  /** What a sandbox with a key calls the gateway. Default `http://gateway:8410`. */
  readonly gatewayUrl?: string;
  /** Commands of the image a class that runs no repo code may run. */
  readonly trustedCommands?: readonly string[];
  readonly apiTimeoutMs?: number;
  /**
   * Portal v2: this driver's own coding gate, read on every W session (the sandbox-controller passes the host's
   * `sandbox.caps.coding`); clamped to `CODING_SESSION_HARD_CEILING`. Default `CODING_SESSION_CAP`.
   */
  readonly codingCap?: () => number;
  /** Portal v2 (`sandbox.profiles`, H28): the lowered class ceilings, read on every spec. */
  readonly ceilings?: PreflightOptions['ceilings'];
}

const MIB = 1024 * 1024;
const MAX_TEXT_LOG = 1_000_000;

/** What a sweep removed (session ids), and what it could not. */
export interface SweepReport {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly scratch: readonly string[];
  readonly errors: readonly string[];
}

export class DockerSandboxDriver implements SandboxPort {
  private readonly api: DockerApi;
  private readonly gate: CodingGate;

  constructor(private readonly cfg: DriverConfig) {
    this.gate = new CodingGate(cfg.codingCap);
    this.api = new DockerApi(cfg.endpoint, { timeoutMs: cfg.apiTimeoutMs ?? 30_000 });
  }

  /** The daemon answers through the proxy. */
  async ping(): Promise<boolean> {
    try {
      return (await this.api.request('GET', '/_ping', { timeoutMs: 5000 })).status === 200;
    } catch {
      return false;
    }
  }

  /**
   * M19 (the runner-killed drill): removes every sandbox of this proxy's owner whose session is not in `keep`, with
   * its session network and its scratch directory. A sandbox-controller that dies mid-session leaves its container
   * running (the daemon does not know the controller died) and the proxy counts it against the caps; the next
   * controller sweeps at boot with nothing to keep (it forgot every session, and each of them was the dead one's) and
   * then periodically with the sessions it runs. The proxy lists only its owner's sandboxes, so another runner host's
   * on the same daemon is never touched. Never throws: what would not go is in `errors`.
   */
  async sweep(keep: ReadonlySet<string> = new Set()): Promise<SweepReport> {
    const out = {
      containers: [] as string[],
      networks: [] as string[],
      scratch: [] as string[],
      errors: [] as string[],
    };
    const sessionOf = (
      row: { session?: unknown; name?: unknown },
      prefix: string,
    ): string | null => {
      const s =
        typeof row.session === 'string'
          ? row.session
          : typeof row.name === 'string' && row.name.startsWith(prefix)
            ? row.name.slice(prefix.length)
            : null;
      return s !== null && SANDBOX_SESSION_ID.test(s) ? s : null;
    };
    try {
      const c = await this.api.json<Array<{ name?: string; session?: string }>>(
        'GET',
        '/containers/json?all=true',
      );
      if (c.status !== 200 || !Array.isArray(c.json))
        out.errors.push(`list containers: ${c.status}`);
      for (const row of Array.isArray(c.json) ? c.json : []) {
        const id = sessionOf(row, SANDBOX_NAME_PREFIX);
        if (id === null || keep.has(id)) continue;
        const r = await this.api
          .request('DELETE', `/containers/${SANDBOX_NAME_PREFIX}${id}?force=true&v=true`, {
            timeoutMs: 30_000,
          })
          .catch(() => ({ status: 0 }));
        if (r.status === 204 || r.status === 404) out.containers.push(id);
        else out.errors.push(`container ${id}: ${r.status}`);
      }
      const n = await this.api.json<Array<{ name?: string; session?: string }>>('GET', '/networks');
      // the cvw proxy has no networks (403): nothing to sweep there
      if (n.status !== 200 && n.status !== 403) out.errors.push(`list networks: ${n.status}`);
      for (const row of n.status === 200 && Array.isArray(n.json) ? n.json : []) {
        const id = sessionOf(row, `${SANDBOX_NAME_PREFIX}net-`);
        if (id === null || keep.has(id)) continue;
        const net = `${SANDBOX_NAME_PREFIX}net-${id}`;
        for (const peer of Object.values(this.cfg.peers)) {
          if (peer === undefined) continue;
          // not attached is fine: only the delete below says whether the network went
          await this.api
            .request('POST', `/networks/${net}/disconnect`, {
              body: { Container: peer, Force: true },
              timeoutMs: 15_000,
            })
            .catch(() => undefined);
        }
        const r = await this.api
          .request('DELETE', `/networks/${net}`, { timeoutMs: 15_000 })
          .catch(() => ({ status: 0 }));
        if (r.status === 204 || r.status === 404) out.networks.push(id);
        else out.errors.push(`network ${id}: ${r.status}`);
      }
    } catch (e) {
      out.errors.push(`proxy: ${e instanceof Error ? e.message : String(e)}`);
    }
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.cfg.scratch.local);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        out.errors.push(`scratch: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`);
    }
    for (const d of dirs) {
      if (!SANDBOX_SESSION_ID.test(d) || keep.has(d)) continue;
      try {
        removeScratch(this.cfg.scratch, d);
        out.scratch.push(d);
      } catch (e) {
        out.errors.push(`scratch ${d}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  async run(spec: SandboxSpec): Promise<Result<SandboxRun, SandboxError>> {
    const opts: PreflightOptions = {
      ...(this.cfg.trustedCommands === undefined
        ? {}
        : { trustedCommands: this.cfg.trustedCommands }),
      ...(this.cfg.ceilings ? { ceilings: this.cfg.ceilings } : {}),
    };
    const pre = preflightSpec(spec, opts);
    if (!pre.ok) return pre;
    if (spec.image !== undefined && !(this.cfg.images ?? []).includes(spec.image)) {
      return err(sandboxError('refused', 'the image named is not one this host may run'));
    }
    const release = this.gate.tryAcquire(spec.class);
    if (release === null) {
      return err(sandboxError('busy', `at most ${this.gate.limit} coding session(s) run at once`));
    }
    try {
      return await this.runOne(spec, pre.value.profile, pre.value.limits);
    } finally {
      release();
    }
  }

  private async runOne(
    spec: SandboxSpec,
    profile: SandboxProfile,
    limits: SandboxLimits,
  ): Promise<Result<SandboxRun, SandboxError>> {
    const id = spec.session_id;
    const name = `${SANDBOX_NAME_PREFIX}${id}`;
    const netName = `${SANDBOX_NAME_PREFIX}net-${id}`;
    const made = { scratch: false, network: false, container: false, attached: [] as string[] };
    const cleanupErrors: string[] = [];
    let result: Result<SandboxRun, SandboxError>;
    try {
      result = await this.execute(spec, profile, limits, name, netName, made);
    } catch (e) {
      result = err(sandboxError('driver_failure', e instanceof Error ? e.message : String(e)));
    }
    // whatever happened: remove what this run made, and say so if something would not go
    await this.cleanup(name, netName, id, made, cleanupErrors);
    if (result.ok && cleanupErrors.length > 0)
      result = ok({ ...result.value, cleanup_errors: cleanupErrors });
    if (!result.ok && cleanupErrors.length > 0) {
      result = err(
        sandboxError(
          result.error.code,
          `${result.error.message} (and left behind: ${cleanupErrors.join('; ')})`,
        ),
      );
    }
    return result;
  }

  private async execute(
    spec: SandboxSpec,
    profile: SandboxProfile,
    limits: SandboxLimits,
    name: string,
    netName: string,
    made: { scratch: boolean; network: boolean; container: boolean; attached: string[] },
  ): Promise<Result<SandboxRun, SandboxError>> {
    const t0 = Date.now();
    const id = spec.session_id;
    {
      // 1. the repo copy
      const copyBytes = spec.repo.reduce(
        (n, f) =>
          n + (typeof f.content === 'string' ? Buffer.byteLength(f.content) : f.content.byteLength),
        0,
      );
      if (profile.repo === 'copy' && copyBytes > limits.work_bytes / 2) {
        return err(sandboxError('invalid_spec', 'the repo copy does not fit in half of /work'));
      }
      let mat;
      try {
        made.scratch = true;
        mat = materialiseRepo(this.cfg.scratch, id, spec.repo, profile.exec);
      } catch (e) {
        made.scratch = false;
        return err(
          sandboxError(
            'driver_failure',
            `repo copy: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }

      // 2. the network
      const peers: SandboxPeer[] = peersOf(profile) as SandboxPeer[];
      if (profile.network !== 'none') {
        for (const p of peers) {
          if (!this.cfg.peers[p])
            return err(
              sandboxError(
                'unavailable',
                `no ${p} peer is configured: a class that needs it does not run`,
              ),
            );
        }
        const c = await this.api.json('POST', '/networks/create', {
          Name: netName,
          Driver: 'bridge',
          Internal: true,
          Labels: { [SANDBOX_LABEL.sandbox]: '1', [SANDBOX_LABEL.session]: id },
        });
        if (c.status !== 201)
          return err(sandboxError('unavailable', `network create: ${c.status} ${c.message}`));
        made.network = true;
        for (const p of peers) {
          const container = this.cfg.peers[p] as string;
          const a = await this.api.json('POST', `/networks/${netName}/connect`, {
            Container: container,
            EndpointConfig: { Aliases: [SANDBOX_PEER_ALIAS[p]] },
          });
          if (a.status !== 200)
            return err(sandboxError('unavailable', `attach ${p}: ${a.status} ${a.message}`));
          made.attached.push(container);
        }
      }

      // 3. the container
      const mark = randomBytes(12).toString('hex');
      const env: string[] = [
        `AISDLC_REPO_MODE=${profile.repo}`,
        `AISDLC_OUT_MARK=${mark}`,
        `AISDLC_OUT_BYTES=${limits.out_bytes}`,
        `AISDLC_TIME_S=${limits.time_s}`,
        ...Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      ];
      if (profile.key && spec.gateway_key !== undefined) {
        env.push(`${SANDBOX_GATEWAY_KEY_ENV}=${spec.gateway_key}`);
        env.push(`${SANDBOX_GATEWAY_URL_ENV}=${this.cfg.gatewayUrl ?? 'http://gateway:8410'}`);
      }
      // the container never sees a credential: checked here on what we are about to send, and again on what the daemon made
      const bad = envCredentialProblems(env, profile.key);
      if (bad.length > 0)
        return err(sandboxError('refused', `credential in the environment: ${bad.join('; ')}`));

      const tm = (bytes: number, exec: boolean, mode: string) =>
        `rw,${exec ? 'exec' : 'noexec'},nosuid,nodev,size=${bytes},uid=${SANDBOX_UID},gid=${SANDBOX_GID},mode=${mode}`;
      const logMb = Math.min(128, Math.ceil((limits.out_bytes * 1.4 + 6 * MIB) / MIB));
      const body = {
        Image: spec.image ?? this.cfg.image,
        Entrypoint: ['/usr/local/bin/aisdlc-run'],
        Cmd: [...spec.command],
        Env: env,
        User: `${SANDBOX_UID}:${SANDBOX_GID}`,
        WorkingDir: '/work',
        Labels: {
          [SANDBOX_LABEL.sandbox]: '1',
          [SANDBOX_LABEL.session]: id,
          [SANDBOX_LABEL.class]: spec.class,
        },
        StopTimeout: 2,
        HostConfig: {
          Binds: [`${mat.hostRepoDir}:/repo:ro`],
          Tmpfs: {
            '/out': tm(limits.out_bytes, false, '0700'),
            '/work': tm(limits.work_bytes, profile.exec, '0755'),
            '/tmp': tm(Math.min(limits.work_bytes, 64 * MIB), profile.exec, '1777'),
          },
          NetworkMode: profile.network === 'none' ? 'none' : netName,
          Memory: limits.memory_mb * MIB,
          MemorySwap: limits.memory_mb * MIB,
          NanoCpus: Math.round(limits.cpus * 1e9),
          PidsLimit: limits.pids,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Ulimits: [
            { Name: 'nofile', Soft: 1024, Hard: 1024 },
            { Name: 'core', Soft: 0, Hard: 0 },
          ],
          LogConfig: { Type: 'json-file', Config: { 'max-size': `${logMb}m`, 'max-file': '2' } },
          Init: true,
          IpcMode: 'private',
        },
      };
      const created = await this.api.json('POST', `/containers/create?name=${name}`, body);
      if (created.status !== 201) {
        // a name that is taken belongs to someone else: do not remove it
        return err(
          sandboxError(
            created.status === 403 ? 'refused' : created.status === 429 ? 'busy' : 'unavailable',
            `create: ${created.status} ${created.message}`,
          ),
        );
      }
      made.container = true;

      const problems = await this.verifyCreated(
        name,
        profile.key,
        spec.class,
        profile.network === 'none' ? 'none' : netName,
        this.cfg.expectImageId?.(spec.class),
      );
      if (problems.length > 0)
        return err(
          sandboxError(
            problems.some((p) => p.startsWith('Image=')) ? 'image_unverified' : 'refused',
            `the daemon's container is not what was asked: ${problems.join('; ')}`,
          ),
        );

      // 4. run
      const started = await this.api.json('POST', `/containers/${name}/start`);
      if (started.status !== 204 && started.status !== 304) {
        return err(sandboxError('unavailable', `start: ${started.status} ${started.message}`));
      }
      const timedOut = await this.waitOrKill(name, limits.time_s * 1000);
      const inspect = await this.api.json<{
        State?: { OOMKilled?: boolean; ExitCode?: number; Running?: boolean };
      }>('GET', `/containers/${name}/json`);
      const oom = inspect.json?.State?.OOMKilled === true;

      // 5. the output
      const streamCap = Math.floor(limits.out_bytes * 1.4) + 8 * MIB;
      const logsRes = await this.api.request(
        'GET',
        `/containers/${name}/logs?stdout=1&stderr=1&follow=0`,
        {
          maxBytes: streamCap * 2 + 8 * MIB,
          timeoutMs: 120_000,
        },
      );
      const d = demux(logsRes.body, streamCap);
      const logsTruncated = logsRes.truncated || d.truncated;
      const block = extractOutBlock(d.stdout, mark);
      let status: SandboxStatus = 'exited';
      let detail: string | null = null;
      let exitCode: number | null = null;
      let files: Array<{ path: string; content: Buffer }> = [];
      if (timedOut) {
        status = 'timed_out';
        detail = `no exit within ${limits.time_s}s`;
      } else if (oom) {
        status = 'oom_killed';
        detail = `the kernel killed the session at ${limits.memory_mb} MiB`;
      } else if (block === null) {
        status = 'killed';
        detail = logsTruncated
          ? 'the log stream passed its cap before the end marker'
          : 'the wrapper never printed its end marker';
      } else if (block.tar.length === 0) {
        status = 'killed';
        detail = 'the wrapper could not archive /out';
      } else {
        const t = readTar(block.tar, { maxFiles: 5000, maxBytes: limits.out_bytes });
        if (t.error !== null) {
          status = 'out_oversized';
          detail = `/out refused: ${t.error}`;
        } else {
          files = t.files.map((f) => ({ path: f.path, content: f.content }));
          exitCode = block.exit_code;
        }
      }
      const stdoutText = (block?.stdout ?? d.stdout).subarray(0, MAX_TEXT_LOG).toString('utf8');
      const stderrText = d.stderr.subarray(0, MAX_TEXT_LOG).toString('utf8');
      const scan = scanSandboxOutput(files, [
        { path: 'stdout', text: stdoutText },
        { path: 'stderr', text: stderrText },
      ]);
      const quarantined = scan.canary;
      const run: SandboxRun = {
        session_id: id,
        class: spec.class,
        status,
        exit_code: status === 'exited' ? exitCode : null,
        stdout: stdoutText,
        stderr: stderrText,
        logs_truncated: logsTruncated,
        out:
          status === 'exited' && !quarantined ? files.map((f) => outFileOf(f.path, f.content)) : [],
        out_scan: scan,
        quarantined,
        duration_ms: Date.now() - t0,
        detail,
        cleanup_errors: [],
        limits,
        peers: peers.map((p) => p),
      };
      return ok(run);
    }
  }

  private async waitOrKill(name: string, ms: number): Promise<boolean> {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const waiting = this.api
      .request('POST', `/containers/${name}/wait?condition=not-running`, {
        timeoutMs: 0,
        signal: ac.signal,
      })
      .then(() => 'exited' as const)
      .catch(() => 'exited' as const);
    const clock = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    const first = await Promise.race([waiting, clock]);
    if (timer) clearTimeout(timer);
    if (first === 'exited') return false;
    // the time limit: kill it, then wait for the daemon to say it is gone
    await this.api
      .request('POST', `/containers/${name}/kill?signal=KILL`, { timeoutMs: 15_000 })
      .catch(() => undefined);
    await Promise.race([waiting, new Promise((r) => setTimeout(r, 15_000))]);
    ac.abort();
    return true;
  }

  /** What the daemon actually made, against what the profile demands (env, hardening, network). */
  private async verifyCreated(
    name: string,
    hasKey: boolean,
    cls: string,
    network: string,
    expectImage?: string,
  ): Promise<string[]> {
    const r = await this.api.json<{
      Image?: string;
      Config?: { Env?: string[]; User?: string; Labels?: Record<string, string> };
      HostConfig?: Record<string, unknown>;
    }>('GET', `/containers/${name}/json`);
    if (r.status !== 200 || !r.json) return [`inspect: ${r.status}`];
    const problems = envCredentialProblems(r.json.Config?.Env ?? [], hasKey);
    // LF4: the image the daemon made the container from, by id
    if (expectImage !== undefined && (expectImage === '' || r.json.Image !== expectImage)) {
      problems.push(`Image=${String(r.json.Image ?? 'unknown').slice(0, 80)}`);
    }
    const h = r.json.HostConfig ?? {};
    if (h['Privileged'] !== false) problems.push('Privileged');
    if (h['ReadonlyRootfs'] !== true) problems.push('ReadonlyRootfs');
    if (JSON.stringify(h['CapDrop']) !== '["ALL"]') problems.push('CapDrop');
    if (JSON.stringify(h['CapAdd'] ?? null) !== 'null' && JSON.stringify(h['CapAdd']) !== '[]')
      problems.push('CapAdd');
    if (h['NetworkMode'] !== network) problems.push(`NetworkMode=${String(h['NetworkMode'])}`);
    if (h['PidMode'] !== '' && h['PidMode'] !== undefined) problems.push('PidMode');
    if (
      !Array.isArray(h['Devices']) ? h['Devices'] != null : (h['Devices'] as unknown[]).length > 0
    )
      problems.push('Devices');
    if (!((h['Memory'] as number) > 0) || h['MemorySwap'] !== h['Memory']) problems.push('Memory');
    if (!((h['PidsLimit'] as number) > 0)) problems.push('PidsLimit');
    if (!((h['NanoCpus'] as number) > 0)) problems.push('NanoCpus');
    if (r.json.Config?.User !== `${SANDBOX_UID}:${SANDBOX_GID}`) problems.push('User');
    if (r.json.Config?.Labels?.[SANDBOX_LABEL.class] !== cls) problems.push('class label');
    const binds = (h['Binds'] as string[] | null) ?? [];
    if (binds.length !== 1 || !binds[0]?.endsWith('/repo:/repo:ro')) problems.push('Binds');
    return problems;
  }

  private async cleanup(
    name: string,
    netName: string,
    id: string,
    made: { scratch: boolean; network: boolean; container: boolean; attached: string[] },
    errors: string[],
  ): Promise<void> {
    if (made.container) {
      const r = await this.api
        .request('DELETE', `/containers/${name}?force=true&v=true`, { timeoutMs: 30_000 })
        .catch((e: unknown) => ({ status: 0, body: Buffer.from(String(e)) }));
      if (r.status !== 204 && r.status !== 404) errors.push(`container ${name}: ${r.status}`);
    }
    if (made.network) {
      for (const c of made.attached) {
        const r = await this.api
          .request('POST', `/networks/${netName}/disconnect`, {
            body: { Container: c, Force: true },
            timeoutMs: 15_000,
          })
          .catch((e: unknown) => ({ status: 0, body: Buffer.from(String(e)) }));
        if (r.status !== 200 && r.status !== 404) errors.push(`disconnect ${c}: ${r.status}`);
      }
      const r = await this.api
        .request('DELETE', `/networks/${netName}`, { timeoutMs: 15_000 })
        .catch((e: unknown) => ({ status: 0, body: Buffer.from(String(e)) }));
      if (r.status !== 204 && r.status !== 404) errors.push(`network ${netName}: ${r.status}`);
    }
    if (made.scratch) {
      try {
        removeScratch(this.cfg.scratch, id);
      } catch (e) {
        errors.push(`scratch ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

/** Problems with an environment list (`NAME=value`): a credential by name, by value, or a canary. The gateway key pair is the one allowed pair, and only for a class with a key. */
export function envCredentialProblems(env: readonly string[], hasKey: boolean): string[] {
  const out: string[] = [];
  const wrapper = new Set<string>(SANDBOX_WRAPPER_ENV);
  for (const e of env) {
    const i = e.indexOf('=');
    const n = i < 0 ? e : e.slice(0, i);
    const v = i < 0 ? '' : e.slice(i + 1);
    if (n === SANDBOX_GATEWAY_KEY_ENV || n === SANDBOX_GATEWAY_URL_ENV) {
      if (!hasKey) out.push(`${n} on a class without a key`);
      continue;
    }
    if (wrapper.has(n)) continue;
    if (SECRET_ENV_NAME.test(n)) out.push(`${n}: credential-shaped name`);
    if (scanText(`${n}=${v}`).length > 0 || scanText(v).length > 0)
      out.push(`${n}: credential-shaped value`);
  }
  return out;
}
