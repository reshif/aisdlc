import {
  AgentGuidelines,
  DEFAULT_AGENT_GUIDELINES,
  DEFAULT_ONBOARDING_CONSOLE,
  ONBOARDING_AGENT_GUIDELINES_KEY,
  ONBOARDING_CONSOLE_KEY,
  OnboardingConsoleConfig,
} from '@aisdlc/contracts';
import { scanText } from '@aisdlc/secrets-rules';
import type { ConfigRegistry } from './registry.js';

/**
 * Registers the onboarding console's two keys (docs/design/onboarding-console.md): `onboarding.console` (whether the
 * agent runs and how much it does by itself) and `onboarding.agent_guidelines` (the factory's words to the onboarder,
 * read as fenced Guidance). Factory layer only, M1-gated like every revision; guidelines are secret-scanned.
 * Idempotent: a registry that has the key keeps it.
 */
export function registerOnboardingConsoleConfig(registry: ConfigRegistry): ConfigRegistry {
  if (registry.get(ONBOARDING_CONSOLE_KEY)) return registry;
  return registry
    .setting({
      key: ONBOARDING_CONSOLE_KEY,
      schema: OnboardingConsoleConfig,
      default: { ...DEFAULT_ONBOARDING_CONSOLE },
      overridable: false,
      description:
        'the onboarding console: on or off, per act tool whether the agent runs it by itself (auto), only after the person says so (ask) or never (off), and the calls it may make per wake. Gates are never in it. Factory layer only, M1-gated',
    })
    .setting({
      key: ONBOARDING_AGENT_GUIDELINES_KEY,
      schema: AgentGuidelines.refine((g) => scanText(g.text).length === 0, {
        message: 'the guidelines hold something that looks like a secret',
        path: ['text'],
      }),
      default: { ...DEFAULT_AGENT_GUIDELINES },
      overridable: false,
      description:
        'the factory guidelines for the onboarding agent: plain text, read as fenced Guidance that can narrow what it does and never widen it. Factory layer only, M1-gated',
    });
}
