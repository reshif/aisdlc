import { hashCanonical } from '@aisdlc/kernel';
import { RULES } from './rules.js';

/** Bumped by hand when the meaning of the ruleset changes; the hash below catches every edit. */
export const RULESET_REVISION = 1;

/**
 * `secrets-rules/<revision>:<12 hex of a hash over every rule's id, regex, keywords, entropy and
 * allow patterns>`. Recorded with every scan (`rules_version`), so a finding set is tied to the rules
 * that produced it, and any edit to a rule changes it.
 */
export const rulesVersion = (rules = RULES): string =>
  `secrets-rules/${RULESET_REVISION}:${hashCanonical(
    rules.map((r) => ({
      id: r.id,
      regex: r.regex.source,
      flags: r.regex.flags,
      keywords: r.keywords,
      group: r.secretGroup ?? 0,
      entropy: r.entropy ?? null,
      allow: (r.allow ?? []).map((a) => a.source),
    })),
  ).slice(0, 12)}`;

export const RULES_VERSION = rulesVersion();
