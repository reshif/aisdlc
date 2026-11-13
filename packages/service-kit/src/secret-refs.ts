import { ServiceConfigError } from './auth.js';
import {
  VAULT_REF_SCAN_RE,
  VaultError,
  type VaultClient,
  parseVaultRef,
  vaultClientFromEnv,
} from './vault.js';
import { vaultCache } from './vault-cache.js';

// `vault:<path>#<key>` references, next to `file:` and `env:` (auth.ts). `resolveSecretRef` is synchronous and is
// called all over the services' configuration code, so a Vault reference is read AHEAD of it: `runService` primes
// every `vault:` reference named anywhere in the process environment before the service starts (an env value that
// is a reference, or JSON that holds some, like GATEWAY_SECRET_REFS), then refreshes them on a timer. A reference
// that Vault does not hold (yet) is remembered as absent: resolving it is a configuration error for a value a
// service needs at start, and a refusal of the one row for a value a registry row names (the gateway's key until
// the owner pastes it). A change is announced to the listeners (`onSecretRefChange`): the gateway rebuilds its
// adapters, an App key re-reads itself on its next signature.
//
// The values live in this process's memory only, never in a log line, an error message or an event.

let client: VaultClient | null = null;
const listeners = new Set<(refs: readonly string[]) => void>();
let timer: NodeJS.Timeout | null = null;

/** Every `vault:` reference in `text` (deduplicated, in order). */
export function vaultRefsIn(text: string): string[] {
  return [...new Set(text.match(VAULT_REF_SCAN_RE) ?? [])];
}

/** The Vault client the references are read with (tests, and a service that writes through it). */
export function setSecretRefVault(c: VaultClient | null): void {
  client = c;
}

/** Reads `refs` from Vault into the cache. Absent is remembered; denied or unavailable is an error. */
export async function primeSecretRefs(refs: Iterable<string>): Promise<string[]> {
  const changed: string[] = [];
  const byPath = new Map<string, string[]>();
  for (const ref of refs) {
    const p = parseVaultRef(ref);
    if (!p) throw new ServiceConfigError(`not a vault: reference: ${ref}`);
    byPath.set(p.path, [...(byPath.get(p.path) ?? []), ref]);
  }
  if (byPath.size === 0) return changed;
  if (!client) {
    throw new ServiceConfigError(
      'vault: references need VAULT_ADDR and VAULT_APPROLE_FILE (or VAULT_TOKEN_FILE)',
    );
  }
  for (const [path, list] of byPath) {
    let read;
    try {
      read = await client.kvRead(path);
    } catch (e) {
      const why = e instanceof VaultError ? `${e.code}: ${e.message}` : 'error';
      throw new ServiceConfigError(`cannot read vault:${path} (${why})`);
    }
    for (const ref of list) {
      const key = (parseVaultRef(ref) as { key: string }).key;
      const value = read?.data[key];
      const next = value === undefined ? null : { value, version: read?.version ?? 0 };
      const prev = vaultCache.get(ref);
      const same =
        prev !== undefined &&
        (prev === null
          ? next === null
          : next !== null && prev.version === next.version && prev.value === next.value);
      vaultCache.set(ref, next);
      if (!same && prev !== undefined) changed.push(ref);
    }
  }
  return changed;
}

/** Re-reads every reference already primed; tells the listeners what changed. Never throws. */
export async function refreshSecretRefs(): Promise<string[]> {
  let changed: string[];
  try {
    changed = await primeSecretRefs([...vaultCache.keys()]);
  } catch (e) {
    console.error(
      `secret refs: refresh failed: ${e instanceof Error ? e.message : 'error'} (the values read before stay)`,
    );
    return [];
  }
  if (changed.length > 0) for (const l of listeners) l(changed);
  return changed;
}

/** Called with the references whose value or version changed (or that appeared or went away). */
export function onSecretRefChange(l: (refs: readonly string[]) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The version of a primed `vault:` reference, `null` when Vault holds none, `undefined` when it was never primed. */
export function secretRefVersion(ref: string): number | null | undefined {
  const v = vaultCache.get(ref);
  return v === undefined ? undefined : v === null ? null : v.version;
}

/**
 * Primes every `vault:` reference in the environment's values and starts the refresh timer (VAULT_REFRESH_SECONDS,
 * default 30; 0: none). Without a reference nothing is read and nothing is needed. Idempotent per process.
 */
export async function primeSecretRefsFromEnv(
  env: Record<string, string | undefined>,
  o: { fetchImpl?: typeof fetch; readFile?: (p: string) => string } = {},
): Promise<number> {
  const refs = new Set<string>();
  for (const v of Object.values(env)) if (v) for (const r of vaultRefsIn(v)) refs.add(r);
  if (refs.size === 0) return 0;
  client ??= vaultClientFromEnv(env, o);
  await primeSecretRefs(refs);
  const every = Number(env['VAULT_REFRESH_SECONDS'] ?? 30);
  if (!Number.isFinite(every) || every < 0) {
    throw new ServiceConfigError('VAULT_REFRESH_SECONDS must be a number of seconds, 0 or more');
  }
  if (every > 0 && timer === null) {
    timer = setInterval(() => void refreshSecretRefs(), every * 1000);
    timer.unref();
  }
  return refs.size;
}

/** Forgets every primed reference and stops the timer (tests). */
export function resetSecretRefs(): void {
  vaultCache.clear();
  listeners.clear();
  if (timer) clearInterval(timer);
  timer = null;
  client = null;
}
