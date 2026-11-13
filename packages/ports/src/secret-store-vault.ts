import { err, ok } from '@aisdlc/kernel';
import { VaultClient, VaultError, type VaultClientOptions } from '@aisdlc/service-kit';
import {
  checkSecretPut,
  parseSecretStoreRef,
  secretStoreError,
  type SecretMeta,
  type SecretStoreError,
  type SecretStorePort,
  type SecretStoreResult,
  type SecretVersion,
} from './secret-store.js';

// `SecretStorePort` over HashiCorp Vault's KV version 2 engine (local prod: the `vault` service of the compose stack).
// The HTTP client is service-kit's `VaultClient` (the one Vault client; `vault:` references are read through it too).
// The process logs in with the token or AppRole it is given; what it may do is Vault's policy for that login, e.g.
// core's: create and update under `aisdlc/data/*`, metadata reads and deletes, and NO read of a value.

const fromVault = (e: unknown, what: string): SecretStoreError => {
  if (e instanceof VaultError) {
    if (e.code === 'denied') return secretStoreError('denied', `${what}: ${e.message}`);
    if (e.code === 'invalid') return secretStoreError('invalid_ref', `${what}: ${e.message}`);
    return secretStoreError('unavailable', `${what}: ${e.message}`);
  }
  return secretStoreError('unavailable', `${what}: unexpected error`);
};

export class VaultSecretStore implements SecretStorePort {
  readonly client: VaultClient;

  constructor(o: VaultClientOptions | VaultClient) {
    this.client = o instanceof VaultClient ? o : new VaultClient(o);
  }

  async put(ref: string, value: string): Promise<SecretStoreResult<SecretVersion>> {
    const bad = checkSecretPut(ref, value);
    if (bad) return err(bad);
    const p = parseSecretStoreRef(ref) as { path: string; key: string };
    try {
      const w = await this.client.kvWrite(p.path, { [p.key]: value });
      return ok({ version: w.version, updated_at: w.created_time });
    } catch (e) {
      return err(fromVault(e, `put ${p.path}`));
    }
  }

  async get(ref: string): Promise<SecretStoreResult<string>> {
    const p = parseSecretStoreRef(ref);
    if (!p) return err(secretStoreError('invalid_ref', `not <path>#<key>: ${ref}`));
    try {
      const r = await this.client.kvRead(p.path);
      const v = r?.data[p.key];
      return v === undefined ? err(secretStoreError('not_found', `${ref}: not set`)) : ok(v);
    } catch (e) {
      return err(fromVault(e, `get ${p.path}`));
    }
  }

  async delete(ref: string): Promise<SecretStoreResult<void>> {
    const p = parseSecretStoreRef(ref);
    if (!p) return err(secretStoreError('invalid_ref', `not <path>#<key>: ${ref}`));
    try {
      await this.client.kvDestroy(p.path);
      return ok(undefined);
    } catch (e) {
      return err(fromVault(e, `delete ${p.path}`));
    }
  }

  /**
   * From the path's metadata only (no read of the data): a field of a multi-field secret is reported by its path. The
   * factory stores one field per path, so the two agree.
   */
  async meta(ref: string): Promise<SecretStoreResult<SecretMeta>> {
    const p = parseSecretStoreRef(ref);
    if (!p) return err(secretStoreError('invalid_ref', `not <path>#<key>: ${ref}`));
    try {
      const m = await this.client.kvMeta(p.path);
      const set = m !== null && !m.current_deleted;
      return ok({
        ref,
        set,
        version: set ? m.current_version : null,
        updated_at: set ? m.updated_time : null,
      });
    } catch (e) {
      return err(fromVault(e, `meta ${p.path}`));
    }
  }
}
