import { callJson, type CallResult } from '@aisdlc/service-kit';

/**
 * What the bff needs from core: one JSON request with the bff's own service token. The browser's
 * cookies and the IdP's tokens are never passed here; the signed-in human travels as the
 * `on_behalf_of` field of the body, which core honours only from a caller holding the `onboard`
 * scope and which it checks against the PDP again.
 */
export interface CoreClient {
  call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<CallResult>;
}

export class HttpCoreClient implements CoreClient {
  constructor(
    private readonly o: {
      readonly baseUrl: string;
      readonly token: string;
      readonly fetchImpl?: typeof fetch;
    },
  ) {}

  call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<CallResult> {
    return callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
  }
}
