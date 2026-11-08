import { createPublicKey, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gitBlobSha, repoKey, type CodeHostSeed } from '@aisdlc/ports';
import { emptySeed } from '@aisdlc/ports';
import { systemClock, type Clock } from '@aisdlc/kernel';

// An in-repo GitHub REST server for tests (PLAN M5.2). It is NOT the in-memory `FakeGitHub`: it
// speaks HTTP and implements only the endpoints the adapter uses, with the JSON shapes of the
// GitHub REST docs (repositories, contents, git refs, repository rules, CODEOWNERS errors,
// collaborators, app installations and installation access tokens), checking what GitHub checks:
// the App JWT (RS256, `iss`, `exp`, at most ten minutes), installation tokens and their expiry,
// requested permissions against the installation's grant, the permission each endpoint needs, and
// pagination with `Link` headers. Everything it is asked is logged.

export interface FakeGitHubRequest {
  readonly method: string;
  /** The path without the query. */
  readonly path: string;
  readonly query: string;
  /** How the caller authenticated: the App JWT, an installation token, or not at all. */
  readonly auth: 'jwt' | 'installation' | 'none';
  readonly status: number;
}

export interface IssuedToken {
  readonly token: string;
  readonly permissions: Record<string, string>;
  readonly expires_at: Date;
}

export interface FakeGitHubServerOptions {
  readonly appId: string;
  /** PEM of the App's PUBLIC key; the server verifies JWTs with it. */
  readonly appPublicKeyPem: string;
  readonly clock?: Clock;
  readonly seed?: CodeHostSeed;
  /** Token lifetime. Default one hour, as GitHub. */
  readonly tokenTtlMs?: number;
}

const ISO = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** A throwaway RSA key pair for tests: the PEM pair, PKCS#1 private (as GitHub hands it out). */
export function generateTestAppKey(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const notFound = {
  message: 'Not Found',
  documentation_url: 'https://docs.github.com/rest',
  status: '404',
};

export class FakeGitHubServer {
  readonly requests: FakeGitHubRequest[] = [];
  readonly issued: IssuedToken[] = [];
  /** Every bearer credential (JWT or installation token) any request carried, for leak checks. */
  readonly seenBearers = new Set<string>();
  private seed: CodeHostSeed;
  private server: Server | null = null;
  private readonly revoked = new Set<string>();
  /** When set, every resource request (not token minting) answers with this status. */
  private override: { status: number; headers: Record<string, string> } | null = null;
  /** Permissions to add to every token response, beyond what was requested. */
  private overshare: Record<string, string> | null = null;
  private delayMs = 0;
  baseUrl = '';

  constructor(private readonly o: FakeGitHubServerOptions) {
    this.seed = o.seed ?? emptySeed();
  }

  private get clock(): Clock {
    return this.o.clock ?? systemClock;
  }

  load(seed: CodeHostSeed): this {
    this.seed = seed;
    return this;
  }

  /** Every resource request answers `status` (with `headers`) until `answerNormally`. */
  answerWith(status: number, headers: Record<string, string> = {}): this {
    this.override = { status, headers };
    return this;
  }

  answerNormally(): this {
    this.override = null;
    return this;
  }

  /** Token responses carry these permissions in addition to the requested ones (a misbehaving host). */
  overshareOnMint(extra: Record<string, string> | null): this {
    this.overshare = extra;
    return this;
  }

  /** Every request waits this long before it is answered (to provoke timeouts). */
  delay(ms: number): this {
    this.delayMs = ms;
    return this;
  }

  /** Every token issued so far stops working (GitHub revoked it): the next use is a 401. */
  revokeAllTokens(): this {
    for (const t of this.issued) this.revoked.add(t.token);
    return this;
  }

  /** Requests a resource client made: everything except minting installation tokens. */
  get apiRequests(): FakeGitHubRequest[] {
    return this.requests.filter((r) => !/^\/app\/installations\/\d+\/access_tokens$/.test(r.path));
  }

  /** The text of everything this server saw, for "the secret never reached the log" checks. */
  allText(): string {
    return JSON.stringify([this.requests, this.issued.map((t) => t.permissions)]);
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    s?.closeAllConnections();
    await new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  // ------------------------------------------------------------ plumbing

  private json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): number {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
    return status;
  }

  private verifyJwt(token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    try {
      const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string };
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as {
        iss?: string;
        iat?: number;
        exp?: number;
      };
      if (header.alg !== 'RS256') return false;
      const v = createVerify('RSA-SHA256').update(`${h}.${p}`);
      if (!v.verify(createPublicKey(this.o.appPublicKeyPem), Buffer.from(s, 'base64url')))
        return false;
      const now = Math.floor(this.clock.now().getTime() / 1000);
      return (
        claims.iss === this.o.appId &&
        typeof claims.iat === 'number' &&
        typeof claims.exp === 'number' &&
        claims.iat <= now + 60 &&
        claims.exp > now &&
        claims.exp - claims.iat <= 10 * 60 + 60
      );
    } catch {
      return false;
    }
  }

  private who(req: IncomingMessage): {
    kind: 'jwt' | 'installation' | 'none';
    perms?: Record<string, string>;
    bad?: boolean;
  } {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!m) return { kind: 'none' };
    const token = m[1] as string;
    if (token.includes('.'))
      return this.verifyJwt(token) ? { kind: 'jwt' } : { kind: 'jwt', bad: true };
    const t = this.issued.find((x) => x.token === token);
    if (!t || this.revoked.has(token) || t.expires_at.getTime() <= this.clock.now().getTime()) {
      return { kind: 'installation', bad: true };
    }
    return { kind: 'installation', perms: t.permissions };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    let body = '';
    for await (const c of req) body += String(c);
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (bearer) this.seenBearers.add(bearer[1] as string);
    const who = this.who(req);
    const log = (status: number): void => {
      this.requests.push({ method, path, query: url.search.slice(1), auth: who.kind, status });
    };

    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (mint) {
      if (method !== 'POST')
        return void log(this.json(res, 405, { message: 'Method Not Allowed' }));
      if (who.kind !== 'jwt' || who.bad) {
        return void log(this.json(res, 401, { message: 'A JSON web token could not be decoded' }));
      }
      if (Number(mint[1]) !== this.seed.installation.installation_id)
        return void log(this.json(res, 404, notFound));
      let asked: Record<string, string>;
      try {
        asked =
          (JSON.parse(body || '{}') as { permissions?: Record<string, string> }).permissions ?? {};
      } catch {
        return void log(this.json(res, 400, { message: 'Problems parsing JSON' }));
      }
      const held = this.seed.installation.permissions;
      for (const [name, level] of Object.entries(asked)) {
        if ((LEVEL[held[name] ?? ''] ?? 0) < (LEVEL[level] ?? 99)) {
          return void log(
            this.json(res, 422, {
              message: `The permissions requested are not granted to this installation.`,
              documentation_url: 'https://docs.github.com/rest',
              status: '422',
            }),
          );
        }
      }
      const permissions = {
        ...(Object.keys(asked).length > 0 ? asked : held),
        ...(this.overshare ?? {}),
      };
      const expires = new Date(this.clock.now().getTime() + (this.o.tokenTtlMs ?? 3_600_000));
      const token = `ghs_${randomBytes(27).toString('base64url')}`;
      this.issued.push({ token, permissions, expires_at: expires });
      return void log(
        this.json(res, 201, {
          token,
          expires_at: ISO(expires),
          permissions,
          repository_selection: this.seed.installation.repository_selection,
        }),
      );
    }

    // Everything below is a resource request.
    if (this.override) {
      return void log(
        this.json(res, this.override.status, { message: 'overridden' }, this.override.headers),
      );
    }
    if (method !== 'GET') return void log(this.json(res, 405, { message: 'Method Not Allowed' }));
    if (who.kind === 'none' || who.bad)
      return void log(this.json(res, 401, { message: 'Bad credentials' }));

    const inst = /^\/app\/installations\/(\d+)$/.exec(path);
    if (inst) {
      if (who.kind !== 'jwt')
        return void log(this.json(res, 401, { message: 'A JSON web token could not be decoded' }));
      const i = this.seed.installation;
      if (Number(inst[1]) !== i.installation_id) return void log(this.json(res, 404, notFound));
      return void log(
        this.json(res, 200, {
          id: i.installation_id,
          account: { login: i.account_login, id: 1, type: 'Organization', site_admin: false },
          repository_selection: i.repository_selection,
          access_tokens_url: `${this.baseUrl}/app/installations/${i.installation_id}/access_tokens`,
          repositories_url: `${this.baseUrl}/installation/repositories`,
          app_id: Number(this.o.appId) || 1,
          target_id: 1,
          target_type: 'Organization',
          permissions: i.permissions,
          events: [],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          suspended_at: i.suspended ? '2026-02-01T00:00:00Z' : null,
        }),
      );
    }
    if (who.kind !== 'installation')
      return void log(this.json(res, 403, { message: 'Resource not accessible' }));
    const perms = who.perms ?? {};

    const forbidden = (): number =>
      this.json(res, 403, { message: 'Resource not accessible by integration', status: '403' });
    const needs = (name: string): boolean => (perms[name] ?? '') !== '';

    if (path === '/installation/repositories') {
      return void log(
        this.page(
          res,
          url,
          this.seed.repos.map((r) => repoJson(r)),
          (items) => ({
            total_count: this.seed.repos.length,
            repository_selection: this.seed.installation.repository_selection,
            repositories: items,
          }),
        ),
      );
    }

    const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
    if (!m) return void log(this.json(res, 404, notFound));
    const full = `${m[1]}/${m[2]}`;
    const rest = m[3] as string;
    if (!this.seed.repos.some((r) => repoKey(r.full_name) === repoKey(full))) {
      return void log(this.json(res, 404, notFound));
    }
    const same = (r: string): boolean => repoKey(r) === repoKey(full);
    const dec = (s: string): string => decodeURIComponent(s);

    let c: RegExpExecArray | null;
    if ((c = /^contents\/(.+)$/.exec(rest))) {
      if (!needs('contents')) return void log(forbidden());
      const p = c[1]!.split('/').map(dec).join('/');
      const ref = url.searchParams.get('ref') ?? '';
      const files = this.seed.files.filter((f) => same(f.repo) && f.sha === ref);
      const file = files.find((f) => f.path === p);
      if (file)
        return void log(
          this.json(res, 200, contentJson(this.baseUrl, full, file.path, file.content)),
        );
      const children = files.filter((f) => f.path.startsWith(`${p}/`));
      if (children.length > 0) {
        const names = [
          ...new Set(children.map((f) => f.path.slice(p.length + 1).split('/')[0] as string)),
        ];
        return void log(
          this.json(
            res,
            200,
            names.map((n) => ({ type: 'dir', name: n, path: `${p}/${n}`, size: 0 })),
          ),
        );
      }
      return void log(this.json(res, 404, notFound));
    }
    if ((c = /^git\/ref\/heads\/(.+)$/.exec(rest))) {
      if (!needs('contents')) return void log(forbidden());
      const branch = c[1]!.split('/').map(dec).join('/');
      const h = this.seed.heads.find((x) => same(x.repo) && x.branch === branch);
      if (!h) return void log(this.json(res, 404, notFound));
      return void log(
        this.json(res, 200, {
          ref: `refs/heads/${branch}`,
          node_id: 'MDM6UmVm',
          url: `${this.baseUrl}/repos/${full}/git/refs/heads/${branch}`,
          object: {
            sha: h.sha,
            type: 'commit',
            url: `${this.baseUrl}/repos/${full}/git/commits/${h.sha}`,
          },
        }),
      );
    }
    if ((c = /^git\/matching-refs\/(.*)$/.exec(rest))) {
      if (!needs('contents')) return void log(forbidden());
      const prefix = c[1]!.split('/').map(dec).join('/');
      const heads = this.seed.heads
        .filter((x) => same(x.repo) && `heads/${x.branch}`.startsWith(prefix))
        .map((h) => ({ ref: `refs/heads/${h.branch}`, object: { sha: h.sha, type: 'commit' } }));
      return void log(this.page(res, url, heads, (items) => items));
    }
    if ((c = /^commits\/([^/]+)$/.exec(rest))) {
      if (!needs('contents')) return void log(forbidden());
      const ref = dec(c[1] as string);
      const h = this.seed.heads.find((x) => same(x.repo) && (x.branch === ref || x.sha === ref));
      if (!h) return void log(this.json(res, 404, notFound));
      return void log(this.json(res, 200, { sha: h.sha, commit: { message: 'm' }, parents: [] }));
    }
    if ((c = /^rules\/branches\/([^/]+)$/.exec(rest))) {
      if (!needs('metadata')) return void log(forbidden());
      const branch = dec(c[1] as string);
      const rules = this.seed.rules
        .filter((x) => same(x.repo) && x.branch === branch)
        .flatMap((x) => x.rules);
      return void log(this.page(res, url, rules, (items) => items));
    }
    if (rest === 'codeowners/errors') {
      if (!needs('contents')) return void log(forbidden());
      const ref = url.searchParams.get('ref');
      const e = this.seed.codeowners_errors.find(
        (x) => same(x.repo) && (ref === null || x.ref === ref || ref.length === 40),
      );
      return void log(
        this.json(res, 200, {
          errors: (e?.errors ?? []).map((x) => ({ ...x, source: '* @nobody', suggestion: null })),
        }),
      );
    }
    if (rest === 'collaborators') {
      if (!needs('metadata')) return void log(forbidden());
      const list = this.seed.collaborators.find((x) => same(x.repo))?.collaborators ?? [];
      return void log(
        this.page(
          res,
          url,
          list.map((x, i) => collaboratorJson(x, i)),
          (items) => items,
        ),
      );
    }
    return void log(this.json(res, 404, notFound));
  }

  /** One page of `items` per `per_page`/`page`, with a `Link` header when there is a next page. */
  private page<T>(res: ServerResponse, url: URL, items: T[], wrap: (page: T[]) => unknown): number {
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30)));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < items.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      headers['link'] = `<${this.baseUrl}${next.pathname}${next.search}>; rel="next"`;
    }
    return this.json(res, 200, wrap(slice), headers);
  }
}

// ---------------------------------------------------------------- JSON shapes (GitHub REST docs)

function repoJson(r: CodeHostSeed['repos'][number]): Record<string, unknown> {
  const [owner, name] = r.full_name.split('/') as [string, string];
  return {
    id: 1000 + (name.length % 7),
    node_id: 'R_kgDOA',
    name,
    full_name: r.full_name,
    private: r.private,
    owner: { login: owner, id: 1, type: 'Organization', site_admin: false },
    html_url: `https://github.com/${r.full_name}`,
    description: null,
    fork: false,
    url: `https://api.github.com/repos/${r.full_name}`,
    default_branch: r.default_branch,
    archived: r.archived,
    disabled: false,
    visibility: r.private ? 'private' : 'public',
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
  };
}

function contentJson(
  base: string,
  repo: string,
  path: string,
  content: string,
): Record<string, unknown> {
  const b64 = Buffer.from(content)
    .toString('base64')
    .replace(/(.{60})/g, '$1\n');
  return {
    type: 'file',
    encoding: 'base64',
    size: Buffer.byteLength(content),
    name: path.split('/').pop(),
    path,
    content: b64.endsWith('\n') ? b64 : `${b64}\n`,
    sha: gitBlobSha(content),
    url: `${base}/repos/${repo}/contents/${path}`,
    html_url: `https://github.com/${repo}/blob/main/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo}/main/${path}`,
  };
}

function collaboratorJson(
  c: CodeHostSeed['collaborators'][number]['collaborators'][number],
  i: number,
): Record<string, unknown> {
  const level = ['read', 'triage', 'write', 'maintain', 'admin'];
  const n = level.indexOf(c.permission);
  return {
    login: c.login,
    id: 100 + i,
    type: 'User',
    site_admin: false,
    permissions: {
      pull: true,
      triage: n >= 1,
      push: n >= 2,
      maintain: n >= 3,
      admin: n >= 4,
    },
    role_name: c.permission,
  };
}
