import type { CodeHostNotOk, CodeHostRole } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { readUnknown, readUnreadable } from '@aisdlc/ports';
import { checkRequest, type CodeHostMode } from './allow-list.js';
import { READ_LIMIT_BYTES, notOkFromFetchError, notOkFromStatus } from './http.js';
import type { TokenBroker } from './token-broker.js';

// The only code that talks to GitHub with a credential. Every request is checked against the
// allow-list BEFORE a token is minted or a socket opened; the base URL is configuration, so
// request text cannot choose the host; redirects are never followed (the credential would go with
// them); and no error or log line carries a header, a body or a token.

/**
 * One outbound request as the structured log records it: the method, the path TEMPLATE (variable
 * parts named, never the values), the status and the role. No token, no header, no body, no query.
 */
export interface RequestLogEntry {
  readonly method: string;
  readonly path: string;
  /** The HTTP status; `0` when no answer came (timeout, network). */
  readonly status: number;
  readonly auth: string;
}

export interface TransportOptions {
  readonly baseUrl: string;
  readonly broker: TokenBroker;
  readonly mode: CodeHostMode;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** One line per request: `GET /path -> status`. Never a header or a body. */
  readonly log?: (line: string) => void;
  /** One structured entry per request that reached the network (see `RequestLogEntry`). */
  readonly onRequest?: (e: RequestLogEntry) => void;
}

export interface GitHubResponse {
  readonly status: number;
  readonly json: unknown;
  /** The response had `Link: <...>; rel="next"`. */
  readonly hasNext: boolean;
}

export const MAX_PAGES = 20;
export const PER_PAGE = 100;

export class GitHubTransport {
  private readonly f: typeof fetch;
  /** Requests that were refused before the network (for tests and health). */
  refused = 0;

  constructor(private readonly o: TransportOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  /**
   * One request. `method` is a string so that a refused verb can be tried (and shown refused); the
   * allow-list admits only the GET rows.
   */
  async request(method: string, target: string): Promise<Result<GitHubResponse, CodeHostNotOk>> {
    const verdict = checkRequest(this.o.mode, method, target);
    if (!verdict.ok) {
      this.refused += 1;
      this.o.log?.(`${method} ${target.split('?')[0]} refused: ${verdict.code}`);
      return err(readUnreadable('refused', verdict.message));
    }
    const what = `${method} ${target.split('?')[0]}`;
    let authorization: string;
    let role: CodeHostRole | null = null;
    if (verdict.row.auth === 'jwt') {
      authorization = `Bearer ${this.o.broker.jwt()}`;
    } else {
      role = verdict.row.auth;
      const t = await this.o.broker.token(role);
      if (!t.ok) return t;
      authorization = `Bearer ${t.value.secret.reveal()}`;
    }
    let res: Response;
    try {
      res = await this.f(new URL(verdict.url, this.o.baseUrl), {
        method: 'GET',
        headers: {
          authorization,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'aisdlc-codehost',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch (e) {
      this.o.log?.(`${what} failed`);
      this.o.onRequest?.({ method, path: verdict.row.template, status: 0, auth: verdict.row.auth });
      return err(notOkFromFetchError(e, what));
    }
    this.o.log?.(`${what} -> ${res.status}`);
    this.o.onRequest?.({
      method,
      path: verdict.row.template,
      status: res.status,
      auth: verdict.row.auth,
    });
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 && role !== null) this.o.broker.invalidate(role);
      return err(notOkFromStatus(res.status, res.headers, what));
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      return err(notOkFromFetchError(e, what));
    }
    if (text.length > READ_LIMIT_BYTES)
      return err(readUnknown('malformed', `${what}: answer too large`));
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return err(readUnknown('malformed', `${what}: the answer is not JSON`));
    }
    return ok({
      status: res.status,
      json,
      hasNext: /<[^>]+>;\s*rel="next"/.test(res.headers.get('link') ?? ''),
    });
  }

  get(target: string): Promise<Result<GitHubResponse, CodeHostNotOk>> {
    return this.request('GET', target);
  }

  /**
   * Every page of a list (`per_page=100`, `page=n`), `pick` taking the items out of one page's
   * JSON. A list still going after `MAX_PAGES` is `unknown/truncated`, never a short list taken
   * for the whole.
   */
  async getAll(
    path: string,
    pick: (json: unknown) => unknown[] | null,
    extraQuery = '',
  ): Promise<Result<unknown[], CodeHostNotOk>> {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this.get(
        `${path}?${extraQuery}${extraQuery === '' ? '' : '&'}per_page=${PER_PAGE}&page=${page}`,
      );
      if (!r.ok) return r;
      const got = pick(r.value.json);
      if (got === null) {
        return err(readUnknown('malformed', `GET ${path}: the page has no list`));
      }
      items.push(...got);
      if (!r.value.hasNext) return ok(items);
    }
    return err(readUnknown('truncated', `GET ${path}: more than ${MAX_PAGES} pages`));
  }
}
