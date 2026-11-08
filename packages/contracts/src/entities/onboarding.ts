import { z } from 'zod';
import { hashCanonical } from '@aisdlc/kernel';
import { GateId } from '../flow.js';
import { LedgerDecision } from '../states/gate-instance.js';
import { OnboardingStatus } from '../states/onboarding.js';
import { Level, LevelValues, StepId } from '../values.js';
import { CatalogueRef } from './config.js';
import {
  CardId,
  CauseCode,
  GateInstanceId,
  IsoDateTime,
  LedgerEntryId,
  ProjectId,
  RepoId,
  S0RecordId,
  Sha256Hex,
} from './ids.js';
import { GapDisposition } from './readiness.js';
import { RoleSlot } from './projects.js';
import { CriterionId } from './criteria.js';

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

/** One row of a list payload: a per-gap disposition (OB §7) or a per-claim verdict (card 2). */
export const CardPayloadItem = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('gap_disposition'),
    gap_id: z.string().min(1),
    criterion: CriterionId,
    disposition: GapDisposition,
  }),
  z.strictObject({
    kind: z.literal('claim_verdict'),
    claim_id: z.string().min(1),
    verdict: ClaimVerdict,
  }),
]);
export type CardPayloadItem = z.infer<typeof CardPayloadItem>;

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
