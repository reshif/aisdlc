import { describe, expect, it } from 'vitest';
import { coreWorkerConfigFromEnv } from '../src/config.js';

// The stage ports and the gateway (PLAN M11.2): the work driver mints every agent-acted command's
// per-Unit key through the gateway's admin API, so it does not run without one to ask.

const BASE = {
  CORE_WORKER_DATABASE_URL: 'postgres://127.0.0.1:5432/db',
  CORE_WORKER_CODEHOST_URL: 'http://127.0.0.1:1',
  CORE_WORKER_CODEHOST_TOKEN_REF: 'env:T',
  T: 'x'.repeat(32),
  CORE_WORKER_STAGE_PORTS: 'fake',
  CORE_WORKER_KNOWLEDGE_URL: 'http://127.0.0.1:2',
  CORE_WORKER_KNOWLEDGE_TOKEN_REF: 'env:T',
  CORE_WORKER_NOTARY_URL: 'http://127.0.0.1:3',
  CORE_WORKER_NOTARY_TOKEN_REF: 'env:T',
  CORE_WORKER_KILLSWITCH_URL: 'http://127.0.0.1:4',
  CORE_WORKER_KILLSWITCH_TOKEN_REF: 'env:T',
};

describe('core-worker config: the gateway', () => {
  it('stage ports need the gateway: no key, no agent run', () => {
    expect(() => coreWorkerConfigFromEnv(BASE)).toThrow(/CORE_WORKER_GATEWAY_URL/);
  });

  it('reads the gateway and the extra models of the keys', () => {
    const cfg = coreWorkerConfigFromEnv({
      ...BASE,
      CORE_WORKER_GATEWAY_URL: 'http://127.0.0.1:5',
      CORE_WORKER_GATEWAY_TOKEN_REF: 'env:T',
      CORE_WORKER_AGENT_EXTRA_MODELS: 'fake-model, other ',
    });
    expect(cfg.gateway).toEqual({ url: 'http://127.0.0.1:5', token: 'x'.repeat(32) });
    expect(cfg.agentExtraModels).toEqual(['fake-model', 'other']);
  });

  it('without stage ports the gateway is not needed', () => {
    const rest: Record<string, string> = { ...BASE };
    delete rest['CORE_WORKER_STAGE_PORTS'];
    const cfg = coreWorkerConfigFromEnv(rest);
    expect(cfg.gateway).toBeNull();
    expect(cfg.agentExtraModels).toEqual([]);
  });
});

describe('core-worker config: S2 and S3 with real agents (PLAN M12)', () => {
  const WITH_GATEWAY = {
    ...BASE,
    CORE_WORKER_GATEWAY_URL: 'http://127.0.0.1:5',
    CORE_WORKER_GATEWAY_TOKEN_REF: 'env:T',
  };

  it('`agents` is a stage-port mode; it needs knowledge, which grounds S2 on its census', () => {
    expect(
      coreWorkerConfigFromEnv({ ...WITH_GATEWAY, CORE_WORKER_STAGE_PORTS: 'agents' }).stagePorts,
    ).toBe('agents');
    const rest: Record<string, string> = { ...WITH_GATEWAY, CORE_WORKER_STAGE_PORTS: 'agents' };
    delete rest['CORE_WORKER_KNOWLEDGE_URL'];
    delete rest['CORE_WORKER_KNOWLEDGE_TOKEN_REF'];
    expect(() => coreWorkerConfigFromEnv(rest)).toThrow(/CORE_WORKER_KNOWLEDGE_URL/);
  });

  it('anything else is refused', () => {
    expect(() =>
      coreWorkerConfigFromEnv({ ...WITH_GATEWAY, CORE_WORKER_STAGE_PORTS: 'real' }),
    ).toThrow(/none`, `fake` or `agents/);
  });
});

describe('core-worker config: real coding sessions (M13.3, M13.4)', () => {
  const WITH_AGENTS = {
    ...BASE,
    CORE_WORKER_STAGE_PORTS: 'agents',
    CORE_WORKER_GATEWAY_URL: 'http://127.0.0.1:5',
    CORE_WORKER_GATEWAY_TOKEN_REF: 'env:T',
  };
  const SANDBOX = {
    CORE_WORKER_SANDBOX_PROXY_URL: 'http://docker-proxy-coding:2375',
    CORE_WORKER_SANDBOX_PROXY_TOKEN_REF: 'env:T',
    CORE_WORKER_SANDBOX_SCRATCH: '/var/lib/aisdlc/sandbox-scratch',
    CORE_WORKER_SANDBOX_MIRROR: 'aisdlc-package-mirror',
    CORE_WORKER_SANDBOX_GATEWAY: 'aisdlc-gateway',
  };
  it('no proxy: no sessions, the stage ports as before', () => {
    expect(coreWorkerConfigFromEnv(WITH_AGENTS).sandbox).toBeNull();
  });
  it('reads the proxy, its bearer token (a reference), the peers and the defaults', () => {
    const cfg = coreWorkerConfigFromEnv({ ...WITH_AGENTS, ...SANDBOX });
    expect(cfg.sandbox).toEqual({
      proxyUrl: 'http://docker-proxy-coding:2375',
      proxyToken: 'x'.repeat(32),
      image: 'aisdlc/sandbox-agent:local',
      scratch: '/var/lib/aisdlc/sandbox-scratch',
      mirror: 'aisdlc-package-mirror',
      gateway: 'aisdlc-gateway',
      storeDir: '/var/lib/aisdlc/sessions',
      model: 'claude-sonnet-5-5',
    });
  });
  it('M14.2: the sandbox-controller instead of an in-process driver (exclusive), with its token as a reference', () => {
    const CTL = {
      CORE_WORKER_SANDBOX_CONTROLLER_URL: 'http://sandbox-controller:8430',
      CORE_WORKER_SANDBOX_CONTROLLER_TOKEN_REF: 'env:T',
    };
    expect(coreWorkerConfigFromEnv(WITH_AGENTS).sandboxController).toBeNull();
    const cfg = coreWorkerConfigFromEnv({ ...WITH_AGENTS, ...CTL });
    expect(cfg.sandbox).toBeNull();
    expect(cfg.sandboxController).toEqual({
      url: 'http://sandbox-controller:8430',
      token: 'x'.repeat(32),
      storeDir: '/var/lib/aisdlc/sessions',
      model: 'claude-sonnet-5-5',
    });
    expect(() => coreWorkerConfigFromEnv({ ...WITH_AGENTS, ...CTL, ...SANDBOX })).toThrow(
      /exclusive/,
    );
    expect(() =>
      coreWorkerConfigFromEnv({
        ...WITH_AGENTS,
        ...CTL,
        CORE_WORKER_SANDBOX_CONTROLLER_TOKEN_REF: 'literal-token',
      }),
    ).toThrow(/env:NAME or file:PATH/);
    expect(() =>
      coreWorkerConfigFromEnv({
        ...BASE,
        ...CTL,
        CORE_WORKER_GATEWAY_URL: 'http://127.0.0.1:5',
        CORE_WORKER_GATEWAY_TOKEN_REF: 'env:T',
      }),
    ).toThrow(/STAGE_PORTS=agents/);
  });
  it('real sessions need the agents stage ports, a token reference (never a literal) and a plain scratch directory', () => {
    expect(() =>
      coreWorkerConfigFromEnv({
        ...BASE,
        ...SANDBOX,
        CORE_WORKER_GATEWAY_URL: 'http://127.0.0.1:5',
        CORE_WORKER_GATEWAY_TOKEN_REF: 'env:T',
      }),
    ).toThrow(/STAGE_PORTS=agents/);
    expect(() =>
      coreWorkerConfigFromEnv({
        ...WITH_AGENTS,
        ...SANDBOX,
        CORE_WORKER_SANDBOX_PROXY_TOKEN_REF: 'literal-token',
      }),
    ).toThrow(/env:NAME or file:PATH/);
    expect(() =>
      coreWorkerConfigFromEnv({ ...WITH_AGENTS, ...SANDBOX, CORE_WORKER_SANDBOX_SCRATCH: '/' }),
    ).toThrow(/plain absolute/);
    expect(() =>
      coreWorkerConfigFromEnv({
        ...WITH_AGENTS,
        ...SANDBOX,
        CORE_WORKER_SANDBOX_SCRATCH: '/a/../b',
      }),
    ).toThrow(/plain absolute/);
  });
});

describe('core-worker config: the scripted S7 of the compose e2e (M14.6)', () => {
  const ENV = {
    ...BASE,
    CORE_WORKER_GATEWAY_URL: 'http://127.0.0.1:5',
    CORE_WORKER_GATEWAY_TOKEN_REF: 'env:T',
  };
  it('defaults to the plain fakes', () => {
    expect(coreWorkerConfigFromEnv(ENV).fakeVerify).toBe('default');
  });
  it('`exceptions` only with FACTORY_ENV=local, the stage ports and no verify service', () => {
    const on = { ...ENV, CORE_WORKER_FAKE_VERIFY: 'exceptions' };
    expect(() => coreWorkerConfigFromEnv(on)).toThrow(/FACTORY_ENV=local/);
    expect(coreWorkerConfigFromEnv({ ...on, FACTORY_ENV: 'local' }).fakeVerify).toBe('exceptions');
    const rest: Record<string, string> = { ...on, FACTORY_ENV: 'local' };
    delete rest['CORE_WORKER_STAGE_PORTS'];
    expect(() => coreWorkerConfigFromEnv(rest)).toThrow(/needs CORE_WORKER_STAGE_PORTS/);
    expect(() => coreWorkerConfigFromEnv({ ...ENV, CORE_WORKER_FAKE_VERIFY: 'yes' })).toThrow(
      /`default` or `exceptions`/,
    );
  });
});

describe('core-worker config: the issue twin’s own App (PLAN M16)', () => {
  const PLAIN: Record<string, string> = {
    CORE_WORKER_DATABASE_URL: 'postgres://127.0.0.1:5432/db',
    CORE_WORKER_CODEHOST_URL: 'http://127.0.0.1:1',
    CORE_WORKER_CODEHOST_TOKEN_REF: 'env:T',
    T: 'x'.repeat(32),
    CORE_WORKER_KNOWLEDGE_URL: 'http://127.0.0.1:2',
    CORE_WORKER_KNOWLEDGE_TOKEN_REF: 'env:T',
  };
  const TRACKER = {
    CORE_WORKER_TRACKER_APP_ID: '777001',
    CORE_WORKER_TRACKER_INSTALLATION_ID: '33',
    CORE_WORKER_TRACKER_APP_KEY_REF: 'file:/run/secrets/tracker.pem',
    CORE_WORKER_TRACKER_LOGIN: 'aisdlc-tracker[bot]',
  };

  it('off unless its App is named; on, it reads its own credential reference and login', () => {
    expect(coreWorkerConfigFromEnv(PLAIN).tracker).toBeNull();
    const cfg = coreWorkerConfigFromEnv({
      ...PLAIN,
      ...TRACKER,
      CORE_WORKER_TRACKER_PLAIN_HTTP_HOSTS: 'codehost',
    });
    expect(cfg.tracker).toEqual({
      apiUrl: 'https://api.github.com',
      appId: '777001',
      installationId: 33,
      appKeyRef: 'file:/run/secrets/tracker.pem',
      login: 'aisdlc-tracker[bot]',
      plainHttpHosts: ['codehost'],
    });
    expect(cfg.issueTwinIntervalMs).toBe(600_000);
  });

  it('a key that is not a file reference, a missing installation and no knowledge are refused', () => {
    expect(() =>
      coreWorkerConfigFromEnv({ ...PLAIN, ...TRACKER, CORE_WORKER_TRACKER_APP_KEY_REF: 'env:K' }),
    ).toThrow(/file: reference/);
    const noInst: Record<string, string> = { ...PLAIN, ...TRACKER };
    delete noInst['CORE_WORKER_TRACKER_INSTALLATION_ID'];
    expect(() => coreWorkerConfigFromEnv(noInst)).toThrow(/CORE_WORKER_TRACKER_INSTALLATION_ID/);
    const noKnowledge: Record<string, string> = { ...PLAIN, ...TRACKER };
    delete noKnowledge['CORE_WORKER_KNOWLEDGE_URL'];
    expect(() => coreWorkerConfigFromEnv(noKnowledge)).toThrow(/CORE_WORKER_KNOWLEDGE_URL/);
  });
});

describe('core-worker config: the health targets (M19)', () => {
  const base = (): Record<string, string> => {
    const rest: Record<string, string> = { ...BASE };
    delete rest['CORE_WORKER_STAGE_PORTS'];
    return rest;
  };
  it('none by default; a url or {url, path} per service', () => {
    expect(coreWorkerConfigFromEnv(base()).healthTargets).toEqual({});
    const cfg = coreWorkerConfigFromEnv({
      ...base(),
      CORE_WORKER_HEALTH_TARGETS: JSON.stringify({
        notary: 'http://notary:8310',
        'object-store': { url: 'http://object-store:9000', path: '/minio/health/live' },
      }),
    });
    expect(cfg.healthTargets).toEqual({
      notary: { url: 'http://notary:8310' },
      'object-store': { url: 'http://object-store:9000', path: '/minio/health/live' },
    });
    expect(cfg.healthIntervalMs).toBe(30_000);
  });
  it('refuses what is not JSON, a bad name, or a URL that is not http(s)', () => {
    for (const v of ['nope', '{"Bad":"http://x"}', '{"a":"ftp://x/y"}', '{"a":"x"}']) {
      expect(() => coreWorkerConfigFromEnv({ ...base(), CORE_WORKER_HEALTH_TARGETS: v })).toThrow(
        /CORE_WORKER_HEALTH_TARGETS/,
      );
    }
  });
});
