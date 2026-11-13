import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
} from 'node:crypto';
import { systemClock, type Clock } from '@aisdlc/kernel';
import { listen, newApp } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// A tiny OIDC provider for development and tests (PLAN M4.5). It is NOT an identity system: it has
// a list of users and no passwords, and a banner says so. It speaks just enough standard OIDC for
// the bff's `HttpOidcClient` to run unchanged against it and against a real IdP:
//
//   discovery, JWKS, `/authorize` (code flow, PKCE S256 required, `prompt=login`, `max_age`,
//   `login_hint`), `/token` (HTTP Basic or `client_secret_post`, single-use codes, PKCE check),
//   ID tokens signed ES256 with `sub`, `aud`, `nonce`, `auth_time`, `amr`.
//
// Without `autoLogin` an unauthenticated browser gets a page that lists the users; with it (tests),
// a `login_hint` naming a user signs that user in at once. A provider session (cookie) gives
// single sign-on until `prompt=login` or an exceeded `max_age` asks for a new sign-in, which is how
// the bff's step-up is proved to be a real re-authentication.

export interface DevUser {
  readonly subject: string;
  readonly name: string;
  readonly email?: string;
}

export interface DevClient {
  readonly client_id: string;
  readonly client_secret: string;
  readonly redirect_uris: readonly string[];
}

export interface DevOidcOptions {
  readonly users: readonly DevUser[];
  readonly clients: readonly DevClient[];
  /** A `login_hint` naming a user signs them in without the page. Tests only. */
  readonly autoLogin?: boolean;
  /** Default: the URL it listens on. */
  readonly issuer?: string;
  readonly clock?: Clock;
  readonly host?: string;
  readonly port?: number;
}

export interface DevOidcProvider {
  readonly url: string;
  readonly issuer: string;
  /** Every authorization request that reached `/authorize`, for assertions. */
  readonly authorizeRequests: ReadonlyArray<Record<string, string>>;
  /** Drops the SSO sessions (the next sign-in needs the user again). */
  endSessions(): void;
  stop(): Promise<void>;
}

interface Code {
  client_id: string;
  redirect_uri: string;
  challenge: string;
  nonce: string;
  subject: string;
  auth_time: number;
  expires: number;
  used: boolean;
}

const SESSION_COOKIE = 'dev_oidc_session';
const CODE_TTL_SECONDS = 60;
const ID_TOKEN_TTL_SECONDS = 300;

const sha256b64 = (s: string): string => createHash('sha256').update(s).digest('base64url');
const safeEqual = (a: string, b: string): boolean => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startDevOidcProvider(o: DevOidcOptions): Promise<DevOidcProvider> {
  const clock = o.clock ?? systemClock;
  const nowS = (): number => Math.floor(clock.now().getTime() / 1000);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = `dev-${randomBytes(4).toString('hex')}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
  const priv = privateKey;

  const codes = new Map<string, Code>();
  const sso = new Map<string, { subject: string; auth_time: number }>();
  const authorizeRequests: Array<Record<string, string>> = [];
  let issuer = o.issuer ?? '';
  const app: FastifyInstance = newApp();

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  const userOf = (subject: string): DevUser | undefined =>
    o.users.find((u) => u.subject === subject);
  const cookieOf = (req: FastifyRequest): string | null => {
    const m = new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
    return m ? (m[1] as string) : null;
  };

  const jwt = (claims: Record<string, unknown>): string => {
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })).toString(
      'base64url',
    );
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), {
      key: priv,
      dsaEncoding: 'ieee-p1363',
    });
    return `${head}.${body}.${sig.toString('base64url')}`;
  };

  app.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    end_session_endpoint: `${issuer}/logout`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  }));
  app.get('/jwks', async () => ({ keys: [jwk] }));

  type Params = Record<string, string | undefined>;

  const bail = (reply: FastifyReply, message: string) =>
    reply.code(400).type('text/plain').send(`dev-oidc: ${message}`);

  /** The redirect back to the client with an error (only once client and redirect are trusted). */
  const redirectError = (reply: FastifyReply, p: Params, error: string) => {
    const u = new URL(p['redirect_uri'] as string);
    u.searchParams.set('error', error);
    if (p['state']) u.searchParams.set('state', p['state']);
    return reply.redirect(u.toString());
  };

  const issueCode = (
    reply: FastifyReply,
    p: Params,
    session: { subject: string; auth_time: number },
  ) => {
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      client_id: p['client_id'] as string,
      redirect_uri: p['redirect_uri'] as string,
      challenge: p['code_challenge'] as string,
      nonce: p['nonce'] ?? '',
      subject: session.subject,
      auth_time: session.auth_time,
      expires: nowS() + CODE_TTL_SECONDS,
      used: false,
    });
    const u = new URL(p['redirect_uri'] as string);
    u.searchParams.set('code', code);
    if (p['state']) u.searchParams.set('state', p['state']);
    return reply.redirect(u.toString());
  };

  const startSession = (reply: FastifyReply, subject: string) => {
    const id = randomBytes(16).toString('base64url');
    const s = { subject, auth_time: nowS() };
    sso.set(id, s);
    reply.header('set-cookie', `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`);
    return s;
  };

  /** Validates an authorization request. Returns an error to show (never redirected) or null. */
  const check = (p: Params): { fatal?: string; error?: string } => {
    const client = o.clients.find((c) => c.client_id === p['client_id']);
    if (!client) return { fatal: 'unknown client_id' };
    if (!p['redirect_uri'] || !client.redirect_uris.includes(p['redirect_uri'])) {
      return { fatal: 'redirect_uri is not registered for this client' };
    }
    if (p['response_type'] !== 'code') return { error: 'unsupported_response_type' };
    if (!p['code_challenge'] || p['code_challenge_method'] !== 'S256')
      return { error: 'invalid_request' };
    if (!p['state'] || !p['nonce']) return { error: 'invalid_request' };
    return {};
  };

  // RP-initiated logout: ends this browser's SSO session, then back to the client, but only to an origin one of the
  // registered redirect URIs has (never an open redirect).
  app.get('/logout', async (req, reply) => {
    const p = req.query as Params;
    const id = cookieOf(req);
    if (id) sso.delete(id);
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    const back = p['post_logout_redirect_uri'];
    let to: URL | null = null;
    try {
      to = back ? new URL(back) : null;
    } catch {
      to = null;
    }
    const known = o.clients.some(
      (c) =>
        (p['client_id'] === undefined || c.client_id === p['client_id']) &&
        c.redirect_uris.some((r) => to !== null && new URL(r).origin === to.origin),
    );
    if (to && known) return reply.redirect(to.toString());
    return reply.type('text/plain').send('signed out');
  });

  app.get('/authorize', async (req, reply) => {
    const p = req.query as Params;
    authorizeRequests.push(
      Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Record<
        string,
        string
      >,
    );
    const bad = check(p);
    if (bad.fatal) return bail(reply, bad.fatal);
    if (bad.error) return redirectError(reply, p, bad.error);

    const maxAge = p['max_age'] === undefined ? null : Number(p['max_age']);
    const forceLogin = p['prompt'] === 'login' || maxAge === 0;
    const id = cookieOf(req);
    const existing = id ? sso.get(id) : undefined;
    const fresh = existing && (maxAge === null || nowS() - existing.auth_time <= maxAge);
    if (existing && fresh && !forceLogin && userOf(existing.subject))
      return issueCode(reply, p, existing);

    const hinted =
      o.autoLogin && p['login_hint']
        ? o.users.find((u) => u.subject === p['login_hint'] || u.email === p['login_hint'])
        : undefined;
    if (hinted) return issueCode(reply, p, startSession(reply, hinted.subject));

    const hidden = Object.entries(p)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v as string)}">`)
      .join('');
    const options = o.users
      .map(
        (u) =>
          `<option value="${esc(u.subject)}">${esc(u.name)} (${esc(u.email ?? u.subject)})</option>`,
      )
      .join('');
    return reply
      .type('text/html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Dev sign-in</title>` +
          `<h1>Dev sign-in</h1><p><strong>Development identity provider. Not for production.</strong></p>` +
          `<form method="post" action="/authorize">${hidden}<label>User <select name="dev_user">${options}</select></label> <button>Sign in</button></form>`,
      );
  });

  app.post('/authorize', async (req, reply) => {
    const p = req.body as Params;
    const bad = check(p);
    if (bad.fatal) return bail(reply, bad.fatal);
    if (bad.error) return redirectError(reply, p, bad.error);
    const user = o.users.find((u) => u.subject === p['dev_user']);
    if (!user) return redirectError(reply, p, 'access_denied');
    return issueCode(reply, p, startSession(reply, user.subject));
  });

  const clientOf = (req: FastifyRequest, body: Params): DevClient | null => {
    let id = body['client_id'];
    let secret = body['client_secret'];
    const h = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    if (h) {
      const [i, ...rest] = Buffer.from(h[1] as string, 'base64')
        .toString('utf8')
        .split(':');
      id = decodeURIComponent(i ?? '');
      secret = decodeURIComponent(rest.join(':'));
    }
    const c = o.clients.find((x) => x.client_id === id);
    return c && secret !== undefined && safeEqual(c.client_secret, secret) ? c : null;
  };

  app.post('/token', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const b = (req.body ?? {}) as Params;
    const client = clientOf(req, b);
    if (!client) return reply.code(401).send({ error: 'invalid_client' });
    if (b['grant_type'] !== 'authorization_code')
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    const c = b['code'] ? codes.get(b['code']) : undefined;
    if (!c || c.used || c.expires <= nowS() || c.client_id !== client.client_id) {
      if (c) c.used = true; // a code is burnt by a failed or repeated use
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    c.used = true;
    if (c.redirect_uri !== b['redirect_uri'])
      return reply.code(400).send({ error: 'invalid_grant' });
    if (!b['code_verifier'] || sha256b64(b['code_verifier']) !== c.challenge) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    const user = userOf(c.subject);
    if (!user) return reply.code(400).send({ error: 'invalid_grant' });
    const now = nowS();
    const id_token = jwt({
      iss: issuer,
      sub: user.subject,
      aud: client.client_id,
      iat: now,
      exp: now + ID_TOKEN_TTL_SECONDS,
      auth_time: c.auth_time,
      nonce: c.nonce,
      amr: ['pwd'],
      name: user.name,
      ...(user.email ? { email: user.email } : {}),
    });
    return {
      token_type: 'Bearer',
      expires_in: ID_TOKEN_TTL_SECONDS,
      access_token: `dev-at-${randomBytes(16).toString('base64url')}`,
      refresh_token: `dev-rt-${randomBytes(16).toString('base64url')}`,
      id_token,
    };
  });

  const url = await listen(app, {
    ...(o.host !== undefined ? { host: o.host } : {}),
    ...(o.port !== undefined ? { port: o.port } : {}),
  });
  issuer = o.issuer ?? url;
  return {
    url,
    get issuer() {
      return issuer;
    },
    authorizeRequests,
    endSessions: () => sso.clear(),
    stop: () => app.close(),
  };
}
