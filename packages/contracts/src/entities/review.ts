import { z } from 'zod';
import { GitSha, PrincipalId, Sha256Hex } from './ids.js';
import { UnitKey } from './planning.js';

// G4 review (FL 8.1, PLAN M15.1): the merge approval, NEVER skipped. Its review mode is decided by the factory, from the
// item, when G4 opens, and recorded with the card (the gate's facts, under `g4_review`, and in its subject hash):
//
//   mode C  a CODEOWNERS owner of the changed paths reads the diff and decides (the `g4` slot narrowed to them)
//   mode E  an evidence approver decides on the Evidence Pack alone (any holder of the `g4` slot); 9.5 samples it later
//
// Anything the factory is unsure of is mode C (B14's rule, applied up front): the changed paths unknown, CODEOWNERS
// unreadable, no governing readiness record, a changed path in an area with a critical unknown (R3 zone). A sensitive
// path is mode C AND the D37 step-up. Mode E is only what is left: every input known and none of them asks for C. The
// card binds the passing Evidence Pack of exactly each PR head: a new push is a new head, and an approval of the old
// one no longer stands (`G4Standing`).

export const ReviewMode = z.enum(['E', 'C']);
export type ReviewMode = z.infer<typeof ReviewMode>;

export const ReviewReason = z.enum([
  /** Mode E: every input is known and none asks for mode C. */
  'evidence_sufficient',
  /** B14: the mode-E approver was unsure; the same review goes to a codeowner. */
  'b14_unsure',
  /** A changed path matches the sensitive or protected globs: codeowner plus the D37 step-up. */
  'sensitive_path',
  /** The changed paths of a head are not in the record: unsure, and treated as sensitive (step-up). */
  'paths_unknown',
  /** The repo's CODEOWNERS could not be read: unsure. */
  'codeowners_unreadable',
  /** The repo has no governing readiness record now: unsure. */
  'no_governing_prr',
  /** The repo's posture puts G4 in mode C on every PR (amber, OB §2.3). */
  'posture',
  /** The effective autonomy is A0 (Census, red posture: "A0 with G4-C"). */
  'autonomy_a0',
  /** A changed path is in an area with a critical unknown (the PRR's R3 zones): unsure. */
  'r3_zone',
  /** A human wrote the change (L8, or a developer who took the item over): a codeowner reads it. */
  'human_led',
]);
export type ReviewReason = z.infer<typeof ReviewReason>;

/** The reasons that also need the D37 step-up to decide G4. */
export const REVIEW_STEP_UP_REASONS: readonly ReviewReason[] = ['sensitive_path', 'paths_unknown'];

/** One Unit's pull request as G4 binds it: the head, and the passing Evidence Pack signed for exactly that head. */
export const G4ReviewUnit = z.strictObject({
  unit_key: UnitKey,
  pr_number: z.number().int().min(1),
  head_sha: GitSha,
  base_sha: GitSha,
  pack_sha256: Sha256Hex,
});
export type G4ReviewUnit = z.infer<typeof G4ReviewUnit>;

/**
 * Who may decide: `path_owners` narrows the `g4` slot to the principals linked to the CODEOWNERS owners of the changed
 * paths (the gate's `deciders`); `g4_slot` is every holder of the slot (mode E, or mode C when no changed path has an
 * owner the factory can map to a principal).
 */
export const G4DecidersBasis = z.enum(['path_owners', 'g4_slot']);
export type G4DecidersBasis = z.infer<typeof G4DecidersBasis>;

export const G4_REVIEW_SCHEMA = 'g4-review/1';
/** The key of the review in the G4 gate's facts. */
export const G4_REVIEW_FACT = 'g4_review';

export const G4Review = z
  .strictObject({
    schema: z.literal(G4_REVIEW_SCHEMA),
    mode: ReviewMode,
    /** Why: every reason that applied, in a fixed order. Mode E has exactly `evidence_sufficient`. */
    reasons: z.array(ReviewReason).min(1).max(16),
    units: z.array(G4ReviewUnit).min(1).max(50),
    /** The evidence the decider is shown: the pack's sha256 for one Unit, the hash of `units` for several. */
    evidence_sha256: Sha256Hex,
    changed_paths: z.strictObject({
      /** `null` when the paths are not in the record (`paths_unknown`). */
      count: z.number().int().min(0).nullable(),
      sha256: Sha256Hex.nullable(),
    }),
    /** The changed paths that are sensitive (first 50, sorted). */
    sensitive_paths: z.array(z.string().min(1).max(1024)).max(50),
    step_up: z.boolean(),
    deciders: z.strictObject({
      basis: G4DecidersBasis,
      /** `path_owners`: the principals; `g4_slot`: empty (the slot's holders when a vote is cast). */
      principals: z.array(PrincipalId).max(64),
    }),
    codeowners: z.strictObject({
      read: z.enum(['ok', 'none', 'unreadable']),
      /** The base commit CODEOWNERS was read at (what is in force on the target branch, never the head's). */
      at_sha: GitSha.nullable(),
      /** Owners of changed paths that map to no principal: user logins without a link, and every team. */
      unmapped: z.array(z.string().min(1).max(200)).max(64),
    }),
    /** People who wrote the change (a takeover, an L8 developer): barred from deciding like the requester. */
    authors: z.array(PrincipalId).max(8),
  })
  .refine(
    (r) =>
      r.mode === 'E'
        ? r.reasons.length === 1 && r.reasons[0] === 'evidence_sufficient'
        : !r.reasons.includes('evidence_sufficient'),
    { message: 'mode E has exactly `evidence_sufficient`; mode C never does', path: ['reasons'] },
  )
  .refine((r) => r.step_up === r.reasons.some((x) => REVIEW_STEP_UP_REASONS.includes(x)), {
    message: 'the step-up follows the reasons',
    path: ['step_up'],
  })
  .refine((r) => (r.deciders.basis === 'path_owners') === r.deciders.principals.length > 0, {
    message: '`path_owners` names its principals; `g4_slot` names none',
    path: ['deciders'],
  })
  .refine((r) => r.mode === 'C' || r.deciders.basis === 'g4_slot', {
    message: 'mode E is decided by the g4 slot',
    path: ['deciders'],
  });
export type G4Review = z.infer<typeof G4Review>;

/**
 * Whether the item's G4 still stands for what is on the PRs now. `head_moved`: G4 was approved, then a PR got a new
 * head (a new push): the approval was of the old head and no longer applies.
 */
export const G4StandingState = z.enum([
  'none',
  'pending',
  'approved',
  'changes_requested',
  'rejected',
  'ended',
  'head_moved',
]);
export type G4StandingState = z.infer<typeof G4StandingState>;
