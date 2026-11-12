import {
  GATE_CHECK_APP_PERMISSIONS,
  type CodeHostNotOk,
  type CodeHostRead,
  type GitSha,
} from '@aisdlc/contracts';
import type { AppKey } from '@aisdlc/codehost';
import { SecretValue, appJwt, notOkFromFetchError, notOkFromStatus } from '@aisdlc/codehost';
import { systemClock, type Clock } from '@aisdlc/kernel';
import {
  badCheckRunWrite,
  readOk,
  readUnknown,
  readUnreadable,
  type CheckRunRead,
  type CheckRunWrite,
  type GateCheckHostPort,
  type GateCheckPull,
  type PullCommit,
} from '@aisdlc/ports';
import { ServiceConfigError } from '@aisdlc/service-kit';
import { z } from 'zod';

// gate-check's GitHub adapter (PLAN M14.5): its OWN App (not the codehost's, not the Push Broker's), one installation
// token with exactly `GATE_CHECK_APP_PERMISSIONS` (checks write, pull requests read, metadata read), and five requests
// it can make, by construction:
//
//   POST /app/installations/{id}/access_tokens     (the App JWT) the installation token
//   GET  /repos/{r}/pulls?state=                    the open PRs; the closed ones, to observe merges
//   GET  /repos/{r}/pulls/{n}                       a merged PR's `merged_by` (the list does not carry it)
//   GET  /repos/{r}/pulls/{n}/commits               the commits of a PR (the laundering check)
//   GET  /repos/{r}/branches/{b}                    the default branch's head when a repo is first watched
//   GET  /repos/{r}/commits/{sha}/check-runs        the check runs on a head (was aisdlc/gate success at merge?)
//   POST /repos/{r}/check-runs                      aisdlc/gate on a head
//
// There is no other method, so nothing here can push, merge, approve or edit a rule. A token that comes back with more
// than was asked is discarded. The base URL is configuration (https, or plain http to loopback or a host the
// deployment names: the compose stack's fake GitHub); redirects are never followed (the token would go with them); no
// error or log line carries a header, a body or the token.

export interface GitHubChecksOptions {
  readonly baseUrl: string;
  readonly appId: string;
  readonly installationId: number;
  readonly appKey: AppKey;
  /** Hosts a plain-http base URL may name besides loopback (the compose stack's fake GitHub). */
  readonly plainHttpHosts?: readonly string[];
  readonly clock?: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** One line per request: `GET /repos/{r}/pulls -> 200`. Never a header, a body or a query value. */
  readonly log?: (line: string) => void;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };
const MAX_PAGES = 10;
const READ_LIMIT = 8 * 1024 * 1024;

const MintResponse = z.looseObject({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z.record(z.string(), z.string()),
});

const Pull = z.looseObject({
  number: z.number().int().min(1),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  merged_by: z.looseObject({ login: z.string() }).nullable().optional(),
  title: z.string(),
  body: z.string().nullable(),
  head: z.looseObject({ ref: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  base: z.looseObject({ ref: z.string().min(1) }),
  user: z.looseObject({ login: z.string().min(1), type: z.string() }).nullable(),
});
const Commits = z.array(
  z.looseObject({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    commit: z.looseObject({ message: z.string() }),
  }),
);
const CheckRuns = z.looseObject({
  check_runs: z.array(
    z.looseObject({
      id: z.number().int(),
      name: z.string(),
      head_sha: z.string(),
      status: z.enum(['queued', 'in_progress', 'completed']),
      conclusion: z.string().nullable(),
      app: z.looseObject({ id: z.number().int() }).nullable().optional(),
    }),
  ),
});
const Branch = z.looseObject({
  commit: z.looseObject({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
});
const Written = z.looseObject({ id: z.number().int().min(1) });

const enc = (repo: string): string =>
  repo
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');

/** The base URL a deployment may name, or a config error. */
export function checkBaseUrl(raw: string, plainHosts: readonly string[] = []): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ServiceConfigError('the GitHub API URL is not a URL');
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new ServiceConfigError('the GitHub API URL carries credentials, a query or a fragment');
  }
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && (LOOPBACK.has(u.hostname) || plainHosts.includes(u.hostname)))
    return u;
  throw new ServiceConfigError(
    'the GitHub API URL must be https (plain http only to loopback or a named fake host)',
  );
}

export class GitHubChecksHost implements GateCheckHostPort {
  readonly app_id: number;
  private readonly base: URL;
  private readonly clock: Clock;
  private readonly f: typeof fetch;
  private token: { secret: SecretValue; expires_at: number } | null = null;
  /** Tokens minted (cache hits are not mints). */
  mints = 0;

  constructor(private readonly o: GitHubChecksOptions) {
    this.base = checkBaseUrl(o.baseUrl, o.plainHttpHosts);
    const id = Number(o.appId);
    if (!Number.isInteger(id) || id < 1)
      throw new ServiceConfigError('the App id is a positive integer');
    this.app_id = id;
    this.clock = o.clock ?? systemClock;
    this.f = o.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.base.origin}${this.base.pathname.replace(/\/$/, '')}${path}`;
  }

  private async send(
    method: 'GET' | 'POST',
    template: string,
    url: string,
    authorization: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Headers; json: unknown } | CodeHostNotOk> {
    const what = `${method} ${template}`;
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      this.o.log?.(`${what} -> 0`);
      return notOkFromFetchError(e, what);
    }
    this.o.log?.(`${what} -> ${res.status}`);
    const text = await res.text().catch(() => null);
    if (text === null || text.length > READ_LIMIT) {
      return readUnknown('malformed', `${what}: the answer could not be read`);
    }
    if (res.status < 200 || res.status >= 300)
      return notOkFromStatus(res.status, res.headers, what);
    try {
      return {
        status: res.status,
        headers: res.headers,
        json: text === '' ? null : JSON.parse(text),
      };
    } catch {
      return readUnknown('malformed', `${what}: not JSON`);
    }
  }

  /** The installation token, minted with exactly the App's permissions; one that carries more is discarded. */
  private async auth(): Promise<string | CodeHostNotOk> {
    const now = this.clock.now().getTime();
    if (this.token && this.token.expires_at - 120_000 > now) {
      return `Bearer ${this.token.secret.reveal()}`;
    }
    this.token = null;
    const jwt = appJwt(this.o.appKey, this.o.appId, this.clock.now());
    const r = await this.send(
      'POST',
      '/app/installations/{installation_id}/access_tokens',
      this.url(`/app/installations/${this.o.installationId}/access_tokens`),
      `Bearer ${jwt}`,
      { permissions: GATE_CHECK_APP_PERMISSIONS },
    );
    if ('state' in r) return r;
    const m = MintResponse.safeParse(r.json);
    if (!m.success) return readUnknown('malformed', 'the token answer has no usable token');
    for (const [name, level] of Object.entries(m.data.permissions)) {
      const asked = GATE_CHECK_APP_PERMISSIONS[name];
      if (asked === undefined || (LEVEL[level] ?? 99) > (LEVEL[asked] ?? 0)) {
        // a token that can do more than gate-check's job is not used, and not kept
        return readUnreadable('refused', `the token came back with more than was asked (${name})`);
      }
    }
    this.mints += 1;
    this.token = {
      secret: new SecretValue(m.data.token),
      expires_at: Date.parse(m.data.expires_at),
    };
    return `Bearer ${m.data.token}`;
  }

  private async get(
    template: string,
    path: string,
    query: Record<string, string> = {},
  ): Promise<CodeHostRead<{ json: unknown; next: string | null }>> {
    const a = await this.auth();
    if (typeof a !== 'string') return a;
    const qs = new URLSearchParams(query).toString();
    const r = await this.send('GET', template, this.url(path) + (qs ? `?${qs}` : ''), a);
    if ('state' in r) return r;
    return readOk({ json: r.json, next: this.nextOf(r.headers) });
  }

  /** The `rel="next"` link, only when it stays on the configured host. */
  private nextOf(h: Headers): string | null {
    const link = h.get('link');
    const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
    if (!m) return null;
    try {
      const u = new URL(m[1] as string);
      return u.origin === this.base.origin ? u.toString() : null;
    } catch {
      return null;
    }
  }

  private async pages(
    template: string,
    path: string,
    query: Record<string, string>,
  ): Promise<CodeHostRead<unknown[]>> {
    const first = await this.get(template, path, { ...query, per_page: '100' });
    if (first.state !== 'ok') return first;
    if (!Array.isArray(first.value.json))
      return readUnknown('malformed', `${template}: not a list`);
    const out: unknown[] = [...first.value.json];
    let next = first.value.next;
    for (let i = 1; next !== null; i++) {
      if (i >= MAX_PAGES)
        return readUnknown('truncated', `${template}: more than ${MAX_PAGES} pages`);
      const a = await this.auth();
      if (typeof a !== 'string') return a;
      const r = await this.send('GET', template, next, a);
      if ('state' in r) return r;
      if (!Array.isArray(r.json)) return readUnknown('malformed', `${template}: not a list`);
      out.push(...r.json);
      next = this.nextOf(r.headers);
    }
    return readOk(out);
  }

  private pullOf(p: z.infer<typeof Pull>, mergedBy: string | null): GateCheckPull {
    const type = p.user?.type;
    return {
      number: p.number,
      state: p.state,
      draft: p.draft ?? false,
      merged: p.merged_at != null,
      head_sha: p.head.sha,
      head_ref: p.head.ref,
      base_ref: p.base.ref,
      author: {
        login: p.user?.login ?? 'ghost',
        type: type === 'Bot' || type === 'Organization' ? type : 'User',
      },
      title: p.title,
      body: p.body ?? '',
      merged_by: mergedBy,
      merge_commit_sha:
        p.merge_commit_sha && /^[0-9a-f]{40}$/.test(p.merge_commit_sha) ? p.merge_commit_sha : null,
      merged_at: p.merged_at ?? null,
    };
  }

  async list_pulls(req: {
    repo: string;
    state: 'open' | 'closed';
  }): Promise<CodeHostRead<GateCheckPull[]>> {
    const r = await this.pages('/repos/{r}/pulls', `/repos/${enc(req.repo)}/pulls`, {
      state: req.state,
      ...(req.state === 'closed' ? { sort: 'updated', direction: 'desc' } : {}),
    });
    if (r.state !== 'ok') return r;
    const out: GateCheckPull[] = [];
    for (const raw of r.value) {
      const p = Pull.safeParse(raw);
      if (!p.success) return readUnknown('malformed', 'a pull request has an unexpected shape');
      let mergedBy = p.data.merged_by?.login ?? null;
      if (p.data.merged_at != null && mergedBy === null) {
        // the list does not say who merged: the single pull request does
        const one = await this.get(
          '/repos/{r}/pulls/{n}',
          `/repos/${enc(req.repo)}/pulls/${p.data.number}`,
        );
        if (one.state !== 'ok') return one;
        const q = Pull.safeParse(one.value.json);
        if (!q.success) return readUnknown('malformed', 'a pull request has an unexpected shape');
        mergedBy = q.data.merged_by?.login ?? null;
      }
      out.push(this.pullOf(p.data, mergedBy));
    }
    return readOk(out);
  }

  async pull_commits(req: { repo: string; number: number }): Promise<CodeHostRead<PullCommit[]>> {
    const r = await this.pages(
      '/repos/{r}/pulls/{n}/commits',
      `/repos/${enc(req.repo)}/pulls/${req.number}/commits`,
      {},
    );
    if (r.state !== 'ok') return r;
    const c = Commits.safeParse(r.value);
    if (!c.success) return readUnknown('malformed', 'the commits have an unexpected shape');
    return readOk(c.data.map((x) => ({ sha: x.sha, message: x.commit.message })));
  }

  async branch_head(req: { repo: string; branch: string }): Promise<CodeHostRead<GitSha>> {
    const r = await this.get(
      '/repos/{r}/branches/{b}',
      `/repos/${enc(req.repo)}/branches/${encodeURIComponent(req.branch)}`,
    );
    if (r.state !== 'ok') return r;
    const b = Branch.safeParse(r.value.json);
    if (!b.success) return readUnknown('malformed', 'the branch has an unexpected shape');
    return readOk(b.data.commit.sha);
  }

  async check_runs(req: {
    repo: string;
    sha: GitSha;
    name: string;
  }): Promise<CodeHostRead<CheckRunRead[]>> {
    if (!/^[0-9a-f]{40}$/.test(req.sha)) return readUnreadable('refused', 'not a commit sha');
    const r = await this.get(
      '/repos/{r}/commits/{sha}/check-runs',
      `/repos/${enc(req.repo)}/commits/${req.sha}/check-runs`,
      { check_name: req.name, per_page: '100' },
    );
    if (r.state !== 'ok') return r;
    const c = CheckRuns.safeParse(r.value.json);
    if (!c.success) return readUnknown('malformed', 'the check runs have an unexpected shape');
    return readOk(
      c.data.check_runs
        .filter((x) => x.name === req.name && x.head_sha === req.sha)
        .map((x) => ({
          id: x.id,
          name: x.name,
          head_sha: x.head_sha,
          status: x.status,
          conclusion: x.conclusion,
          app_id: x.app?.id ?? null,
        })),
    );
  }

  async write_check_run(req: CheckRunWrite): Promise<CodeHostRead<{ id: number; app_id: number }>> {
    const bad = badCheckRunWrite(req);
    if (bad) return readUnreadable('refused', bad);
    const a = await this.auth();
    if (typeof a !== 'string') return a;
    const r = await this.send(
      'POST',
      '/repos/{r}/check-runs',
      this.url(`/repos/${enc(req.repo)}/check-runs`),
      a,
      {
        name: req.name,
        head_sha: req.head_sha,
        status: req.status,
        ...(req.conclusion === null ? {} : { conclusion: req.conclusion }),
        external_id: req.external_id,
        output: { title: req.title, summary: req.summary },
      },
    );
    if ('state' in r) return r;
    const w = Written.safeParse(r.json);
    if (!w.success) return readUnknown('malformed', 'the check run answer has no id');
    return readOk({ id: w.data.id, app_id: this.app_id });
  }
}
