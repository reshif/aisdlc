import { createPublicKey, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gitBlobSha, repoKey, type CodeHostSeed } from '@aisdlc/ports';
import { GitObjects } from './fake-github-objects.js';
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

/** A pull request the fake holds (GitHub's fields, the ones the broker reads and writes). */
export interface FakePull {
  number: number;
  repo: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
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
  /** Where to listen. Default a random loopback port; the compose stack's fake host fixes both. */
  readonly listenPort?: number;
  readonly listenHost?: string;
  /** Called for every request after it was answered (the compose stack prints them as its request log). */
  readonly onRequest?: (r: FakeGitHubRequest) => void;
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
  /** Blobs, trees and commits the Git Data API wrote (real git hashes). */
  readonly objects: GitObjects;
  readonly pulls: FakePull[] = [];
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
    this.objects = new GitObjects(this.seed);
  }

  private get clock(): Clock {
    return this.o.clock ?? systemClock;
  }

  load(seed: CodeHostSeed): this {
    this.seed = seed;
    this.objects.load(seed);
    this.pulls.length = 0;
    return this;
  }

  /** Somebody else wrote to a branch (a person pushed, against the rules): it now points at `sha`. */
  moveBranch(repo: string, branch: string, sha: string): this {
    const h = this.seed.heads.find((x) => repoKey(x.repo) === repoKey(repo) && x.branch === branch);
    if (h) h.sha = sha;
    else this.seed.heads.push({ repo, branch, sha });
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
    await new Promise<void>((resolve) =>
      this.server?.listen(this.o.listenPort ?? 0, this.o.listenHost ?? '127.0.0.1', resolve),
    );
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
    if (path === '/healthz' && method === 'GET') {
      // Not GitHub, not logged: the compose healthcheck's door.
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    const log = (status: number): void => {
      const entry = { method, path, query: url.search.slice(1), auth: who.kind, status };
      this.requests.push(entry);
      this.o.onRequest?.(entry);
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
    if (!['GET', 'POST', 'PATCH'].includes(method)) {
      return void log(this.json(res, 405, { message: 'Method Not Allowed' }));
    }
    if (who.kind === 'none' || who.bad)
      return void log(this.json(res, 401, { message: 'Bad credentials' }));

    const inst = /^\/app\/installations\/(\d+)$/.exec(path);
    if (method !== 'GET' && !/^\/repos\//.test(path)) {
      return void log(this.json(res, 405, { message: 'Method Not Allowed' }));
    }
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

    if (method !== 'GET') {
      return void log(this.write(res, method, full, rest, perms, body));
    }
    let c: RegExpExecArray | null;
    if ((c = /^pulls$/.exec(rest))) {
      if (!needs('pull_requests')) return void log(forbidden());
      const head = url.searchParams.get('head') ?? '';
      const state = url.searchParams.get('state') ?? 'open';
      const list = this.pulls
        .filter((p) => same(p.repo) && (state === 'all' || p.state === state))
        .filter((p) => head === '' || `${full.split('/')[0]}:${p.head.ref}` === head)
        .map((p) => this.pullJson(p));
      return void log(this.page(res, url, list, (items) => items));
    }
    if ((c = /^pulls\/(\d+)$/.exec(rest))) {
      if (!needs('pull_requests')) return void log(forbidden());
      const p = this.pulls.find((x) => same(x.repo) && x.number === Number(c![1]));
      return void log(p ? this.json(res, 200, this.pullJson(p)) : this.json(res, 404, notFound));
    }
    if ((c = /^git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      if (!needs('contents')) return void log(forbidden());
      const cm = this.objects.commit(full, c[1] as string);
      if (!cm) return void log(this.json(res, 404, notFound));
      return void log(
        this.json(res, 200, {
          sha: cm.sha,
          url: `${this.baseUrl}/repos/${full}/git/commits/${cm.sha}`,
          tree: { sha: cm.tree, url: `${this.baseUrl}/repos/${full}/git/trees/${cm.tree}` },
          parents: cm.parents.map((x) => ({ sha: x })),
          message: cm.message,
          author: cm.author,
          committer: cm.committer,
        }),
      );
    }
    if ((c = /^contents\/(.+)$/.exec(rest))) {
      if (!needs('contents')) return void log(forbidden());
      const p = c[1]!.split('/').map(dec).join('/');
      const ref = url.searchParams.get('ref') ?? '';
      if (this.objects.created(ref)) {
        const bytes = this.objects.fileAt(full, ref, p);
        if (bytes)
          return void log(
            this.json(res, 200, contentJson(this.baseUrl, full, p, bytes.toString('utf8'))),
          );
        return void log(this.json(res, 404, notFound));
      }
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

  private pullJson(p: FakePull): Record<string, unknown> {
    // a pull request's head follows its branch, as on GitHub
    const live = this.seed.heads.find(
      (h) => repoKey(h.repo) === repoKey(p.repo) && h.branch === p.head.ref,
    );
    if (live) p.head.sha = live.sha;
    return {
      url: `${this.baseUrl}/repos/${p.repo}/pulls/${p.number}`,
      html_url: `https://github.example/${p.repo}/pull/${p.number}`,
      number: p.number,
      state: p.state,
      draft: p.draft,
      merged: p.merged,
      title: p.title,
      body: p.body,
      head: { ref: p.head.ref, sha: p.head.sha, label: `${p.repo.split('/')[0]}:${p.head.ref}` },
      base: { ref: p.base.ref },
      user: { login: 'aisdlc[bot]', type: 'Bot' },
    };
  }

  /**
   * The write endpoints of the Git Data API and the pull requests, as GitHub answers them (PLAN M13.6): blobs, trees,
   * commits, refs (a ref update that is not a fast-forward is 422 `Update is not a fast forward`, as GitHub says it),
   * and draft pull requests. It checks what GitHub checks: the token's `contents` and `pull_requests` write. There is no
   * merge, review, status or delete here: those are 404.
   */
  private write(
    res: ServerResponse,
    method: string,
    full: string,
    rest: string,
    perms: Record<string, string>,
    raw: string,
  ): number {
    const canWrite = (name: string): boolean => (LEVEL[perms[name] ?? ''] ?? 0) >= 2;
    const denied = (): number =>
      this.json(res, 403, { message: 'Resource not accessible by integration', status: '403' });
    const bad = (message: string): number =>
      this.json(res, 422, {
        message,
        documentation_url: 'https://docs.github.com/rest',
        status: '422',
      });
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      return this.json(res, 400, { message: 'Problems parsing JSON' });
    }
    const same = (r: string): boolean => repoKey(r) === repoKey(full);
    const now = this.clock.now().toISOString();
    let c: RegExpExecArray | null;
    if (method === 'POST' && rest === 'git/blobs') {
      if (!canWrite('contents')) return denied();
      if (typeof j['content'] !== 'string' || j['encoding'] !== 'base64')
        return bad('Invalid blob');
      const sha = this.objects.addBlob(Buffer.from(j['content'], 'base64'));
      return this.json(res, 201, { sha, url: `${this.baseUrl}/repos/${full}/git/blobs/${sha}` });
    }
    if (method === 'POST' && rest === 'git/trees') {
      if (!canWrite('contents')) return denied();
      const entries = Array.isArray(j['tree'])
        ? (j['tree'] as Array<Record<string, unknown>>)
        : null;
      if (!entries) return bad('tree is required');
      const base = typeof j['base_tree'] === 'string' ? j['base_tree'] : undefined;
      const t = this.objects.createTree(
        base,
        entries.map((e) => ({
          path: String(e['path']),
          mode: String(e['mode']),
          sha: e['sha'] === null ? null : String(e['sha']),
        })),
      );
      if ('error' in t) return bad(t.error);
      return this.json(res, 201, {
        sha: t.sha,
        url: `${this.baseUrl}/repos/${full}/git/trees/${t.sha}`,
        tree: entries.map((e) => ({
          path: e['path'],
          mode: e['mode'],
          type: 'blob',
          sha: e['sha'],
        })),
        truncated: false,
      });
    }
    if (method === 'POST' && rest === 'git/commits') {
      if (!canWrite('contents')) return denied();
      const who = (v: unknown): { name: string; email: string; date: string } => {
        const o = (v ?? {}) as Record<string, unknown>;
        return {
          name: typeof o['name'] === 'string' ? o['name'] : 'aisdlc[bot]',
          email: typeof o['email'] === 'string' ? o['email'] : 'bot@users.noreply.github.example',
          date: typeof o['date'] === 'string' ? o['date'] : now,
        };
      };
      const k = this.objects.createCommit(full, {
        tree: String(j['tree']),
        parents: Array.isArray(j['parents']) ? (j['parents'] as unknown[]).map(String) : [],
        message: String(j['message'] ?? ''),
        author: who(j['author']),
        committer: who(j['committer'] ?? j['author']),
      });
      if ('error' in k) return bad(k.error);
      return this.json(res, 201, {
        sha: k.sha,
        url: `${this.baseUrl}/repos/${full}/git/commits/${k.sha}`,
        tree: { sha: String(j['tree']) },
        parents: (j['parents'] as unknown[]).map((x) => ({ sha: String(x) })),
        message: String(j['message'] ?? ''),
      });
    }
    if (method === 'POST' && rest === 'git/refs') {
      if (!canWrite('contents')) return denied();
      const ref = String(j['ref'] ?? '');
      const m = /^refs\/heads\/(.+)$/.exec(ref);
      if (!m) return bad('Reference is invalid');
      const branch = m[1] as string;
      if (this.seed.heads.some((h) => same(h.repo) && h.branch === branch)) {
        return bad('Reference already exists');
      }
      const sha = String(j['sha'] ?? '');
      if (!this.objects.commit(full, sha)) return bad('Object does not exist');
      this.seed.heads.push({ repo: full, branch, sha });
      return this.json(res, 201, {
        ref,
        object: { sha, type: 'commit', url: `${this.baseUrl}/repos/${full}/git/commits/${sha}` },
      });
    }
    if (method === 'PATCH' && (c = /^git\/refs\/heads\/(.+)$/.exec(rest))) {
      if (!canWrite('contents')) return denied();
      const branch = c[1]!.split('/').map(decodeURIComponent).join('/');
      const head = this.seed.heads.find((h) => same(h.repo) && h.branch === branch);
      if (!head) return this.json(res, 404, notFound);
      const sha = String(j['sha'] ?? '');
      if (!this.objects.commit(full, sha)) return bad('Object does not exist');
      if (j['force'] !== true && !this.objects.isAncestor(full, head.sha, sha)) {
        return bad('Update is not a fast forward');
      }
      head.sha = sha;
      return this.json(res, 200, {
        ref: `refs/heads/${branch}`,
        object: { sha, type: 'commit', url: `${this.baseUrl}/repos/${full}/git/commits/${sha}` },
      });
    }
    if (method === 'POST' && rest === 'pulls') {
      if (!canWrite('pull_requests')) return denied();
      const headRef = String(j['head'] ?? '');
      const head = this.seed.heads.find((h) => same(h.repo) && h.branch === headRef);
      const baseRef = String(j['base'] ?? '');
      if (!head) return bad('Validation Failed: head ref does not exist');
      if (!this.seed.heads.some((h) => same(h.repo) && h.branch === baseRef)) {
        return bad('Validation Failed: base ref does not exist');
      }
      if (this.pulls.some((p) => same(p.repo) && p.state === 'open' && p.head.ref === headRef)) {
        return bad('A pull request already exists for this head');
      }
      const p: FakePull = {
        number: this.pulls.filter((x) => same(x.repo)).length + 1,
        repo: full,
        title: String(j['title'] ?? ''),
        body: String(j['body'] ?? ''),
        state: 'open',
        draft: j['draft'] === true,
        merged: false,
        head: { ref: headRef, sha: head.sha },
        base: { ref: baseRef },
      };
      this.pulls.push(p);
      return this.json(res, 201, this.pullJson(p));
    }
    if (method === 'PATCH' && (c = /^pulls\/(\d+)$/.exec(rest))) {
      if (!canWrite('pull_requests')) return denied();
      const p = this.pulls.find((x) => same(x.repo) && x.number === Number(c![1]));
      if (!p) return this.json(res, 404, notFound);
      if (typeof j['title'] === 'string') p.title = j['title'];
      if (typeof j['body'] === 'string') p.body = j['body'];
      // a pull request's head follows its branch
      const head = this.seed.heads.find((h) => same(h.repo) && h.branch === p.head.ref);
      if (head) p.head.sha = head.sha;
      return this.json(res, 200, this.pullJson(p));
    }
    return this.json(res, 404, notFound);
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
