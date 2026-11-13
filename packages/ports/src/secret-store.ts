import {
  err,
  ok,
  systemClock,
  taggedError,
  type Clock,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';

// SecretStorePort (portal v2, gap G1, N15): where the secrets a person pastes into the portal live. Write-only from
// the factory's side: `put` stores a new version, `meta` says whether a value is set (version, when) and never what
// it is, `delete` destroys every version. `get` exists for the services that USE a secret (each reads its own folder;
// the writer's Vault policy has no read). Adapters: `VaultSecretStore` (HashiCorp Vault KV v2, local prod),
// `AwsSecretsManagerStore` (a stub for production later, not wired by default) and `FakeSecretStore` below.
//
// A reference is `<path>#<key>`: a path of lower-case segments (`gateway/anthropic-api-key`) and the field the value
// is stored under (`value`). One secret per path: a `put` replaces the path's fields with the one given. Configuration
// names it as `vault:<path>#<key>` (`secretVaultRef` in contracts).
//
// No error, log line or result of this port ever carries a value.

export const SecretStoreError = taggedError('SecretStoreError');
export type SecretStoreError = TaggedError<
  'SecretStoreError',
  {
    code:
      /** `get` of a reference with no current value. */
      | 'not_found'
      /** Not `<path>#<key>`. */
      | 'invalid_ref'
      /** Empty, too long, or not text. */
      | 'invalid_value'
      /** The store refused (its policy for this process). */
      | 'denied'
      /** The store did not answer, or is sealed. Unknown means unmet. */
      | 'unavailable';
    message: string;
  }
>;
export const secretStoreError = (
  code: SecretStoreError['code'],
  message: string,
): SecretStoreError => SecretStoreError({ code, message });
export type SecretStoreResult<T> = Result<T, SecretStoreError>;

export interface SecretMeta {
  readonly ref: string;
  /** A current value is stored. */
  readonly set: boolean;
  /** The current version (1, 2, ...), or null when nothing is set. */
  readonly version: number | null;
  /** When the current version was written (ISO 8601), or null. */
  readonly updated_at: string | null;
}

export interface SecretVersion {
  readonly version: number;
  readonly updated_at: string;
}

export interface SecretStorePort {
  /** Stores `value` as a new version. */
  put(ref: string, value: string): Promise<SecretStoreResult<SecretVersion>>;
  /** The current value; `not_found` when none. */
  get(ref: string): Promise<SecretStoreResult<string>>;
  /** Destroys every version of the reference's path. Idempotent. */
  delete(ref: string): Promise<SecretStoreResult<void>>;
  /** Whether a value is set, its version and when; never the value. */
  meta(ref: string): Promise<SecretStoreResult<SecretMeta>>;
}

/** The largest value any adapter accepts (Vault's request limit is far above; a PEM key is ~1.7 KiB). */
export const SECRET_STORE_MAX_VALUE = 65_536;

const SEGMENT = '[a-z0-9][a-z0-9_-]{0,63}';
const REF_RE = new RegExp(`^(${SEGMENT}(?:/${SEGMENT}){0,7})#([A-Za-z0-9_-]{1,64})$`);

/** `<path>#<key>` split, or null. */
export function parseSecretStoreRef(ref: string): { path: string; key: string } | null {
  const m = REF_RE.exec(ref);
  return m ? { path: m[1] as string, key: m[2] as string } : null;
}

/** The checks every adapter makes first (one function for the fake and the real adapters). */
export function checkSecretPut(ref: string, value: string): SecretStoreError | null {
  if (!parseSecretStoreRef(ref)) return secretStoreError('invalid_ref', `not <path>#<key>: ${ref}`);
  if (typeof value !== 'string' || value.length === 0) {
    return secretStoreError('invalid_value', 'the value is empty');
  }
  if (value.length > SECRET_STORE_MAX_VALUE) {
    return secretStoreError('invalid_value', `the value is longer than ${SECRET_STORE_MAX_VALUE}`);
  }
  if (value.includes('\u0000')) return secretStoreError('invalid_value', 'the value holds a NUL');
  return null;
}

/** The deterministic fake: the same rules, in memory, versions per path, a clock for `updated_at`. */
export class FakeSecretStore implements SecretStorePort {
  private readonly paths = new Map<
    string,
    { fields: Map<string, string>; version: number; at: string }
  >();
  private readonly clock: Clock;
  /** Set to make every call `unavailable` (a sealed or unreachable store). */
  down = false;
  /** Paths this store refuses (a policy that does not cover them). */
  readonly deniedPaths = new Set<string>();

  constructor(o: { clock?: Clock } = {}) {
    this.clock = o.clock ?? systemClock;
  }

  private gate(ref: string): SecretStoreResult<{ path: string; key: string }> {
    if (this.down) return err(secretStoreError('unavailable', 'the fake store is down'));
    const p = parseSecretStoreRef(ref);
    if (!p) return err(secretStoreError('invalid_ref', `not <path>#<key>: ${ref}`));
    if (this.deniedPaths.has(p.path)) return err(secretStoreError('denied', `${p.path}: denied`));
    return ok(p);
  }

  async put(ref: string, value: string): Promise<SecretStoreResult<SecretVersion>> {
    const g = this.gate(ref);
    if (!g.ok) return g;
    const bad = checkSecretPut(ref, value);
    if (bad) return err(bad);
    const cur = this.paths.get(g.value.path);
    const version = (cur?.version ?? 0) + 1;
    const at = this.clock.now().toISOString();
    this.paths.set(g.value.path, { fields: new Map([[g.value.key, value]]), version, at });
    return ok({ version, updated_at: at });
  }

  async get(ref: string): Promise<SecretStoreResult<string>> {
    const g = this.gate(ref);
    if (!g.ok) return g;
    const v = this.paths.get(g.value.path)?.fields.get(g.value.key);
    return v === undefined ? err(secretStoreError('not_found', `${ref}: not set`)) : ok(v);
  }

  async delete(ref: string): Promise<SecretStoreResult<void>> {
    const g = this.gate(ref);
    if (!g.ok) return g;
    // like Vault's metadata delete: every version goes, and a later put starts again at version 1
    this.paths.delete(g.value.path);
    return ok(undefined);
  }

  async meta(ref: string): Promise<SecretStoreResult<SecretMeta>> {
    const g = this.gate(ref);
    if (!g.ok) return g;
    const cur = this.paths.get(g.value.path);
    const set = cur?.fields.has(g.value.key) === true;
    return ok({
      ref,
      set,
      version: set && cur ? cur.version : null,
      updated_at: set && cur ? cur.at : null,
    });
  }
}
