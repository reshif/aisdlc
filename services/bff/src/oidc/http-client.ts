import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import {
  oidcError,
  type OidcAuthorizeParams,
  type OidcEndSessionParams,
  type OidcError,
  type OidcExchangeParams,
  type OidcIdentity,
  type OidcPort,
} from '@aisdlc/ports';
import { z } from 'zod';

// `OidcPort` over HTTP to a standards-based provider (the in-repo dev provider, Entra, any OIDC
// IdP): authorization code with PKCE (S256), the bff as a CONFIDENTIAL client (the secret goes
// only to the token endpoint, HTTP Basic). The ID token is verified here: signature against the
// provider's JWKS (ES256 or RS256), issuer, audience, expiry and nonce. The access and refresh
// tokens are read and dropped: nothing here returns or keeps them.

export interface HttpOidcOptions {
  readonly issuer: string;
  readonly client_id: string;
  /** Resolved from an `env:` or `file:` reference by the caller; never logged. */
  readonly client_secret: string;
  readonly scope?: string;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: Clock;
  /** Clock skew tolerated on `exp` and `iat`, in seconds. Default 60. */
  readonly skewSeconds?: number;
}

const Discovery = z.looseObject({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  end_session_endpoint: z.url().optional(),
});
type Discovery = z.infer<typeof Discovery>;

const Jwks = z.object({
  keys: z.array(z.looseObject({ kid: z.string().optional(), kty: z.string() })),
});
const TokenResponse = z.looseObject({
  id_token: z.string().min(1),
  token_type: z.string(),
});

const b64 = (s: string): Buffer => Buffer.from(s, 'base64url');

export class HttpOidcClient implements OidcPort {
  private discovery: Discovery | null = null;
  private jwks: Array<Record<string, unknown>> | null = null;

  constructor(private readonly o: HttpOidcOptions) {}

  private get f(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.f(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  private async discover(): Promise<Result<Discovery, OidcError>> {
    if (this.discovery) return ok(this.discovery);
    try {
      const url = `${this.o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const d = Discovery.safeParse(await this.getJson(url));
      if (!d.success) return err(oidcError('unavailable', 'malformed discovery document'));
      if (d.data.issuer !== this.o.issuer) {
        return err(
          oidcError('unavailable', `discovery issuer ${d.data.issuer} is not ${this.o.issuer}`),
        );
      }
      this.discovery = d.data;
      return ok(d.data);
    } catch (e) {
      return err(oidcError('unavailable', e instanceof Error ? e.message : String(e)));
    }
  }

  async authorizationUrl(p: OidcAuthorizeParams): Promise<Result<string, OidcError>> {
    const d = await this.discover();
    if (!d.ok) return d;
    const u = new URL(d.value.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.o.client_id);
    u.searchParams.set('redirect_uri', p.redirect_uri);
    u.searchParams.set('scope', this.o.scope ?? 'openid');
    u.searchParams.set('state', p.state);
    u.searchParams.set('nonce', p.nonce);
    u.searchParams.set('code_challenge', p.code_challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (p.prompt) u.searchParams.set('prompt', p.prompt);
    if (p.max_age !== undefined) u.searchParams.set('max_age', String(p.max_age));
    if (p.login_hint) u.searchParams.set('login_hint', p.login_hint);
    return ok(u.toString());
  }

  async endSessionUrl(p: OidcEndSessionParams): Promise<Result<string | null, OidcError>> {
    const d = await this.discover();
    if (!d.ok) return d;
    if (!d.value.end_session_endpoint) return ok(null);
    const u = new URL(d.value.end_session_endpoint);
    u.searchParams.set('client_id', this.o.client_id);
    if (p.id_token_hint) u.searchParams.set('id_token_hint', p.id_token_hint);
    u.searchParams.set('post_logout_redirect_uri', p.post_logout_redirect_uri);
    return ok(u.toString());
  }

  async exchange(p: OidcExchangeParams): Promise<Result<OidcIdentity, OidcError>> {
    const d = await this.discover();
    if (!d.ok) return d;
    let res: Response;
    try {
      res = await this.f(d.value.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(
            `${encodeURIComponent(this.o.client_id)}:${encodeURIComponent(this.o.client_secret)}`,
          ).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: p.code,
          redirect_uri: p.redirect_uri,
          code_verifier: p.code_verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      return err(oidcError('unavailable', e instanceof Error ? e.message : String(e)));
    }
    if (res.status >= 500)
      return err(oidcError('unavailable', `token endpoint HTTP ${res.status}`));
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code =
        typeof (json as { error?: unknown } | null)?.error === 'string'
          ? (json as { error: string }).error
          : `HTTP ${res.status}`;
      return err(oidcError('invalid_grant', code));
    }
    const t = TokenResponse.safeParse(json);
    if (!t.success) return err(oidcError('unavailable', 'malformed token response'));
    return this.verifyIdToken(t.data.id_token, p.nonce, d.value);
  }

  private async keys(refresh: boolean): Promise<Array<Record<string, unknown>>> {
    if (this.jwks && !refresh) return this.jwks;
    const d = this.discovery as Discovery;
    const j = Jwks.parse(await this.getJson(d.jwks_uri));
    this.jwks = j.keys;
    return j.keys;
  }

  private async verifyIdToken(
    token: string,
    nonce: string,
    d: Discovery,
  ): Promise<Result<OidcIdentity, OidcError>> {
    const bad = (m: string) => err(oidcError('invalid_token', m));
    const parts = token.split('.');
    if (parts.length !== 3) return bad('not a JWT');
    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(b64(parts[0] as string).toString('utf8')) as typeof header;
      claims = JSON.parse(b64(parts[1] as string).toString('utf8')) as typeof claims;
    } catch {
      return bad('malformed JWT');
    }
    if (header.alg !== 'ES256' && header.alg !== 'RS256')
      return bad(`unsupported alg ${String(header.alg)}`);
    let jwk: Record<string, unknown> | undefined;
    try {
      for (const refresh of [false, true]) {
        const keys = await this.keys(refresh);
        jwk = keys.find(
          (k) => k['kid'] === header.kid && (k['use'] === undefined || k['use'] === 'sig'),
        );
        if (jwk) break;
      }
    } catch (e) {
      return err(oidcError('unavailable', e instanceof Error ? e.message : String(e)));
    }
    if (!jwk) return bad('signing key not found');
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      const okSig = cryptoVerify(
        'sha256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
        b64(parts[2] as string),
      );
      if (!okSig) return bad('signature is invalid');
    } catch {
      return bad('signature cannot be verified');
    }
    const now = Math.floor((this.o.clock ?? systemClock).now().getTime() / 1000);
    const skew = this.o.skewSeconds ?? 60;
    if (claims['iss'] !== d.issuer) return bad('issuer mismatch');
    const aud = claims['aud'];
    const audOk = Array.isArray(aud) ? aud.includes(this.o.client_id) : aud === this.o.client_id;
    if (!audOk) return bad('audience mismatch');
    if (Array.isArray(aud) && aud.length > 1 && claims['azp'] !== this.o.client_id)
      return bad('azp mismatch');
    if (typeof claims['exp'] !== 'number' || claims['exp'] + skew <= now)
      return bad('token expired');
    if (typeof claims['iat'] === 'number' && claims['iat'] - skew > now)
      return bad('token issued in the future');
    if (claims['nonce'] !== nonce) return bad('nonce mismatch');
    if (typeof claims['sub'] !== 'string' || claims['sub'] === '') return bad('no subject');
    return ok({
      issuer: d.issuer,
      subject: claims['sub'],
      auth_time: typeof claims['auth_time'] === 'number' ? claims['auth_time'] : null,
      amr: Array.isArray(claims['amr'])
        ? claims['amr'].filter((x): x is string => typeof x === 'string')
        : [],
      id_token: token,
    });
  }
}
