import { ConfigRegistry } from '@aisdlc/config';
import { FakeEligibility } from '@aisdlc/decisions';
import { describe, expect, it } from 'vitest';
import { BootstrapEligibility } from '../src/bootstrap.js';
import { cardDepsFrom, RefusingStepUp } from '../src/card-wiring.js';
import { FakeKnowledge } from '../src/clients.js';
import { coreConfigFromEnv } from '../src/config.js';
import { fakeHost } from '../src/testing.js';

// The deployment's card wiring (PLAN M8.0): bootstrap on, eligibility plain (so the grant stays
// scoped to one S0 record per card operation), and the configuration that switches cards on.

describe('cardDepsFrom', () => {
  it('turns the bootstrap decider on and keeps the base eligibility plain', async () => {
    const elig = new FakeEligibility();
    const deps = cardDepsFrom({
      pool: {} as never,
      readPool: {} as never,
      registry: new ConfigRegistry(),
      ledger: {} as never,
      eligibility: elig,
      stepUp: new RefusingStepUp(),
      knowledge: new FakeKnowledge(),
      source: fakeHost(),
    });
    expect(deps.bootstrap).toBe(true);
    // Never a BootstrapEligibility underneath: the card layer wraps it per S0 record, and a wrapped
    // wrapper would answer the grant for every record that holds one.
    expect(deps.decisions.eligibility).toBe(elig);
    expect(deps.decisions.eligibility).not.toBeInstanceOf(BootstrapEligibility);
    expect(deps.config?.eligibility).toBe(elig);
    expect(await new RefusingStepUp().verify()).toMatchObject({ ok: false });
  });
});

describe('core configuration of the cards', () => {
  const base = {
    CORE_DATABASE_URL: 'postgres://localhost/db',
    CORE_CALLERS: JSON.stringify({ bff: { token_ref: 'env:T', scopes: ['read'] } }),
    T: 'a'.repeat(32),
    K: 'b'.repeat(32),
    C: 'c'.repeat(32),
    N: 'd'.repeat(32),
  };
  const cards = {
    CORE_KNOWLEDGE_URL: 'http://knowledge:8370',
    CORE_KNOWLEDGE_TOKEN_REF: 'env:K',
    CORE_CODEHOST_URL: 'http://codehost:8350',
    CORE_CODEHOST_TOKEN_REF: 'env:C',
  };
  const ledger = { CORE_NOTARY_URL: 'http://notary:8310', CORE_NOTARY_TOKEN_REF: 'env:N' };

  it('is off with no remotes, on with both remotes and the ledger', () => {
    expect(coreConfigFromEnv(base).cards).toBeNull();
    expect(coreConfigFromEnv({ ...base, ...ledger, ...cards }).cards).toEqual({
      knowledge: { url: 'http://knowledge:8370', token: 'b'.repeat(32) },
      codehost: { url: 'http://codehost:8350', token: 'c'.repeat(32) },
    });
  });

  it('refuses half of it', () => {
    const onlyKnowledge = {
      CORE_KNOWLEDGE_URL: cards.CORE_KNOWLEDGE_URL,
      CORE_KNOWLEDGE_TOKEN_REF: cards.CORE_KNOWLEDGE_TOKEN_REF,
    };
    expect(() => coreConfigFromEnv({ ...base, ...ledger, ...onlyKnowledge })).toThrow(
      /both CORE_KNOWLEDGE_URL and CORE_CODEHOST_URL/,
    );
    expect(() => coreConfigFromEnv({ ...base, ...cards })).toThrow(/need the ledger/);
    expect(() =>
      coreConfigFromEnv({ ...base, ...ledger, ...cards, CORE_KNOWLEDGE_TOKEN_REF: '' }),
    ).toThrow(/CORE_KNOWLEDGE_TOKEN_REF is required/);
  });

  it('switches the assistant on with the gateway, and only beside knowledge (M18)', () => {
    const gw = { CORE_GATEWAY_URL: 'http://gateway:8390', CORE_GATEWAY_TOKEN_REF: 'env:N' };
    expect(coreConfigFromEnv({ ...base, ...ledger, ...cards }).assistant).toBeNull();
    expect(
      coreConfigFromEnv({
        ...base,
        ...ledger,
        ...cards,
        ...gw,
        CORE_ASSISTANT_EXTRA_MODELS: 'fake-model, bad model',
      }).assistant,
    ).toEqual({
      gateway: { url: 'http://gateway:8390', token: 'd'.repeat(32) },
      extraModels: ['fake-model'],
    });
    expect(() => coreConfigFromEnv({ ...base, ...gw })).toThrow(/the assistant needs knowledge/);
  });
});

describe('core configuration of deletion (portal v2)', () => {
  it('a caller may hold the delete scope, and the purge login switches the routes on', () => {
    const c = coreConfigFromEnv({
      CORE_DATABASE_URL: 'postgres://localhost/db',
      CORE_CALLERS: JSON.stringify({ bff: { token_ref: 'env:T', scopes: ['read', 'delete'] } }),
      T: 'a'.repeat(32),
      CORE_PURGE_DATABASE_URL: 'postgres://core_purge@localhost/db',
    });
    expect(c.callers['bff']).toEqual(['read', 'delete']);
    expect(c.deletion?.databaseUrl).toBe('postgres://core_purge@localhost/db');
  });
});
