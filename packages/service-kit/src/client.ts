export interface CallOptions {
  baseUrl: string;
  token: string;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type CallResult =
  { reached: true; status: number; json: unknown } | { reached: false; message: string };

/** One JSON request with a bearer token. Never throws: a network failure is `reached: false`. */
export async function callJson(o: CallOptions): Promise<CallResult> {
  const f = o.fetchImpl ?? fetch;
  try {
    const res = await f(new URL(o.path, o.baseUrl), {
      method: o.method,
      headers: {
        authorization: `Bearer ${o.token}`,
        ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      return { reached: true, status: res.status, json: null };
    }
    return { reached: true, status: res.status, json };
  } catch (e) {
    return { reached: false, message: e instanceof Error ? e.message : String(e) };
  }
}
