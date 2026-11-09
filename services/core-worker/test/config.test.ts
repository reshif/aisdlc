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
