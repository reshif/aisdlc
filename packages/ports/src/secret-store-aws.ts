import { randomUUID } from 'node:crypto';
import { err, ok } from '@aisdlc/kernel';
import { resolveSecretRef } from '@aisdlc/service-kit';
import { sha256Of, signV4, type SigV4Credentials } from './s3-sigv4.js';
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

// `SecretStorePort` over AWS Secrets Manager (the production target behind the same port; portal v2 decision of
// 2026-11-13). A STUB: it implements the interface over the JSON 1.1 API with the SigV4 signer the object store uses,
// and is tested against a fake HTTP server only. Nothing wires it by default.
//
// Mapping: a reference `<path>#<key>` is the secret `<prefix><path>` whose SecretString is the JSON object {key: value}.
// Secrets Manager has no integer versions: `version` is the number of versions the service lists for the secret
// (DescribeSecret's VersionIdsToStages), which grows with each put until AWS ages old versions out.

export interface AwsSecretsManagerConfig {
  /** e.g. eu-west-1 */
  readonly region: string;
  /** Default `https://secretsmanager.<region>.amazonaws.com`. */
  readonly endpoint?: string;
  /** `file:` or `env:` references (never values). */
  readonly accessKeyRef: string;
  readonly secretKeyRef: string;
  readonly sessionTokenRef?: string;
  /** Prepended to every path (e.g. `aisdlc/`). */
  readonly prefix?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown> | null;
  readonly type: string | null;
}

export class AwsSecretsManagerStore implements SecretStorePort {
  private readonly endpoint: URL;
  private readonly creds: SigV4Credentials;
  private readonly sessionToken: string | null;
  private readonly prefix: string;

  constructor(private readonly cfg: AwsSecretsManagerConfig) {
    this.endpoint = new URL(cfg.endpoint ?? `https://secretsmanager.${cfg.region}.amazonaws.com`);
    this.creds = {
      accessKey: resolveSecretRef(cfg.accessKeyRef),
      secretKey: resolveSecretRef(cfg.secretKeyRef),
    };
    this.sessionToken = cfg.sessionTokenRef ? resolveSecretRef(cfg.sessionTokenRef) : null;
    this.prefix = cfg.prefix ?? '';
  }

  /** One signed call of the JSON 1.1 API. Never throws; a value is never put in an error. */
  private async call(
    target: string,
    body: Record<string, unknown>,
  ): Promise<SecretStoreResult<Answer>> {
    const text = JSON.stringify(body);
    const url = new URL('/', this.endpoint);
    const headers = signV4(this.creds, {
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `secretsmanager.${target}`,
        ...(this.sessionToken ? { 'x-amz-security-token': this.sessionToken } : {}),
      },
      payloadSha256: sha256Of(text),
      region: this.cfg.region,
      now: (this.cfg.now ?? (() => new Date()))(),
      service: 'secretsmanager',
    });
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(url, {
        method: 'POST',
        headers,
        body: text,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch {
      return err(secretStoreError('unavailable', `${target}: Secrets Manager did not answer`));
    }
    const raw = await res.text().catch(() => '');
    let json: Record<string, unknown> | null;
    try {
      json = raw === '' ? null : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      json = null;
    }
    const t = json?.['__type'];
    const type = typeof t === 'string' ? (t.split('#').pop() ?? t) : null;
    if (res.status >= 500)
      return err(secretStoreError('unavailable', `${target}: HTTP ${res.status}`));
    if (
      res.status === 403 ||
      type === 'AccessDeniedException' ||
      type === 'UnrecognizedClientException'
    ) {
      return err(secretStoreError('denied', `${target}: ${type ?? `HTTP ${res.status}`}`));
    }
    return ok({ status: res.status, json, type });
  }

  private id(path: string): string {
    return `${this.prefix}${path}`;
  }

  private async describe(path: string): Promise<SecretStoreResult<SecretMeta | null>> {
    const r = await this.call('DescribeSecret', { SecretId: this.id(path) });
    if (!r.ok) return r;
    if (r.value.type === 'ResourceNotFoundException') return ok(null);
    if (r.value.status !== 200 || !r.value.json) {
      return err(
        secretStoreError('unavailable', `DescribeSecret: ${r.value.type ?? r.value.status}`),
      );
    }
    const j = r.value.json;
    if (j['DeletedDate'] !== undefined) return ok(null);
    const stages = (j['VersionIdsToStages'] ?? {}) as Record<string, unknown>;
    const n = Object.keys(stages).length;
    const changed = j['LastChangedDate'];
    const at =
      typeof changed === 'number'
        ? new Date(changed * 1000).toISOString()
        : new Date(0).toISOString();
    return ok(n === 0 ? null : { ref: path, set: true, version: n, updated_at: at });
  }

  async put(ref: string, value: string): Promise<SecretStoreResult<SecretVersion>> {
    const bad = checkSecretPut(ref, value);
    if (bad) return err(bad);
    const p = parseSecretStoreRef(ref) as { path: string; key: string };
    const SecretString = JSON.stringify({ [p.key]: value });
    let r = await this.call('PutSecretValue', {
      SecretId: this.id(p.path),
      SecretString,
      ClientRequestToken: randomUUID(),
    });
    if (!r.ok) return r;
    if (r.value.type === 'ResourceNotFoundException') {
      r = await this.call('CreateSecret', {
        Name: this.id(p.path),
        SecretString,
        ClientRequestToken: randomUUID(),
      });
      if (!r.ok) return r;
    }
    if (r.value.status !== 200) {
      return err(
        secretStoreError('unavailable', `put ${p.path}: ${r.value.type ?? r.value.status}`),
      );
    }
    const d = await this.describe(p.path);
    if (!d.ok) return d;
    if (!d.value)
      return err(secretStoreError('unavailable', `put ${p.path}: not listed after the write`));
    return ok({ version: d.value.version ?? 1, updated_at: d.value.updated_at ?? '' });
  }

  async get(ref: string): Promise<SecretStoreResult<string>> {
    const p = parseSecretStoreRef(ref);
    if (!p) return err(secretStoreError('invalid_ref', `not <path>#<key>: ${ref}`));
    const r = await this.call('GetSecretValue', { SecretId: this.id(p.path) });
    if (!r.ok) return r;
    if (
      r.value.type === 'ResourceNotFoundException' ||
      r.value.type === 'InvalidRequestException'
    ) {
      return err(secretStoreError('not_found', `${ref}: not set`));
    }
    const s = r.value.json?.['SecretString'];
    if (r.value.status !== 200 || typeof s !== 'string') {
      return err(
        secretStoreError('unavailable', `get ${p.path}: ${r.value.type ?? r.value.status}`),
      );
    }
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      return err(secretStoreError('not_found', `${ref}: the secret is not a JSON object`));
    }
    const v = (obj as Record<string, unknown> | null)?.[p.key];
    return typeof v === 'string' ? ok(v) : err(secretStoreError('not_found', `${ref}: not set`));
  }

  async delete(ref: string): Promise<SecretStoreResult<void>> {
    const p = parseSecretStoreRef(ref);
    if (!p) return err(secretStoreError('invalid_ref', `not <path>#<key>: ${ref}`));
    const r = await this.call('DeleteSecret', {
      SecretId: this.id(p.path),
      ForceDeleteWithoutRecovery: true,
    });
    if (!r.ok) return r;
    if (r.value.status === 200 || r.value.type === 'ResourceNotFoundException')
      return ok(undefined);
    return err(
      secretStoreError('unavailable', `delete ${p.path}: ${r.value.type ?? r.value.status}`),
    );
  }

  async meta(ref: string): Promise<SecretStoreResult<SecretMeta>> {
    const p = parseSecretStoreRef(ref);
    if (!p) return err(secretStoreError('invalid_ref', `not <path>#<key>: ${ref}`));
    const d = await this.describe(p.path);
    if (!d.ok) return d as { ok: false; error: SecretStoreError };
    return ok(
      d.value
        ? { ref, set: true, version: d.value.version, updated_at: d.value.updated_at }
        : { ref, set: false, version: null, updated_at: null },
    );
  }
}
