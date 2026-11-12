import { VerifyCheckResult, VerifyRunResponse, type VerifyRunRequest } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { postLong } from '@aisdlc/ports';
import { z } from 'zod';

// Core's side of the verify service (docs/specs/verify-api.md): `POST /v1/checks` and `GET /v1/results`. It fails
// closed: no answer, a non-2xx or a body that does not parse is an error, never a result; `unavailable` (a transport
// error, 503) means "ask again", `refused` (4xx) does not.

export interface VerifyClientError {
  readonly code: 'unavailable' | 'refused';
  readonly status: number;
  readonly message: string;
}

export interface VerifyClient {
  run(req: VerifyRunRequest): Promise<Result<VerifyRunResponse, VerifyClientError>>;
  /** Every recorded result of an item's head, in the order they were recorded. */
  results(
    item_id: string,
    head_sha: string,
  ): Promise<Result<VerifyCheckResult[], VerifyClientError>>;
}

function errorOf(status: number, json: unknown): VerifyClientError {
  const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
  return {
    code: status >= 500 || status === 429 ? 'unavailable' : 'refused',
    status,
    message: typeof code === 'string' ? code.slice(0, 64) : `http ${status}`,
  };
}

const Results = z.strictObject({ results: z.array(VerifyCheckResult) });

export class HttpVerify implements VerifyClient {
  constructor(
    private readonly o: {
      readonly baseUrl: string;
      readonly token: string;
      readonly fetchImpl?: typeof fetch;
      /** The deadline of one check (it runs every kit of its step: minutes, not seconds). Default one hour. */
      readonly timeoutMs?: number;
    },
  ) {}

  private async call<T>(
    path: string,
    init: RequestInit,
    parse: (j: unknown) => T | null,
  ): Promise<Result<T, VerifyClientError>> {
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(new URL(path, this.o.baseUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${this.o.token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return err({ code: 'unavailable', status: 0, message: 'the verify service did not answer' });
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status !== 200) return err(errorOf(res.status, json));
    const v = parse(json);
    return v === null
      ? err({
          code: 'unavailable',
          status: 200,
          message: 'the verify service answered a malformed body',
        })
      : ok(v);
  }

  /** A POST over `node:http` with one deadline for the whole call: fetch would cut a long check at 300 s of headers. */
  async run(req: VerifyRunRequest): Promise<Result<VerifyRunResponse, VerifyClientError>> {
    const a = await postLong(
      new URL('/v1/checks', this.o.baseUrl),
      this.o.token,
      JSON.stringify(req),
      this.o.timeoutMs ?? 3_600_000,
      64 * 1024 * 1024,
    );
    if ('failed' in a) return err({ code: 'unavailable', status: 0, message: a.failed });
    let json: unknown = null;
    try {
      json = a.text === '' ? null : JSON.parse(a.text);
    } catch {
      /* not JSON */
    }
    if (a.status !== 200) return err(errorOf(a.status, json));
    const r = VerifyRunResponse.safeParse(json);
    return r.success
      ? ok(r.data)
      : err({
          code: 'unavailable',
          status: 200,
          message: 'the verify service answered a malformed body',
        });
  }

  results(
    item_id: string,
    head_sha: string,
  ): Promise<Result<VerifyCheckResult[], VerifyClientError>> {
    const q = new URLSearchParams({ item: item_id, head: head_sha });
    return this.call(`/v1/results?${q}`, { method: 'GET' }, (j) => {
      const r = Results.safeParse(j);
      return r.success ? r.data.results : null;
    });
  }
}
