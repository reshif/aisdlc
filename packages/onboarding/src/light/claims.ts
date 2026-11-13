import {
  readinessPolicy,
  type DetectorEvidence,
  type Fact,
  type LightClaim,
  type LightClaimCategory,
} from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import { scanText } from '@aisdlc/secrets-rules';
import { lintText } from '@aisdlc/text-lint';

// The static cartographer (OB §6.2 row 0.2, DEC-15(d): it stands in for A9 at Light until A9 is
// real): at most 50 high-impact claims about the repo, each a sentence built from ONE detector fact
// and carrying that fact's evidence {path, blob, line}. Claims are linted before they are kept
// (OB §4.1 item 5: "lint claim and unknown text"), and the evidence validator drops any claim whose
// evidence is not in the facts: a claim the facts cannot back is a fabrication. Pure.

/** Higher first: what a wrong claim would cost most (a deploy on merge, the tier, the commands). */
const PRIORITY: readonly LightClaimCategory[] = [
  'deploy',
  'risk',
  'command',
  'instructions',
  'ownership',
  'dependencies',
  'stack',
  'presence',
];

const claimId = (category: string, text: string): string =>
  `cl-${sha256Hex(`${category}\n${text}`).slice(0, 16)}`;

const ev = (f: Fact): DetectorEvidence[] => f.evidence.slice(0, 20);

function claimOf(f: Fact): { category: LightClaimCategory; text: string } | null {
  switch (f.kind) {
    case 'stack':
      return {
        category: 'stack',
        text: `The repository uses ${f.name} (${f.category.replace('_', ' ')}).`,
      };
    case 'task_command':
      return f.state === 'found' && f.invocation !== null
        ? {
            category: 'command',
            text: `The task \`${f.name}\` runs as \`${f.invocation}\`${f.source ? ` (from ${f.source})` : ''}.`,
          }
        : null;
    case 'lockfile':
      return {
        category: 'dependencies',
        text:
          f.state === 'present' && f.lockfile !== null
            ? `The dependencies of ${f.manifest} are locked in ${f.lockfile}.`
            : `${f.manifest} has no lockfile.`,
      };
    case 'codeowners':
      return f.state === 'present' && f.path !== null
        ? {
            category: 'ownership',
            text: `CODEOWNERS at ${f.path} has ${f.rule_count} rule(s)${f.protected_set.covered ? ' and covers the protected files' : '; some protected files have no owner'}.`,
          }
        : null;
    case 'instruction_file':
      return f.state === 'data'
        ? {
            category: 'instructions',
            text: `${f.inventory.replaceAll('_', ' ')} is present (${f.file_count} file(s))${f.auto_run === 'yes' ? ' and runs code on its own' : ''}.`,
          }
        : null;
    case 'apply_on_merge':
      return {
        category: 'deploy',
        text: `The default branch may deploy on every merge (${f.rule.replaceAll('_', ' ')} in ${f.path}, ${f.confidence} confidence).`,
      };
    case 'tier_signal':
      return {
        category: 'risk',
        text: `The signal ${f.signal} (${f.criterion.replace('_', ' ')}) raises the tier floor to ${f.floor}.`,
      };
    case 'presence':
      return f.state === 'present'
        ? { category: 'presence', text: `The repository has ${f.item.replaceAll('_', ' ')}.` }
        : null;
    default:
      // Workflow findings are security (B5) and lint findings are counts: not claims.
      return null;
  }
}

/** A claim's text is clean: no secret, no blocking lint finding (it may reach an agent as data). */
const clean = (text: string): boolean =>
  scanText(text).length === 0 && !lintText(text).some((f) => f.severity === 'blocking');

export interface CartographerResult {
  readonly claims: LightClaim[];
  /** Claims left out by the validator or the lint. */
  readonly dropped: number;
  readonly truncated: boolean;
}

/**
 * The evidence validator: a claim is kept only if every evidence item is the evidence of a fact
 * (same path, blob and line). A claim with no evidence, or with evidence the facts do not hold, is
 * dropped. Used on the cartographer's claims and, later, on A9's.
 */
export function validateClaims(
  claims: readonly LightClaim[],
  facts: readonly Fact[],
): { kept: LightClaim[]; dropped: number } {
  const known = new Set(
    facts.flatMap((f) => f.evidence.map((e) => `${e.path}\0${e.blob}\0${e.line}`)),
  );
  const kept = claims.filter(
    (c) =>
      c.evidence.length > 0 &&
      c.evidence.every((e) => known.has(`${e.path}\0${e.blob}\0${e.line}`)),
  );
  return { kept, dropped: claims.length - kept.length };
}

export function cartographerClaims(facts: readonly Fact[]): CartographerResult {
  const made: LightClaim[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const f of facts) {
    const c = claimOf(f);
    if (c === null || f.evidence.length === 0) continue;
    if (!clean(c.text)) {
      dropped++;
      continue;
    }
    const id = claimId(c.category, c.text);
    if (seen.has(id)) continue;
    seen.add(id);
    made.push({ claim_id: id, category: c.category, text: c.text, evidence: ev(f) });
  }
  const v = validateClaims(made, facts);
  const ranked = v.kept.sort(
    (a, b) =>
      PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category) ||
      (a.claim_id < b.claim_id ? -1 : a.claim_id > b.claim_id ? 1 : 0),
  );
  return {
    claims: ranked.slice(0, readinessPolicy().max_light_claims),
    dropped: dropped + v.dropped,
    truncated: ranked.length > readinessPolicy().max_light_claims,
  };
}
