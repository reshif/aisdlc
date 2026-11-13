import {
  DEFAULT_LIGHT_TESTS,
  ONBOARDING_LIGHT_TESTS_KEY,
  ONBOARDING_SANDBOX_IMAGE_KEY,
  SANDBOX_EXEC_ALLOWED_REPOS_KEY,
} from '@aisdlc/contracts';
import { ConfigRegistry } from '@aisdlc/config';
import { describe, expect, it } from 'vitest';
import { localIntegrationRegistry, sandboxDoc, seedSandboxFromEnv } from '../src/seed.js';
import { registerCoreConfig } from '../src/settings.js';

// The local stack's sandbox settings the seed publishes (the request-to-PR e2e): DEC-18's allow-list, the probe image and
// the W image LF4 is about, each an ordinary factory config key, and nothing at all unless the stack names one.

const IMG = `sha256:${'b'.repeat(64)}`;

describe('the seed: the local sandbox settings', () => {
  it('none by default', () => {
    expect(seedSandboxFromEnv({})).toBeNull();
  });
  it('the three keys, valid against the registered schemas', () => {
    const s = seedSandboxFromEnv({
      SEED_EXEC_ALLOWED_REPOS: 'reshif/asf-factory-testbed',
      SEED_ONBOARDING_SANDBOX_IMAGE: IMG,
      SEED_ONBOARDING_LOCK_SHA256: 'c'.repeat(64),
      SEED_WORKER_IMAGE: `sha256:${'d'.repeat(64)}`,
    });
    expect(s).not.toBeNull();
    const doc = sandboxDoc(s!);
    expect(doc).toEqual({
      [SANDBOX_EXEC_ALLOWED_REPOS_KEY]: ['reshif/asf-factory-testbed'],
      [ONBOARDING_SANDBOX_IMAGE_KEY]: { image: IMG, lock_sha256: 'c'.repeat(64) },
      [ONBOARDING_LIGHT_TESTS_KEY]: {
        ...DEFAULT_LIGHT_TESTS,
        worker_image: `sha256:${'d'.repeat(64)}`,
      },
    });
    const reg = registerCoreConfig(new ConfigRegistry());
    for (const [k, v] of Object.entries(doc)) {
      expect(reg.get(k)?.schema.safeParse(v).success, k).toBe(true);
    }
  });
  it('refuses what does not parse', () => {
    expect(() => seedSandboxFromEnv({ SEED_EXEC_ALLOWED_REPOS: 'not a repo' })).toThrow(
      /owner\/name/,
    );
    expect(() => seedSandboxFromEnv({ SEED_WORKER_IMAGE: 'aisdlc/sandbox-agent:local' })).toThrow(
      /digest/,
    );
    expect(() => seedSandboxFromEnv({ SEED_ONBOARDING_SANDBOX_IMAGE: IMG })).toThrow(/together/);
  });
  it('the fake provider answers with the testbed fixtures when asked', () => {
    const fake = localIntegrationRegistry(null, 'testbed').find((r) => r.integration_id === 'fake');
    expect(fake?.config).toEqual({ fixtures: 'testbed' });
    expect(localIntegrationRegistry(null).find((r) => r.integration_id === 'fake')?.config).toEqual(
      { fixtures: 'planning' },
    );
  });
});
