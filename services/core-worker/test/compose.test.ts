import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// User decision 2026-11-12: core-worker keeps NO route out. Every GitHub call is the codehost's, the issue twin's
// tracker included: its OWN App key mounts on the codehost only (the fake GitHub gets its public half), and core-worker
// reaches the tracker through the codehost's `tracker` routes with its service token.

const dir = join(import.meta.dirname, '..', '..', '..', 'platform', 'compose');
interface Service {
  secrets?: Array<string | { source: string }>;
  environment?: Record<string, string>;
  networks?: string[] | Record<string, unknown>;
}
const compose = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf8'), { merge: true }) as {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean } | null>;
};
const secretsOf = (s: Service): string[] =>
  (s.secrets ?? []).map((x) => (typeof x === 'string' ? x : x.source));
const netsOf = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});
const cw = compose.services['core-worker'] as Service;

describe('core-worker in the compose stack', () => {
  it('is on no network with a route out: every network it joins is internal', () => {
    const nets = netsOf(cw);
    expect(nets.length).toBeGreaterThan(0);
    for (const n of nets) {
      expect(compose.networks[n]?.internal, `${n} must be internal`).toBe(true);
    }
    expect(nets).not.toContain('egress');
    expect(Object.keys(compose.networks)).not.toContain('tracker-egress');
  });

  it('holds no GitHub credential: the tracker App key is the codehost’s, the public half the fake host’s', () => {
    expect(secretsOf(cw).filter((x) => /app\.pem$|app\.pub\.pem$/.test(x))).toEqual([]);
    for (const [name, svc] of Object.entries(compose.services)) {
      if (name === 'codehost') continue;
      expect(secretsOf(svc), name).not.toContain('tracker-app.pem');
    }
    const codehost = compose.services['codehost'] as Service;
    expect(secretsOf(codehost)).toContain('tracker-app.pem');
    expect(codehost.environment?.['CODEHOST_TRACKER_APP_KEY_REF']).toBe(
      'file:/run/secrets/tracker-app.pem',
    );
    expect(secretsOf(compose.services['fake-github'] as Service)).toContain('tracker-app.pub.pem');
    // core-worker names the login only; nothing of the App, its key or a GitHub URL
    const env = Object.keys(cw.environment ?? {}).filter((k) =>
      k.startsWith('CORE_WORKER_TRACKER'),
    );
    expect(env).toEqual(['CORE_WORKER_TRACKER_LOGIN']);
    // and only core-worker's codehost token carries the `tracker` scope
    const callers = JSON.parse(codehost.environment?.['CODEHOST_CALLERS'] ?? '{}') as Record<
      string,
      { scopes: string[] }
    >;
    expect(
      Object.entries(callers)
        .filter(([, c]) => c.scopes.includes('tracker'))
        .map(([n]) => n),
    ).toEqual(['core-worker']);
  });
});

describe('the Push Broker in the compose stack (M13.6)', () => {
  const pb = compose.services['push-broker'] as Service & { profiles?: string[] };
  const members = (n: string) =>
    Object.entries(compose.services)
      .filter(([, s]) => netsOf(s).includes(n))
      .map(([k]) => k)
      .sort();
  it('is the codehost in push mode with the push key (the factory App, or its own), mounted nowhere else', () => {
    expect(pb.environment?.['CODEHOST_MODE']).toBe('push');
    // the mounted file by default; portal v2: the owner may point it at the Vault field instead (its own folder)
    expect(pb.environment?.['CODEHOST_GITHUB_APP_KEY_REF']).toBe(
      '${AISDLC_PUSH_BROKER_KEY_REF:-file:/run/secrets/push-broker-app.pem}',
    );
    expect(secretsOf(pb)).not.toContain('github-app.pem');
    for (const [name, svc] of Object.entries(compose.services)) {
      if (name !== 'push-broker') expect(secretsOf(svc), name).not.toContain('push-broker-app.pem');
    }
    expect(secretsOf(compose.services['fake-github'] as Service)).toContain(
      'push-broker-app.pub.pem',
    );
    expect(pb.profiles).toEqual(['push-broker', 'full']);
    // core-worker is its one caller that may push; core reads its App report only (P2-4, scope status)
    expect(JSON.parse(pb.environment?.['CODEHOST_CALLERS'] ?? '{}')).toEqual({
      'core-worker': {
        token_ref: 'file:/run/secrets/tok-core-worker-push-broker',
        scopes: ['push'],
      },
      core: { token_ref: 'file:/run/secrets/tok-core-push-broker', scopes: ['status'] },
    });
  });
  it('its networks open no new path: core, core-worker and identity share app already', () => {
    // portal v2: vault-pushbroker is its own link to Vault (Vault and the Push Broker only)
    expect(netsOf(pb).sort()).toEqual([
      'pushbroker',
      'pushbroker-egress',
      'pushbroker-github',
      'vault-pushbroker',
    ]);
    expect(members('vault-pushbroker')).toEqual(['push-broker', 'vault']);
    expect(members('pushbroker')).toEqual(['core', 'core-worker', 'identity', 'push-broker']);
    for (const s of ['core', 'core-worker', 'identity'])
      expect(netsOf(compose.services[s] as Service)).toContain('app');
    expect(members('pushbroker-github')).toEqual(['codehost', 'push-broker']);
    expect(members('pushbroker-egress')).toEqual(['push-broker']);
    expect(compose.networks['pushbroker']?.internal).toBe(true);
    expect(compose.networks['pushbroker-github']?.internal).toBe(true);
    // core-worker reaches it with its own token there, not the codehost's
    expect(cw.environment?.['CORE_WORKER_PUSH_BROKER_TOKEN_REF']).toBe(
      'file:/run/secrets/tok-core-worker-push-broker',
    );
    expect(secretsOf(pb)).not.toContain('tok-core-worker-codehost');
  });
});
