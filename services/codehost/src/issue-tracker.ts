import { TRACKER_APP_PERMISSIONS, type CodeHostNotOk, type CodeHostRead } from '@aisdlc/contracts';
import { systemClock, type Clock } from '@aisdlc/kernel';
import {
  badIssueComment,
  badIssueFile,
  isOwnIssue,
  readOk,
  readUnknown,
  readUnreadable,
  type IssueFile,
  type IssueTrackerPort,
  type TrackedIssue,
} from '@aisdlc/ports';
import { ServiceConfigError } from '@aisdlc/service-kit';
import { z } from 'zod';
import { SecretValue, type AppKey } from './app-key.js';
import { notOkFromFetchError, notOkFromStatus } from './http.js';
import { appJwt } from './jwt.js';

// The issue tracker's GitHub adapter (PLAN M16; OB §6.5 "Gap issues: new `tracker` role, issues:write +
// metadata:read"). Its OWN credential: an App id, an installation and a key reference that are not the Push Broker's
// and not gate-check's, and one installation token with exactly `TRACKER_APP_PERMISSIONS`. The requests it can make,
// by construction:
//
//   POST  /app/installations/{id}/access_tokens   (the App JWT) the installation token
//   GET   /repos/{r}/issues?labels=&state=all     the labelled issues (pull requests left out)
//   GET   /repos/{r}/issues/{n}                   one issue (closed_by; 404, 410 deleted, 301 transferred: not found)
//   POST  /repos/{r}/issues                       a twin: title, body, labels, nothing else
//   POST  /repos/{r}/issues/{n}/comments          a comment on the tracker's own issue
//   PATCH /repos/{r}/issues/{n}                   {state: closed, state_reason: completed} on the tracker's own issue
//
// Nothing here edits a title, a body or a label after filing, reopens, locks, transfers or deletes. Before a comment
// or a close the issue is read and must be the tracker's own (its bot AND its marker). A token that comes back with
// more than was asked is discarded. The base URL is https, or plain http to loopback or a host the deployment names;
// redirects are never followed; no error or log line carries a header, a body or the token.

export interface GitHubIssueTrackerOptions {
  readonly baseUrl: string;
  readonly appId: string;
  readonly installationId: number;
  readonly appKey: AppKey;
  /** The login the App writes as (`<slug>[bot]`): the author of every twin. */
  readonly login: string;
  readonly plainHttpHosts?: readonly string[];
  readonly clock?: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** One line per request: `GET /repos/{r}/issues -> 200`. Never a header, a body or a query value. */
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

const Issue = z.looseObject({
  number: z.number().int().min(1),
  state: z.enum(['open', 'closed']),
  title: z.string(),
  body: z.string().nullable().optional(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])),
  user: z.looseObject({ login: z.string().min(1), type: z.string() }).nullable(),
  closed_by: z
    .looseObject({ login: z.string().min(1) })
    .nullable()
    .optional(),
  pull_request: z.unknown().optional(),
});
const Created = z.looseObject({ number: z.number().int().min(1) });
const Commented = z.looseObject({ id: z.number().int().min(1) });

const enc = (repo: string): string =>
  repo
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');

/** The base URL a deployment may name, or a config error. */
export function trackerBaseUrl(raw: string, plainHosts: readonly string[] = []): URL {
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

function trackedOf(i: z.infer<typeof Issue>): TrackedIssue {
  const type = i.user?.type;
  return {
    number: i.number,
    state: i.state,
    title: i.title,
    body: i.body ?? '',
    labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    author: {
      login: i.user?.login ?? 'ghost',
      type: type === 'Bot' || type === 'Organization' ? type : 'User',
    },
    closed_by: i.state === 'closed' ? (i.closed_by?.login ?? null) : null,
  };
}

export class GitHubIssueTracker implements IssueTrackerPort {
  readonly login: string;
  private readonly base: URL;
  private readonly clock: Clock;
  private readonly f: typeof fetch;
  private token: { secret: SecretValue; expires_at: number } | null = null;
  /** Tokens minted (cache hits are not mints). */
  mints = 0;

  constructor(private readonly o: GitHubIssueTrackerOptions) {
    this.base = trackerBaseUrl(o.baseUrl, o.plainHttpHosts);
    if (!/^[1-9][0-9]*$/.test(o.appId)) {
      throw new ServiceConfigError('the tracker App id is a positive integer');
    }
    if (!/^[A-Za-z0-9-]+(\[bot\])?$/.test(o.login)) {
      throw new ServiceConfigError('the tracker login is a GitHub login (`<slug>[bot]`)');
    }
    this.login = o.login;
    this.clock = o.clock ?? systemClock;
    this.f = o.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.base.origin}${this.base.pathname.replace(/\/$/, '')}${path}`;
  }

  private async send(
    method: 'GET' | 'POST' | 'PATCH',
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
    // 410: GitHub's answer for a deleted issue. It is gone, as a 404 is.
    if (res.status === 410) return readUnreadable('not_found', `${what}: 410 (deleted)`);
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

  /** The installation token, minted with exactly the tracker's permissions; one that carries more is discarded. */
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
      { permissions: TRACKER_APP_PERMISSIONS },
    );
    if ('state' in r) return r;
    const m = MintResponse.safeParse(r.json);
    if (!m.success) return readUnknown('malformed', 'the token answer has no usable token');
    for (const [name, level] of Object.entries(m.data.permissions)) {
      const asked = TRACKER_APP_PERMISSIONS[name];
      if (asked === undefined || (LEVEL[level] ?? 99) > (LEVEL[asked] ?? 0)) {
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

  private async call(
    method: 'GET' | 'POST' | 'PATCH',
    template: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Headers; json: unknown } | CodeHostNotOk> {
    const a = await this.auth();
    if (typeof a !== 'string') return a;
    return this.send(method, template, url, a, body);
  }

  async list_labelled(req: { repo: string; label: string }): Promise<CodeHostRead<TrackedIssue[]>> {
    const template = '/repos/{r}/issues';
    const qs = new URLSearchParams({ labels: req.label, state: 'all', per_page: '100' });
    let next: string | null = `${this.url(`/repos/${enc(req.repo)}/issues`)}?${qs.toString()}`;
    const out: TrackedIssue[] = [];
    for (let page = 0; next !== null; page++) {
      if (page >= MAX_PAGES)
        return readUnknown('truncated', `${template}: more than ${MAX_PAGES} pages`);
      const r = await this.call('GET', template, next);
      if ('state' in r) return r;
      if (!Array.isArray(r.json)) return readUnknown('malformed', `${template}: not a list`);
      for (const raw of r.json) {
        const i = Issue.safeParse(raw);
        if (!i.success) return readUnknown('malformed', 'an issue has an unexpected shape');
        if (i.data.pull_request !== undefined) continue; // a pull request, not an issue
        out.push(trackedOf(i.data));
      }
      next = this.nextOf(r.headers);
    }
    return readOk(out);
  }

  async read_issue(req: { repo: string; number: number }): Promise<CodeHostRead<TrackedIssue>> {
    if (!Number.isInteger(req.number) || req.number < 1)
      return readUnreadable('refused', 'not an issue number');
    const r = await this.call(
      'GET',
      '/repos/{r}/issues/{n}',
      this.url(`/repos/${enc(req.repo)}/issues/${req.number}`),
    );
    if ('state' in r) return r;
    const i = Issue.safeParse(r.json);
    if (!i.success) return readUnknown('malformed', 'the issue has an unexpected shape');
    if (i.data.pull_request !== undefined) return readUnreadable('not_found', 'a pull request');
    return readOk(trackedOf(i.data));
  }

  async file_issue(req: IssueFile): Promise<CodeHostRead<{ number: number }>> {
    const bad = badIssueFile(req);
    if (bad) return readUnreadable('refused', bad);
    const r = await this.call(
      'POST',
      '/repos/{r}/issues',
      this.url(`/repos/${enc(req.repo)}/issues`),
      {
        title: req.title,
        body: req.body,
        labels: [...req.labels],
      },
    );
    if ('state' in r) return r;
    const c = Created.safeParse(r.json);
    return c.success
      ? readOk({ number: c.data.number })
      : readUnknown('malformed', 'the created issue has no number');
  }

  /** The tracker's own issue, read fresh before a write; anybody else's is refused. */
  private async own(repo: string, number: number): Promise<CodeHostRead<TrackedIssue>> {
    const r = await this.read_issue({ repo, number });
    if (r.state !== 'ok') return r;
    if (!isOwnIssue(r.value, this.login)) {
      return readUnreadable(
        'refused',
        `issue ${number} is not the tracker's own: never written to`,
      );
    }
    return r;
  }

  async comment_issue(req: {
    repo: string;
    number: number;
    body: string;
  }): Promise<CodeHostRead<{ id: number }>> {
    const bad = badIssueComment(req.body);
    if (bad) return readUnreadable('refused', bad);
    const own = await this.own(req.repo, req.number);
    if (own.state !== 'ok') return own;
    const r = await this.call(
      'POST',
      '/repos/{r}/issues/{n}/comments',
      this.url(`/repos/${enc(req.repo)}/issues/${req.number}/comments`),
      { body: req.body },
    );
    if ('state' in r) return r;
    const c = Commented.safeParse(r.json);
    return c.success
      ? readOk({ id: c.data.id })
      : readUnknown('malformed', 'the comment has no id');
  }

  async close_issue(req: {
    repo: string;
    number: number;
  }): Promise<CodeHostRead<{ number: number }>> {
    const own = await this.own(req.repo, req.number);
    if (own.state !== 'ok') return own;
    if (own.value.state === 'closed') return readOk({ number: req.number });
    const r = await this.call(
      'PATCH',
      '/repos/{r}/issues/{n}',
      this.url(`/repos/${enc(req.repo)}/issues/${req.number}`),
      { state: 'closed', state_reason: 'completed' },
    );
    if ('state' in r) return r;
    return readOk({ number: req.number });
  }
}
