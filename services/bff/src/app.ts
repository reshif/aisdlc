import { timingSafeEqual } from 'node:crypto';
import {
  STEP_UP_RECONFIRM_STAMP,
  Sha256Hex,
  pdpResource,
  type ActionId,
  type PrincipalId,
} from '@aisdlc/contracts';
import { directoryProjection, getPrincipal as getDirectoryPrincipal } from '@aisdlc/directory';
import { freshReadModel, getPrincipal, inForceBindings, resolveLink } from '@aisdlc/identity/read';
import { systemClock, type Clock } from '@aisdlc/kernel';
import type { Pdp } from '@aisdlc/pdp';
import { pkceChallenge, type OidcPort } from '@aisdlc/ports';
import { runProjection } from '@aisdlc/record';
import { newApp, sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { type CoreClient } from './core-client.js';
import { collectProof, createAttempt, storeProof, takeAttempt } from './attempts.js';
import { cookieName, readCookie, serializeCookie } from './cookies.js';
import {
  createSession,
  lookupSession,
  randomToken,
  revokePrincipalSessions,
  revokeSession,
  sha256b64,
  type SessionRow,
} from './sessions.js';
import { registerAccessRoutes } from './access.js';
import { registerAssistantRoutes } from './assistant.js';
import { registerDriftRoutes } from './drift.js';
import { registerIssueTwinRoutes } from './issue-twin.js';
import { registerKillRoutes } from './kill.js';
import { registerOpsRoutes } from './ops.js';
import { registerNotificationRoutes } from './notifications.js';
import { registerAuditRoutes } from './audit.js';
import { registerPortalRoutes } from './portal.js';
import { registerPortalListRoutes } from './portal-lists.js';
import { registerFloorRoutes } from './floor.js';
import { levelsOn, rolesIn } from './levels.js';
import { DEFAULT_RATE_LIMITS, TokenBuckets, type RateLimits } from './rate-limit.js';
import { registerWebFiles } from './static.js';
import type { StepUpIssuer } from './stepup/issuer.js';

// The bff: the browser edge (PLAN M4.5, RV §1.4 "Browser edge"). It holds the OIDC client secret
// and the sessions; the browser holds one opaque, HttpOnly cookie and nothing else, and the IdP's
// tokens never leave this process. Every route that acts asks the PDP; this file carries no
// authority of its own.
//
//   GET  /auth/login        start a sign-in (authorization code + PKCE), redirect to the IdP
//   GET  /auth/callback     finish it: verify, map the subject to a principal, open a session
//   GET  /api/me            who am I, what may I do at the top level, the CSRF token
//   GET  /api/me/access     the person's bindings, view level and data class per project (access.ts)
//   /api/assistant/*        the onboarding assistant and "Ask the factory", in front of core (assistant.ts, M18)
//   POST /api/me/decisions  a batch of PDP capability probes for the screen (access.ts)
//   POST /api/logout        revoke the session
//   POST /api/step-up       start a step-up bound to a hash (re-authentication, or DEC-11(c-ii))
//   GET  /api/step-up/:id   collect the proof once, after the re-authentication returned
//   /api/projects, /api/onboard, /api/s0/*, /api/cards/*   the portal's calls to core (portal.ts)
//   /api/items, /api/agents, /api/admission, /api/slots, /api/controls, ...  lists and operate (portal-lists.ts)
//   /api/budgets, /api/cost, /api/banners, /api/models/*, /api/onboard/repos, breakers   P2 operate and govern (ops.ts)
//   everything else         the web bundle (`webDir`), single-page app, strict CSP (static.ts)
//
// Rate limits (rate-limit.ts): `/auth/login` 10 at once then 10 a minute per client IP; the step-up
// start 20 at once then 20 a minute per IP and 5 at once then 5 a minute per principal. An empty
// bucket answers 429 with `Retry-After` (seconds). Buckets are in memory (one bff process).

export type StepUpMode = 'reauth' | 'reconfirm';

export interface BffAppOptions {
  /** The record database: the bff schema is its own, identity and directory are read models in it. */
  readonly pool: pg.Pool;
  readonly oidc: OidcPort;
  readonly pdp: Pdp;
  readonly stepUp: StepUpIssuer;
  /** The browser-visible origin and base, e.g. `https://factory.example`; no trailing slash. */
  readonly publicUrl: string;
  /** Origins other than `publicUrl` allowed on state-changing requests. */
  readonly allowedOrigins?: readonly string[];
  /** `Secure` cookies and the `__Host-` prefix. Only local plain http turns this off. */
  readonly cookieSecure?: boolean;
  /** Signed out after this idle time; a function is read on every request (portal v2 `session.policy`, H16). */
  readonly idleSeconds?: number | (() => number);
  /** Signed out after this long whatever happens; a function is read at each sign-in (portal v2 `session.policy`). */
  readonly absoluteSeconds?: number | (() => number);
  /**
   * `reauth` (D37): the principal signs in again at the IdP. `reconfirm` (DEC-11(c-ii)): a plain
   * confirm in the session, no new authentication, stamped as such in the proof and the response.
   */
  readonly stepUpMode?: StepUpMode;
  readonly clock?: Clock;
  /** Core, for the portal's `/api/*` routes; without it they answer 503 (after the session and CSRF checks). */
  readonly core?: CoreClient;
  /** The notifier (M18), for `/api/me/notifications*`; without it they answer 503. Best effort: nothing else needs it. */
  readonly notifier?: CoreClient;
  /** The audit service (M19), for `/api/audit/*`; without it they answer 503. */
  readonly audit?: CoreClient;
  /**
   * M19: the profile services only the bff reaches (the notifier), by name -> base URL: `GET /healthz/peer/:name`
   * relays the peer's liveness answer (status and loop states only) for core-worker's health tiles, so their tiles are
   * read through the service that can reach them instead of a new path. Unreachable: 502 (core-worker reads unknown).
   */
  readonly healthPeers?: Readonly<Record<string, string>>;
  /** gate-check's read API (M14.6: the run status on the item page); without it that status reads `unknown`. */
  readonly gateCheck?: CoreClient;
  /** The kill switch (RC-UI-1, scopes `act`, `read`), for `/api/kills/*` with the person's step-up; else 503. */
  readonly killswitch?: CoreClient;
  /** P2-5: the model gateway's admin API (scope `operate`): provider test and reload; without it those answer 503. */
  readonly gateway?: CoreClient;
  /** The sandbox-controller's read API (`GET /v1/slots`, scope `read`); without it the Sandboxes screen says so. */
  readonly sandboxController?: CoreClient;
  /** The built web bundle (`index.html` and `assets/`) to serve; without it the bff serves only its API. */
  readonly webDir?: string;
  /** Overrides of `DEFAULT_RATE_LIMITS`. */
  readonly rateLimits?: Partial<RateLimits>;
}

export const DEFAULT_IDLE_SECONDS = 30 * 60;
export const DEFAULT_ABSOLUTE_SECONDS = 8 * 60 * 60;
/** How far before the step-up began a sign-in may be dated and still count as "just now". */
const FRESH_SKEW_SECONDS = 5;

const StepUpBody = z
  .strictObject({
    subject_hash: Sha256Hex.optional(),
    text_sha256: Sha256Hex.optional(),
    return_to: z.string().optional(),
  })
  .refine((b) => (b.subject_hash === undefined) !== (b.text_sha256 === undefined), {
    message: 'give exactly one of subject_hash and text_sha256',
  });

/** Only same-site paths: anything that could leave the site is replaced by `/`. */
export function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex -- control characters in a redirect target are refused on purpose
  if (/[\u0000-\u001f\u007f\\]/.test(raw) || raw.length > 2048) return '/';
  // P2-18: whatever the browser would make of it, it must stay on this origin and be a path
  const base = 'http://bff.invalid';
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return '/';
  }
  if (u.origin !== base) return '/';
  // the auth routes are never a place to come back to (a loop, or a sign-out on arrival)
  if (u.pathname === '/auth' || u.pathname.startsWith('/auth/')) return '/';
  return `${u.pathname}${u.search}${u.hash}`;
}

const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createBffApp(o: BffAppOptions): FastifyInstance {
  const app = newApp();
  const clock = o.clock ?? systemClock;
  const secure = o.cookieSecure ?? true;
  const secondsOf = (v: number | (() => number) | undefined, fallback: number) => (): number => {
    const n = typeof v === 'function' ? v() : v;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : fallback;
  };
  const idleNow = secondsOf(o.idleSeconds, DEFAULT_IDLE_SECONDS);
  const absoluteNow = secondsOf(o.absoluteSeconds, DEFAULT_ABSOLUTE_SECONDS);
  const mode = o.stepUpMode ?? 'reauth';
  const sidName = cookieName('aisdlc_sid', secure);
  const binderName = cookieName('aisdlc_login', secure);
  const redirectUri = `${o.publicUrl}/auth/callback`;
  const origins = new Set([new URL(o.publicUrl).origin, ...(o.allowedOrigins ?? [])]);

  // API and redirect responses carry no content, so their policy is the strictest; the web files set
  // their own (static.ts) before this hook runs, and it leaves a header that is already there.
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    }
  });

  const limits: RateLimits = { ...DEFAULT_RATE_LIMITS, ...o.rateLimits };
  const loginByIp = new TokenBuckets(limits.login, clock);
  const stepUpByIp = new TokenBuckets(limits.stepUpIp, clock);
  const stepUpByPrincipal = new TokenBuckets(limits.stepUpPrincipal, clock);
  /** Takes one token from each bucket; a refusal is the 429 with the longest wait. */
  const limited = (reply: FastifyReply, ...takes: Array<ReturnType<TokenBuckets['take']>>) => {
    const waits = takes.flatMap((t) => (t.ok ? [] : [t.retryAfterSeconds]));
    if (waits.length === 0) return false;
    const wait = Math.max(...waits);
    reply.header('retry-after', String(wait));
    sendError(reply, 429, 'rate_limited', `too many attempts, try again in ${wait} seconds`);
    return true;
  };

  const setCookies = (reply: FastifyReply, cookies: string[]): void => {
    reply.header('set-cookie', cookies);
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/healthz/peer/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const base = Object.hasOwn(o.healthPeers ?? {}, name) ? o.healthPeers?.[name] : undefined;
    if (base === undefined) return sendError(reply, 404, 'not_found', 'no such peer');
    let res: Response;
    try {
      res = await fetch(new URL('/healthz', base), { signal: AbortSignal.timeout(3_000) });
    } catch {
      return sendError(reply, 502, 'unreachable', `${name} did not answer`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
    // what is passed on: the status and each loop's name, state and failure count; nothing else of the answer
    const b = body as { status?: unknown; loops?: unknown } | null;
    const loops = Array.isArray(b?.loops)
      ? (b.loops as Array<Record<string, unknown>>)
          .filter((l) => typeof l?.['name'] === 'string' && typeof l['state'] === 'string')
          .slice(0, 50)
          .map((l) => ({
            name: String(l['name']).slice(0, 64),
            state: String(l['state']).slice(0, 16),
            consecutive_failures:
              typeof l['consecutive_failures'] === 'number' ? l['consecutive_failures'] : 0,
          }))
      : undefined;
    return reply.code(res.ok ? 200 : 503).send({
      status: res.ok && b?.status !== 'unhealthy' ? 'ok' : 'unhealthy',
      ...(loops ? { loops, alerts: [] } : {}),
    });
  });

  // ------------------------------------------------------------ the principal of a sign-in

  type Mapped =
    | { readonly ok: true; readonly principal: PrincipalId }
    | {
        readonly ok: false;
        readonly status: number;
        readonly code: string;
        readonly message: string;
      };

  /** The principal an IdP subject is, if it may sign in at all. Unknown, disabled, service: refused. */
  async function mapSubject(issuer: string, subject: string): Promise<Mapped> {
    const fresh = await freshReadModel(o.pool);
    if (!fresh.ok)
      return { ok: false, status: 503, code: 'identity_unavailable', message: fresh.error.message };
    const p = await resolveLink(o.pool, { kind: 'idp_subject', issuer, value: subject });
    if (!p)
      return {
        ok: false,
        status: 403,
        code: 'unknown_principal',
        message: 'this identity is not linked to a principal',
      };
    if (p.status !== 'active')
      return {
        ok: false,
        status: 403,
        code: 'principal_disabled',
        message: 'this principal is not active',
      };
    if (p.kind !== 'human')
      return {
        ok: false,
        status: 403,
        code: 'service_principal',
        message: 'a service principal cannot sign in',
      };
    return { ok: true, principal: p.principal_id };
  }

  // ------------------------------------------------------------ sign-in

  app.get('/auth/login', async (req, reply) => {
    if (limited(reply, loginByIp.take(req.ip))) return;
    const q = req.query as { return_to?: string };
    const now = clock.now();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const binder = randomToken();
    const url = await o.oidc.authorizationUrl({
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: pkceChallenge(verifier),
    });
    if (!url.ok) return sendError(reply, 502, 'idp_unavailable', url.error.message);
    await createAttempt(o.pool, {
      purpose: 'login',
      state,
      nonce,
      code_verifier: verifier,
      binder,
      return_to: safeReturnTo(q.return_to),
      now,
    });
    setCookies(reply, [serializeCookie(binderName, binder, { secure, maxAge: 600 })]);
    return reply.redirect(url.value);
  });

  app.get('/auth/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const now = clock.now();
    const clearBinder = serializeCookie(binderName, '', { secure, maxAge: 0 });
    if (!q.state) return sendError(reply, 400, 'invalid_callback', 'missing state');
    const binder = readCookie(req.headers.cookie, binderName);
    const attempt = binder ? await takeAttempt(o.pool, q.state, binder, now) : null;
    if (!attempt) {
      return sendError(
        reply,
        400,
        'invalid_callback',
        'unknown, expired or foreign sign-in attempt',
      );
    }
    if (q.error || !q.code) {
      setCookies(reply, [clearBinder]);
      return sendError(reply, 401, 'idp_refused', q.error ?? 'no authorization code');
    }
    const id = await o.oidc.exchange({
      code: q.code,
      redirect_uri: redirectUri,
      code_verifier: attempt.code_verifier,
      nonce: attempt.nonce,
    });
    if (!id.ok) {
      setCookies(reply, [clearBinder]);
      return sendError(
        reply,
        id.error.code === 'unavailable' ? 502 : 401,
        id.error.code,
        id.error.message,
      );
    }
    const who = await mapSubject(id.value.issuer, id.value.subject);
    if (!who.ok) {
      setCookies(reply, [clearBinder]);
      return sendError(reply, who.status, who.code, who.message);
    }
    const authTime = id.value.auth_time === null ? null : new Date(id.value.auth_time * 1000);

    if (attempt.purpose === 'login') {
      // A new session id at every sign-in; an old session in this browser ends (no fixation).
      const old = readCookie(req.headers.cookie, sidName);
      if (old) await revokeSession(o.pool, sha256b64(old), 'replaced', now);
      const s = await createSession(o.pool, {
        principal_id: who.principal,
        issuer: id.value.issuer,
        subject: id.value.subject,
        auth_time: authTime,
        id_token: id.value.id_token,
        now,
        absoluteSeconds: absoluteNow(),
      });
      setCookies(reply, [serializeCookie(sidName, s.id, { secure }), clearBinder]);
      return reply.redirect(attempt.return_to);
    }

    // Step-up: the same browser session, the same principal, and a sign-in that happened now.
    const sid = readCookie(req.headers.cookie, sidName);
    const session = sid ? await lookupSession(o.pool, sid, now, idleNow()) : null;
    if (!session?.ok || sha256b64(sid as string) !== attempt.session_hash) {
      setCookies(reply, [clearBinder]);
      return sendError(reply, 401, 'no_session', 'the session that started this step-up is gone');
    }
    if (session.session.principal_id !== who.principal) {
      setCookies(reply, [clearBinder]);
      return sendError(
        reply,
        403,
        'step_up_principal_mismatch',
        'the step-up sign-in is for another principal',
      );
    }
    if (
      authTime === null ||
      authTime.getTime() < attempt.created_at.getTime() - FRESH_SKEW_SECONDS * 1000
    ) {
      setCookies(reply, [clearBinder]);
      return sendError(
        reply,
        403,
        'step_up_not_fresh',
        'the identity provider did not sign the principal in again',
      );
    }
    const issued = await o.stepUp.issue({
      principal: who.principal,
      bound_hash: attempt.bound_hash as string,
      method: 'reauth',
      auth_time: authTime,
    });
    if (!issued.ok) {
      setCookies(reply, [clearBinder]);
      return sendError(reply, 502, 'step_up_unavailable', issued.error);
    }
    await storeProof(o.pool, attempt.attempt_id, issued.value.claims.proof_id, issued.value.proof);
    setCookies(reply, [clearBinder]);
    const back = new URL(attempt.return_to, o.publicUrl);
    back.searchParams.set('step_up', attempt.attempt_id);
    return reply.redirect(`${back.pathname}${back.search}`);
  });

  // ------------------------------------------------------------ authenticated routes

  interface Authed {
    readonly session: SessionRow;
    readonly sessionHash: string;
  }
  const authed = new WeakMap<FastifyRequest, Authed>();

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const now = clock.now();
    const sid = readCookie(req.headers.cookie, sidName);
    if (!sid) return sendError(reply, 401, 'unauthenticated', 'no session');
    const found = await lookupSession(o.pool, sid, now, idleNow());
    if (!found.ok) {
      setCookies(reply, [serializeCookie(sidName, '', { secure, maxAge: 0 })]);
      return sendError(reply, 401, 'unauthenticated', `session ${found.reason}`);
    }
    // A principal that was disabled after the session began has no session any more.
    const fresh = await freshReadModel(o.pool);
    if (!fresh.ok) return sendError(reply, 503, 'identity_unavailable', fresh.error.message);
    const p = await getPrincipal(o.pool, found.session.principal_id);
    if (!p || p.status !== 'active') {
      await revokePrincipalSessions(o.pool, found.session.principal_id, 'principal_inactive', now);
      return sendError(reply, 401, 'unauthenticated', 'session principal is not active');
    }
    authed.set(req, { session: found.session, sessionHash: found.session.id_hash });

    // CSRF on state-changing requests: the Origin, when the browser sends one, must be ours, and the
    // per-session token (from /api/me) must come back in a header a cross-site form cannot set.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin)) {
        return sendError(reply, 403, 'csrf_failed', 'origin not allowed');
      }
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || !eq(token, found.session.csrf_token)) {
        return sendError(reply, 403, 'csrf_failed', 'missing or wrong CSRF token');
      }
    }
  });

  const ctx = (req: FastifyRequest): Authed => authed.get(req) as Authed;

  app.get('/api/me', async (req, reply) => {
    const { session } = ctx(req);
    const now = clock.now();
    const caught = await runProjection(o.pool, directoryProjection);
    if (!caught.ok)
      return sendError(reply, 503, 'directory_unavailable', 'directory needs a rebuild');
    const summary = await getDirectoryPrincipal(o.pool, session.principal_id);
    if (!summary)
      return sendError(
        reply,
        403,
        'unknown_principal',
        'the directory does not know this principal',
      );

    const principal = session.principal_id;
    const fleet = await o.pdp.allowedActions(principal, pdpResource.fleet());
    const projects = new Set<string>();
    for (const b of await inForceBindings(o.pool, principal, now)) {
      if (b.scope.kind === 'project') projects.add(b.scope.ref);
      else if (b.scope.kind !== 'fleet' && b.scope.ref.includes('/'))
        projects.add(b.scope.ref.split('/')[0] as string);
    }
    const perProject: Array<{ project_id: string; actions: ActionId[] }> = [];
    for (const project of [...projects].sort()) {
      const actions = await o.pdp.allowedActions(principal, pdpResource.project(project));
      if (actions.length > 0) perProject.push({ project_id: project, actions });
    }
    const idleAt = session.last_seen_at.getTime() + idleNow() * 1000;
    return {
      principal: summary,
      session: {
        auth_time: session.auth_time ? session.auth_time.toISOString() : null,
        expires_at: new Date(Math.min(idleAt, session.absolute_expires_at.getTime())).toISOString(),
        absolute_expires_at: session.absolute_expires_at.toISOString(),
        idle_timeout_seconds: idleNow(),
      },
      csrf_token: session.csrf_token,
      step_up: { mode },
      actions: { fleet, projects: perProject },
    };
  });

  app.post('/api/logout', async (req, reply) => {
    const { sessionHash } = ctx(req);
    await revokeSession(o.pool, sessionHash, 'logout', clock.now());
    setCookies(reply, [serializeCookie(sidName, '', { secure, maxAge: 0 })]);
    return { ok: true };
  });

  // ------------------------------------------------------------ step-up

  app.post('/api/step-up', async (req, reply) => {
    const { session, sessionHash } = ctx(req);
    if (limited(reply, stepUpByIp.take(req.ip), stepUpByPrincipal.take(session.principal_id)))
      return;
    const body = StepUpBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.message);
    const bound = (body.data.subject_hash ?? body.data.text_sha256) as string;
    const now = clock.now();
    const principal = session.principal_id as PrincipalId;

    if (mode === 'reconfirm') {
      // DEC-11(c-ii): no re-authentication. The proof says so (`method: reconfirm`), and so does this answer.
      const issued = await o.stepUp.issue({
        principal,
        bound_hash: bound,
        method: 'reconfirm',
        auth_time: now,
      });
      if (!issued.ok) return sendError(reply, 502, 'step_up_unavailable', issued.error);
      return {
        status: 'ready',
        method: 'reconfirm',
        stamp: STEP_UP_RECONFIRM_STAMP,
        proof: issued.value.proof,
        bound_hash: bound,
        expires_at: issued.value.claims.expires_at,
      };
    }

    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const binder = randomToken();
    const url = await o.oidc.authorizationUrl({
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: pkceChallenge(verifier),
      prompt: 'login',
      max_age: 0,
      login_hint: session.subject,
    });
    if (!url.ok) return sendError(reply, 502, 'idp_unavailable', url.error.message);
    const attemptId = await createAttempt(o.pool, {
      purpose: 'step_up',
      state,
      nonce,
      code_verifier: verifier,
      binder,
      return_to: safeReturnTo(body.data.return_to),
      session_hash: sessionHash,
      bound_hash: bound,
      now,
    });
    setCookies(reply, [serializeCookie(binderName, binder, { secure, maxAge: 600 })]);
    return {
      status: 'redirect',
      method: 'reauth',
      attempt_id: attemptId,
      authorize_url: url.value,
    };
  });

  app.get('/api/step-up/:id', async (req, reply) => {
    const { sessionHash } = ctx(req);
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/.test(id)) return sendError(reply, 404, 'not_found', 'no such step-up');
    const got = await collectProof(o.pool, id, sessionHash, clock.now());
    if (!got)
      return sendError(
        reply,
        404,
        'not_found',
        'no proof to collect (not ready, not yours, or already collected)',
      );
    return { status: 'ready', method: 'reauth', proof: got.token, bound_hash: got.bound_hash };
  });

  registerAccessRoutes({
    app,
    pool: o.pool,
    pdp: o.pdp,
    clock,
    principalOf: (req) => ctx(req).session.principal_id,
    displayNameOf: async (id) => {
      const caught = await runProjection(o.pool, directoryProjection);
      if (!caught.ok) return null;
      return (await getDirectoryPrincipal(o.pool, id))?.display_name ?? null;
    },
  });
  registerPortalListRoutes({
    app,
    pool: o.pool,
    pdp: o.pdp,
    core: o.core,
    ...(o.sandboxController ? { sandboxController: o.sandboxController } : {}),
    ...(o.gateCheck ? { gateCheck: o.gateCheck } : {}),
    now: () => clock.now(),
    principalOf: (req) => ctx(req).session.principal_id,
  });
  // M19: the floor, cut to the person's view level and data class, polled with an ETag
  registerFloorRoutes({
    app,
    pdp: o.pdp,
    core: o.core,
    ...(o.sandboxController ? { sandboxController: o.sandboxController } : {}),
    principalOf: (req) => ctx(req).session.principal_id,
    levelsOf: (principal, project) => levelsOn(o.pool, principal, project, clock.now()),
    rolesOf: (principal) => rolesIn(o.pool, principal, clock.now()),
  });
  registerPortalRoutes({
    app,
    pdp: o.pdp,
    core: o.core,
    ...(o.gateCheck ? { gateCheck: o.gateCheck } : {}),
    levelsOf: (principal, project) => levelsOn(o.pool, principal, project, clock.now()),
    principalOf: (req) => ctx(req).session.principal_id,
    namesOf: async (ids) => {
      const out: Record<string, string> = {};
      for (const id of ids) {
        const p = await getDirectoryPrincipal(o.pool, id);
        if (p) out[id] = p.display_name;
      }
      return out;
    },
  });
  registerIssueTwinRoutes({
    app,
    pdp: o.pdp,
    core: o.core,
    principalOf: (req) => ctx(req).session.principal_id,
  });
  registerDriftRoutes({
    app,
    pdp: o.pdp,
    core: o.core,
    principalOf: (req) => ctx(req).session.principal_id,
  });
  registerAssistantRoutes({
    app,
    pool: o.pool,
    pdp: o.pdp,
    clock,
    core: o.core,
    principalOf: (req) => ctx(req).session.principal_id,
  });
  registerNotificationRoutes({
    app,
    pdp: o.pdp,
    notifier: o.notifier,
    principalOf: (req) => ctx(req).session.principal_id,
  });
  registerKillRoutes({
    app,
    pdp: o.pdp,
    killswitch: o.killswitch,
    principalOf: (req) => ctx(req).session.principal_id,
  });
  registerOpsRoutes({
    app,
    pdp: o.pdp,
    core: o.core,
    ...(o.gateway ? { gateway: o.gateway } : {}),
    principalOf: (req) => ctx(req).session.principal_id,
  });
  registerAuditRoutes({
    app,
    pdp: o.pdp,
    audit: o.audit,
    principalOf: (req) => ctx(req).session.principal_id,
  });
  if (o.webDir) registerWebFiles(app, o.webDir);

  return app;
}
