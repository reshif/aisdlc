import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// PLAN M19 in the compose stack: the audit service is hardened like every factory service, under its own profile, on
// its own networks (its own way to Postgres as its own role, the bff's way to it, its one link to core), with no route
// out and no route to the record services' network; only the bff holds a token for it, and it holds the narrow
// tokens it needs (the Notary's ledger and export purpose, kms-local's public keys, core's erasure scope).

const dir = join(import.meta.dirname, '..', '..', '..', 'platform', 'compose');
interface Service {
  secrets?: Array<string | { source: string }>;
  environment?: Record<string, string>;
  networks?: string[] | Record<string, unknown>;
  profiles?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  healthcheck?: { test?: string[] };
  user?: string;
}
const compose = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf8'), { merge: true }) as {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean } | null>;
};
const secretsOf = (s: Service): string[] =>
  (s.secrets ?? []).map((x) => (typeof x === 'string' ? x : x.source));
const netsOf = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});
const a = compose.services['audit'] as Service;
const members = (net: string) =>
  Object.entries(compose.services)
    .filter(([, s]) => netsOf(s).includes(net))
    .map(([k]) => k)
    .sort();
const holders = (secret: string) =>
  Object.entries(compose.services)
    .filter(([, s]) => secretsOf(s).includes(secret))
    .map(([k]) => k)
    .sort();
const json = (s: Service | undefined, k: string) => JSON.parse(s?.environment?.[k] ?? '{}');

describe('the audit service in the compose stack', () => {
  it('is hardened, health-checked and under its own profile', () => {
    expect(a.profiles).toEqual(['audit']);
    expect(a.read_only).toBe(true);
    expect(a.cap_drop).toEqual(['ALL']);
    expect(a.security_opt).toContain('no-new-privileges:true');
    expect(a.user).toMatch(/AISDLC_UID/);
    expect(a.healthcheck?.test).toContain('8480');
  });

  it('is on its own networks, internal, with no route out and none to the record services', () => {
    expect(netsOf(a).sort()).toEqual(
      [
        'audit-api',
        'audit-core',
        'data-audit',
        'kms-clients',
        'notary-api',
        'objectstore-api',
      ].sort(),
    );
    for (const x of ['data-audit', 'audit-api', 'audit-core'])
      expect(compose.networks[x]?.internal).toBe(true);
    expect(members('data-audit')).toEqual(['audit', 'postgres']);
    expect(members('audit-api')).toEqual(['audit', 'bff']);
    expect(members('audit-core')).toEqual(['audit', 'core']);
    expect(netsOf(a)).not.toContain('data-record');
    expect(netsOf(a)).not.toContain('app');
    for (const net of netsOf(a)) expect(compose.networks[net]?.internal, net).toBe(true);
  });

  it('connects as its own role and holds exactly the narrow tokens it needs, each scoped at the callee', () => {
    expect(a.environment?.['AUDIT_DATABASE_URL']).toBe('file:/run/secrets/db-url-audit');
    expect(json(a, 'AUDIT_CALLERS')).toEqual({
      bff: { token_ref: 'file:/run/secrets/tok-bff-audit', scopes: ['read', 'export', 'govern'] },
    });
    expect(holders('tok-bff-audit')).toEqual(['audit', 'bff']);
    expect(holders('tok-audit-core')).toEqual(['audit', 'core']);
    expect(holders('tok-audit-notary')).toEqual(['audit', 'notary']);
    expect(holders('tok-audit-kms')).toEqual(['audit', 'kms-local']);
    expect(json(compose.services['core'], 'CORE_CALLERS')['audit']).toEqual({
      token_ref: 'file:/run/secrets/tok-audit-core',
      scopes: ['erasure'],
    });
    expect(json(compose.services['notary'], 'NOTARY_CALLERS')['audit']).toEqual({
      token_ref: 'file:/run/secrets/tok-audit-notary',
      scopes: ['ledger', 'read', 'audit_export'],
    });
    // kms-local: public-key reads only, no key it may use
    expect(json(compose.services['kms-local'], 'KMS_CALLERS')['audit']).toEqual({
      token_ref: 'file:/run/secrets/tok-audit-kms',
      keys: [],
    });
    expect(compose.services['bff']?.environment?.['BFF_AUDIT_URL']).toBe('http://audit:8480');
    expect(readFileSync(join(dir, 'db-init.sh'), 'utf8')).toContain('GRANT aisdlc_audit TO audit;');
    expect(readFileSync(join(dir, 'init-secrets'), 'utf8')).toContain('secrets/db-url-audit');
  });
});
