import { z } from 'zod';
import { GateId, type GateId as GateIdType } from '../flow.js';
import { SubjectKind, VoteDecision } from './decisions.js';
import {
  CardId,
  GateInstanceId,
  IsoDateTime,
  JsonObject,
  LedgerEntryId,
  PrincipalId,
  ProjectId,
  Sha256Hex,
} from './ids.js';
import { RoleSlot, TWO_PERSON_GATES, TWO_PERSON_KILL_RELEASE } from './projects.js';

// The GateInstance lifecycle on the record and the ledger (PLAN M3.1-M3.3, DM §3.4 and §6.2).
//
// Opening, superseding, expiring and closing a gate are record events on stream `gate:<id>`. A
// decision is ONLY a ledger entry (`entry_type: 'decision'`): the status of an instance is a
// projection of those entries, never of a record event, so a Notary-signed decision whose caller
// transaction rolled back still counts once the reconciler has inserted it.

// ---------------------------------------------------------------- Record events

export const GATE_EVENT = {
  opened: 'gate.opened',
  vote: 'gate.vote',
  superseded: 'gate.superseded',
  closed: 'gate.closed',
  expired: 'gate.expired',
  evidence_viewed: 'gate.evidence_viewed',
} as const;
export const GateEventType = z.enum([
  GATE_EVENT.opened,
  GATE_EVENT.vote,
  GATE_EVENT.superseded,
  GATE_EVENT.closed,
  GATE_EVENT.expired,
  GATE_EVENT.evidence_viewed,
]);
export type GateEventType = z.infer<typeof GateEventType>;

/** The record stream of a gate instance. */
export const gateStream = (id: string): string => `gate:${id}`;

/** Why the required quorum is what it is (DEC-28, DEC-6). */
export const QuorumBasis = z.enum([
  /** One approval, no two-person rule for this gate. */
  'single',
  /** Two-person rule in force: two distinct approvers. */
  'two_person',
  /** Two-person gate, but exactly one person holds the slot: decides alone, `sod_waiver`. */
  'single_holder',
  /** Two-person gate, project setting off (never T2): decides alone, `sod_waiver`. */
  'two_person_off',
  /** The sole holder of the slot is the requester: decides alone, `sod_waiver` (never T2). */
  'own_item',
]);
export type QuorumBasis = z.infer<typeof QuorumBasis>;

const Expiring = JsonObject.refine((f) => IsoDateTime.safeParse(f['expires_at']).success, {
  message: 'facts.expires_at is an ISO instant',
  path: ['expires_at'],
});

/** Payload of `gate.opened`, the first event of stream `gate:<id>`. */
export const GateOpenedPayload = z.strictObject({
  gate_instance_id: GateInstanceId,
  gate_id: GateId,
  project_id: ProjectId,
  subject_kind: SubjectKind,
  subject_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  subject_hash: Sha256Hex,
  evidence_pack_hash: Sha256Hex.nullable(),
  /** Who asked for the work; the SoD rule keeps them from approving it. `null`: nobody to exclude. */
  requester: PrincipalId.nullable(),
  /**
   * Who wrote the artefact this gate decides (B5: the person who wrote the plan by hand). Treated exactly
   * like the requester by the SoD rule: they cannot decide it unless they are the sole holder of the slot
   * (stamped `sod_waiver`, never T2). Absent: nobody besides the requester.
   */
  authors: z.array(PrincipalId).max(8).optional(),
  /** Conflict facts, project policy; `expires_at` drives the TTL sweep and is always present. */
  facts: Expiring,
  /** Frozen at open. The projection decides `decided` by this number. */
  quorum: z.strictObject({
    required: z.number().int().min(1).max(5),
    slot: RoleSlot,
    basis: QuorumBasis,
  }),
  /** A step-up proof bound to `bound_hash` (default `subject_hash`; D37 uses `text_sha256`) is needed to decide. */
  step_up: z.strictObject({ required: z.boolean(), bound_hash: Sha256Hex }),
  /** The instance this one replaced because the subject hash changed. */
  supersedes: GateInstanceId.nullable(),
  opened_by: z.string().min(1),
});
export type GateOpenedPayload = z.infer<typeof GateOpenedPayload>;

/** Markers written in the same transaction as a ledger decision. They never carry the decision. */
export const GateVoteMarker = z.strictObject({
  ledger_entry_id: LedgerEntryId,
  approver: PrincipalId,
  decision: VoteDecision,
});
export const GateSupersededMarker = z.strictObject({
  ledger_entry_id: LedgerEntryId,
  superseded_by: GateInstanceId,
  new_subject_hash: Sha256Hex,
});
export const GateClosedMarker = z.strictObject({
  ledger_entry_id: LedgerEntryId,
  reason: z.string().min(1),
});
export const GateExpiredMarker = z.strictObject({
  ledger_entry_id: LedgerEntryId,
  expires_at: IsoDateTime,
});
export const GateEvidenceViewedPayload = z.strictObject({
  principal: PrincipalId,
  evidence_hash: Sha256Hex,
  nonce_sha256: Sha256Hex,
});

// ---------------------------------------------------------------- Ledger decision body

/** The `body` of a `decision` ledger entry. `kind` follows the decision. */
export const DecisionBody = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('vote'),
    evidence_hash: Sha256Hex,
    evidence_viewed_at: IsoDateTime,
    /** sha256 of the nonce; the nonce itself never goes on the ledger. */
    nonce_sha256: Sha256Hex,
    step_up: z.strictObject({ bound_hash: Sha256Hex, proof_sha256: Sha256Hex }).nullable(),
    quorum_required: z.number().int().min(1),
    approvals_after: z.number().int().min(0),
    /** Set when the vote was cast as part of a card decision (PLAN M3.4). */
    card: z.strictObject({ card_id: CardId, payload_hash: Sha256Hex }).optional(),
  }),
  z.strictObject({
    kind: z.literal('supersede'),
    superseded_by: GateInstanceId,
    new_subject_hash: Sha256Hex,
  }),
  z.strictObject({ kind: z.literal('expire'), expires_at: IsoDateTime }),
  z.strictObject({ kind: z.literal('withdraw'), reason: z.string().min(1) }),
]);
export type DecisionBody = z.infer<typeof DecisionBody>;

// ---------------------------------------------------------------- Per-gate policy

/**
 * `never`: one approval decides. `project`: two distinct approvers when the project's two-person
 * setting is on (always for T2); see `planQuorum` in `@aisdlc/decisions`.
 */
export const TwoPersonMode = z.enum(['never', 'project']);
export type TwoPersonMode = z.infer<typeof TwoPersonMode>;

export const GatePolicy = z.strictObject({
  /** Whose role slot decides this gate (OB §1B). */
  slot: RoleSlot,
  two_person: TwoPersonMode,
  /** `blocked`: the requester cannot decide their own request unless the single-holder waiver applies. */
  own_request: z.enum(['blocked', 'allowed']),
  /** A step-up proof bound to a hash is required to decide (D37, release). */
  step_up: z.boolean(),
  /** May share a card with other gates in the SOLO profile (FL PROFILES). X, E, Q and M never do. */
  consolidatable: z.boolean(),
});
export type GatePolicy = z.infer<typeof GatePolicy>;

/** `kill_release` is an action with a two-person rule (DEC-28) but no GateInstance. */
export type PolicyKey = GateIdType | typeof TWO_PERSON_KILL_RELEASE;

const twoPerson = (g: GateIdType): TwoPersonMode =>
  (TWO_PERSON_GATES as readonly GateIdType[]).includes(g) ? 'project' : 'never';

type Row = Pick<GatePolicy, 'slot'> & Partial<Omit<GatePolicy, 'two_person'>>;
const row = (g: GateIdType, r: Row): GatePolicy => ({
  two_person: twoPerson(g),
  own_request: 'blocked',
  step_up: false,
  consolidatable: false,
  ...r,
});

/**
 * Slots follow OB §1B: G0/G1/G2 `intent`; G3d/G3/G3s `design`; G4 `g4` (code owners); G5 `g5` with
 * step-up kept; G6 is the requester's acceptance, so the requester may decide it. X1, X2, E2 and the
 * other exception and action gates use `x`; M4 uses `m4`; the other meta gates are the project
 * `admin`; Q1 and SECT use `sec`. Consolidatable: only the gates in the SOLO cards of FL PROFILES
 * (G0+G1, G2+oracles, G3d+G3+G3s, G5+G6); G4, X, E, M and Q are always their own decision. The
 * choices OB does not state (G1f, G3o, X3, X4, E1-E6 slots) are marked in the report.
 */
export const GATE_POLICIES: Readonly<Record<GateIdType, GatePolicy>> = {
  G0: row('G0', { slot: 'intent', consolidatable: true }),
  G1: row('G1', { slot: 'intent', consolidatable: true }),
  G1f: row('G1f', { slot: 'intent' }),
  G2: row('G2', { slot: 'intent', consolidatable: true }),
  G3: row('G3', { slot: 'design', consolidatable: true }),
  G3d: row('G3d', { slot: 'design', consolidatable: true }),
  G3s: row('G3s', { slot: 'design', consolidatable: true }),
  G3o: row('G3o', { slot: 'design', consolidatable: true }),
  G4: row('G4', { slot: 'g4' }),
  G5: row('G5', { slot: 'g5', step_up: true, consolidatable: true }),
  G6: row('G6', { slot: 'requesters', own_request: 'allowed', consolidatable: true }),
  X1: row('X1', { slot: 'x' }),
  X2: row('X2', { slot: 'x' }),
  X3: row('X3', { slot: 'x' }),
  X4: row('X4', { slot: 'x' }),
  E1: row('E1', { slot: 'x' }),
  E2: row('E2', { slot: 'x' }),
  E3: row('E3', { slot: 'x' }),
  E4: row('E4', { slot: 'x' }),
  E5: row('E5', { slot: 'x' }),
  E6: row('E6', { slot: 'x' }),
  M1: row('M1', { slot: 'admin' }),
  M2: row('M2', { slot: 'admin' }),
  M3: row('M3', { slot: 'admin' }),
  M4: row('M4', { slot: 'm4', step_up: true }),
  M5: row('M5', { slot: 'admin' }),
  M6: row('M6', { slot: 'admin' }),
  Q1: row('Q1', { slot: 'sec' }),
  SECT: row('SECT', { slot: 'sec' }),
};

/** The kill release (DEC-28, INV-13 two humans) as a policy row; not a gate. */
export const KILL_RELEASE_POLICY: GatePolicy = {
  slot: 'kill',
  two_person: 'project',
  own_request: 'blocked',
  step_up: false,
  consolidatable: false,
};

export function gatePolicy(key: PolicyKey): GatePolicy {
  return key === TWO_PERSON_KILL_RELEASE ? KILL_RELEASE_POLICY : GATE_POLICIES[key];
}
