import http from 'node:http';

// The driver's only way to Docker: HTTP to an allow-list proxy (services/docker-proxy), by unix socket or TCP.
// It never opens /var/run/docker.sock: there is no code path here that could.

export type Endpoint =
  | { readonly socketPath: string }
  /** `token`: the caller's bearer token for a TCP proxy (read from a `file:` reference by the caller of the driver; never logged). */
  | { readonly host: string; readonly port: number; readonly token?: string };

export interface ApiResponse {
  readonly status: number;
  readonly body: Buffer;
  /** The body was longer than `maxBytes`: the rest was dropped. */
  readonly truncated: boolean;
}

export class DockerApi {
  constructor(
    private readonly endpoint: Endpoint,
    private readonly defaults: { readonly timeoutMs: number } = { timeoutMs: 30_000 },
  ) {}

  request(
    method: string,
    path: string,
    opts: { body?: unknown; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
      const headers: Record<string, string | number> = {};
      if ('token' in this.endpoint && this.endpoint.token !== undefined) {
        headers['Authorization'] = `Bearer ${this.endpoint.token}`;
      }
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      } else if (method === 'POST') {
        headers['Content-Length'] = 0;
      }
      const req = http.request(
        {
          method,
          path,
          headers,
          ...('socketPath' in this.endpoint
            ? { socketPath: this.endpoint.socketPath }
            : { host: this.endpoint.host, port: this.endpoint.port }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let n = 0;
          let truncated = false;
          const max = opts.maxBytes ?? 8 * 1024 * 1024;
          res.on('data', (c: Buffer) => {
            if (n >= max) {
              truncated = true;
              return;
            }
            const take = Math.min(c.length, max - n);
            chunks.push(take === c.length ? c : c.subarray(0, take));
            n += take;
            if (take < c.length) {
              truncated = true;
              // stop reading: the answer is already larger than anything we will accept
              res.destroy();
            }
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), truncated }),
          );
          res.on('close', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), truncated }),
          );
          res.on('error', reject);
        },
      );
      const timer =
        opts.timeoutMs === 0
          ? null
          : setTimeout(
              () => req.destroy(new Error(`docker api ${method} ${path} timed out`)),
              opts.timeoutMs ?? this.defaults.timeoutMs,
            );
      const done = () => timer && clearTimeout(timer);
      req.on('close', done);
      req.on('error', (e) => {
        done();
        reject(e);
      });
      opts.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), {
        once: true,
      });
      req.end(payload);
    });
  }

  async json<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T | null; message: string }> {
    const r = await this.request(method, path, body === undefined ? {} : { body });
    let parsed: unknown;
    try {
      parsed = r.body.length > 0 ? JSON.parse(r.body.toString('utf8')) : null;
    } catch {
      parsed = null;
    }
    const message =
      (parsed as { message?: string } | null)?.message ?? r.body.toString('utf8').slice(0, 300);
    return { status: r.status, json: parsed as T | null, message };
  }
}
