import { RULES, type SecretRule } from './rules.js';
import { shannonEntropy } from './entropy.js';

/**
 * One match. `value` is the secret itself, for in-memory fingerprinting only: a caller redacts
 * (drops `value`) before anything is stored, logged or returned (OB §5.3 item 4).
 */
export interface RuleMatch {
  readonly rule_id: string;
  /** 1-based line of the start of the secret. */
  readonly line: number;
  readonly value: string;
}

/** A match with the value removed: the only shape that may leave the scanning function. */
export type RedactedMatch = Omit<RuleMatch, 'value'>;

export const redact = (m: RuleMatch): RedactedMatch => ({ rule_id: m.rule_id, line: m.line });

const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
};

/**
 * Runs `rules` over `text`. A rule whose keywords are all absent never runs its regex. A match
 * whose secret is below the rule's entropy floor, or matches an allow pattern, is not a finding.
 * Matches come back in text order per rule; identical (rule, line, value) matches are returned once.
 */
export function scanText(text: string, rules: readonly SecretRule[] = RULES): RuleMatch[] {
  const lower = rules.some((r) => r.keywords.length > 0) ? text.toLowerCase() : '';
  const out: RuleMatch[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.keywords.length > 0 && !rule.keywords.some((k) => lower.includes(k))) continue;
    for (const m of text.matchAll(rule.regex)) {
      const value = m[rule.secretGroup ?? 0];
      if (value === undefined || value === '') continue;
      if (rule.entropy !== undefined && shannonEntropy(value) < rule.entropy) continue;
      if (rule.allow?.some((a) => a.test(value))) continue;
      // The start of the secret inside the match: the group's own offset is not in a plain exec.
      const inMatch = m[0].indexOf(value);
      const line = lineAt(text, (m.index ?? 0) + Math.max(0, inMatch));
      const key = `${rule.id}\0${line}\0${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule_id: rule.id, line, value });
    }
  }
  return out;
}
