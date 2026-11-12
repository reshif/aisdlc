import http from 'node:http';
import type { Duplex } from 'node:stream';
import { SANDBOX_LABEL } from '@aisdlc/contracts';
import type { ServiceAuth } from '@aisdlc/service-kit';
import {
  OCCUPIES_SLOT,
  isOwnedBy,
  ownerOf,
  peerLabelOk,
  route,
  validateArchive,
  validateConnect,
  validateCreate,
  validateDelete,
  validateKill,
  validateList,
  validateLogs,
  validateNetworkCreate,
  validateWaitCondition,
  type Decision,
  type PolicyConfig,
  type Route,
} from './policy.js';

// The Docker socket proxy (PLAN M13.2; RV §3.4). A small HTTP server that answers the few Docker API calls the
// sandbox driver needs and refuses everything else. It is the ONLY process that mounts the Docker socket.
//
// Two instances run in the compose stack: one for the CVW (`allowNetworks: false`: it can only start network-less
// sandboxes) and one for the coding worker (`allowNetworks: true`: it can also create the per-session internal
// networks and attach the gateway and the package mirror to them). Neither can exec, build, pull, run
// privileged, mount anything but the one read-only repo copy, or touch a container it did not label as a sandbox.
//
// What the client sends is never forwarded as it came: the request line is rebuilt from the validated route,
// the headers are rebuilt from scratch and a JSON body is the proxy's own re-serialisation of what it checked.

export interface UpstreamTarget {
  readonly socketPath?: string;
  readonly host?: string;
  readonly port?: number;
}

export interface ProxyOptions {
  /**
   * Who may call over TCP (a per-caller bearer token, resolved from `file:` references by the boot code). The
   * internal network is not an identity: a TCP listener without callers refuses to start, and a TCP request
   * without a known token is refused before anything is routed. A unix-socket listener (the test rig, a
   * sidecar) is a filesystem permission and needs none. `/healthz` stays open: it answers a daemon ping only.
   */
  readonly auth?: ServiceAuth;
  readonly policy: PolicyConfig;
  readonly upstream: UpstreamTarget;
  readonly log?: (line: string) => void;
}

export interface ProxyStats {
  allowed: number;
  refused: number;
  readonly refusals: Array<{ route: string; reason: string }>;
}

const MAX_JSON_BODY = 64 * 1024;

interface UpResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: http.IncomingMessage;
}

export class DockerProxy {
  readonly stats: ProxyStats = { allowed: 0, refused: 0, refusals: [] };
  readonly server: http.Server;
  private createLock: Promise<void> = Promise.resolve();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ProxyOptions) {
    this.log = opts.log ?? (() => undefined);
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        this.log(`error ${req.method} ${req.url}: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) this.refuse(res, 502, 'the proxy could not reach the daemon');
        else res.destroy();
      });
    });
    // No hijack, no upgrade: attach and exec need them, and are not on the list.
    this.server.on('upgrade', (_req, socket: Duplex) => {
      this.note('upgrade', 'HTTP upgrade is refused');
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    this.server.on('connect', (_req, socket: Duplex) => {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    this.server.headersTimeout = 20_000;
    this.server.maxHeadersCount = 50;
  }

  private note(what: string, reason: string): void {
    this.stats.refused += 1;
    if (this.stats.refusals.length < 200) this.stats.refusals.push({ route: what, reason });
    this.log(`refuse ${what}: ${reason}`);
  }

  private refuse(res: http.ServerResponse, status: number, reason: string): void {
    const body = JSON.stringify({ message: `docker-proxy: ${reason}` });
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
    });
    res.end(body);
  }

  // ---- upstream

  private up(
    method: string,
    path: string,
    headers: Record<string, string | number>,
    body?: Buffer | http.IncomingMessage,
  ): Promise<UpResponse> {
    return new Promise((resolve, reject) => {
      const { socketPath, host, port } = this.opts.upstream;
      const req = http.request(
        {
          method,
          path,
          headers: { Host: 'docker', Connection: 'close', ...headers },
          ...(socketPath ? { socketPath } : { host, port }),
        },
        (r) => resolve({ status: r.statusCode ?? 502, headers: r.headers, body: r }),
      );
      req.on('error', reject);
      if (body === undefined) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else body.pipe(req);
    });
  }

  private async upJson(path: string): Promise<{ status: number; json: unknown }> {
    const r = await this.up('GET', path, {});
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of r.body) {
      n += (c as Buffer).length;
      if (n > 4 * 1024 * 1024) throw new Error('upstream answer too large');
      chunks.push(c as Buffer);
    }
    try {
      return { status: r.status, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      return { status: r.status, json: null };
    }
  }

  private async pass(res: http.ServerResponse, up: UpResponse): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    for (const k of [
      'content-type',
      'content-length',
      'api-version',
      'docker-experimental',
      'ostype',
      'server',
      'transfer-encoding',
      'x-docker-container-path-stat',
    ]) {
      const v = up.headers[k];
      if (v !== undefined) headers[k] = v;
    }
    headers['connection'] = 'close';
    res.writeHead(up.status, headers);
    up.body.pipe(res);
    await new Promise<void>((resolve) => {
      res.on('close', resolve);
      up.body.on('error', () => res.destroy());
    });
  }

  private async readJson(req: http.IncomingMessage): Promise<Decision<unknown>> {
    const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (ct !== 'application/json')
      return { allow: false, status: 415, reason: 'Content-Type must be application/json' };
    const cl = req.headers['content-length'];
    if (cl !== undefined && Number(cl) > MAX_JSON_BODY)
      return { allow: false, status: 413, reason: 'body too large' };
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > MAX_JSON_BODY) return { allow: false, status: 413, reason: 'body too large' };
      chunks.push(c as Buffer);
    }
    try {
      return { allow: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      return { allow: false, status: 400, reason: 'the body is not JSON' };
    }
  }

  private async drain(req: http.IncomingMessage): Promise<void> {
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > MAX_JSON_BODY) {
        req.destroy();
        return;
      }
    }
  }

  // ---- ownership: a verb on a container or network is only for one the proxy's own labels mark as a sandbox's

  private async ownsContainer(id: string): Promise<Decision> {
    const r = await this.upJson(`/containers/${id}/json`);
    if (r.status === 404) return { allow: false, status: 404, reason: 'no such container' };
    const cfg = (r.json as { Config?: { Labels?: unknown } } | null)?.Config;
    if (r.status !== 200 || !isOwnedBy(cfg?.Labels, ownerOf(this.opts.policy))) {
      return {
        allow: false,
        status: 403,
        reason: `not a sandbox container of this proxy (${SANDBOX_LABEL.sandbox}=1 and ${SANDBOX_LABEL.owner}=${ownerOf(this.opts.policy)})`,
      };
    }
    return { allow: true, value: undefined };
  }

  private async ownsNetwork(id: string): Promise<Decision> {
    const r = await this.upJson(`/networks/${id}`);
    if (r.status === 404) return { allow: false, status: 404, reason: 'no such network' };
    const n = r.json as { Labels?: unknown; Internal?: unknown } | null;
    if (
      r.status !== 200 ||
      !isOwnedBy(n?.Labels, ownerOf(this.opts.policy)) ||
      n?.Internal !== true
    ) {
      return {
        allow: false,
        status: 403,
        reason: 'not a sandbox session network of this proxy (labels and internal)',
      };
    }
    return { allow: true, value: undefined };
  }

  /** The caps, counted from the daemon so a restart of this proxy forgets nothing. Called with the create lock held. */
  private async capsOk(cls: string): Promise<Decision> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${SANDBOX_LABEL.sandbox}=1`] }));
    const r = await this.upJson(`/containers/json?all=true&filters=${filters}`);
    if (r.status !== 200 || !Array.isArray(r.json)) {
      return {
        allow: false,
        status: 502,
        reason: 'the daemon would not list sandboxes: no create without a count',
      };
    }
    const live = (r.json as Array<{ State?: string; Labels?: Record<string, string> }>).filter(
      (c) => OCCUPIES_SLOT.has(String(c.State)),
    );
    if (live.length >= this.opts.policy.maxSandboxes) {
      return {
        allow: false,
        status: 429,
        reason: `at most ${this.opts.policy.maxSandboxes} sandboxes at once`,
      };
    }
    if (
      cls === 'W' &&
      live.filter((c) => c.Labels?.[SANDBOX_LABEL.class] === 'W').length >=
        this.opts.policy.codingCap
    ) {
      return {
        allow: false,
        status: 429,
        reason: `at most ${this.opts.policy.codingCap} coding session at once`,
      };
    }
    return { allow: true, value: undefined };
  }

  /**
   * M19: this proxy's own sandboxes, as a minimal list the proxy writes itself (the filter is the proxy's: the
   * sandbox label and its owner label; nothing of the daemon's answer is passed on but ids, names, state and the
   * session and class labels).
   */
  private async list(res: http.ServerResponse, kind: 'containers' | 'networks'): Promise<void> {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [
          `${SANDBOX_LABEL.sandbox}=1`,
          `${SANDBOX_LABEL.owner}=${ownerOf(this.opts.policy)}`,
        ],
      }),
    );
    const r = await this.upJson(
      kind === 'containers'
        ? `/containers/json?all=true&filters=${filters}`
        : `/networks?filters=${filters}`,
    );
    if (r.status !== 200 || !Array.isArray(r.json)) {
      this.refuse(res, 502, `the daemon would not list ${kind}`);
      return;
    }
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const rows = (r.json as Array<Record<string, unknown>>).flatMap((x) => {
      const labels = (x['Labels'] ?? {}) as Record<string, unknown>;
      // the daemon filtered by label; checked again here (a filter the daemon ignored lists nothing)
      if (!isOwnedBy(labels, ownerOf(this.opts.policy))) return [];
      const id = str(x['Id']);
      if (id === null) return [];
      const name =
        kind === 'containers'
          ? (str((x['Names'] as unknown[] | undefined)?.[0]) ?? '').replace(/^\//, '')
          : (str(x['Name']) ?? '');
      return [
        {
          id,
          name,
          session: str(labels[SANDBOX_LABEL.session]),
          ...(kind === 'containers'
            ? { class: str(labels[SANDBOX_LABEL.class]), state: str(x['State']) }
            : {}),
        },
      ];
    });
    const body = JSON.stringify(rows);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
    });
    res.end(body);
  }

  // ---- the handler

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? '').toUpperCase();
    const url = req.url ?? '';
    const where = `${method} ${url.split('?')[0]}`;
    const deny = async (status: number, reason: string): Promise<void> => {
      this.note(where, reason);
      this.drain(req).catch(() => undefined);
      this.refuse(res, status, reason);
    };

    if (
      req.headers.upgrade !== undefined ||
      /upgrade/i.test(String(req.headers.connection ?? ''))
    ) {
      return deny(403, 'HTTP upgrade is refused');
    }
    const tcp = req.socket.remotePort !== undefined;
    if (tcp && !(method === 'GET' && url === '/healthz')) {
      const caller = this.opts.auth?.authenticate(req.headers.authorization) ?? null;
      if (caller === null) return deny(401, 'a bearer token of a known caller is required');
    }
    if (method === 'GET' && url === '/healthz') {
      const r = await this.up('GET', '/_ping', {}).catch(() => null);
      res.writeHead(r?.status === 200 ? 200 : 503, { 'Content-Type': 'text/plain' });
      res.end(r?.status === 200 ? 'ok' : 'daemon unreachable');
      r?.body.resume();
      return;
    }

    const routed = route(method, url);
    if (!routed.allow) return deny(routed.status, routed.reason);
    const r: Route = routed.value;
    const label = `${r.kind}${r.id ? ` ${r.id}` : ''}`;
    const ok = (): void => {
      this.stats.allowed += 1;
      this.log(`allow ${label}`);
    };
    const check = async (d: Decision | Promise<Decision>): Promise<boolean> => {
      const x = await d;
      if (!x.allow) {
        await deny(x.status, `${label}: ${x.reason}`);
        return false;
      }
      return true;
    };

    switch (r.kind) {
      case 'ping': {
        ok();
        return this.pass(res, await this.up(method, r.path, {}));
      }
      case 'container_list':
      case 'network_list': {
        if (r.kind === 'network_list' && !this.opts.policy.allowNetworks)
          return deny(403, `${label}: this proxy has no networks`);
        if (!(await check(validateList(r.query)))) return;
        this.drain(req).catch(() => undefined);
        ok();
        return this.list(res, r.kind === 'container_list' ? 'containers' : 'networks');
      }
      case 'container_create': {
        const body = await this.readJson(req);
        if (!(await check(body))) return;
        const plan = validateCreate((body as { value: unknown }).value, r.query, this.opts.policy);
        if (!(await check(plan))) return;
        const p = (plan as { value: { body: string; name: string; class: string } }).value;
        // creates are serialised so the count and the create are one step
        const prev = this.createLock;
        let unlock!: () => void;
        this.createLock = new Promise<void>((resolve) => (unlock = resolve));
        await prev;
        try {
          if (!(await check(this.capsOk(p.class)))) return;
          ok();
          const buf = Buffer.from(p.body);
          const path = `${r.path}?name=${encodeURIComponent(p.name)}`;
          return await this.pass(
            res,
            await this.up(
              'POST',
              path,
              { 'Content-Type': 'application/json', 'Content-Length': buf.length },
              buf,
            ),
          );
        } finally {
          unlock();
        }
      }
      case 'container_start':
      case 'container_wait':
      case 'container_kill':
      case 'container_logs':
      case 'container_inspect':
      case 'container_delete':
      case 'container_archive_get':
      case 'container_archive_put': {
        const id = r.id as string;
        const param =
          r.kind === 'container_wait'
            ? validateWaitCondition(r.query)
            : r.kind === 'container_kill'
              ? validateKill(r.query)
              : r.kind === 'container_logs'
                ? validateLogs(r.query)
                : r.kind === 'container_delete'
                  ? validateDelete(r.query)
                  : r.kind === 'container_archive_get'
                    ? validateArchive('get', r.query, this.opts.policy)
                    : r.kind === 'container_archive_put'
                      ? validateArchive('put', r.query, this.opts.policy)
                      : ({ allow: true, value: undefined } as Decision);
        if (!(await check(param))) return;
        if (!(await check(this.ownsContainer(id)))) return;
        const qs = [...r.query].map(([k, v]) => `${k}=${v}`).join('&');
        const path = qs === '' ? r.path : `${r.path}?${qs}`;
        const m =
          r.kind === 'container_delete'
            ? 'DELETE'
            : r.kind === 'container_archive_get' ||
                r.kind === 'container_logs' ||
                r.kind === 'container_inspect'
              ? 'GET'
              : r.kind === 'container_archive_put'
                ? 'PUT'
                : 'POST';
        if (r.kind === 'container_archive_put') {
          const cl = Number(req.headers['content-length']);
          if (!Number.isInteger(cl) || cl < 0 || cl > this.opts.policy.maxArchiveBytes) {
            return deny(
              413,
              `${label}: a Content-Length up to ${this.opts.policy.maxArchiveBytes} is required`,
            );
          }
          ok();
          return this.pass(
            res,
            await this.up(
              'PUT',
              path,
              { 'Content-Type': 'application/x-tar', 'Content-Length': cl },
              req,
            ),
          );
        }
        this.drain(req).catch(() => undefined);
        ok();
        return this.pass(res, await this.up(m, path, m === 'POST' ? { 'Content-Length': 0 } : {}));
      }
      case 'network_create': {
        const body = await this.readJson(req);
        if (!(await check(body))) return;
        const plan = validateNetworkCreate((body as { value: unknown }).value, this.opts.policy);
        if (!(await check(plan))) return;
        const buf = Buffer.from((plan as { value: { body: string } }).value.body);
        ok();
        return this.pass(
          res,
          await this.up(
            'POST',
            r.path,
            { 'Content-Type': 'application/json', 'Content-Length': buf.length },
            buf,
          ),
        );
      }
      case 'network_connect':
      case 'network_disconnect': {
        if (!this.opts.policy.allowNetworks)
          return deny(403, `${label}: this proxy does not connect networks`);
        const body = await this.readJson(req);
        if (!(await check(body))) return;
        const verb = r.kind === 'network_connect' ? 'connect' : 'disconnect';
        const plan = validateConnect((body as { value: unknown }).value, verb, this.opts.policy);
        if (!(await check(plan))) return;
        const p = (
          plan as { value: { body: string; container: string; peer: 'gateway' | 'mirror' | null } }
        ).value;
        if (!(await check(this.ownsNetwork(r.id as string)))) return;
        const c = await this.upJson(`/containers/${encodeURIComponent(p.container)}/json`);
        const labels = (c.json as { Config?: { Labels?: unknown } } | null)?.Config?.Labels;
        const peerOk =
          c.status === 200 &&
          (p.peer !== null
            ? peerLabelOk(labels, p.peer)
            : peerLabelOk(labels, 'gateway') || peerLabelOk(labels, 'mirror'));
        if (!peerOk)
          return deny(
            403,
            `${label}: ${p.container} is not a labelled ${p.peer ?? 'peer'} (${SANDBOX_LABEL.peer})`,
          );
        const buf = Buffer.from(p.body);
        ok();
        return this.pass(
          res,
          await this.up(
            'POST',
            r.path,
            { 'Content-Type': 'application/json', 'Content-Length': buf.length },
            buf,
          ),
        );
      }
      case 'network_delete': {
        if (!this.opts.policy.allowNetworks)
          return deny(403, `${label}: this proxy does not delete networks`);
        if (!(await check(this.ownsNetwork(r.id as string)))) return;
        this.drain(req).catch(() => undefined);
        ok();
        return this.pass(res, await this.up('DELETE', r.path, {}));
      }
    }
  }

  listen(target: { socketPath: string } | { host: string; port: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      if ('socketPath' in target) this.server.listen(target.socketPath, resolve);
      else {
        if (this.opts.auth === undefined) {
          reject(new Error('a TCP listener needs caller tokens: refusing to start without them'));
          return;
        }
        this.server.listen(target.port, target.host, resolve);
      }
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}
