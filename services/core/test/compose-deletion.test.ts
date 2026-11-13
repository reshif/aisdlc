import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { coreConfigFromEnv } from '../src/config.js';

// Delete means delete and identity's write API in the compose stack (portal v2, docs/specs/deletion.md): core's delete
// routes run on their own login (a member of `aisdlc_purge`, which core's normal login is not) and purge packs with an
// object-store user that may lift a legal hold and nothing else; the bff holds `delete` at core and `admin` (alone) at
// identity. Each new secret is mounted where it is used and nowhere else.

const dir = join(import.meta.dirname, '..', '..', '..', 'platform', 'compose');
interface Service {
  image?: string;
  secrets?: Array<string | { source: string }>;
  environment?: Record<string, string>;
  networks?: string[] | Record<string, unknown>;
  depends_on?: Record<string, { condition?: string }>;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  user?: string;
  ports?: unknown[];
  restart?: string;
  volumes?: string[];
}
const compose = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf8'), { merge: true }) as {
  services: Record<string, Service>;
  secrets: Record<string, { file: string }>;
};
const svc = (n: string) => compose.services[n] as Service;
const env = (n: string) => svc(n).environment ?? {};
const netsOf = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});
const secretsOf = (s: Service): string[] =>
  (s.secrets ?? []).map((x) => (typeof x === 'string' ? x : x.source));
const holders = (secret: string) =>
  Object.entries(compose.services)
    .filter(([, s]) => secretsOf(s).includes(secret))
    .map(([k]) => k)
    .sort();
const callers = (n: string, key: string) =>
  JSON.parse(env(n)[key] ?? '{}') as Record<string, { token_ref: string; scopes: string[] }>;

describe('deletion in compose: the purge login and the purge credential', () => {
  it("core runs the delete routes on the purge login and purges with the store's purge user", () => {
    expect(env('core')['CORE_PURGE_DATABASE_URL']).toBe('file:/run/secrets/db-url-purge');
    expect(env('core')['CORE_DATABASE_URL']).toBe('file:/run/secrets/db-url-aisdlc');
    expect(env('core')['CORE_PURGE_OBJECT_STORE_URL']).toBe('http://object-store:9000');
    expect(env('core')['CORE_PURGE_OBJECT_STORE_ACCESS_KEY_REF']).toBe(
      'file:/run/secrets/object-store-purge-access-key',
    );
    expect(env('core')['CORE_PURGE_OBJECT_STORE_SECRET_KEY_REF']).toBe(
      'file:/run/secrets/object-store-purge-secret-key',
    );
    expect(netsOf(svc('core'))).toContain('objectstore-api');
    expect(svc('core').depends_on?.['object-store-init']?.condition).toBe(
      'service_completed_successfully',
    );
  });

  it('each new secret is mounted only where it is used', () => {
    expect(holders('db-url-purge')).toEqual(['core']);
    expect(holders('pg-pass-purge')).toEqual(['db-init']);
    expect(holders('object-store-purge-access-key')).toEqual(['core', 'object-store-init']);
    expect(holders('object-store-purge-secret-key')).toEqual(['core', 'object-store-init']);
    expect(holders('tok-bff-identity')).toEqual(['bff', 'identity']);
    for (const s of [
      'db-url-purge',
      'pg-pass-purge',
      'object-store-purge-access-key',
      'object-store-purge-secret-key',
      'tok-bff-identity',
    ])
      expect(compose.secrets[s]?.file).toBe(`./secrets/${s}`);
  });

  it('db-init makes the purge login a member of aisdlc_purge, and core’s normal login is not one', () => {
    const sh = readFileSync(join(dir, 'db-init.sh'), 'utf8');
    expect(sh).toMatch(/CREATE ROLE core_purge LOGIN/);
    expect(sh).toMatch(/GRANT aisdlc_purge TO core_purge;/);
    expect(sh).not.toMatch(/GRANT aisdlc_purge TO aisdlc\b/);
    // record/0005 (run as aisdlc) grants aisdlc_app to the purge role: PostgreSQL 16 needs ADMIN on aisdlc_app for it
    expect(sh).toMatch(/GRANT aisdlc_app TO aisdlc WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;/);
    expect(sh).toMatch(/GRANT CONNECT ON DATABASE aisdlc TO core_purge;/);
    const init = readFileSync(join(dir, 'init-secrets'), 'utf8');
    expect(init).toMatch(/postgres core_purge .* >secrets\/db-url-purge/);
    expect(init).toMatch(/\bbff-identity\b/);
    expect(init).toMatch(/put object-store-purge-secret-key/);
  });

  it('object-store-init is a hardened one-shot on the store’s network only, and its policy lifts holds, nothing more', () => {
    const j = svc('object-store-init');
    expect(j.image).toBe(svc('object-store').image);
    expect(j.restart).toBe('no');
    expect(j.read_only).toBe(true);
    expect(j.cap_drop).toEqual(['ALL']);
    expect(j.security_opt).toContain('no-new-privileges:true');
    expect(j.user).toMatch(/AISDLC_UID/);
    expect(j.ports).toBeUndefined();
    expect(netsOf(j)).toEqual(['objectstore-api']);
    const sh = readFileSync(join(dir, 'object-store-init.sh'), 'utf8');
    const policy = JSON.parse(/<<'JSON'\n([\s\S]*?)\nJSON/.exec(sh)?.[1] ?? '{}') as {
      Statement: Array<{ Action: string[]; Resource: string[] }>;
    };
    const actions = policy.Statement.flatMap((s) => s.Action).sort();
    expect(actions).toEqual([
      's3:DeleteObject',
      's3:DeleteObjectVersion',
      's3:ListBucketVersions',
      's3:PutObjectLegalHold',
    ]);
    for (const r of policy.Statement.flatMap((s) => s.Resource))
      expect(r).toMatch(/^arn:aws:s3:::(evidence-packs|audit-exports)(\/\*)?$/);
  });
});

describe('the portal’s admin writes in compose', () => {
  it('the bff holds delete at core and admin alone at identity', () => {
    expect(callers('core', 'CORE_CALLERS')['bff']?.scopes).toContain('delete');
    const delHolders = Object.entries(callers('core', 'CORE_CALLERS'))
      .filter(([, c]) => c.scopes.includes('delete'))
      .map(([k]) => k);
    expect(delHolders).toEqual(['bff']);
    expect(callers('identity', 'IDENTITY_CALLERS')['bff']).toEqual({
      token_ref: 'file:/run/secrets/tok-bff-identity',
      scopes: ['admin'],
    });
    expect(env('bff')['BFF_IDENTITY_URL']).toBe('http://identity:8330');
    expect(env('bff')['BFF_IDENTITY_TOKEN_REF']).toBe('file:/run/secrets/tok-bff-identity');
    // the bff reaches identity on a network the two already shared (no new path)
    const shared = netsOf(svc('bff')).filter((n) => netsOf(svc('identity')).includes(n));
    expect(shared).toContain('data-record');
  });

  it("core's configuration takes the compose callers as they are, the bff's delete scope included", () => {
    const tokens: Record<string, string> = {};
    const list = Object.fromEntries(
      Object.entries(callers('core', 'CORE_CALLERS')).map(([name, c], i) => {
        tokens[`T${i}`] = String(i).padEnd(32, 'x');
        return [name, { ...c, token_ref: `env:T${i}` }];
      }),
    );
    const cfg = coreConfigFromEnv({
      ...tokens,
      CORE_DATABASE_URL: 'postgres://postgres:5432/aisdlc',
      CORE_CALLERS: JSON.stringify(list),
    });
    expect(cfg.callers['bff']).toContain('delete');
  });
});
