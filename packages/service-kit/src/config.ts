import type { z } from 'zod';
import { ServiceConfigError, resolveSecretRef, type SecretRefDeps } from './auth.js';

export type Env = Record<string, string | undefined>;

/** A required, non-empty variable. Missing or blank is a configuration error (fail fast). */
export function requiredEnv(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') throw new ServiceConfigError(`${name} is required`);
  return v;
}

/**
 * `<PREFIX>_HOST` (default 127.0.0.1) and `<PREFIX>_PORT` (default `defaultPort`, 0 = any free
 * port). A port that is not an integer in 0..65535 is a configuration error.
 */
export function listenConfig(
  env: Env,
  prefix: string,
  defaultPort: number,
): { host: string; port: number } {
  const raw = env[`${prefix}_PORT`];
  const port = raw === undefined || raw === '' ? defaultPort : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ServiceConfigError(`${prefix}_PORT must be an integer from 0 to 65535, got ${raw}`);
  }
  const host = env[`${prefix}_HOST`];
  return { host: host === undefined || host === '' ? '127.0.0.1' : host, port };
}

/** A required variable holding JSON that matches `schema`. Secrets in it are references only. */
export function jsonEnv<S extends z.ZodType>(env: Env, name: string, schema: S): z.infer<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(requiredEnv(env, name));
  } catch (cause) {
    if (cause instanceof ServiceConfigError) throw cause;
    throw new ServiceConfigError(`${name} is not valid JSON`, { cause });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ServiceConfigError(`${name}: ${parsed.error.message}`);
  return parsed.data;
}

const PG_URL = /^postgres(?:ql)?:\/\//;
const PG_URL_WITH_PASSWORD = /^postgres(?:ql)?:\/\/[^/?#@]*:[^/?#@]*@/;

/**
 * A database URL from the variable `name`. The value is a secret reference (`env:NAME` or
 * `file:PATH`), or a literal `postgres://` URL that carries no password (peer or socket
 * authentication, local development). A literal URL with a password is refused: secrets are only
 * ever references.
 */
export function databaseUrl(env: Env, name: string, deps: SecretRefDeps = {}): string {
  const v = requiredEnv(env, name);
  if (v.startsWith('env:') || v.startsWith('file:')) return resolveSecretRef(v, { env, ...deps });
  if (!PG_URL.test(v)) {
    throw new ServiceConfigError(`${name} must be env:NAME, file:PATH or a postgres:// URL`);
  }
  if (PG_URL_WITH_PASSWORD.test(v)) {
    throw new ServiceConfigError(
      `${name} contains a password; give it as env:NAME or file:PATH instead`,
    );
  }
  return v;
}

/** A required http(s) base URL. */
export function httpUrlEnv(env: Env, name: string): string {
  const v = requiredEnv(env, name);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ServiceConfigError(`${name} is not a URL: ${v}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ServiceConfigError(`${name} must be an http(s) URL, got ${v}`);
  }
  return v;
}
