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

type Snapshot = {
  readonly rejected: readonly string[];
  readonly revisions?: { readonly factory: string | null };
  get(key: string): unknown;
};

/**
 * `onboarding.console` from a config reader's snapshot. A published value that does not read is NOT the default: the
 * console is off until a person fixes it (fail closed).
 */
export function onboardingConsoleFrom(c: Snapshot): OnboardingConsoleConfig {
  if (c.rejected.includes(ONBOARDING_CONSOLE_KEY))
    return { ...DEFAULT_ONBOARDING_CONSOLE, enabled: false };
  const p = OnboardingConsoleConfig.safeParse(
    c.get(ONBOARDING_CONSOLE_KEY) ?? DEFAULT_ONBOARDING_CONSOLE,
  );
  return p.success ? p.data : { ...DEFAULT_ONBOARDING_CONSOLE, enabled: false };
}

/**
 * `onboarding.agent_guidelines` from a snapshot, with the factory revision it came from (recorded on each turn). A
 * value that does not read is empty guidelines, never a guess.
 */
export function agentGuidelinesFrom(c: Snapshot): { text: string; revision: string } {
  const revision = c.revisions?.factory ?? 'default';
  if (c.rejected.includes(ONBOARDING_AGENT_GUIDELINES_KEY)) return { text: '', revision };
  const p = AgentGuidelines.safeParse(
    c.get(ONBOARDING_AGENT_GUIDELINES_KEY) ?? DEFAULT_AGENT_GUIDELINES,
  );
  return { text: p.success ? p.data.text : '', revision };
}
