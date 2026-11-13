/**
 * The process's `vault:` reference cache (secret-refs.ts fills it, `resolveSecretRef` reads it). A ref maps to its
 * value and version, or to `null` when Vault holds no value for it. In memory only.
 */
export const vaultCache = new Map<string, { value: string; version: number } | null>();
