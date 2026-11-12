import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// PLAN M14.5 in the compose stack: gate-check's own App key is mounted into gate-check and nothing else (the fake
// GitHub gets its PUBLIC half only), the codehost's App key is not in gate-check, gate-check is hardened like every
// factory service, and its networks are its own: no route to core, the Notary, identity or the record services' net.

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
const gc = compose.services['gate-check'] as Service;
const netsOf = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});

describe('gate-check in the compose stack', () => {
  it('its App key is mounted into gate-check only; the codehost’s App key is not in gate-check', () => {
    expect(compose.secrets['gate-check-app.pem']).toEqual({ file: './secrets/gate-check-app.pem' });
    for (const [name, svc] of Object.entries(compose.services)) {
      if (name === 'gate-check') continue;
      expect(secretsOf(svc), name).not.toContain('gate-check-app.pem');
    }
    expect(secretsOf(gc)).toContain('gate-check-app.pem');
    expect(secretsOf(gc)).not.toContain('github-app.pem');
    expect(gc.environment?.['GATE_CHECK_APP_KEY_REF']).toBe('file:/run/secrets/gate-check-app.pem');
    expect(readFileSync(join(dir, 'init-secrets'), 'utf8')).toContain('secrets/gate-check-app.pem');
    // the fake GitHub verifies gate-check's App JWTs with the public half only
    expect(secretsOf(compose.services['fake-github'] as Service)).toEqual([
      'github-app.pub.pem',
      'gate-check-app.pub.pem',
      // M15.3: gate-relay's App is the host's third
      'gate-relay-app.pub.pem',
      // M16: the issue twin's tracker App is its fourth
      'tracker-app.pub.pem',
      // the Push Broker's own App is its fifth
      'push-broker-app.pub.pem',
    ]);
  });

  it('is hardened, health-checked, and on its own networks: no route to core, the Notary or identity', () => {
    // its own profile, and `full` (the request-to-PR stack)
    expect(gc.profiles).toEqual(['gate-check', 'full']);
    expect(gc.read_only).toBe(true);
    expect(gc.cap_drop).toEqual(['ALL']);
    expect(gc.security_opt).toContain('no-new-privileges:true');
    expect(gc.healthcheck?.test).toContain('8450');
    expect(netsOf(gc).sort()).toEqual(
      [
        'data-gatecheck',
        'gatecheck-api',
        'gatecheck-egress',
        'gatecheck-github',
        'kms-clients',
        'objectstore-api',
      ].sort(),
    );
    for (const n of ['data-gatecheck', 'gatecheck-github'])
      expect(compose.networks[n]?.internal).toBe(true);
    // the only other members of its private networks: Postgres, and the codehost whose namespace the fake lives in
    const members = (n: string) =>
      Object.entries(compose.services)
        .filter(([, s]) => netsOf(s).includes(n))
        .map(([k]) => k)
        .sort();
    expect(members('data-gatecheck')).toEqual(['gate-check', 'postgres']);
    expect(members('gatecheck-github')).toEqual(['codehost', 'gate-check']);
    expect(members('gatecheck-egress')).toEqual(['gate-check']);
    // its read API is reachable by the bff only (M14.6: gate-check verdicts on the item page)
    expect(compose.networks['gatecheck-api']?.internal).toBe(true);
    expect(members('gatecheck-api')).toEqual(['bff', 'gate-check']);
    // its kms caller may use no key (a public-key read of the Notary's)
    expect(compose.services['kms-local']?.environment?.['KMS_CALLERS']).toMatch(
      /"gate-check":\{"token_ref":"file:\/run\/secrets\/tok-gate-check-kms","keys":\[\]\}/,
    );
  });
});
