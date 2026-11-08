import { ApiError } from './api';

/** One sentence for an error the person can act on; the code stays for the support conversation. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) {
      return `Too many attempts. Try again in ${e.retryAfterSeconds ?? 'a few'} seconds.`;
    }
    if (e.status === 403) return `You are not allowed to do that (${e.message}).`;
    if (e.status === 401) return 'Your session has ended. Sign in again.';
    if (e.status === 0) return e.message;
    return `${e.message} (${e.code})`;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export const shortTime = (iso: string | null): string =>
  iso === null ? '' : new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
