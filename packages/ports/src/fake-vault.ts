import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A deterministic, in-memory stand-in for the slice of HashiCorp Vault the factory uses (tests only): KV version 2
// under one mount (data read and write, metadata read, delete and list), AppRole login, tokens with a policy each
// (which path prefixes they may read, write, see the metadata of and delete), and a sealed state (503). It answers
// the same JSON shapes as Vault, as a `fetch` function or on a loopback port. The compose stack and the Docker test
// run a real Vault.

export interface FakeVaultPolicy {
  /** Path prefixes (under the mount) whose values may be read. */
  readonly read?: readonly string[];
  /** Path prefixes that may be written (create and update). */
  readonly write?: readonly string[];
  /** Path prefixes whose metadata may be read and listed. */
  readonly meta?: readonly string[];
  /** Path prefixes whose metadata (every version) may be deleted. */
  readonly destroy?: readonly string[];
}

interface Version {
  readonly data: Record<string, string>;
  readonly created_time: string;
}

export class FakeVault {
  readonly mount: string;
  sealed = false;
  /** Every request the fake answered: method, path and status (never a body). */
  readonly log: Array<{ method: string; path: string; status: number }> = [];
  private readonly kv = new Map<string, Version[]>();
  private readonly tokens = new Map<string, FakeVaultPolicy>();
  private readonly roles = new Map<string, { secret_id: string; policy: FakeVaultPolicy }>();
  private tick = 0;
  private server: Server | null = null;

  constructor(o: { mount?: string } = {}) {
    this.mount = o.mount ?? 'aisdlc';
  }

  /** A token with `policy`; returns it. */
  token(policy: FakeVaultPolicy, token = `hvs.${randomBytes(12).toString('hex')}`): string {
    this.tokens.set(token, policy);
    return token;
  }

  /** An AppRole; returns the {role_id, secret_id} a process logs in with. */
  approle(policy: FakeVaultPolicy): { role_id: string; secret_id: string } {
    const role_id = randomBytes(8).toString('hex');
    const secret_id = randomBytes(16).toString('hex');
    this.roles.set(role_id, { secret_id, policy });
    return { role_id, secret_id };
  }

  /** Revokes every token (the next call of a client must log in again). */
  revokeAll(): void {
    this.tokens.clear();
  }

  /** Writes behind the API (a test's setup). */
  seed(path: string, data: Record<string, string>): void {
    this.write(path, data);
  }

  private now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 10, 13, 12, 0, this.tick)).toISOString();
  }

  private write(path: string, data: Record<string, string>): Version[] {
    const versions = this.kv.get(path) ?? [];
    versions.push({ data: { ...data }, created_time: this.now() });
    this.kv.set(path, versions);
    return versions;
  }

  private allowed(token: string | null, what: keyof FakeVaultPolicy, path: string): boolean {
    const p = token ? this.tokens.get(token) : undefined;
    return (p?.[what] ?? []).some(
      (pre) => pre === '' || path === pre || path.startsWith(pre.endsWith('/') ? pre : `${pre}/`),
    );
  }

  /** A `fetch` that answers like Vault. */
  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : null;
    const r = this.handle(method, url.pathname, headers.get('x-vault-token'), body);
    this.log.push({ method, path: url.pathname, status: r.status });
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  private handle(
    method: string,
    pathname: string,
    token: string | null,
    body: string | null,
  ): { status: number; json?: unknown } {
    if (this.sealed) return { status: 503, json: { errors: ['Vault is sealed'] } };
    const denied = { status: 403, json: { errors: ['permission denied'] } };
    if (method === 'POST' && pathname === '/v1/auth/approle/login') {
      const b = JSON.parse(body ?? '{}') as { role_id?: string; secret_id?: string };
      const role = b.role_id ? this.roles.get(b.role_id) : undefined;
      if (!role || role.secret_id !== b.secret_id)
        return { status: 400, json: { errors: ['invalid role or secret ID'] } };
      return {
        status: 200,
        json: { auth: { client_token: this.token(role.policy), lease_duration: 3600 } },
      };
    }
    const m = new RegExp(`^/v1/${this.mount}/(data|metadata)/(.*)$`).exec(pathname);
    if (!m) return { status: 404, json: { errors: [] } };
    const kind = m[1] as 'data' | 'metadata';
    const path = (m[2] as string).replace(/\/$/, '');
    if (kind === 'data' && method === 'GET') {
      if (!this.allowed(token, 'read', path)) return denied;
      const v = this.kv.get(path)?.at(-1);
      if (!v) return { status: 404, json: { errors: [] } };
      const versions = this.kv.get(path) as Version[];
      return {
        status: 200,
        json: {
          data: {
            data: v.data,
            metadata: { version: versions.length, created_time: v.created_time },
          },
        },
      };
    }
    if (kind === 'data' && method === 'POST') {
      if (!this.allowed(token, 'write', path)) return denied;
      const b = JSON.parse(body ?? '{}') as {
        data?: Record<string, string>;
        options?: { cas?: number };
      };
      const have = this.kv.get(path)?.length ?? 0;
      if (b.options?.cas !== undefined && b.options.cas !== have) {
        return {
          status: 400,
          json: { errors: ['check-and-set parameter did not match the current version'] },
        };
      }
      const versions = this.write(path, b.data ?? {});
      const v = versions.at(-1) as Version;
      return {
        status: 200,
        json: { data: { version: versions.length, created_time: v.created_time } },
      };
    }
    if (kind === 'metadata' && method === 'GET') {
      if (!this.allowed(token, 'meta', path)) return denied;
      const versions = this.kv.get(path);
      if (!versions || versions.length === 0) return { status: 404, json: { errors: [] } };
      return {
        status: 200,
        json: {
          data: {
            current_version: versions.length,
            created_time: versions[0]?.created_time,
            updated_time: versions.at(-1)?.created_time,
            versions: Object.fromEntries(
              versions.map((v, i) => [
                String(i + 1),
                { created_time: v.created_time, deletion_time: '', destroyed: false },
              ]),
            ),
          },
        },
      };
    }
    if (kind === 'metadata' && method === 'DELETE') {
      if (!this.allowed(token, 'destroy', path)) return denied;
      this.kv.delete(path);
      return { status: 204 };
    }
    if (kind === 'metadata' && method === 'LIST') {
      if (!this.allowed(token, 'meta', path)) return denied;
      const pre = path === '' ? '' : `${path}/`;
      const keys = new Set<string>();
      for (const k of this.kv.keys()) {
        if (!k.startsWith(pre)) continue;
        const rest = k.slice(pre.length);
        const i = rest.indexOf('/');
        keys.add(i < 0 ? rest : rest.slice(0, i + 1));
      }
      return keys.size === 0
        ? { status: 404, json: { errors: [] } }
        : { status: 200, json: { data: { keys: [...keys].sort() } } };
    }
    return { status: 405, json: { errors: ['unsupported'] } };
  }

  /** Serves the fake on a loopback port; returns its address. */
  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString('utf8')));
      req.on('end', () => {
        const tok = req.headers['x-vault-token'];
        const r = this.handle(
          req.method ?? 'GET',
          new URL(req.url ?? '/', 'http://x').pathname,
          typeof tok === 'string' ? tok : null,
          body === '' ? null : body,
        );
        this.log.push({ method: req.method ?? 'GET', path: req.url ?? '/', status: r.status });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(r.json === undefined ? undefined : JSON.stringify(r.json));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}
