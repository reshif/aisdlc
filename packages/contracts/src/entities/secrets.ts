import { z } from 'zod';
import { IsoDateTime, PrincipalId } from './ids.js';

// Secrets entered in the portal (portal v2 intent, 2026-11-13: "write-only portal fields into HashiCorp Vault"; screen
// map N15, gap G1). A person pastes a value once; it travels browser -> bff -> core -> the secret store (Vault in local
// prod, AWS Secrets Manager later, behind `SecretStorePort`) and is never shown, logged, recorded or hashed after that.
// The record keeps only {name, version, who, when} (`secret.stored`), with a ledger entry over exactly that.
//
// The names are an allow-list: each is owned by the ONE service that reads it (its Vault policy reads only its own
// folder), and configuration names it by reference: `vault:<owner>/<name>#value` (`secretVaultRef`). A name that is
// not listed here cannot be written.

/** The service that reads a secret (its Vault folder and policy). */
export const SecretOwner = z.enum([
  'gateway',
  'codehost',
  'push-broker',
  'gate-check',
  'gate-relay',
  'notifier',
]);
export type SecretOwner = z.infer<typeof SecretOwner>;

/** What a value must look like (checked by core before it is stored; a refusal never echoes the value). */
export const SecretFormat = z.enum(['token', 'pem_private_key', 'url']);
export type SecretFormat = z.infer<typeof SecretFormat>;

export interface SecretDef {
  readonly owner: SecretOwner;
  /** Plain words for the portal. */
  readonly label: string;
  readonly format: SecretFormat;
}

export const SECRET_DEFS = {
  'anthropic-api-key': { owner: 'gateway', label: 'Anthropic API key', format: 'token' },
  'openai-api-key': { owner: 'gateway', label: 'OpenAI-compatible API key', format: 'token' },
  'deepseek-api-key': { owner: 'gateway', label: 'DeepSeek API key', format: 'token' },
  'github-app-key': {
    owner: 'codehost',
    label: 'Factory GitHub App private key',
    format: 'pem_private_key',
  },
  'tracker-app-key': {
    owner: 'codehost',
    label: 'Issues GitHub App private key',
    format: 'pem_private_key',
  },
  'push-broker-app-key': {
    owner: 'push-broker',
    label: 'Push GitHub App private key',
    format: 'pem_private_key',
  },
  'gate-check-app-key': {
    owner: 'gate-check',
    label: 'Check GitHub App private key',
    format: 'pem_private_key',
  },
  'gate-relay-app-key': {
    owner: 'gate-relay',
    label: 'Release GitHub App private key',
    format: 'pem_private_key',
  },
  'slack-webhook-url': { owner: 'notifier', label: 'Slack webhook URL', format: 'url' },
  'smtp-password': { owner: 'notifier', label: 'SMTP password', format: 'token' },
} as const satisfies Record<string, SecretDef>;

export const SecretName = z.enum(Object.keys(SECRET_DEFS) as [keyof typeof SECRET_DEFS]);
export type SecretName = z.infer<typeof SecretName>;
export const SECRET_NAMES: readonly SecretName[] = SecretName.options;

export const secretDef = (name: SecretName): SecretDef => SECRET_DEFS[name];
/** The secret store path: `<owner>/<name>` (one secret per path, its value under the field `value`). */
export const secretPath = (name: SecretName): string => `${SECRET_DEFS[name].owner}/${name}`;
/** The reference configuration names it by. */
export const secretVaultRef = (name: SecretName): string => `vault:${secretPath(name)}#value`;

/** The largest value accepted (a PEM key is about 1.7 KiB). */
export const SECRET_VALUE_MAX = 16_384;

export const SECRET_EVENT = {
  stored: 'secret.stored',
  destroyed: 'secret.destroyed',
} as const;
/** The ledger entry types (one per record event, over exactly its body). */
export const SECRET_ENTRY = {
  stored: 'secret.stored',
  destroyed: 'secret.destroyed',
} as const;
export const SECRET_STREAM_PREFIX = 'secret:';
export const secretStream = (name: SecretName): string => `${SECRET_STREAM_PREFIX}${name}`;

/** `secret.stored`: who stored which version of which secret, when. NEVER the value, a hash or a length of it. */
export const SecretStoredPayload = z.strictObject({
  name: SecretName,
  /** The store's version number after the write. */
  version: z.number().int().min(1),
  by: PrincipalId,
  at: IsoDateTime,
});
export type SecretStoredPayload = z.infer<typeof SecretStoredPayload>;

/** `secret.destroyed`: every version removed from the store. */
export const SecretDestroyedPayload = z.strictObject({
  name: SecretName,
  by: PrincipalId,
  at: IsoDateTime,
});
export type SecretDestroyedPayload = z.infer<typeof SecretDestroyedPayload>;

/** What `GET /v1/secrets` lists: names and metadata only. */
export const SecretView = z.strictObject({
  name: SecretName,
  owner: SecretOwner,
  label: z.string(),
  format: SecretFormat,
  /** The reference configuration uses. */
  ref: z.string(),
  /** The store holds a current value. */
  set: z.boolean(),
  version: z.number().int().min(1).nullable(),
  updated_at: IsoDateTime.nullable(),
  /** From the record: who stored the current version (null when it was put there outside the portal). */
  updated_by: PrincipalId.nullable(),
});
export type SecretView = z.infer<typeof SecretView>;

export const SecretList = z.strictObject({
  /** `false`: the store did not answer; `set` is then unknown for every row (shown as unknown, never as set). */
  store_reachable: z.boolean(),
  secrets: z.array(SecretView),
});
export type SecretList = z.infer<typeof SecretList>;

/** The browser's body (bff `PUT /api/secrets/:name`): the value, once. */
export const SecretPutRequest = z.strictObject({
  value: z.string().min(1).max(SECRET_VALUE_MAX),
});
/** Core's body (`PUT /v1/secrets/:name`): the value and the person the bff acts for. */
export const SecretPutBody = z.strictObject({
  value: z.string().min(1).max(SECRET_VALUE_MAX),
  on_behalf_of: PrincipalId,
});
export const SecretDeleteBody = z.strictObject({ on_behalf_of: PrincipalId });

/** What a write answers: metadata only (never the value). */
export const SecretWriteResult = z.strictObject({
  name: SecretName,
  version: z.number().int().min(1).nullable(),
  updated_at: IsoDateTime,
});
export type SecretWriteResult = z.infer<typeof SecretWriteResult>;
