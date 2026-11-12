import {
  CodeHostNotOk,
  GateCheckAuthor,
  type CodeHostRead,
  type RepoFullName,
} from '@aisdlc/contracts';
import { z } from 'zod';
import { readOk, readUnknown } from './codehost.js';
import type { IssueFile, IssueTrackerPort, TrackedIssue } from './issue-tracker.js';

// The issue twin's tracker over the codehost's HTTP API (PLAN M16; user decision 2026-11-12: core-worker keeps NO route
// out). Every GitHub call is the codehost's: it holds the tracker App's OWN key (issues: write, metadata: read; never the
// Push Broker's or the read App's), checks that the repo is registered, and serves the five operations of
// `IssueTrackerPort` as narrow routes under scope `tracker` (only core-worker holds that token). This adapter is what
// core-worker's `issue_twin` loop calls, with its own service token. A 2xx is a `CodeHostRead` with state `ok`; any
// other answer carries the read that was not ok; anything else (network, a garbled body) is `unknown`, never a value.

export interface HttpIssueTrackerOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** The login the codehost's tracker App writes as (`<slug>[bot]`): the author of every twin. */
  readonly login: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The routes, once: what the codehost serves and this adapter calls. */
export const TRACKER_ROUTES = {
  issues: (repo: string) => `/v1/tracker/repos/${repo}/issues`,
  issue: (repo: string, n: number) => `/v1/tracker/repos/${repo}/issues/${n}`,
  comments: (repo: string, n: number) => `/v1/tracker/repos/${repo}/issues/${n}/comments`,
  close: (repo: string, n: number) => `/v1/tracker/repos/${repo}/issues/${n}/close`,
} as const;

export const TrackedIssueWire = z.strictObject({
  number: z.number().int().min(1),
  state: z.enum(['open', 'closed']),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  author: GateCheckAuthor,
  closed_by: z.string().nullable(),
});

export class HttpIssueTracker implements IssueTrackerPort {
  readonly login: string;
  constructor(private readonly o: HttpIssueTrackerOptions) {
    this.login = o.login;
  }

  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    value: S,
    body?: unknown,
  ): Promise<CodeHostRead<z.infer<S>>> {
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(new URL(path, this.o.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${this.o.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch {
      return readUnknown('network', `codehost did not answer ${path.split('?')[0]}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return readUnknown('malformed', `codehost answered ${res.status} without JSON`);
    }
    if (res.status >= 200 && res.status < 300) {
      const ok = z
        .strictObject({ state: z.literal('ok'), value: value as z.ZodType })
        .safeParse(json);
      return ok.success
        ? readOk(ok.data.value as z.infer<S>)
        : readUnknown('malformed', 'codehost answered with an unexpected shape');
    }
    const notOk = CodeHostNotOk.safeParse(json);
    if (notOk.success) return notOk.data;
    return res.status === 401 || res.status === 403
      ? { state: 'unreadable', reason: 'forbidden', message: `codehost refused with ${res.status}` }
      : readUnknown('server_error', `codehost answered ${res.status}`);
  }

  list_labelled(req: { readonly repo: RepoFullName; readonly label: string }) {
    return this.call(
      'GET',
      `${TRACKER_ROUTES.issues(req.repo)}?label=${encodeURIComponent(req.label)}`,
      z.array(TrackedIssueWire),
    ) as Promise<CodeHostRead<TrackedIssue[]>>;
  }

  read_issue(req: { readonly repo: RepoFullName; readonly number: number }) {
    return this.call(
      'GET',
      TRACKER_ROUTES.issue(req.repo, req.number),
      TrackedIssueWire,
    ) as Promise<CodeHostRead<TrackedIssue>>;
  }

  file_issue(req: IssueFile) {
    return this.call(
      'POST',
      TRACKER_ROUTES.issues(req.repo),
      z.strictObject({ number: z.number().int().min(1) }),
      { title: req.title, body: req.body, labels: req.labels },
    );
  }

  comment_issue(req: {
    readonly repo: RepoFullName;
    readonly number: number;
    readonly body: string;
  }) {
    return this.call(
      'POST',
      TRACKER_ROUTES.comments(req.repo, req.number),
      z.strictObject({ id: z.number().int() }),
      { body: req.body },
    );
  }

  close_issue(req: { readonly repo: RepoFullName; readonly number: number }) {
    return this.call(
      'POST',
      TRACKER_ROUTES.close(req.repo, req.number),
      z.strictObject({ number: z.number().int().min(1) }),
      {},
    );
  }
}
