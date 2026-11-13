import {
  OVERRIDE_REASON_HEADER,
  type OnboardingBlockers,
  type OnboardingSummaryView,
  type SignOffRequest,
  type SignOffResult,
} from '@aisdlc/contracts';
import { ApiError } from '../api';

// Portal v2 agent-led onboarding and the onboarded repo's lifecycle (screen-map §2.9, §2.10, §3; N11-N13, N26): the
// summary, the one sign-off and "ask the agent again" (delete is the admin lifecycle's `DeleteObject`). The person is always the
// session's; the factory admin's override reason travels in its header, never in a body.

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  o: { body?: unknown; csrf?: string; override?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.csrf !== undefined) headers['x-csrf-token'] = o.csrf;
  if (o.override) headers[OVERRIDE_REASON_HEADER] = encodeURIComponent(o.override);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    });
  } catch {
    throw new ApiError(0, 'network', 'The factory could not be reached. Nothing was changed.');
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'error',
      e?.message ?? `The request failed (${res.status}).`,
    );
  }
  return json as T;
}

export type SignOffBody = Omit<SignOffRequest, 'on_behalf_of'>;

const enc = encodeURIComponent;

export const onboardApi = {
  summary: (s0: string) => call<OnboardingSummaryView>('GET', `/api/s0/${enc(s0)}/summary`),
  blockers: (s0: string) => call<OnboardingBlockers>('GET', `/api/s0/${enc(s0)}/blockers`),
  signOff: (s0: string, body: SignOffBody, csrf: string, override?: string) =>
    call<SignOffResult>('POST', `/api/s0/${enc(s0)}/sign-off`, {
      body,
      csrf,
      ...(override ? { override } : {}),
    }),
  runAgent: (s0: string, csrf: string) =>
    call<{ state: string }>('POST', `/api/s0/${enc(s0)}/agent/run`, { body: {}, csrf }),
};
