import type { Clock } from '@aisdlc/kernel';

// Token buckets for the routes an attacker can hammer without a session: `/auth/login` (per client
// IP: nobody is known yet) and the step-up start (per IP and per principal: re-authentication is
// an IdP round trip the bff pays for, and a stolen session must not be able to grind it).
//
// Memory, not the database: a bucket is a few bytes, losing them on a restart only gives an
// attacker a fresh burst, and one bff process serves local-prod. A deployment with several bff
// instances behind a balancer MUST move the buckets to the bff schema (or the edge's WAF) or the
// effective limit is the limit times the instance count; the interface (`take`) stays the same.

export interface BucketLimit {
  /** The burst: tokens in a full bucket. */
  readonly capacity: number;
  /** Tokens added per second, so `1 / refillPerSecond` seconds per request when sustained. */
  readonly refillPerSecond: number;
}

export interface RateLimits {
  /** `/auth/login`, by client IP. */
  readonly login: BucketLimit;
  /** The step-up start, by client IP. */
  readonly stepUpIp: BucketLimit;
  /** The step-up start, by principal. */
  readonly stepUpPrincipal: BucketLimit;
}

/** Documented defaults (also in `docs/` via the bff README comment of `createBffApp`). */
export const DEFAULT_RATE_LIMITS: RateLimits = {
  // 10 sign-in starts at once, then one every 6 seconds (10 a minute) per IP.
  login: { capacity: 10, refillPerSecond: 1 / 6 },
  // 20 at once, then one every 3 seconds per IP.
  stepUpIp: { capacity: 20, refillPerSecond: 1 / 3 },
  // 5 at once, then one every 12 seconds (5 a minute) per principal.
  stepUpPrincipal: { capacity: 5, refillPerSecond: 1 / 12 },
};

export type Take =
  { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  at: number;
}

/** A keyed token bucket. A request takes one token; an empty bucket answers how long until one. */
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: BucketLimit,
    private readonly clock: Clock,
    /** Keys kept at most; a full bucket carries no information, so those are dropped first. */
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string): Take {
    const now = this.clock.now().getTime();
    const b = this.buckets.get(key) ?? { tokens: this.limit.capacity, at: now };
    const elapsed = Math.max(0, now - b.at) / 1000;
    b.tokens = Math.min(this.limit.capacity, b.tokens + elapsed * this.limit.refillPerSecond);
    b.at = now;
    this.buckets.delete(key);
    this.buckets.set(key, b); // most recently used last
    if (this.buckets.size > this.maxKeys) this.evict(now);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / this.limit.refillPerSecond)),
    };
  }

  private evict(now: number): void {
    for (const [k, b] of this.buckets) {
      const full =
        b.tokens + (Math.max(0, now - b.at) / 1000) * this.limit.refillPerSecond >=
        this.limit.capacity;
      if (full || this.buckets.size > this.maxKeys) this.buckets.delete(k);
      if (this.buckets.size <= this.maxKeys) break;
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
