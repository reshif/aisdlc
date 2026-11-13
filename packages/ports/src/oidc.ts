import { createHash } from 'node:crypto';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// OidcPort (PLAN M4.5): the bff is a confidential OIDC client (authorization code + PKCE) and
// reaches the identity provider only through this port. `HttpOidcClient` (in `@aisdlc/bff`) talks
// to any standards-based provider, the in-repo dev provider included; `FakeOidc` is the
// deterministic fake. The port returns a VERIFIED identity: issuer, audience, expiry, nonce and
// signature have been checked, or it returns an error. Tokens never leave the bff.

export type OidcErrorCode =
  /** The provider cannot be reached or answered nonsense. */
  | 'unavailable'
  /** The code was refused: unknown, used, expired, wrong redirect or PKCE verifier. */
  | 'invalid_grant'
  /** The ID token failed verification (signature, issuer, audience, expiry, nonce). */
  | 'invalid_token';

export const OidcError = taggedError('OidcError');
export type OidcError = TaggedError<'OidcError', { code: OidcErrorCode; message: string }>;
export const oidcError = (code: OidcErrorCode, message: string): OidcError =>
  OidcError({ code, message });

export interface OidcAuthorizeParams {
  readonly redirect_uri: string;
  readonly state: string;
  readonly nonce: string;
  /** S256 challenge of the verifier the bff keeps. */
  readonly code_challenge: string;
  /** `login`: force a new sign-in (step-up). */
  readonly prompt?: 'login';
  /** `0` with `prompt=login`: the sign-in must be new. */
  readonly max_age?: number;
  readonly login_hint?: string;
}

export interface OidcExchangeParams {
  readonly code: string;
  readonly redirect_uri: string;
  readonly code_verifier: string;
  /** The nonce sent in the authorization request; the ID token must echo it. */
  readonly nonce: string;
}

/** What a verified sign-in is. `auth_time` is seconds since the epoch, `null` if the IdP omitted it. */
export interface OidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly auth_time: number | null;
  readonly amr: readonly string[];
  /** The ID token, kept server-side only (logout hint). Never given to a browser. */
  readonly id_token: string;
}

/** RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0): end the person's session at the provider too. */
export interface OidcEndSessionParams {
  /** The ID token of the session being ended; `null` when the session kept none. */
  readonly id_token_hint: string | null;
  /** Where the provider sends the browser afterwards; it must be registered with the provider. */
  readonly post_logout_redirect_uri: string;
}

export interface OidcPort {
  authorizationUrl(p: OidcAuthorizeParams): Promise<Result<string, OidcError>>;
  exchange(p: OidcExchangeParams): Promise<Result<OidcIdentity, OidcError>>;
  /** The provider's end-session URL for this logout, or `null` when the provider has no end-session endpoint. */
  endSessionUrl(p: OidcEndSessionParams): Promise<Result<string | null, OidcError>>;
}

/** `base64url(sha256(verifier))`, the PKCE S256 challenge (RFC 7636). */
export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

interface FakeCode {
  subject: string;
  authTime: number;
  nonce: string;
  challenge: string;
  redirect_uri: string;
}

/**
 * Deterministic in-memory provider behind the port. `authorizationUrl` records the request and
 * returns a URL; the test then plays the user with `signIn(state, subject)`, which returns the code
 * the browser would carry back. `exchange` enforces PKCE, the redirect URI, the nonce and
 * single use, like a real provider.
 */
export class FakeOidc implements OidcPort {
  readonly issuer = 'https://fake-idp.test';
  /** Seconds since the epoch; tests move it. */
  now = 1_800_000_000;
  readonly requests: OidcAuthorizeParams[] = [];
  private readonly codes = new Map<string, FakeCode>();
  private n = 0;
  private down = false;

  fail(): this {
    this.down = true;
    return this;
  }

  async authorizationUrl(p: OidcAuthorizeParams) {
    if (this.down) return err(oidcError('unavailable', 'fake IdP down'));
    this.requests.push(p);
    return ok(`${this.issuer}/authorize?state=${encodeURIComponent(p.state)}`);
  }

  /** The logouts asked for, in order (tests read them). */
  readonly endSessions: OidcEndSessionParams[] = [];

  async endSessionUrl(p: OidcEndSessionParams) {
    if (this.down) return err(oidcError('unavailable', 'fake IdP down'));
    this.endSessions.push(p);
    return ok(
      `${this.issuer}/logout?post_logout_redirect_uri=${encodeURIComponent(p.post_logout_redirect_uri)}`,
    );
  }

  /** The user signs in for the request with this `state`; returns the authorization code. */
  signIn(state: string, subject: string, o: { authTime?: number } = {}): string {
    const req = this.requests.find((r) => r.state === state);
    if (!req) throw new RangeError(`no authorization request with state ${state}`);
    const code = `fake-code-${++this.n}`;
    this.codes.set(code, {
      subject,
      authTime: o.authTime ?? this.now,
      nonce: req.nonce,
      challenge: req.code_challenge,
      redirect_uri: req.redirect_uri,
    });
    return code;
  }

  async exchange(p: OidcExchangeParams) {
    if (this.down) return err(oidcError('unavailable', 'fake IdP down'));
    const c = this.codes.get(p.code);
    this.codes.delete(p.code);
    if (!c) return err(oidcError('invalid_grant', 'unknown or used code'));
    if (c.redirect_uri !== p.redirect_uri) return err(oidcError('invalid_grant', 'redirect_uri'));
    if (pkceChallenge(p.code_verifier) !== c.challenge) {
      return err(oidcError('invalid_grant', 'PKCE verifier does not match'));
    }
    if (c.nonce !== p.nonce) return err(oidcError('invalid_token', 'nonce mismatch'));
    return ok({
      issuer: this.issuer,
      subject: c.subject,
      auth_time: c.authTime,
      amr: ['pwd'],
      id_token: `fake-id-token.${c.subject}`,
    });
  }
}
