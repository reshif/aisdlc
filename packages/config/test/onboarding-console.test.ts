import {
  DEFAULT_ONBOARDING_CONSOLE,
  ONBOARDING_AGENT_GUIDELINES_KEY,
  ONBOARDING_CONSOLE_KEY,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { ConfigRegistry, registerOnboardingConsoleConfig } from '../src/index.js';

// The onboarding console's two keys: factory layer only (M1-gated like every revision), defaults that read.

describe('onboarding console config', () => {
  const r = registerOnboardingConsoleConfig(registerOnboardingConsoleConfig(new ConfigRegistry()));

  it('registers once, not project-overridable, with defaults that validate', () => {
    expect(r.get(ONBOARDING_CONSOLE_KEY)).toMatchObject({
      overridable: false,
      default: DEFAULT_ONBOARDING_CONSOLE,
    });
    expect(r.get(ONBOARDING_AGENT_GUIDELINES_KEY)).toMatchObject({ overridable: false });
    expect(r.validate('factory', {}).ok).toBe(true);
  });

  it('refuses a document that names a gate or an unknown autonomy', () => {
    const bad = r.validate('factory', {
      [ONBOARDING_CONSOLE_KEY]: {
        ...DEFAULT_ONBOARDING_CONSOLE,
        autonomy: { ...DEFAULT_ONBOARDING_CONSOLE.autonomy, run_probe: 'always' },
      },
    });
    expect(bad.ok).toBe(false);
    expect(
      r.validate('factory', {
        [ONBOARDING_CONSOLE_KEY]: { ...DEFAULT_ONBOARDING_CONSOLE, decide_gates: true },
      }).ok,
    ).toBe(false);
  });

  it('refuses guidelines that hold a secret, and a project layer that sets either key', () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    expect(
      r.validate('factory', { [ONBOARDING_AGENT_GUIDELINES_KEY]: { text: `use ${secret}` } }).ok,
    ).toBe(false);
    expect(
      r.validate('factory', { [ONBOARDING_AGENT_GUIDELINES_KEY]: { text: 'Prefer small PRs.' } })
        .ok,
    ).toBe(true);
    expect(r.validate('project', { [ONBOARDING_AGENT_GUIDELINES_KEY]: { text: 'x' } }).ok).toBe(
      false,
    );
  });
});
