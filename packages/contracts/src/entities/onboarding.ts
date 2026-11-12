import { z } from 'zod';
import { ReleaseSetting } from './gate-relay.js';
import { hashCanonical } from '@aisdlc/kernel';
import { GateId } from '../flow.js';
import { LedgerDecision } from '../states/gate-instance.js';
import { OnboardingStatus } from '../states/onboarding.js';
import { Level, LevelValues, StepId, Tier } from '../values.js';
import { CatalogueRef } from './config.js';
import {
  CardId,
  CauseCode,
  GateInstanceId,
  IsoDateTime,
  LedgerEntryId,
  PrincipalId,
  ProjectId,
  RepoId,
  S0RecordId,
  Sha256Hex,
} from './ids.js';
import { GapDisposition } from './readiness.js';
import {
  GatingProfile,
  KillDelegation,
  RepoPlan,
  RoleMap,
  RoleSlot,
  TwoPerson,
} from './projects.js';
import { CriterionId } from './criteria.js';
import { FindingId, FindingState } from './knowledge.js';

// S0 onboarding records, steps and cards (DM §3.2, OB §6).

/** The S0 steps 0.1 to 0.5, taken from `StepId` (not re-listed). */
export const OnboardingStepId = StepId.extract(['0.1', '0.2', '0.3', '0.4', '0.5']);
export type OnboardingStepId = z.infer<typeof OnboardingStepId>;

/**
 * DM §3.2 `OnboardingStep.state`: `todo running card blocked done skip`. The PRR calls a step that
 * was not requested `not_requested`; here that is `skip` (see `PrrStepState` in readiness.ts).
 */
export const OnboardingStepState = z.enum(['todo', 'running', 'card', 'blocked', 'done', 'skip']);
export type OnboardingStepState = z.infer<typeof OnboardingStepState>;
export const OnboardingStepStateValues: readonly OnboardingStepState[] =
  OnboardingStepState.options;

export const OnboardingStep = z
  .strictObject({
    s0_id: S0RecordId,
    step: OnboardingStepId,
    state: OnboardingStepState,
    /** Why the step is blocked ("BLOCKED with a cause code", OB §6.2). */
    blocked_cause: CauseCode.nullable(),
    started_at: IsoDateTime.nullable(),
    finished_at: IsoDateTime.nullable(),
  })
  .refine((s) => s.state === 'blocked' || s.blocked_cause === null, {
    message: 'a cause code belongs to a blocked step',
    path: ['blocked_cause'],
  })
  .refine((s) => s.state !== 'blocked' || s.blocked_cause !== null, {
    message: 'a blocked step carries a cause code',
    path: ['blocked_cause'],
  });
export type OnboardingStep = z.infer<typeof OnboardingStep>;

/**
 * The S0 record. Its UUID is the gate subject of M4 and S0 X2 (fix #32); it is not a delivery item.
 * `intake_ref` is `s0_ref = record:<intake event>` (OB §6, never `g0_ref`).
 */
export const S0Record = z
  .strictObject({
    s0_id: S0RecordId,
    project_id: ProjectId,
    repo_id: RepoId,
    status: OnboardingStatus,
    requested_level: Level,
    /**
     * The highest level this onboarding can sign (DEC-9: "the human may sign a lower level"). Starts
     * equal to `requested_level`, is never above it, and drops when something blocks the higher
     * levels (an open secret at the Census: Light and Full are blocked, Census may still sign).
     */
    signable_level: Level,
    intake_ref: z.string().regex(/^record:\S+$/, 'record:<intake event>'),
    /** The step a send-back rejected at (`rejected_at:0.2`), once rejected. */
    rejected_at: OnboardingStepId.nullable(),
    /** The PRR version this record produced, once one exists. */
    readiness_version: z.number().int().min(1).nullable(),
    /** The catalogue revision this onboarding started with (M1.6). */
    catalogue_ref: CatalogueRef,
    version: z.number().int().min(1),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .refine((r) => LevelValues.indexOf(r.signable_level) <= LevelValues.indexOf(r.requested_level), {
    message: 'the signable level cannot be above the requested level',
    path: ['signable_level'],
  });
export type S0Record = z.infer<typeof S0Record>;

// ---------------------------------------------------------------- Cards

/** DM §3.2 `OnboardingCard.card`: `C1 C2 C3 C4 C5 SECR BATCH X2`. */
export const CardKind = z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'SECR', 'BATCH', 'X2']);
export type CardKind = z.infer<typeof CardKind>;
export const CardKindValues: readonly CardKind[] = CardKind.options;

/** DM §3.2 `OnboardingCard.role`: `admin intent sec m4 x`, taken from the role slots. */
export const CardRole = RoleSlot.extract(['admin', 'intent', 'sec', 'm4', 'x']);
export type CardRole = z.infer<typeof CardRole>;

/**
 * DM gives `OnboardingCard.status` no values. These cover what OB §6.3 and §6.2 describe: waiting,
 * decided, sent back (one send-back per step, DEC-9), rejected, withdrawn; the inbox adds expired
 * and superseded.
 */
export const CardStatus = z.enum([
  'open',
  'decided',
  'sent_back',
  'rejected',
  'withdrawn',
  // Inbox cards (M3.4): every gate on the card ran out of time, or was replaced by a new subject
  // hash. Neither is a decision, and neither approves anything.
  'expired',
  'superseded',
]);
export type CardStatus = z.infer<typeof CardStatus>;
export const CardStatusValues: readonly CardStatus[] = CardStatus.options;

export const ClaimVerdict = z.enum(['affirm', 'correct', 'unknown']);
export type ClaimVerdict = z.infer<typeof ClaimVerdict>;

/** A waiver asked for on a gap row (OB §7): a reason and an expiry, at most `MAX_WAIVER_DAYS` out. */
export const GapWaiverRequest = z.strictObject({
  reason: z.string().min(1).max(500),
  expires_at: IsoDateTime,
});
export type GapWaiverRequest = z.infer<typeof GapWaiverRequest>;

/**
 * What the human attests on card 4 about settings the factory cannot read (OB §5.5, §6.2 row 0.4).
 * Each claim is positive: a card that cannot attest one of them is not decided, it shows the
 * instruction and the re-check. `secret_scanning` says "on" or that the plan does not offer it.
 */
export const ControlsAttestation = z.strictObject({
  bypass_has_no_factory_app: z.literal(true),
  app_scope_selected: z.literal(true),
  github_token_readonly: z.literal(true),
  actions_cannot_approve_prs: z.literal(true),
  fork_pr_approval_required: z.literal(true),
  secret_scanning: z.enum(['on', 'plan_unavailable']),
  /** The owner states the GitHub plan (the App cannot read it, CF4). `unknown` leaves RS-ID-4 open. */
  plan: RepoPlan,
  /** At Light and above (OB §6.2 row 0.4). */
  operations_md: z.literal(true).optional(),
});
export type ControlsAttestation = z.infer<typeof ControlsAttestation>;

/**
 * One row of a list payload: a per-gap disposition (OB §7), a per-claim verdict (card 2), or one of
 * the decisions of the S0 cards. Everything a person decides on a card is a row, so the one payload
 * hash that goes into the ledger entry binds all of it (SP-PROC-2). Rows carry no secret value, no
 * fingerprint and no path.
 */
export const CardPayloadItem = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('gap_disposition'),
    gap_id: z.string().min(1),
    criterion: CriterionId,
    disposition: GapDisposition,
    /** Only with `waive`. */
    waiver: GapWaiverRequest.optional(),
  }),
  z.strictObject({
    kind: z.literal('claim_verdict'),
    claim_id: z.string().min(1),
    verdict: ClaimVerdict,
  }),
  /**
   * A work-item gate card (M12, Gap B): why the person rejected it or asked for changes (or said anything with
   * an approval). The payload's hash is bound into every ledger entry of the card's decision, so the reason
   * is part of what was decided, and it is the one place the reason is kept.
   */
  z.strictObject({
    kind: z.literal('decision_reason'),
    text: z.string().min(1).max(1000),
  }),
  /** Card 1: the owner(s) of the project (OB §6.2 row 0.1). */
  z.strictObject({
    kind: z.literal('owner_confirmation'),
    owners: z
      .array(PrincipalId)
      .min(1)
      .max(20)
      .refine((a) => new Set(a).size === a.length, { message: 'duplicate owner' }),
  }),
  /** Card 1: the tier as signed (raise-only from `floor`) and the attestations behind it (DEC-4). */
  z.strictObject({
    kind: z.literal('tier_decision'),
    tier: Tier,
    floor: Tier,
    /** "no prod, no real data, no dependants": required to sign T0. */
    t0_attested: z.boolean(),
    regulatory_attested: z.boolean(),
    criticality_attested: z.boolean(),
  }),
  /** Card 1: the owner disputes a piece of the evidence; recorded, never silently applied. */
  z.strictObject({
    kind: z.literal('evidence_dispute'),
    ref: z.string().min(1).max(120),
    note: z.string().min(1).max(500),
  }),
  /** Card 1: the census and the gap ledger as disposed, hashed (one of the three hashes of M4). */
  z.strictObject({
    kind: z.literal('gap_ledger'),
    census_hash: Sha256Hex,
    gap_ledger_hash: Sha256Hex,
    gaps: z.number().int().min(0),
  }),
  /** Card 4: the controls report the person was shown. */
  z.strictObject({
    kind: z.literal('controls_report'),
    report_hash: Sha256Hex,
    reduced: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('controls_attestation'), attestation: ControlsAttestation }),
  /** Card 4: the settings the person confirmed or edited (they become a config revision). */
  z.strictObject({
    kind: z.literal('settings_decision'),
    tier: Tier,
    role_map: RoleMap,
    two_person: TwoPerson,
    gating_profile: GatingProfile,
    kill_delegations: z.array(KillDelegation),
    /** M15.5: card 4's release choice (`project.release`); absent: card 4 did not ask (keep the one in force). */
    release: ReleaseSetting.nullable().optional(),
  }),
  /** Card 5: the hashes the sign-off covers (OB §6.2 row 0.5), and the PRR M4 binds to. */
  z.strictObject({
    kind: z.literal('m4_package'),
    census_hash: Sha256Hex,
    gap_ledger_hash: Sha256Hex,
    controls_report_hash: Sha256Hex,
    /** The `record_hash` of the proposed Project Readiness Record: the M4 gate's subject hash. */
    prr_record_hash: Sha256Hex,
  }),
  /** The security card: a finding's new state. The reason stays in the Security store. */
  z.strictObject({
    kind: z.literal('finding_state'),
    finding_id: FindingId,
    state: FindingState.exclude(['open']),
  }),
]);
export type CardPayloadItem = z.infer<typeof CardPayloadItem>;

/** The key that makes a row unique in a payload: a second row with the same key is refused. */
export function cardPayloadItemKey(item: CardPayloadItem): string {
  switch (item.kind) {
    case 'gap_disposition':
      return `gap:${item.gap_id}`;
    case 'claim_verdict':
      return `claim:${item.claim_id}`;
    case 'evidence_dispute':
      return `dispute:${item.ref}`;
    case 'finding_state':
      return `finding:${item.finding_id}`;
    default:
      return item.kind;
  }
}

/** `hashCanonical` of the list payload: the one hash a 50-row decision binds to (SP-PROC-2). */
export function cardPayloadHash(payload: readonly CardPayloadItem[]): string {
  return hashCanonical(payload);
}

/**
 * One decision a card carries. A card can carry several (card 5 is the 0.5 sign-off and then M4), so
 * the target is a step or a gate; each decision becomes its own ledger entry.
 */
export const CardDecision = z.strictObject({
  target: z.union([StepId, GateId]),
  gate_instance_id: GateInstanceId.nullable(),
  decision: LedgerDecision.nullable(),
  ledger_entry_id: LedgerEntryId.nullable(),
});
export type CardDecision = z.infer<typeof CardDecision>;

export const Card = z
  .strictObject({
    card_id: CardId,
    s0_id: S0RecordId,
    card: CardKind,
    status: CardStatus,
    role: CardRole,
    decisions: z.array(CardDecision).min(1),
    payload: z.array(CardPayloadItem),
    payload_hash: Sha256Hex,
    send_backs: z.number().int().min(0),
    created_at: IsoDateTime,
    decided_at: IsoDateTime.nullable(),
  })
  .refine((c) => c.payload_hash === cardPayloadHash(c.payload), {
    message: 'payload_hash does not match the payload',
    path: ['payload_hash'],
  })
  .refine((c) => c.status !== 'decided' || c.decisions.every((d) => d.ledger_entry_id !== null), {
    message: 'a decided card has a ledger entry for every decision',
    path: ['decisions'],
  });
export type Card = z.infer<typeof Card>;
