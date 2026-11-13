import { readFileSync } from 'node:fs';
import { ServiceConfigError } from './auth.js';

// A minimal HashiCorp Vault client over fetch (no SDK enters the tree): the KV version 2 secrets engine and the two
// ways a factory process logs in (a token from a file, or AppRole with its role_id and secret_id from a file). It is
// the one HTTP client of Vault: `resolveSecretRef` reads `vault:` references through it (secret-refs.ts) and
// `VaultSecretStore` (@aisdlc/ports) implements the SecretStorePort with it.
//
// Values never leave this module except as the return value of `kvRead`: an error message names the path and the
// HTTP status, never a body, a token or a value.

export type VaultErrorCode =
  /** Vault answered 403: the policy of this process does not allow the call (or the login failed). */
  | 'denied'
  /** Vault did not answer, answered 5xx, or is sealed. Unknown means unmet. */
  | 'unavailable'
  /** A path or a reference that is not one, or an answer that does not parse. */
  | 'invalid';

export class VaultError extends Error {
  override readonly name = 'VaultError';
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type VaultAuth =
  | { readonly kind: 'token'; readonly tokenFile: string }
  /** A JSON file `{"role_id": "...", "secret_id": "..."}` (init-secrets writes one per service). */
  | { readonly kind: 'approle'; readonly file: string };

export interface VaultClientOptions {
  /** e.g. http://vault:8200 */
  readonly addr: string;
  readonly auth: VaultAuth;
  /** The KV v2 mount. Default `aisdlc`. */
  readonly mount?: string;
  readonly fetchImpl?: typeof fetch;
  readonly readFile?: (path: string) => string;
  readonly timeoutMs?: number;
}

export interface KvVersion {
  readonly version: number;
  readonly created_time: string;
}

export interface KvRead extends KvVersion {
  readonly data: Readonly<Record<string, string>>;
}

export interface KvMeta {
  readonly current_version: number;
  readonly created_time: string;
  readonly updated_time: string;
  /** The current version was deleted (soft) or destroyed: there is no value to read. */
  readonly current_deleted: boolean;
}

/** One path segment: lower-case letters, digits, `-` and `_`, starting with a letter or digit. */
const SEGMENT = '[a-z0-9][a-z0-9_-]{0,63}';
export const VAULT_PATH_RE = new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,7}$`);
/** `vault:<path>#<key>`, e.g. `vault:gateway/anthropic-api-key#value`. */
export const VAULT_REF_RE = new RegExp(
  `^vault:(${SEGMENT}(?:/${SEGMENT}){0,7})#([A-Za-z0-9_-]{1,64})$`,
);
/** The same shape anywhere in a string (an env value holding JSON with references in it). */
export const VAULT_REF_SCAN_RE = new RegExp(
  `vault:${SEGMENT}(?:/${SEGMENT}){0,7}#[A-Za-z0-9_-]{1,64}`,
  'g',
);

export function parseVaultRef(ref: string): { path: string; key: string } | null {
  const m = VAULT_REF_RE.exec(ref);
  return m ? { path: m[1] as string, key: m[2] as string } : null;
}

const MOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class VaultClient {
  private token: string | null = null;
  private readonly mount: string;
  private readonly base: string;

  constructor(private readonly o: VaultClientOptions) {
    this.mount = o.mount ?? 'aisdlc';
    if (!MOUNT_RE.test(this.mount))
      throw new ServiceConfigError('the Vault KV mount is not a mount name');
    let u: URL;
    try {
      u = new URL(o.addr);
    } catch {
      throw new ServiceConfigError('VAULT_ADDR is not a URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new ServiceConfigError('VAULT_ADDR must be an http(s) URL');
    }
    this.base = o.addr.replace(/\/+$/, '');
  }

  private get f(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  private readFile(p: string): string {
    try {
      return (this.o.readFile ?? ((x: string) => readFileSync(x, 'utf8')))(p);
    } catch {
      throw new VaultError('denied', `cannot read the Vault credential file ${p}`);
    }
  }

  private async login(): Promise<string> {
    const a = this.o.auth;
    if (a.kind === 'token') {
      const t = this.readFile(a.tokenFile).trim();
      if (t === '') throw new VaultError('denied', `the Vault token file ${a.tokenFile} is empty`);
      return t;
    }
    let cred: { role_id?: unknown; secret_id?: unknown };
    try {
      cred = JSON.parse(this.readFile(a.file)) as typeof cred;
    } catch (e) {
      if (e instanceof VaultError) throw e;
      throw new VaultError('invalid', `the AppRole file ${a.file} is not JSON`);
    }
    if (typeof cred.role_id !== 'string' || typeof cred.secret_id !== 'string') {
      throw new VaultError('invalid', `the AppRole file ${a.file} has no role_id and secret_id`);
    }
    const res = await this.raw('POST', '/v1/auth/approle/login', null, {
      role_id: cred.role_id,
      secret_id: cred.secret_id,
    });
    if (res.status !== 200) {
      throw new VaultError(
        res.status === 400 || res.status === 403 ? 'denied' : 'unavailable',
        `AppRole login: HTTP ${res.status}`,
      );
    }
    const tok = (res.json as { auth?: { client_token?: unknown } } | null)?.auth?.client_token;
    if (typeof tok !== 'string' || tok === '')
      throw new VaultError('invalid', 'AppRole login: no token');
    return tok;
  }

  private async raw(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          ...(token ? { 'x-vault-token': token } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch {
      throw new VaultError('unavailable', `${method} ${path}: Vault did not answer`);
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  }

  /** One call with the process's token; a 403 logs in again once (an expired token), then is `denied`. */
  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    for (const attempt of [0, 1]) {
      this.token ??= await this.login();
      const res = await this.raw(method, path, this.token, body);
      if (res.status === 403 && attempt === 0 && this.o.auth.kind === 'approle') {
        this.token = null;
        continue;
      }
      if (res.status === 403) throw new VaultError('denied', `${method} ${path}: HTTP 403`);
      if (res.status === 503)
        throw new VaultError('unavailable', `${method} ${path}: Vault is sealed`);
      if (res.status >= 500)
        throw new VaultError('unavailable', `${method} ${path}: HTTP ${res.status}`);
      return res;
    }
    throw new VaultError('denied', `${method} ${path}: HTTP 403`);
  }

  private check(path: string): void {
    if (!VAULT_PATH_RE.test(path)) throw new VaultError('invalid', `not a secret path: ${path}`);
  }

  /** The current version's data, or `null` when there is none (never written, deleted or destroyed). */
  async kvRead(path: string): Promise<KvRead | null> {
    this.check(path);
    const res = await this.call('GET', `/v1/${this.mount}/data/${path}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new VaultError('unavailable', `read ${path}: HTTP ${res.status}`);
    const d = (res.json as { data?: { data?: unknown; metadata?: unknown } } | null)?.data;
    const meta = d?.metadata as { version?: unknown; created_time?: unknown } | undefined;
    const data = d?.data;
    if (data === null || typeof data !== 'object' || typeof meta?.version !== 'number') {
      throw new VaultError('invalid', `read ${path}: the answer is not a KV v2 secret`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return {
      data: out,
      version: meta.version,
      created_time: typeof meta.created_time === 'string' ? meta.created_time : '',
    };
  }

  /** Writes a new version. `cas` (check-and-set): 0 means "only if it does not exist yet". */
  async kvWrite(
    path: string,
    data: Readonly<Record<string, string>>,
    o: { cas?: number } = {},
  ): Promise<KvVersion> {
    this.check(path);
    const res = await this.call('POST', `/v1/${this.mount}/data/${path}`, {
      ...(o.cas === undefined ? {} : { options: { cas: o.cas } }),
      data,
    });
    if (res.status === 400)
      throw new VaultError('invalid', `write ${path}: HTTP 400 (check-and-set?)`);
    if (res.status !== 200 && res.status !== 204) {
      throw new VaultError('unavailable', `write ${path}: HTTP ${res.status}`);
    }
    const m = (res.json as { data?: { version?: unknown; created_time?: unknown } } | null)?.data;
    if (typeof m?.version !== 'number')
      throw new VaultError('invalid', `write ${path}: no version`);
    return {
      version: m.version,
      created_time: typeof m.created_time === 'string' ? m.created_time : '',
    };
  }

  /** The metadata (never a value), or `null` when the path has none. */
  async kvMeta(path: string): Promise<KvMeta | null> {
    this.check(path);
    const res = await this.call('GET', `/v1/${this.mount}/metadata/${path}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new VaultError('unavailable', `meta ${path}: HTTP ${res.status}`);
    const d = (res.json as { data?: Record<string, unknown> } | null)?.data;
    const cur = d?.['current_version'];
    if (typeof cur !== 'number')
      throw new VaultError('invalid', `meta ${path}: no current_version`);
    const versions = (d?.['versions'] ?? {}) as Record<
      string,
      { deletion_time?: unknown; destroyed?: unknown }
    >;
    const v = versions[String(cur)];
    return {
      current_version: cur,
      created_time: typeof d?.['created_time'] === 'string' ? d['created_time'] : '',
      updated_time: typeof d?.['updated_time'] === 'string' ? d['updated_time'] : '',
      current_deleted:
        v === undefined ||
        v.destroyed === true ||
        (typeof v.deletion_time === 'string' && v.deletion_time !== ''),
    };
  }

  /** Deletes the path's metadata and every version (destroyed: nothing can be read or undeleted). Idempotent. */
  async kvDestroy(path: string): Promise<void> {
    this.check(path);
    const res = await this.call('DELETE', `/v1/${this.mount}/metadata/${path}`);
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new VaultError('unavailable', `destroy ${path}: HTTP ${res.status}`);
    }
  }

  /** The keys directly under `prefix` (folders end with `/`); `[]` when there are none. */
  async kvList(prefix: string): Promise<string[]> {
    if (prefix !== '') this.check(prefix.replace(/\/$/, ''));
    const res = await this.call('LIST', `/v1/${this.mount}/metadata/${prefix}`);
    if (res.status === 404) return [];
    if (res.status !== 200)
      throw new VaultError('unavailable', `list ${prefix}: HTTP ${res.status}`);
    const keys = (res.json as { data?: { keys?: unknown } } | null)?.data?.keys;
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
  }
}

/**
 * A Vault client from the environment, or `null` when `VAULT_ADDR` is unset:
 *   VAULT_ADDR           e.g. http://vault:8200
 *   VAULT_APPROLE_FILE   a JSON file {role_id, secret_id} (compose: /run/secrets/vault-approle-<service>), or
 *   VAULT_TOKEN_FILE     a file holding a token (one of the two)
 *   VAULT_KV_MOUNT       the KV v2 mount (default aisdlc)
 */
export function vaultClientFromEnv(
  env: Record<string, string | undefined>,
  o: Pick<VaultClientOptions, 'fetchImpl' | 'readFile'> = {},
): VaultClient | null {
  const addr = env['VAULT_ADDR'];
  if (addr === undefined || addr === '') return null;
  const approle = env['VAULT_APPROLE_FILE'];
  const token = env['VAULT_TOKEN_FILE'];
  const has = (v: string | undefined) => v !== undefined && v !== '';
  if (has(approle) === has(token)) {
    throw new ServiceConfigError(
      'VAULT_ADDR needs exactly one of VAULT_APPROLE_FILE and VAULT_TOKEN_FILE',
    );
  }
  const mount = env['VAULT_KV_MOUNT'];
  return new VaultClient({
    addr,
    auth: has(approle)
      ? { kind: 'approle', file: approle as string }
      : { kind: 'token', tokenFile: token as string },
    ...(mount ? { mount } : {}),
    ...o,
  });
}
