import {
  CODEHOST_ROLE_PERMISSIONS,
  CodeHostRole,
  codeHostRoleIsReadOnly,
  forbiddenPermissionsIn,
  type CodeHostNotOk,
  type GithubPermissions,
} from '@aisdlc/contracts';
import { err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import { readUnknown, readUnreadable } from '@aisdlc/ports';
import { z } from 'zod';
import { SecretValue, type AppKey } from './app-key.js';
import { notOkFromFetchError, notOkFromStatus } from './http.js';
import { appJwt } from './jwt.js';
import type { CodeHostMode } from './allow-list.js';

// The installation token broker (PLAN M5.2, OB §6.5). One App plays every role, so the separation
// is here: a token is minted PER ROLE with an explicit subset of permissions (never the whole
// installation grant), `FORBIDDEN_PERMS` are never requested, a token that comes back carrying
// more than was asked is discarded, and in Census mode only read-only roles can be minted. A token
// is a `SecretValue` held in this process: it is cached until shortly before it expires, handed to
// the transport for an `Authorization` header, and appears in no response, log or error.

export interface MintedToken {
  readonly role: CodeHostRole;
  readonly secret: SecretValue;
  readonly expires_at: Date;
  /** What GitHub says the token carries. */
  readonly permissions: GithubPermissions;
}

export interface TokenBrokerOptions {
  readonly appKey: AppKey;
  readonly appId: string;
  readonly installationId: number;
  readonly baseUrl: string;
  readonly mode: CodeHostMode;
  readonly clock?: Clock;
  readonly fetchImpl?: typeof fetch;
  /** A token is renewed when it has less than this long to live. Default two minutes. */
  readonly skewMs?: number;
  readonly timeoutMs?: number;
}

const MintResponse = z.looseObject({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z.record(z.string(), z.string()),
});

const LEVEL = { read: 1, write: 2, admin: 3 } as const;
const levelOf = (l: string): number => (LEVEL as Record<string, number>)[l] ?? 99;

export class TokenBroker {
  private readonly clock: Clock;
  private readonly f: typeof fetch;
  private readonly skewMs: number;
  private readonly cache = new Map<CodeHostRole, MintedToken>();
  private readonly inflight = new Map<CodeHostRole, Promise<Result<MintedToken, CodeHostNotOk>>>();
  private readonly seen = new Map<CodeHostRole, GithubPermissions>();
  private mints = 0;

  constructor(private readonly o: TokenBrokerOptions) {
    this.clock = o.clock ?? systemClock;
    this.f = o.fetchImpl ?? fetch;
    this.skewMs = o.skewMs ?? 120_000;
  }

  /** The permissions a token of `role` asks for: the explicit subset, nothing from the installation. */
  static permissionsFor(role: CodeHostRole): GithubPermissions {
    return { ...CODEHOST_ROLE_PERMISSIONS[role] };
  }

  /** How many tokens were minted (cache hits are not mints). */
  get mintCount(): number {
    return this.mints;
  }

  /** The permissions of the tokens GitHub actually returned, by role (for the B4a check). */
  observedPermissions(): ReadonlyArray<{ role: CodeHostRole; permissions: GithubPermissions }> {
    return [...this.seen].map(([role, permissions]) => ({ role, permissions }));
  }

  /** Drops the cached token of `role` (after a 401). */
  invalidate(role: CodeHostRole): void {
    this.cache.delete(role);
  }

  /** The App JWT, for the few calls that authenticate as the App (`GET /app/installations/{id}`). */
  jwt(): string {
    return appJwt(this.o.appKey, this.o.appId, this.clock.now());
  }

  /** A token for `role`: cached while it has more than `skewMs` to live, else minted. */
  token(role: CodeHostRole): Promise<Result<MintedToken, CodeHostNotOk>> {
    const parsed = CodeHostRole.safeParse(role);
    if (!parsed.success) {
      return Promise.resolve(err(readUnreadable('refused', `unknown role ${String(role)}`)));
    }
    const forbidden = forbiddenPermissionsIn(CODEHOST_ROLE_PERMISSIONS[role]);
    if (forbidden.length > 0) {
      return Promise.resolve(
        err(readUnreadable('refused', `role ${role} would request forbidden permissions`)),
      );
    }
    if (this.o.mode === 'census' && !codeHostRoleIsReadOnly(role)) {
      return Promise.resolve(
        err(readUnreadable('refused', `role ${role} writes and is not mintable in Census mode`)),
      );
    }
    const cached = this.cache.get(role);
    if (cached && cached.expires_at.getTime() - this.skewMs > this.clock.now().getTime()) {
      return Promise.resolve(ok(cached));
    }
    const pending = this.inflight.get(role);
    if (pending) return pending;
    const p = this.mint(role).finally(() => this.inflight.delete(role));
    this.inflight.set(role, p);
    return p;
  }

  private async mint(role: CodeHostRole): Promise<Result<MintedToken, CodeHostNotOk>> {
    const what = `token for ${role}`;
    const requested = TokenBroker.permissionsFor(role);
    // The one POST this service makes: it mints a credential, reads nothing, and goes only to the
    // configured installation (the id is a number from configuration, never from a request).
    const url = new URL(
      `/app/installations/${this.o.installationId}/access_tokens`,
      this.o.baseUrl,
    );
    let res: Response;
    try {
      res = await this.f(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.jwt()}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'aisdlc-codehost',
        },
        body: JSON.stringify({ permissions: requested }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch (e) {
      return err(notOkFromFetchError(e, what));
    }
    this.mints += 1;
    if (res.status !== 201 && res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      // 422: the installation does not hold a permission the role asks for.
      if (res.status === 422) {
        return err(
          readUnreadable('permission_not_granted', `${what}: the installation does not grant them`),
        );
      }
      return err(notOkFromStatus(res.status, res.headers, what));
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return err(readUnknown('malformed', `${what}: the answer is not JSON`));
    }
    const m = MintResponse.safeParse(json);
    if (!m.success) return err(readUnknown('malformed', `${what}: the answer has no token`));
    // A token that carries more than was asked is never used or kept.
    const extra = Object.entries(m.data.permissions).filter(
      ([name, level]) =>
        !(name in requested) || levelOf(level) > levelOf(requested[name] as string),
    );
    const bad = [
      ...extra.map(([n, l]) => `${n}:${l}`),
      ...forbiddenPermissionsIn(m.data.permissions),
    ];
    if (bad.length > 0) {
      return err(
        readUnreadable('refused', `${what}: GitHub returned permissions beyond the request`),
      );
    }
    const token: MintedToken = {
      role,
      secret: new SecretValue(m.data.token),
      expires_at: new Date(m.data.expires_at),
      permissions: m.data.permissions as GithubPermissions,
    };
    this.cache.set(role, token);
    this.seen.set(role, token.permissions);
    return ok(token);
  }
}
