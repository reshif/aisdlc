import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// PLAN M19 in the compose stack: the sandbox-controller's one route to core (heartbeats, scope `activity` only), the
// health targets core-worker reads, and the OpenTelemetry collector (pinned, hardened, no way out, on networks that
// open no path between services that did not have one).

const dir = join(import.meta.dirname, '..', '..', '..', 'platform', 'compose');
interface Service {
  image?: string;
  secrets?: Array<string | { source: string }>;
  environment?: Record<string, string>;
  networks?: string[] | Record<string, unknown>;
  profiles?: string[];
  ports?: unknown[];
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  user?: string;
  depends_on?: Record<string, unknown>;
  volumes?: string[];
}
const compose = parse(readFileSync(join(dir, 'docker-compose.yml'), 'utf8'), { merge: true }) as {
  services: Record<string, Service>;
  networks: Record<
    string,
    { internal?: boolean; ipam?: { config?: Array<{ subnet?: string }> } } | null
  >;
};
const netsOf = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});
const members = (net: string) =>
  Object.entries(compose.services)
    .filter(([, s]) => netsOf(s).includes(net))
    .map(([k]) => k)
    .sort();
const svc = (n: string) => compose.services[n] as Service;

describe('M19 heartbeats in compose', () => {
  it('core-activity joins the sandbox-controller and core only; its token carries scope activity alone', () => {
    expect(compose.networks['core-activity']?.internal).toBe(true);
    expect(members('core-activity')).toEqual(['core', 'sandbox-controller']);
    const callers = JSON.parse(svc('core').environment?.['CORE_CALLERS'] ?? '{}') as Record<
      string,
      { scopes: string[] }
    >;
    expect(callers['sandbox-controller']?.scopes).toEqual(['activity']);
    expect(svc('sandbox-controller').environment?.['SANDBOX_CONTROLLER_CORE_URL']).toBe(
      'http://core:8380',
    );
    const init = readFileSync(join(dir, 'init-secrets'), 'utf8');
    expect(init).toMatch(/\bsandbox-controller-core\b/);
  });
});

describe('M19 health targets', () => {
  it('core-worker reads only services it shares a network with', () => {
    const cw = svc('core-worker');
    const targets = JSON.parse(cw.environment?.['CORE_WORKER_HEALTH_TARGETS'] ?? '{}') as Record<
      string,
      string | { url: string }
    >;
    expect(Object.keys(targets).length).toBeGreaterThan(5);
    const mine = new Set(netsOf(cw));
    for (const [name, t] of Object.entries(targets)) {
      const host = new URL(typeof t === 'string' ? t : t.url).hostname;
      const other = svc(host);
      expect(other, `${name}: ${host} is a service`).toBeDefined();
      expect(
        netsOf(other).some((n) => mine.has(n)),
        `${name}: core-worker shares a network with ${host}`,
      ).toBe(true);
    }
  });
});

describe('M19 the OpenTelemetry collector', () => {
  const c = svc('otel-collector');
  it('is pinned by digest, hardened, under its own profile, publishes nothing and nothing depends on it', () => {
    expect(c.image).toMatch(/^otel\/opentelemetry-collector:[0-9.]+@sha256:[0-9a-f]{64}$/);
    expect(c.profiles).toEqual(['telemetry']);
    expect(c.read_only).toBe(true);
    expect(c.cap_drop).toEqual(['ALL']);
    expect(c.security_opt).toContain('no-new-privileges:true');
    expect(c.user).not.toMatch(/^0(:|$)/);
    expect(c.ports).toBeUndefined();
    expect(c.volumes).toEqual(['./config/otel-collector.yaml:/etc/otelcol/config.yaml:ro']);
    for (const [name, s] of Object.entries(compose.services)) {
      expect(Object.keys(s.depends_on ?? {}), name).not.toContain('otel-collector');
    }
  });

  it('is on internal telemetry networks only, which open no path the services did not have', () => {
    expect(netsOf(c).sort()).toEqual(['telemetry', 'telemetry-bff']);
    expect(compose.networks['telemetry']?.internal).toBe(true);
    expect(compose.networks['telemetry-bff']?.internal).toBe(true);
    const app = new Set(members('app'));
    for (const m of members('telemetry').filter((x) => x !== 'otel-collector')) {
      expect(app.has(m), `${m} already shares app`).toBe(true);
    }
    expect(members('telemetry-bff')).toEqual(['bff', 'otel-collector']);
  });

  it('every service that joins a telemetry network has the export switch, off by default', () => {
    for (const net of ['telemetry', 'telemetry-bff']) {
      for (const m of members(net).filter((x) => x !== 'otel-collector')) {
        expect(svc(m).environment?.['OTEL_EXPORTER_OTLP_ENDPOINT'], m).toBe(
          '${OTEL_EXPORTER_OTLP_ENDPOINT:-}',
        );
      }
    }
  });
});

describe('M19 the networks fit any Docker daemon', () => {
  it('every network has its own /24 under AISDLC_SUBNET_PREFIX (the default address pools hold about 30)', () => {
    const subnets = Object.entries(compose.networks).map(([name, n]) => {
      const s = n?.ipam?.config?.[0]?.subnet ?? '';
      expect(s, name).toMatch(/^\$\{AISDLC_SUBNET_PREFIX:-10\.231\}\.\d{1,3}\.0\/24$/);
      return s;
    });
    expect(new Set(subnets).size).toBe(subnets.length);
    expect(subnets.length).toBeLessThanOrEqual(254);
  });
});
