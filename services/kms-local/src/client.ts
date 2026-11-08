import { b64urlDecode, b64urlEncode, err, ok, type Jwk, type Result } from '@aisdlc/kernel';
import {
  ErrorEnvelope,
  KmsHmacResponse,
  KmsSignResponse,
  keyCustodyError,
  type KeyCustodyError,
  type KeyCustodyErrorKind,
  type KeyCustodyPort,
} from '@aisdlc/ports';
import { callJson } from '@aisdlc/service-kit';
import { z } from 'zod';

export interface HttpKeyCustodyOptions {
  baseUrl: string;
  /** This caller's service token. */
  token: string;
  fetchImpl?: typeof fetch;
}

const KINDS: readonly KeyCustodyErrorKind[] = [
  'unauthenticated',
  'forbidden',
  'unknown_key',
  'dev_key_refused',
  'wrong_key_type',
  'invalid_request',
  'unavailable',
];

const PublicJwk = z.looseObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string(),
  y: z.string(),
});

/** `KeyCustodyPort` over HTTP to kms-local. Every failure, network or protocol, is an error. */
export class HttpKeyCustody implements KeyCustodyPort {
  constructor(private readonly o: HttpKeyCustodyOptions) {}

  private async call<T>(
    method: 'GET' | 'POST',
    keyId: string,
    op: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<Result<T, KeyCustodyError>> {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method,
      path: `/v1/keys/${encodeURIComponent(keyId)}/${op}`,
      ...(body === undefined ? {} : { body }),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!r.reached) return err(keyCustodyError('unavailable', r.message));
    if (r.status !== 200) {
      const e = ErrorEnvelope.safeParse(r.json);
      const code = e.success ? e.data.error.code : '';
      const kind = KINDS.find((k) => k === code) ?? 'unavailable';
      return err(keyCustodyError(kind, e.success ? e.data.error.message : `HTTP ${r.status}`));
    }
    const parsed = schema.safeParse(r.json);
    return parsed.success
      ? ok(parsed.data)
      : err(keyCustodyError('unavailable', 'malformed response from kms-local'));
  }

  async publicKey(keyId: string): Promise<Result<Jwk, KeyCustodyError>> {
    return this.call('GET', keyId, 'public', undefined, PublicJwk as z.ZodType<Jwk>);
  }

  async sign(keyId: string, digest32: Uint8Array): Promise<Result<Uint8Array, KeyCustodyError>> {
    const r = await this.call(
      'POST',
      keyId,
      'sign',
      { digest: b64urlEncode(digest32) },
      KmsSignResponse,
    );
    if (!r.ok) return r;
    const sig = b64urlDecode(r.value.signature);
    return sig.length === 64
      ? ok(sig)
      : err(keyCustodyError('unavailable', 'signature is not 64 bytes'));
  }

  async hmac(keyId: string, data: Uint8Array): Promise<Result<string, KeyCustodyError>> {
    const r = await this.call('POST', keyId, 'hmac', { data: b64urlEncode(data) }, KmsHmacResponse);
    return r.ok ? ok(r.value.mac) : r;
  }
}
