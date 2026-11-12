import { createServer } from 'node:net';
import type { PolicyBundle } from '@aisdlc/contracts';
import { migrateConfig } from '@aisdlc/config';
import { migrateDirectory } from '@aisdlc/directory';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { BootstrapPdpEntities } from '@aisdlc/onboarding';
import {
  seedLinks,
  seedPrincipals,
  startIdentityStack,
  type IdentityStack,
} from '@aisdlc/identity/testing';
import { Pdp, StaticBundleSource, buildBundle, MemoryDecisionLog } from '@aisdlc/pdp';
import type { OidcPort } from '@aisdlc/ports';
import { listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { createBffApp, type BffAppOptions } from './app.js';
import { startDevOidcProvider, type DevOidcProvider, type DevUser } from './dev-oidc/provider.js';
import { migrateBff } from './migrations.js';
import { HttpOidcClient } from './oidc/http-client.js';
import { StepUpIssuer } from './stepup/issuer.js';
import { PgProofStore } from './stepup/store.js';

// A real bff stack for tests: one Postgres with every schema the bff reads or owns, real kms-local
// (which signs the proofs), the in-repo dev OIDC provider over HTTP, identity as seeded
// principals with IdP links, and the PDP over the identity read model with the generated bundle.

/** A free loopback port (bound and released; fine for a test that starts right after). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Jar {
  value: string;
  attrs: string[];
  deleted: boolean;
}

/** A browser stand-in: a cookie jar per host, and redirects followed by hand across hosts. */
export class Browser {
  private readonly jar = new Map<string, Map<string, Jar>>();
  /** Every Set-Cookie header ever received, raw, for attribute assertions. */
  readonly setCookies: string[] = [];
  /** Everything the browser ever saw from a server: status line, headers and body of each response. */
  readonly transcript: string[] = [];

  cookie(url: string, name: string): string | undefined {
    const j = this.jar.get(new URL(url).host)?.get(name);
    return j && !j.deleted ? j.value : undefined;
  }

  cookiesOf(url: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.jar.get(new URL(url).host) ?? []) if (!v.deleted) out[k] = v.value;
    return out;
  }

  setCookie(url: string, name: string, value: string): void {
    const host = new URL(url).host;
    const m = this.jar.get(host) ?? new Map<string, Jar>();
    m.set(name, { value, attrs: [], deleted: false });
    this.jar.set(host, m);
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host;
    const cookies = [...(this.jar.get(host) ?? [])]
      .filter(([, v]) => !v.deleted)
      .map(([k, v]) => `${k}=${v.value}`)
      .join('; ');
    const headers = new Headers(init.headers);
    if (cookies) headers.set('cookie', cookies);
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    this.transcript.push(
      `${res.status} ${url}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.clone().text()}`,
    );
    for (const raw of res.headers.getSetCookie()) {
      this.setCookies.push(raw);
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const i = (pair as string).indexOf('=');
      const name = (pair as string).slice(0, i);
      const value = (pair as string).slice(i + 1);
      const m = this.jar.get(host) ?? new Map<string, Jar>();
      const gone = attrs.some((a) => /^max-age=0$/i.test(a)) || value === '';
      m.set(name, { value, attrs, deleted: gone });
      this.jar.set(host, m);
    }
    return res;
  }

  /** GET `url` and follow every redirect; returns the last response and the URLs visited. */
  async follow(url: string, init: RequestInit = {}): Promise<{ res: Response; chain: string[] }> {
    const chain = [url];
    let res = await this.request(url, init);
    for (let i = 0; i < 20 && res.status >= 300 && res.status < 400; i++) {
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, chain[chain.length - 1]).toString();
      chain.push(next);
      res = await this.request(next);
    }
    return { res, chain };
  }
}

export const SUBJECTS = {
  alice: 'sub-alice',
  bob: 'sub-bob',
  carol: 'sub-carol',
  root: 'sub-root',
  ghost: 'sub-ghost',
  dora: 'sub-dora',
  bot: 'sub-bot',
} as const;

export const CLIENT = { client_id: 'bff', client_secret: 'dev-client-secret-0123456789' } as const;

export interface BffStack {
  readonly identity: IdentityStack;
  readonly oidc: DevOidcProvider;
  readonly app: FastifyInstance;
  readonly base: string;
  readonly port: number;
  readonly pdp: Pdp;
  readonly log: MemoryDecisionLog;
  readonly stepUp: StepUpIssuer;
  stop(): Promise<void>;
}

export interface StartOptions {
  readonly cookieSecure?: boolean;
  readonly idleSeconds?: number;
  readonly absoluteSeconds?: number;
  readonly stepUpMode?: 'reauth' | 'reconfirm';
  readonly allowedOrigins?: string[];
  /** Wraps the real OIDC client (to make the IdP misbehave in a test). */
  readonly wrapOidc?: (real: OidcPort) => OidcPort;
  readonly override?: Partial<BffAppOptions>;
  /** The policy bundle the PDP loads (default: `buildBundle()`, the catalogues as they are). */
  readonly bundle?: PolicyBundle;
  /**
   * The dev IdP's users instead of the test principals (`SUBJECTS`). Then the stack creates no principal and no link:
   * the caller's IdP sync does (e.g. the compose seed's `idp-seed.json`), and `signInSubject` signs a user in.
   */
  readonly devUsers?: readonly DevUser[];
}

/**

 * Starts the stack. Principals: alice, bob, carol, root, dora (human, each with an IdP link), bot (a
 * service principal with a link) and ghost (a principal with no IdP link, on purpose). The caller shapes identity (`bindProject`, `grantFleetRole`, ...) after.
 */
export async function startBffStack(o: StartOptions = {}): Promise<BffStack> {
  // `freePort` binds and releases a port, and the stack starts other servers (identity, the dev OIDC
  // provider) before the bff binds it, so on a busy machine another process can take it in between.
  // Only that race (EADDRINUSE) starts the whole stack again, with a fresh port; any other error fails.
  for (let attempt = 1; ; attempt++) {
    try {
      return await startBffStackOnce(o);
    } catch (e) {
      const inUse = (e as { code?: unknown } | null)?.code === 'EADDRINUSE';
      if (!inUse || attempt >= 5) throw e;
    }
  }
}

async function startBffStackOnce(o: StartOptions): Promise<BffStack> {
  const identity = await startIdentityStack();
  const stoppers: Array<() => Promise<void>> = [() => identity.stop()];
  try {
    await migrateDirectory(identity.record.pool);
    await migrateConfig(identity.record.pool);
    await migrateBff(identity.record.pool);

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const oidc = await startDevOidcProvider({
      users:
        o.devUsers ??
        Object.entries(SUBJECTS).map(([name, subject]) => ({
          subject,
          name,
          email: `${name}@example.test`,
        })),
      clients: [{ ...CLIENT, redirect_uris: [`${base}/auth/callback`] }],
      autoLogin: true,
      clock: identity.clock,
    });
    stoppers.push(() => oidc.stop());

    if (o.devUsers === undefined) {
      await seedPrincipals(identity.deps, ['alice', 'bob', 'carol', 'root', 'ghost', 'dora']);
      await seedPrincipals(identity.deps, ['bot'], { kind: 'service' });
      await seedLinks(
        identity.deps,
        ['alice', 'bob', 'carol', 'root', 'dora', 'bot'].map((principal) => ({
          principal,
          issuer: oidc.issuer,
          subject: SUBJECTS[principal as keyof typeof SUBJECTS],
        })),
      );
    }

    const pool = identity.record.pool;
    const log = new MemoryDecisionLog();
    const pdp = new Pdp({
      source: new StaticBundleSource(o.bundle ?? buildBundle()),
      entities: new BootstrapPdpEntities(new IdentityPdpEntities({ pool }), { db: pool }),
      clock: identity.clock,
      log,
    });
    const custody = identity.kms.custodyFor('bff');
    const stepUp = new StepUpIssuer({
      custody,
      store: new PgProofStore(pool),
      clock: identity.clock,
    });
    const app = createBffApp({
      pool,
      oidc: (o.wrapOidc ?? ((x: OidcPort) => x))(
        new HttpOidcClient({
          issuer: oidc.issuer,
          client_id: CLIENT.client_id,
          client_secret: CLIENT.client_secret,
          clock: identity.clock,
        }),
      ),
      pdp,
      stepUp,
      publicUrl: base,
      cookieSecure: o.cookieSecure ?? false,
      clock: identity.clock,
      // Tests sign in many times on a clock that does not move; the limits have tests of their own.
      rateLimits: {
        login: { capacity: 1_000_000, refillPerSecond: 1 },
        stepUpIp: { capacity: 1_000_000, refillPerSecond: 1 },
        stepUpPrincipal: { capacity: 1_000_000, refillPerSecond: 1 },
      },
      ...(o.idleSeconds !== undefined ? { idleSeconds: o.idleSeconds } : {}),
      ...(o.absoluteSeconds !== undefined ? { absoluteSeconds: o.absoluteSeconds } : {}),
      ...(o.stepUpMode !== undefined ? { stepUpMode: o.stepUpMode } : {}),
      ...(o.allowedOrigins !== undefined ? { allowedOrigins: o.allowedOrigins } : {}),
      ...o.override,
    });
    await listen(app, { port });
    stoppers.push(() => app.close());
    return {
      identity,
      oidc,
      app,
      base,
      port,
      pdp,
      log,
      stepUp,
      async stop() {
        for (const s of stoppers.reverse()) await s();
      },
    };
  } catch (e) {
    for (const s of stoppers.reverse()) await s().catch(() => undefined);
    throw e;
  }
}

/** Signs `who` in through the whole redirect dance; returns the browser holding the session. */
export async function signIn(
  s: Pick<BffStack, 'base'>,
  who: keyof typeof SUBJECTS,
  browser = new Browser(),
  returnTo = '/',
): Promise<{ browser: Browser; res: Response; chain: string[] }> {
  return signInSubject(s, SUBJECTS[who], browser, returnTo);
}

/** Signs the dev IdP user with this subject in (a stack started with `devUsers`). */
export async function signInSubject(
  s: Pick<BffStack, 'base'>,
  subject: string,
  browser = new Browser(),
  returnTo = '/',
): Promise<{ browser: Browser; res: Response; chain: string[] }> {
  // The dev provider has autoLogin; the hint names the user it should sign in. The bff does not
  // forward a hint on login (it does not know the user yet), so the test plays the user: it follows
  // the redirect to the provider and submits the form for `who`.
  const first = await browser.request(
    `${s.base}/auth/login?return_to=${encodeURIComponent(returnTo)}`,
  );
  const idp = new URL(first.headers.get('location') as string);
  idp.searchParams.set('login_hint', subject);
  const hopped = await browser.follow(idp.toString());
  return {
    browser,
    res: hopped.res,
    chain: [first.headers.get('location') as string, ...hopped.chain],
  };
}
