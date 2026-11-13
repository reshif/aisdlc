import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// PLAN M15.3 in the compose stack: gate-relay's own App key is mounted into gate-relay and nothing else (the fake GitHub
// gets its PUBLIC half only), neither the codehost's nor gate-check's App key is in gate-relay, it is hardened like
// every factory service, and its networks are its own: no route to core, the Notary, identity or the record services'.

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
}
const compose = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf8'), { merge: true }) as {
  services: Record<string, Service>;
  secrets: Record<string, { file: string }>;
  networks: Record<string, { internal?: boolean } | null>;
};
const secretsOf = (s: Service): string[] =>
  (s.secrets ?? []).map((x) => (typeof x === 'string' ? x : x.source));
const gr = compose.services['gate-relay'] as Service;
const netsOf = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});

describe('gate-relay in the compose stack', () => {
  it('its App key is mounted into gate-relay only; no other App key is in gate-relay', () => {
    expect(compose.secrets['gate-relay-app.pem']).toEqual({ file: './secrets/gate-relay-app.pem' });
    for (const [name, svc] of Object.entries(compose.services)) {
      if (name === 'gate-relay') continue;
      expect(secretsOf(svc), name).not.toContain('gate-relay-app.pem');
    }
    expect(secretsOf(gr)).toContain('gate-relay-app.pem');
    expect(secretsOf(gr)).not.toContain('github-app.pem');
    expect(secretsOf(gr)).not.toContain('gate-check-app.pem');
    // the mounted file by default; portal v2: the owner may point it at the Vault field (gate-relay's own folder)
    expect(gr.environment?.['GATE_RELAY_APP_KEY_REF']).toBe(
      '${AISDLC_GATE_RELAY_KEY_REF:-file:/run/secrets/gate-relay-app.pem}',
    );
    expect(readFileSync(join(dir, 'init-secrets'), 'utf8')).toContain('secrets/gate-relay-app.pem');
    expect(secretsOf(compose.services['fake-github'] as Service)).toContain(
      'gate-relay-app.pub.pem',
    );
  });

  it('is hardened, health-checked, and on its own networks: no route to core, the Notary or identity', () => {
    expect(gr.profiles).toEqual(['gate-relay']);
    expect(gr.read_only).toBe(true);
    expect(gr.cap_drop).toEqual(['ALL']);
    expect(gr.security_opt).toContain('no-new-privileges:true');
    expect(gr.healthcheck?.test).toContain('8470');
    expect(netsOf(gr).sort()).toEqual(
      [
        'data-gaterelay',
        'gaterelay-egress',
        'gaterelay-github',
        'kms-clients',
        'objectstore-api',
        // M19: its own network to the collector (it and the collector only)
        'telemetry-gate-relay',
        // portal v2: its own link to Vault (it and Vault only; its policy reads its own folder)
        'vault-gaterelay',
      ].sort(),
    );
    for (const n of ['data-gaterelay', 'gaterelay-github'])
      expect(compose.networks[n]?.internal).toBe(true);
    const members = (n: string) =>
      Object.entries(compose.services)
        .filter(([, s]) => netsOf(s).includes(n))
        .map(([k]) => k)
        .sort();
    expect(members('data-gaterelay')).toEqual(['gate-relay', 'postgres']);
    expect(members('vault-gaterelay')).toEqual(['gate-relay', 'vault']);
    expect(members('gaterelay-github')).toEqual(['codehost', 'gate-relay']);
    expect(members('gaterelay-egress')).toEqual(['gate-relay']);
    expect(compose.services['kms-local']?.environment?.['KMS_CALLERS']).toMatch(
      /"gate-relay":\{"token_ref":"file:\/run\/secrets\/tok-gate-relay-kms","keys":\[\]\}/,
    );
  });
});
