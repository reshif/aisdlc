import { z } from 'zod';
import { RepoFullName } from './codehost.js';
import { GitSha, S0RecordId, Sha256Hex } from './ids.js';

// The affirmed pack's git projection (PLAN M16; onboarding-roadmap §4.1 item 7, §6.4, R2b; DEC-11 refined, DEC-12(a)
// record-first, DEC-13(a)(i)).
//
// What card 2 affirmed lives in the RECORD: the instruction text by hash (the proposal or an edit holds it), the
// claims as decided, the intent answers. That record copy is what agents receive. The files in git are a rendered
// PROJECTION of it, written by the factory and never re-read as authority:
//
//   1. once card 2 is applied (approved), the factory renders the pack deterministically from the record
//      (`renderOnboardingPack`) and RECORDS it first (`pack.rendered`: every file by path and sha256, and the patch
//      hash) on `pack:<s0>`;
//   2. the pack touches protected paths (AGENTS.md, CLAUDE.md, `.factory/**`), so it opens X2 on the S0 record (the
//      record's UUID is the gate subject, fix #32), bound to exactly that patch hash (`pack.x2_opened`);
//   3. only after X2 is decided `approve` in the ledger does the factory ask the Push Broker for a draft PR on
//      `agent/<s0>/onboarding-pack` (the broker asks core for the lease and the X2 binding itself, and refuses a
//      different patch); the intent and the receipt are recorded as for every push (`push:<s0>`, record + ledger);
//   4. a person merges the PR, or does not. The factory never merges; gate-check's `s0` profile never passes it.
//
// CODEOWNERS (M16): rendered only when the repo has none at the census head, from the project's PUBLISHED role map: the
// admin slot's people as the GitHub logins identity links them to among the repo's collaborators. Who resolved to
// which login, and who stayed out and why, is RECORDED once before the first render (`pack.codeowners_resolved`), so
// the render stays a pure function of the record; the factory never invents an owner.

/** The Unit key of an onboarding pack push: its branch is `agent/<s0 id>/onboarding-pack`. */
export const ONBOARDING_PACK_UNIT = 'onboarding-pack';
/**
 * The Unit key of the Full pack (M17, the oracle lock through X2): card 3's oracle lock and the seeds it affirmed
 * `intended`, on their own branch `agent/<s0 id>/onboarding-full-pack` and their own X2 (step 0.3's artefact).
 */
export const ONBOARDING_FULL_PACK_UNIT = 'onboarding-full-pack';
/** Where the oracle lock lives in the repo (DM §3.2 OracleLock). A protected path (`.factory/**`). */
export const ORACLE_LOCK_PATH = '.factory/oracle-lock.json';
export const ORACLE_LOCK_SCHEMA_ID = 'oracle-lock/1';

/** Which projection a pack is: card 2's (Light, step 0.2) or card 3's (Full, step 0.3). */
export const PackKind = z.enum(['light', 'full']);
export type PackKind = z.infer<typeof PackKind>;
/** The Unit key, the S0 step and the X2 facts kind of each pack. */
export const PACK_KINDS: Readonly<
  Record<
    PackKind,
    { readonly unit: string; readonly step: '0.2' | '0.3'; readonly facts_kind: string }
  >
> = {
  light: { unit: ONBOARDING_PACK_UNIT, step: '0.2', facts_kind: 'onboarding_pack' },
  full: { unit: ONBOARDING_FULL_PACK_UNIT, step: '0.3', facts_kind: 'onboarding_full_pack' },
};
/** The broker's `lane` for an onboarding pack: not a delivery lane (S0 is not an item), never the spike lane. */
export const ONBOARDING_PACK_LANE = 'S0';
/** The one lease epoch an onboarding pack is pushed under (it has no Unit and no lease of its own). */
export const ONBOARDING_PACK_EPOCH = 1;
export const ONBOARDING_PACK_RENDERER = 'onboarding-pack/1';

export const packStream = (s0Id: string): string => `pack:${s0Id}`;
export const PACK_EVENT = {
  /** Who the pack's CODEOWNERS names (or why it has none): recorded once, before the first render. */
  codeowners_resolved: 'pack.codeowners_resolved',
  rendered: 'pack.rendered',
  x2_opened: 'pack.x2_opened',
} as const;

/** Where a pack file's content comes from in the record. */
export const PackFileSource = z.enum([
  'affirmed_instructions',
  'claims',
  'unknowns',
  'intent',
  'manifest',
  /** card 3's oracle lock proposal, as affirmed (`.factory/oracle-lock.json`). */
  'oracle_lock',
  /** a living-spec seed card 3 affirmed `intended` (`specs/<area>.md`). */
  'seed',
  'codeowners',
]);
export type PackFileSource = z.infer<typeof PackFileSource>;

/** Where the pack's CODEOWNERS goes (GitHub's first location). */
export const PACK_CODEOWNERS_PATH = '.github/CODEOWNERS';

/** Why the pack does (`rendered`) or does not hold a CODEOWNERS. */
export const PackCodeownersOutcome = z.enum([
  'rendered',
  /** The repo already has one at the census head: the factory never replaces a person's file. */
  'repo_has_codeowners',
  /** No role map is published for the project yet (a first onboarding publishes it at card 4's M1). */
  'role_map_unpublished',
  /** The admin slot names nobody, or nobody in it is linked to a login with access to the repo. */
  'no_owner_mapped',
]);
export type PackCodeownersOutcome = z.infer<typeof PackCodeownersOutcome>;

export const PackCodeownersResolvedPayload = z.strictObject({
  s0_id: S0RecordId,
  outcome: PackCodeownersOutcome,
  /** Each person of the admin slot: the login it maps to, or why it stays out. */
  owners: z
    .array(
      z.strictObject({
        principal_id: z.string().min(1).max(200),
        login: z.string().min(1).max(39).nullable(),
        reason: z.enum(['mapped', 'no_linked_login']),
      }),
    )
    .max(50),
});
export type PackCodeownersResolvedPayload = z.infer<typeof PackCodeownersResolvedPayload>;

export const PackFile = z.strictObject({
  path: z.string().min(1).max(300),
  source: PackFileSource,
  /** sha256 of the file's bytes as rendered. */
  sha256: Sha256Hex,
  bytes: z.number().int().min(0),
  /** The protected-path rule it falls under (`protectedPushPath`), or `null`. */
  protected_rule: z.string().max(40).nullable(),
});
export type PackFile = z.infer<typeof PackFile>;

export const PackRenderedPayload = z.strictObject({
  s0_id: S0RecordId,
  project_id: z.string().min(1),
  repo: RepoFullName,
  /** The commit the pack is written on top of: the census head card 2 was about. */
  base_sha: GitSha,
  /** Absent on a Light pack (every pack before M17); `full` for card 3's. */
  kind: PackKind.optional(),
  /**
   * The deciding card and its payload hash (what the projection renders): card 2 for a Light pack, card 3 for a
   * Full one (the field names are the first release's and stay, so older events keep parsing).
   */
  c2_card_id: z.string().uuid(),
  c2_payload_hash: Sha256Hex,
  renderer: z.literal(ONBOARDING_PACK_RENDERER),
  files: z.array(PackFile).min(1).max(50),
  /** `patchHashOf` of the rendered patch: what X2 is bound to and what the broker hashes again. */
  patch_hash: Sha256Hex,
  rendered_at: z.string().datetime(),
});
export type PackRenderedPayload = z.infer<typeof PackRenderedPayload>;

export const PackX2OpenedPayload = z.strictObject({
  s0_id: S0RecordId,
  patch_hash: Sha256Hex,
  card_id: z.string().uuid(),
  gate_instance_id: z.string().min(1),
});
export type PackX2OpenedPayload = z.infer<typeof PackX2OpenedPayload>;

/** Where an S0 record's pack projection stands (derived from the record and the ledger, never stored as truth). */
export const PackProjectionState = z.enum([
  /** the deciding card (card 2 for Light, card 3 for Full) is not applied (approved) yet: nothing to render. */
  'waiting_for_c2',
  /** rendered and recorded; X2 is open, waiting for a decision. */
  'x2_pending',
  /** X2 was rejected (or expired): nothing is pushed. A new card 2 renders a new pack. */
  'x2_rejected',
  /** X2 approved; the push was not (yet) answered. */
  'x2_approved',
  /** the Push Broker opened (or updated) the draft PR. */
  'pushed',
  /** the Push Broker refused (its code says why). */
  'refused',
]);
export type PackProjectionState = z.infer<typeof PackProjectionState>;

export const PackProjectionView = z.strictObject({
  s0_id: S0RecordId,
  /** Absent: the Light pack. */
  kind: PackKind.optional(),
  state: PackProjectionState,
  patch_hash: Sha256Hex.nullable(),
  files: z.array(PackFile),
  x2_card_id: z.string().uuid().nullable(),
  pr_number: z.number().int().min(1).nullable(),
  head_sha: GitSha.nullable(),
  refusal: z.string().max(40).nullable(),
});
export type PackProjectionView = z.infer<typeof PackProjectionView>;
