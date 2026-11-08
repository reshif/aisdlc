import { Readable } from 'node:stream';
import {
  BundleManifest,
  CodeHostNotOk,
  type BundleRequest,
  type CodeHostRead,
} from '@aisdlc/contracts';
import { readOk, readUnknown, type BundleResult } from '@aisdlc/ports';

// The bundle source over the codehost's HTTP route (`GET /v1/repos/:o/:n/bundle`, scope census).
// knowledge holds only a service token for the codehost, never a code-host credential; the bundle
// it gets back is credential-free by construction (PLAN M5.3).

export interface BundleSource {
  bundle(req: BundleRequest): Promise<CodeHostRead<BundleResult>>;
}

export interface HttpBundleOptions {
  readonly baseUrl: string;
  /** knowledge's service token at the codehost (scope `census`). */
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /** Time to the response headers. The body is bounded by the job's own deadline. */
  readonly headersTimeoutMs?: number;
}

export class HttpBundleSource implements BundleSource {
  constructor(private readonly o: HttpBundleOptions) {}

  async bundle(req: BundleRequest): Promise<CodeHostRead<BundleResult>> {
    const q = new URLSearchParams({ refs: req.refs });
    if (req.base_sha !== undefined) q.set('base_sha', req.base_sha);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.o.headersTimeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(
        new URL(`/v1/repos/${req.repo}/bundle?${q}`, this.o.baseUrl),
        { headers: { authorization: `Bearer ${this.o.token}` }, signal: ac.signal },
      );
    } catch {
      clearTimeout(t);
      return readUnknown('network', 'the codehost did not answer');
    }
    clearTimeout(t);
    if (res.status !== 200 || res.body === null) {
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* no body */
      }
      const notOk = CodeHostNotOk.safeParse(json);
      if (notOk.success) return notOk.data;
      return res.status === 401 || res.status === 403
        ? {
            state: 'unreadable',
            reason: 'forbidden',
            message: `the codehost refused with ${res.status}`,
          }
        : readUnknown('malformed', `the codehost answered ${res.status} with no bundle`);
    }
    const manifest = BundleManifest.safeParse(safeJson(res.headers.get('x-bundle-manifest')));
    const base = res.headers.get('x-base-sha');
    if (!manifest.success || base === null || base !== manifest.data.head_sha) {
      await res.body.cancel().catch(() => undefined);
      return readUnknown(
        'malformed',
        'the bundle headers are missing or disagree (X-Base-Sha, manifest)',
      );
    }
    const stream = Readable.fromWeb(res.body as never);
    return readOk({ manifest: manifest.data, stream, dispose: () => void stream.destroy() });
  }
}

function safeJson(s: string | null): unknown {
  try {
    return s === null ? null : JSON.parse(s);
  } catch {
    return null;
  }
}
