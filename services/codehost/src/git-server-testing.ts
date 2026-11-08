import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Test infrastructure for the bundle (PLAN M5.3): fixture git repositories with branches, tags and
// pull-request refs, and a real git smart-HTTP server in front of them (`git http-backend`, the
// CGI git ships) that answers only a request whose `Authorization` header `isAuthorized` accepts. A test
// therefore proves the token reached git as a header, and a push (`git-receive-pack`) is refused
// and counted.

/** Git with nothing from the machine: no global config, no templates, fixed identity and dates. */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim();
}

/** Deterministic incompressible bytes (a hash chain), so a fixture of a given size is the same every run. */
export function noise(seed: string, bytes: number): Buffer {
  const out: Buffer[] = [];
  let have = 0;
  let h = createHash('sha256').update(seed).digest();
  while (have < bytes) {
    out.push(h);
    have += h.length;
    h = createHash('sha256').update(h).digest();
  }
  return Buffer.concat(out).subarray(0, bytes);
}

export interface FixtureRepoSpec {
  /** `acme/app` */
  readonly name: string;
  readonly default_branch?: string;
  /** Commits on the default branch (each adds a file). Default 3. */
  readonly commits?: number;
  /** Extra branches, each one commit off the default branch's head. */
  readonly branches?: ReadonlyArray<{ name: string; padBytes?: number }>;
  readonly tags?: readonly string[];
  readonly annotatedTags?: readonly string[];
  /** `refs/pull/<n>/head` pointing at the head of the named branch. */
  readonly pulls?: ReadonlyArray<{ number: number; branch: string }>;
  /** Random bytes in every default-branch commit (to make the repo large). */
  readonly padBytes?: number;
  /** No commits at all. */
  readonly empty?: boolean;
}

export interface FixtureRepo {
  readonly name: string;
  readonly bare: string;
  readonly default_branch: string;
  /** Head of the default branch. */
  readonly head: string;
  readonly refs: Record<string, string>;
}

/** Builds `<root>/<owner>/<name>.git` as a bare repo with the refs `spec` asks for. */
export function createFixtureRepo(root: string, spec: FixtureRepoSpec): FixtureRepo {
  const dflt = spec.default_branch ?? 'main';
  const bare = join(root, `${spec.name}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  execFileSync('git', ['init', '--bare', '--quiet', `--initial-branch=${dflt}`, bare], {
    env: gitEnv(),
  });
  if (spec.empty) return { name: spec.name, bare, default_branch: dflt, head: '', refs: {} };
  const work = mkdtempSync(join(tmpdir(), 'aisdlc-fixture-'));
  try {
    git(work, 'init', '--quiet', `--initial-branch=${dflt}`);
    for (let i = 1; i <= (spec.commits ?? 3); i++) {
      writeFileSync(join(work, `file-${i}.txt`), `commit ${i} of ${spec.name}\n`);
      if (spec.padBytes)
        writeFileSync(join(work, `pad-${i}.bin`), noise(`${spec.name}-${i}`, spec.padBytes));
      git(work, 'add', '-A');
      git(work, 'commit', '--quiet', '-m', `commit ${i}`);
    }
    const head = git(work, 'rev-parse', 'HEAD');
    const refs: Record<string, string> = { [`refs/heads/${dflt}`]: head };
    for (const b of spec.branches ?? []) {
      git(work, 'checkout', '--quiet', '-b', b.name, head);
      writeFileSync(join(work, `branch-${b.name.replace(/\W/g, '_')}.txt`), `branch ${b.name}\n`);
      if (b.padBytes)
        writeFileSync(
          join(work, `pad-${b.name.replace(/\W/g, '_')}.bin`),
          noise(b.name, b.padBytes),
        );
      git(work, 'add', '-A');
      git(work, 'commit', '--quiet', '-m', `on ${b.name}`);
      refs[`refs/heads/${b.name}`] = git(work, 'rev-parse', 'HEAD');
      git(work, 'checkout', '--quiet', dflt);
    }
    for (const t of spec.tags ?? []) {
      git(work, 'tag', t, head);
      refs[`refs/tags/${t}`] = head;
    }
    for (const t of spec.annotatedTags ?? []) {
      git(work, 'tag', '-a', '-m', `release ${t}`, t, head);
      refs[`refs/tags/${t}`] = git(work, 'rev-parse', `refs/tags/${t}`);
    }
    git(work, 'push', '--quiet', '--mirror', bare);
    for (const p of spec.pulls ?? []) {
      const sha = refs[`refs/heads/${p.branch}`];
      if (!sha) throw new Error(`fixture: no branch ${p.branch} for pull ${p.number}`);
      git(bare, 'update-ref', `refs/pull/${p.number}/head`, sha);
      refs[`refs/pull/${p.number}/head`] = sha;
    }
    return { name: spec.name, bare, default_branch: dflt, head, refs };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface GitServerRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly authorized: boolean;
}

/**
 * `git http-backend` behind a small Node HTTP server. A request that is not authorized gets a 401. Pushes are refused with a 403.
 */
export class GitHttpTestServer {
  readonly requests: GitServerRequest[] = [];
  /** Requests that tried to push (`git-receive-pack`). */
  pushAttempts = 0;
  private server: Server | null = null;
  baseUrl = '';

  constructor(
    private readonly o: {
      readonly root: string;
      /** Is this `Authorization` header (or its absence) acceptable? */
      readonly isAuthorized: (header: string | undefined) => boolean;
    },
  ) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    s?.closeAllConnections();
    await new Promise<void>((r) => (s ? s.close(() => r()) : r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const authorized = this.o.isAuthorized(req.headers.authorization);
    this.requests.push({
      method: req.method ?? '',
      path: url.pathname,
      query: url.search,
      authorized,
    });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (!authorized) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end('unauthorized');
      return;
    }
    if (/git-receive-pack/.test(url.pathname + url.search)) {
      this.pushAttempts += 1;
      res.writeHead(403).end('pushes are refused');
      return;
    }
    const cgi = spawn('git', ['http-backend'], {
      env: gitEnv({
        GIT_PROJECT_ROOT: this.o.root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(body.length),
        REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['content-encoding']
          ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) }
          : {}),
        ...(req.headers['git-protocol']
          ? { HTTP_GIT_PROTOCOL: String(req.headers['git-protocol']) }
          : {}),
      }),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    cgi.stdin.on('error', () => undefined);
    cgi.stdin.end(body);
    const out: Buffer[] = [];
    for await (const c of cgi.stdout) out.push(c as Buffer);
    const all = Buffer.concat(out);
    const sep = all.indexOf('\r\n\r\n');
    if (sep < 0) {
      res.writeHead(500).end('bad CGI answer');
      return;
    }
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of all.subarray(0, sep).toString('latin1').split('\r\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === 'status') status = Number(v.split(' ')[0]);
      else headers[k] = v;
    }
    res.writeHead(status, headers).end(all.subarray(sep + 4));
  }
}
