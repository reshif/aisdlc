import {
  DEFAULT_ONBOARDING_CONSOLE,
  ONBOARDING_AGENT_GUIDELINES_KEY,
  ONBOARDING_CONSOLE_KEY,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  ConfigRegistry,
  agentGuidelinesFrom,
  onboardingConsoleFrom,
  registerOnboardingConsoleConfig,
} from '../src/index.js';

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

describe('reading the keys from a snapshot', () => {
  const snap = (
    values: Record<string, unknown>,
    rejected: string[] = [],
    factory: string | null = 'rev-3',
  ) => ({
    rejected,
    revisions: { factory },
    get: (k: string) => values[k],
  });

  it('the console: the defaults when nothing is published; OFF when the published value does not read (fail closed)', () => {
    expect(onboardingConsoleFrom(snap({}))).toEqual(DEFAULT_ONBOARDING_CONSOLE);
    expect(onboardingConsoleFrom(snap({}, [ONBOARDING_CONSOLE_KEY])).enabled).toBe(false);
    expect(
      onboardingConsoleFrom(snap({ [ONBOARDING_CONSOLE_KEY]: { enabled: 'yes' } })).enabled,
    ).toBe(false);
  });

  it('the guidelines: the text and the factory revision; empty when unreadable', () => {
    expect(
      agentGuidelinesFrom(snap({ [ONBOARDING_AGENT_GUIDELINES_KEY]: { text: 'Be brief.' } })),
    ).toEqual({
      text: 'Be brief.',
      revision: 'rev-3',
    });
    expect(agentGuidelinesFrom(snap({}, [], null))).toEqual({ text: '', revision: 'default' });
    expect(
      agentGuidelinesFrom(
        snap({ [ONBOARDING_AGENT_GUIDELINES_KEY]: { text: 'x' } }, [
          ONBOARDING_AGENT_GUIDELINES_KEY,
        ]),
      ).text,
    ).toBe('');
  });
});
