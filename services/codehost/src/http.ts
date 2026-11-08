import type { CodeHostNotOk } from '@aisdlc/contracts';
import { readUnknown, readUnreadable } from '@aisdlc/ports';

/**
 * What a non-2xx answer means (the message has the status only, never a body or a header: a body
 * can echo what was sent and a header holds the credential).
 *
 * `unreadable`: GitHub answered and refuses or hides the thing. `unknown`: no usable answer (rate
 * limit, server error). 403 with an exhausted rate limit or a `retry-after` is a rate limit.
 */
export function notOkFromStatus(
  status: number,
  headers: { get(name: string): string | null },
  what: string,
): CodeHostNotOk {
  if (status === 401) return readUnreadable('unauthenticated', `${what}: 401`);
  if (status === 403) {
    const limited =
      headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null;
    return limited
      ? readUnknown('rate_limited', `${what}: 403 (rate limited)`)
      : readUnreadable('forbidden', `${what}: 403`);
  }
  if (status === 404) return readUnreadable('not_found', `${what}: 404`);
  if (status === 429) return readUnknown('rate_limited', `${what}: 429`);
  if (status >= 500) return readUnknown('server_error', `${what}: ${status}`);
  if (status >= 300 && status < 400) {
    return readUnreadable(
      'not_found',
      `${what}: ${status} (moved; the factory does not follow redirects)`,
    );
  }
  return readUnreadable('refused', `${what}: ${status}`);
}

/** A failed `fetch`: a timeout is `timeout`, anything else `network`. The cause text is not passed on. */
export function notOkFromFetchError(e: unknown, what: string): CodeHostNotOk {
  const name = e instanceof Error ? e.name : '';
  return name === 'TimeoutError' || name === 'AbortError'
    ? readUnknown('timeout', `${what}: timed out`)
    : readUnknown('network', `${what}: the request failed`);
}

export const READ_LIMIT_BYTES = 16 * 1024 * 1024;
