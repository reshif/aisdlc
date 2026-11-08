import { z } from 'zod';
import { GateId, type GateId as GateIdType } from '../flow.js';
import { GateStatus } from '../states/gate-instance.js';
import { StepId } from '../values.js';
import { SubjectKind, VoteDecision } from './decisions.js';
import {
  CardId,
  GateInstanceId,
  IsoDateTime,
  LedgerEntryId,
  PrincipalId,
  ProjectId,
  Sha256Hex,
} from './ids.js';
import { CardKind, CardPayloadItem, CardStatus } from './onboarding.js';
import { RoleSlot } from './projects.js';

// The inbox (PLAN M3.4, DM §3.4 and §3.9, OB §6.3 and §7, FL PROFILES and B21).
//
// A card is what a human sees: one or more gate instances (and/or step decisions) of ONE subject.
// A card owns no decision. Deciding it writes one ledger entry per contained decision, so the
// ledger stays per gate and a card is a read model over gate instances plus its own record stream
// `card:<id>`. This is the inbox card; `Card` in onboarding.ts is the S0 document of a step card.

/** The record stream of a card. */
export const cardStream = (id: string): string => `card:${id}`;

export const CARD_EVENT = {
  opened: 'card.opened',
  payload_recorded: 'card.payload_recorded',
  decided: 'card.decided',
  escalated: 'card.escalated',
  /** A card with no gate (an S0 step card) that nobody can decide any more: its record moved on. */
  withdrawn: 'card.withdrawn',
} as const;
export const CardEventType = z.enum([
  CARD_EVENT.opened,
  CARD_EVENT.payload_recorded,
  CARD_EVENT.decided,
  CARD_EVENT.escalated,
  CARD_EVENT.withdrawn,
]);
export type CardEventType = z.infer<typeof CardEventType>;

/** `entry_type` of the ledger entry a card step decision writes (it has no gate instance). */
export const CARD_STEP_ENTRY_TYPE = 'card.step_decision';

// ---------------------------------------------------------------- SOLO consolidation (FL PROFILES)

/**
 * The single-operator cards of FL PROFILES: card 1 G0+G1, card 2 G2+oracles, card 3 G3d+G3+G3s,
 * card 4 G4 alone, card 5 G5+G6 when the requester is the operator. Only gates whose policy says
 * `consolidatable` may share a card; X, E, M, Q and SECT never do (they are in no group, so they
 * always get a card of their own). G1f is not in the flow's list and stays alone.
 */
export const SoloCardId = z.enum(['solo1', 'solo2', 'solo3', 'solo4', 'solo5']);
export type SoloCardId = z.infer<typeof SoloCardId>;
export const SoloCardIdValues: readonly SoloCardId[] = SoloCardId.options;

export interface SoloCardDef {
  readonly gates: readonly GateIdType[];
  /** Card 5 only: the gates share a card only if the requester is the operator who decides them. */
  readonly requester_is_operator: boolean;
}

export const SOLO_CARDS: Readonly<Record<SoloCardId, SoloCardDef>> = {
  solo1: { gates: ['G0', 'G1'], requester_is_operator: false },
  // "oracles": G3o, the oracle deviation approval, is the oracle half of this card.
  solo2: { gates: ['G2', 'G3o'], requester_is_operator: false },
  solo3: { gates: ['G3d', 'G3', 'G3s'], requester_is_operator: false },
  solo4: { gates: ['G4'], requester_is_operator: false },
  solo5: { gates: ['G5', 'G6'], requester_is_operator: true },
};

/** The SOLO card a gate belongs to, or `null` (X, E, M, Q, SECT, G1f: always a card of their own). */
export function soloCardOf(gate: GateIdType): SoloCardId | null {
  for (const id of SoloCardIdValues) if (SOLO_CARDS[id].gates.includes(gate)) return id;
  return null;
}

/** `single`: a card with one gate (or one step) and no consolidation group. */
export const CardGroup = z.union([SoloCardId, z.literal('single')]);
export type CardGroup = z.infer<typeof CardGroup>;

// ---------------------------------------------------------------- Record events

export const InboxCardTarget = z.discriminatedUnion('target', [
  z.strictObject({
    target: z.literal('gate'),
    gate_instance_id: GateInstanceId,
    gate_id: GateId,
    subject_hash: Sha256Hex,
  }),
  /** A step decision (card 5 of onboarding: the 0.5 sign-off). `slot` is who may decide it. */
  z.strictObject({ target: z.literal('step'), step: StepId, slot: RoleSlot }),
]);
export type InboxCardTarget = z.infer<typeof InboxCardTarget>;

/** Payload of `card.opened`, the first event of stream `card:<id>`. */
export const CardOpenedPayload = z.strictObject({
  card_id: CardId,
  project_id: ProjectId,
  subject_kind: SubjectKind,
  subject_id: z.string().min(1),
  group: CardGroup,
  /** The onboarding card (C1..C5, SECR, BATCH, X2) this inbox card is the decision of, if any. */
  label: CardKind.nullable(),
  /** Whose inbox it is in: the slot of the first gate. */
  role: RoleSlot,
  targets: z.array(InboxCardTarget).min(1),
  requester: PrincipalId.nullable(),
  /** B21: one business day after opening, by the calendar in force at opening. */
  sla_due_at: IsoDateTime,
  opened_by: z.string().min(1),
  /** The opener's key of a card without a gate (what makes its id unique); `null` on a card with gates. */
  key: z.string().min(1).max(300).nullable().default(null),
});
export type CardOpenedPayload = z.infer<typeof CardOpenedPayload>;

/** Upper bound of a list payload (a 50-row card is normal; this is a guard, not a design size). */
export const CARD_PAYLOAD_MAX_ROWS = 1000;

/** The full list payload, on the card stream; its hash is what the ledger entries carry. */
export const CardPayloadRecordedPayload = z.strictObject({
  card_id: CardId,
  payload: z.array(CardPayloadItem).max(CARD_PAYLOAD_MAX_ROWS),
  payload_hash: Sha256Hex,
  recorded_by: PrincipalId,
});
export type CardPayloadRecordedPayload = z.infer<typeof CardPayloadRecordedPayload>;

/** Marker written in the same transaction as the ledger entries of a card decision. */
export const CardDecidedPayload = z.strictObject({
  card_id: CardId,
  actor: PrincipalId,
  decisions: z
    .array(
      z.strictObject({
        target: z.enum(['gate', 'step']),
        gate_instance_id: GateInstanceId.nullable(),
        step: StepId.nullable(),
        decision: VoteDecision,
        ledger_entry_id: LedgerEntryId,
      }),
    )
    .min(1),
  payload_hash: Sha256Hex.nullable(),
});
export type CardDecidedPayload = z.infer<typeof CardDecidedPayload>;

/** B21: a gate pending past its SLA went to the backup approver slot. Never an approval. */
export const CardEscalatedPayload = z.strictObject({
  card_id: CardId,
  gate_instance_id: GateInstanceId,
  /** Only level 1 exists. */
  level: z.literal(1),
  reason: z.literal('sla_b21'),
  due_at: IsoDateTime,
  escalated_at: IsoDateTime,
  backup_slot: RoleSlot,
  /** Who got an inbox entry. Empty: nobody besides the approvers holds the backup slot (a visible gap). */
  backup: z.array(PrincipalId),
});
export type CardEscalatedPayload = z.infer<typeof CardEscalatedPayload>;

/**
 * A card that carries no gate (the S0 step cards) is closed without a decision when its record
 * moves on: parked, withdrawn, superseded, or the step went back to the factory. Never an approval.
 */
export const CardWithdrawnPayload = z.strictObject({
  card_id: CardId,
  reason: z.string().min(1).max(200),
  by: z.string().min(1),
});
export type CardWithdrawnPayload = z.infer<typeof CardWithdrawnPayload>;

/** `body` of the ledger entry of a card step decision. */
export const CardStepDecisionBody = z.strictObject({
  kind: z.literal('step_decision'),
  card_id: CardId,
  step: StepId,
  payload_hash: Sha256Hex,
  /** A card without a gate: what the person was shown (the nonce's evidence hash), like a gate vote's. */
  evidence: z
    .strictObject({
      evidence_hash: Sha256Hex,
      evidence_viewed_at: IsoDateTime,
      nonce_sha256: Sha256Hex,
    })
    .optional(),
});
export type CardStepDecisionBody = z.infer<typeof CardStepDecisionBody>;

// ---------------------------------------------------------------- Read model

export const InboxCard = z.strictObject({
  card_id: CardId,
  project_id: ProjectId,
  subject_kind: SubjectKind,
  subject_id: z.string().min(1),
  group: CardGroup,
  label: CardKind.nullable(),
  role: RoleSlot,
  /** Derived from the gates and steps; never stored. */
  status: CardStatus,
  gates: z.array(
    z.strictObject({
      gate_instance_id: GateInstanceId,
      gate_id: GateId,
      status: GateStatus,
      outcome: VoteDecision.nullable(),
    }),
  ),
  steps: z.array(
    z.strictObject({
      step: StepId,
      decision: VoteDecision.nullable(),
    }),
  ),
  sla_due_at: IsoDateTime,
  escalated: z.boolean(),
  payload_hash: Sha256Hex.nullable(),
  requester: PrincipalId.nullable(),
  opened_at: IsoDateTime,
});
export type InboxCard = z.infer<typeof InboxCard>;

/** Why a card is in a principal's inbox. */
export const InboxEntryReason = z.enum(['eligible', 'escalated_backup']);
export type InboxEntryReason = z.infer<typeof InboxEntryReason>;
