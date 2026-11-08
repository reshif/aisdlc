import type {
  ActionId,
  OnboardRequest,
  OnboardingCardSummary,
  PortalCardSummary,
  ProjectDetail,
  ProjectSummary,
  S0Overview,
} from '@aisdlc/contracts';

// The browser's only server is the bff, on this origin: one HttpOnly session cookie (sent by the
// browser by itself), a CSRF token from /api/me that a write must send back in a header. Nothing
// here holds a credential.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** `GET /api/me`: who is signed in, what they may do at the top level, the CSRF token. */
export interface Me {
  readonly principal: { readonly principal_id: string; readonly display_name: string };
  readonly csrf_token: string;
  readonly actions: {
    readonly fleet: readonly ActionId[];
    readonly projects: ReadonlyArray<{ project_id: string; actions: readonly ActionId[] }>;
  };
}

export type OnboardInput = Omit<OnboardRequest, 'on_behalf_of'>;
export interface OnboardResult {
  readonly s0_id: string;
  readonly duplicate: boolean;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  csrf?: string,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf !== undefined) headers['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'network', 'The factory could not be reached.');
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
    const retry = Number(res.headers.get('retry-after'));
    throw new ApiError(
      res.status,
      e?.code ?? 'error',
      e?.message ?? `The request failed (${res.status}).`,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  return json as T;
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  logout: (csrf: string) => request<{ ok: true }>('POST', '/api/logout', {}, csrf),
  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  project: (id: string) => request<ProjectDetail>('GET', `/api/projects/${encodeURIComponent(id)}`),
  onboard: (input: OnboardInput, csrf: string) =>
    request<OnboardResult>('POST', '/api/onboard', input, csrf),
  s0: (id: string) => request<S0Overview>('GET', `/api/s0/${encodeURIComponent(id)}`),
  cards: (s0Id: string) =>
    request<PortalCardSummary[]>('GET', `/api/s0/${encodeURIComponent(s0Id)}/cards`),
  card: (id: string) =>
    request<{ summary: OnboardingCardSummary; may_decide: boolean }>(
      'GET',
      `/api/cards/${encodeURIComponent(id)}`,
    ),
};
