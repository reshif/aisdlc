import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { vaultCache } from './vault-cache.js';

/** Smallest service token accepted. Short tokens are a configuration error (fail closed). */
export const MIN_TOKEN_LENGTH = 16;

export class ServiceConfigError extends Error {
  override readonly name = 'ServiceConfigError';
}

export interface SecretRefDeps {
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

/**
 * Resolves a secret reference: `env:NAME` reads an environment variable, `file:/path` reads a
 * file (a mounted secret) and trims trailing whitespace, `vault:<path>#<key>` reads what the process
 * primed from Vault (secret-refs.ts: `runService` primes every reference of the environment first).
 * The value itself never appears in configuration.
 */
export function resolveSecretRef(ref: string, deps: SecretRefDeps = {}): string {
  const env = deps.env ?? process.env;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let value: string | undefined;
  if (ref.startsWith('env:')) value = env[ref.slice(4)];
  else if (ref.startsWith('file:')) {
    try {
      value = read(ref.slice(5)).trim();
    } catch (cause) {
      throw new ServiceConfigError(`cannot read secret ${ref}`, { cause });
    }
  } else if (ref.startsWith('vault:')) {
    const hit = vaultCache.get(ref);
    if (hit === undefined) throw new ServiceConfigError(`secret ${ref} was not loaded from Vault`);
    value = hit?.value;
  } else {
    throw new ServiceConfigError(
      `secret reference must be env:NAME, file:PATH or vault:PATH#KEY, got ${ref}`,
    );
  }
  if (value === undefined || value.length < MIN_TOKEN_LENGTH) {
    throw new ServiceConfigError(`secret ${ref} is missing or shorter than ${MIN_TOKEN_LENGTH}`);
  }
  return value;
}

export interface CallerTokenConfig {
  token_ref: string;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Bearer-token authentication: one token per calling service. */
export class ServiceAuth {
  private readonly callers: Array<{ name: string; digest: Buffer }>;

  constructor(tokens: Record<string, string>) {
    this.callers = Object.entries(tokens).map(([name, token]) => {
      if (token.length < MIN_TOKEN_LENGTH) {
        throw new ServiceConfigError(
          `token for caller ${name} is shorter than ${MIN_TOKEN_LENGTH}`,
        );
      }
      return { name, digest: digest(token) };
    });
    const seen = new Set(this.callers.map((c) => c.digest.toString('hex')));
    if (seen.size !== this.callers.length) {
      throw new ServiceConfigError('two callers share a token');
    }
  }

  /** The caller name for an `Authorization` header, or null. Compares every caller. */
  authenticate(header: string | undefined): string | null {
    const m = /^Bearer ([^\s]+)$/.exec(header ?? '');
    if (!m) return null;
    const d = digest(m[1] as string);
    let found: string | null = null;
    for (const c of this.callers) {
      if (timingSafeEqual(c.digest, d)) found = c.name;
    }
    return found;
  }
}

/** Builds `ServiceAuth` from `{caller: {token_ref}}`. */
export function loadServiceAuth(
  callers: Record<string, CallerTokenConfig>,
  deps: SecretRefDeps = {},
): ServiceAuth {
  return new ServiceAuth(
    Object.fromEntries(
      Object.entries(callers).map(([name, c]) => [name, resolveSecretRef(c.token_ref, deps)]),
    ),
  );
}
