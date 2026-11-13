import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// PLAN M18 in the compose stack: the notifier is hardened like every factory service, under its own profile, on its
// own networks (its own way to Postgres as its own role, the bff's way to it, its own way out), with no route to core,
// identity's API, the Notary or the record services' network; only the bff holds a token for it.

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
const n = compose.services['notifier'] as Service;
const members = (net: string) =>
  Object.entries(compose.services)
    .filter(([, s]) => netsOf(s).includes(net))
    .map(([k]) => k)
    .sort();

describe('the notifier in the compose stack', () => {
  it('is hardened, health-checked and under its own profile', () => {
    expect(n.profiles).toEqual(['notifier']);
    expect(n.read_only).toBe(true);
    expect(n.cap_drop).toEqual(['ALL']);
    expect(n.security_opt).toContain('no-new-privileges:true');
    expect(n.user).toMatch(/AISDLC_UID/);
    expect(n.healthcheck?.test).toContain('8460');
  });

  it('is on its own networks only, and only the bff can reach its API', () => {
    // M19: plus its own network to the collector (it and the collector only)
    expect(netsOf(n).sort()).toEqual([
      'data-notifier',
      'notifier-api',
      'notifier-egress',
      'telemetry-notifier',
      // portal v2: its own link to Vault (it and Vault only; its policy reads its own folder)
      'vault-notifier',
    ]);
    for (const x of ['data-notifier', 'notifier-api'])
      expect(compose.networks[x]?.internal).toBe(true);
    expect(members('data-notifier')).toEqual(['notifier', 'postgres']);
    expect(members('notifier-api')).toEqual(['bff', 'notifier']);
    expect(members('notifier-egress')).toEqual(['notifier']);
    expect(members('vault-notifier')).toEqual(['notifier', 'vault']);
    expect(netsOf(n)).not.toContain('data-record');
  });

  it('connects as its own role, takes only the bff’s token and holds no channel credential by default', () => {
    // portal v2: its Vault AppRole reads its own folder, where a channel's secret is pasted in the portal (empty until
    // then); no channel credential is mounted
    expect(secretsOf(n).sort()).toEqual([
      'db-url-notifier',
      'tok-bff-notifier',
      'vault-approle-notifier',
    ]);
    expect(
      JSON.parse(
        n.environment?.['NOTIFIER_SECRET_REFS']?.replace(/^\$\{[A-Z_]+:-(.*)\}$/, '$1') ?? '[]',
      ),
    ).toEqual(['vault:notifier/slack-webhook-url#value', 'vault:notifier/smtp-password#value']);
    expect(n.environment?.['NOTIFIER_DATABASE_URL']).toBe('file:/run/secrets/db-url-notifier');
    expect(JSON.parse(n.environment?.['NOTIFIER_CALLERS'] ?? '{}')).toEqual({
      bff: { token_ref: 'file:/run/secrets/tok-bff-notifier', scopes: ['people'] },
    });
    const holders = Object.entries(compose.services)
      .filter(([, s]) => secretsOf(s).includes('tok-bff-notifier'))
      .map(([k]) => k)
      .sort();
    expect(holders).toEqual(['bff', 'notifier']);
    expect(compose.services['bff']?.environment?.['BFF_NOTIFIER_URL']).toBe('http://notifier:8460');
    const init = readFileSync(join(dir, 'db-init.sh'), 'utf8');
    expect(init).toContain('GRANT aisdlc_notifier TO notifier;');
    expect(readFileSync(join(dir, 'init-secrets'), 'utf8')).toContain('secrets/db-url-notifier');
  });
});
