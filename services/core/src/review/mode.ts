import { ruleFor, type ParsedCodeowners } from '@aisdlc/codeowners';
import {
  REVIEW_STEP_UP_REASONS,
  type Autonomy,
  type ReviewMode,
  type ReviewReason,
} from '@aisdlc/contracts';
import { matchesAny } from '@aisdlc/tripwires';

// G4's review mode (FL 8.1), decided from the item and nothing else: a pure function, the same inputs giving the same
// mode and reasons. Every input the factory is unsure of sends the review to a codeowner (B14's rule applied up front),
// a sensitive path also needs the D37 step-up, and mode E (an evidence approver on the pack alone) is only what is left.

/** What the readiness record governing the repo says now, or `null` when none governs it. */
export interface ReviewPrrFacts {
  readonly effective: Autonomy;
  /** `null` is green: no posture constraint. */
  readonly posture_cap: Autonomy | null;
  /** Area globs with a critical unknown (R3). */
  readonly r3_zones: readonly string[];
}

export interface ReviewModeInput {
  /** The engine says B14 was taken: the mode-E approver was unsure. */
  readonly b14: boolean;
  /** A human wrote the change: an L8 item, or a developer took it over. */
  readonly human_authored: boolean;
  /** Every changed path of every PR head, or `null` when one head's paths are not in the record. */
  readonly changed_paths: readonly string[] | null;
  /** Sensitive and protected globs (CODEOWNERS syntax). */
  readonly sensitive_globs: readonly string[];
  /** CODEOWNERS at the base: parsed, absent (`none`), or not readable. */
  readonly codeowners:
    | { readonly read: 'ok'; readonly parsed: ParsedCodeowners }
    | { readonly read: 'none' }
    | { readonly read: 'unreadable' };
  readonly prr: ReviewPrrFacts | null;
  /** The posture caps the pinned catalogue says put G4 in mode C on every PR (`autonomy.posture[*].g4_mode_c`). */
  readonly mode_c_posture_caps: readonly Autonomy[];
  /** B19 (M15.4): the project's mode-E audit sample suspended mode E. */
  readonly mode_e_suspended: boolean;
}

export interface ReviewModeDecision {
  readonly mode: ReviewMode;
  readonly reasons: readonly ReviewReason[];
  readonly step_up: boolean;
  /** Changed paths that are sensitive, sorted. */
  readonly sensitive_paths: readonly string[];
  /** The CODEOWNERS user logins (lower case) that own at least one changed path, sorted. */
  readonly owner_logins: readonly string[];
  /** Owners of changed paths the factory cannot map to one principal: teams and e-mail addresses. */
  readonly other_owners: readonly string[];
}

/** The fixed order reasons are reported in (the contract's order). */
const ORDER: readonly ReviewReason[] = [
  'b14_unsure',
  'sensitive_path',
  'paths_unknown',
  'codeowners_unreadable',
  'no_governing_prr',
  'posture',
  'autonomy_a0',
  'r3_zone',
  'human_led',
  'mode_e_suspended',
];

export function decideReviewMode(i: ReviewModeInput): ReviewModeDecision {
  const why = new Set<ReviewReason>();
  if (i.b14) why.add('b14_unsure');
  const paths = i.changed_paths === null ? null : [...new Set(i.changed_paths)].sort();
  if (paths === null) why.add('paths_unknown');
  const sensitive = (paths ?? []).filter((p) => matchesAny(p, i.sensitive_globs));
  if (sensitive.length > 0) why.add('sensitive_path');
  if (i.codeowners.read === 'unreadable') why.add('codeowners_unreadable');
  if (i.prr === null) why.add('no_governing_prr');
  else {
    if (i.prr.posture_cap !== null && i.mode_c_posture_caps.includes(i.prr.posture_cap))
      why.add('posture');
    if (i.prr.effective === 'A0') why.add('autonomy_a0');
    if ((paths ?? []).some((p) => matchesAny(p, i.prr?.r3_zones ?? []))) why.add('r3_zone');
  }
  if (i.human_authored) why.add('human_led');
  if (i.mode_e_suspended) why.add('mode_e_suspended');

  const users = new Set<string>();
  const others = new Set<string>();
  if (i.codeowners.read === 'ok') {
    for (const p of paths ?? []) {
      for (const o of ruleFor(i.codeowners.parsed, p)?.owners ?? []) {
        if (o.kind === 'user') users.add(o.login.toLowerCase());
        else others.add(o.kind === 'team' ? `@${o.org}/${o.slug}` : o.email);
      }
    }
  }
  const reasons = ORDER.filter((r) => why.has(r));
  return {
    mode: reasons.length > 0 ? 'C' : 'E',
    reasons: reasons.length > 0 ? reasons : ['evidence_sufficient'],
    step_up: reasons.some((r) => REVIEW_STEP_UP_REASONS.includes(r)),
    sensitive_paths: sensitive,
    owner_logins: [...users].sort(),
    other_owners: [...others].sort(),
  };
}
