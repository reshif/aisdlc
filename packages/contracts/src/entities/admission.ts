import { z } from 'zod';
import { UnitState } from '../states/unit.js';
import type { GateId } from '../flow.js';
import { IsoDateTime, PrincipalId, ProjectId, WorkItemId } from './ids.js';
import { UnitEnvelope, UnitKey } from './planning.js';

// Unit, Lease and AdmissionGrant (PLAN M13.1; DM §3.6 Lease and Branch, §6.4 Unit and Session, §8 gap 14).
//
// The Unit is the single owner of its lease epoch (gap 14: the code host's lease table, the grant, the engine's
// `lease_seq` and the stage request each held a copy). Everything about a Unit after S5 is an event on
// `unit:<item>` (the plan's own event stays `units.planned` on `planning:<item>`); `core.unit`, `core.lease`
// and `core.admission_grant` are read models folded from both streams in record order and rebuilt from them.

export const unitStream = (itemId: string): string => `unit:${itemId}`;
export const UNIT_STREAM_PREFIX = 'unit:';

/** The branch a Unit writes: `agent/<item>/<unit>` (DM §3.6 Branch; the only prefix the Push Broker writes). */
export const unitBranchOf = (itemId: string, unitKey: string): string =>
  `agent/${itemId}/${unitKey}`;

export const UNIT_EVENT = {
  /** 6.0 admitted the Unit: a lease epoch, an approver slot and an envelope, as one grant. */
  admitted: 'unit.admitted',
  /** The lease changed hands or ended: a takeover, a hand-back, a new session, the end of S6. */
  lease_changed: 'unit.lease_changed',
  /** The grant ended: handoff, the item ended, or G4 was decided. */
  grant_released: 'unit.grant_released',
  /** HUMAN-WAIT: a human gate is pending in S6; lease and slot are released, a snapshot is kept, the clock stops. */
  wait_entered: 'unit.wait_entered',
  /** The Unit moved (session, push, verify, review, merge: M13.3 onwards); checked against the lease epoch. */
  state_changed: 'unit.state_changed',
} as const;
export type UnitEventType = (typeof UNIT_EVENT)[keyof typeof UNIT_EVENT];

export const LeaseHolderKind = z.enum(['agent', 'human']);
export type LeaseHolderKind = z.infer<typeof LeaseHolderKind>;

export const LeaseStatus = z.enum(['held', 'released']);
export type LeaseStatus = z.infer<typeof LeaseStatus>;

/** Why a lease changed (the Lease's append-only history). */
export const LeaseChangeCause = z.enum([
  'admitted',
  'takeover',
  'hand_back',
  'new_session',
  'left_s6',
  'handoff',
  'human_wait',
  'readmitted',
  'item_ended',
  'g4_decided',
]);
export type LeaseChangeCause = z.infer<typeof LeaseChangeCause>;

export const GrantStatus = z.enum(['active', 'waiting', 'released']);
export type GrantStatus = z.infer<typeof GrantStatus>;

/** DM §6.4: `Admitted -> GrantReleased` on handoff, item end or G4 decided; `readmitted` closes a waiting grant. */
export const GrantReleaseCause = z.enum(['handoff', 'item_ended', 'g4_decided', 'readmitted']);
export type GrantReleaseCause = z.infer<typeof GrantReleaseCause>;

/** The gates whose pending decision, while the item is in S6, makes the session wait for a person. */
export const HUMAN_WAIT_GATES = ['G3o', 'X1', 'X3', 'E6'] as const satisfies readonly GateId[];
export const HumanWaitGate = z.enum(HUMAN_WAIT_GATES);
export type HumanWaitGate = z.infer<typeof HumanWaitGate>;

/**
 * The approver slot an admission reserves (H1): that the deciders downstream of the Unit exist in the role
 * map: the G4 slot (principals, or the code owners on the host) and the X-gate slot. Counts, never names.
 */
export const AdmissionSlot = z.strictObject({
  g4: z.strictObject({
    kind: z.enum(['principals', 'codeowners']),
    count: z.number().int().min(0),
  }),
  x: z.strictObject({ count: z.number().int().min(1) }),
});
export type AdmissionSlot = z.infer<typeof AdmissionSlot>;

/** The envelope reserved at admission: a budget group in the gateway created for the Unit with the 5.5 limits. */
export const GrantEnvelope = z.strictObject({
  /** The gateway's budget group id. */
  ref: z.string().min(1).max(128),
  max_tokens: UnitEnvelope.shape.max_tokens,
  max_cost_micro_usd: UnitEnvelope.shape.max_cost_micro_usd,
});
export type GrantEnvelope = z.infer<typeof GrantEnvelope>;

/** A snapshot of a waiting session's workspace (M13.3 stores it; M13.1 holds only the reference). */
export const SnapshotRef = z.string().min(1).max(256);
export type SnapshotRef = z.infer<typeof SnapshotRef>;

const Ids = {
  unit_id: z.string().min(1),
  item_id: WorkItemId,
};

export const UnitAdmittedPayload = z.strictObject({
  grant_id: z.string().min(1),
  ...Ids,
  project_id: ProjectId,
  repo: z.string().min(1),
  unit_key: UnitKey,
  branch: z.string().min(1),
  lease_epoch: z.number().int().min(1),
  slot: AdmissionSlot,
  envelope: GrantEnvelope,
  /** The 6.0 command (or the re-admission) that asked. */
  command_key: z.string().min(1),
  /** A re-admission after HUMAN-WAIT (via 6.1): the waiting grant it continues and its snapshot. */
  resumes: z.strictObject({ grant_id: z.string().min(1), snapshot_ref: SnapshotRef }).nullable(),
});
export type UnitAdmittedPayload = z.infer<typeof UnitAdmittedPayload>;

export const UnitLeaseChangedPayload = z.strictObject({
  ...Ids,
  lease_epoch: z.number().int().min(1),
  holder_kind: LeaseHolderKind,
  holder_ref: PrincipalId.nullable(),
  status: LeaseStatus,
  cause: LeaseChangeCause,
});
export type UnitLeaseChangedPayload = z.infer<typeof UnitLeaseChangedPayload>;

export const UnitGrantReleasedPayload = z.strictObject({
  grant_id: z.string().min(1),
  ...Ids,
  cause: GrantReleaseCause,
});
export type UnitGrantReleasedPayload = z.infer<typeof UnitGrantReleasedPayload>;

export const UnitWaitEnteredPayload = z.strictObject({
  grant_id: z.string().min(1),
  ...Ids,
  gate: HumanWaitGate,
  gate_instance_id: z.string().min(1),
  /** The epoch the released lease had. */
  lease_epoch: z.number().int().min(1),
  snapshot_ref: SnapshotRef,
});
export type UnitWaitEnteredPayload = z.infer<typeof UnitWaitEnteredPayload>;

export const UnitStateChangedPayload = z.strictObject({
  ...Ids,
  /** The epoch the writer holds: a stale one is refused before this event is written. */
  lease_epoch: z.number().int().min(1),
  to: UnitState,
  head_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  pr_ref: z.string().min(1).max(128).optional(),
  reason: z.string().min(1).max(64),
});
export type UnitStateChangedPayload = z.infer<typeof UnitStateChangedPayload>;

export const UnitEventPayloads = {
  [UNIT_EVENT.admitted]: UnitAdmittedPayload,
  [UNIT_EVENT.lease_changed]: UnitLeaseChangedPayload,
  [UNIT_EVENT.grant_released]: UnitGrantReleasedPayload,
  [UNIT_EVENT.wait_entered]: UnitWaitEnteredPayload,
  [UNIT_EVENT.state_changed]: UnitStateChangedPayload,
} as const satisfies Record<UnitEventType, z.ZodType>;

/** One entry of a Lease's append-only history (DM §3.6 `Lease.history`). */
export const LeaseHistoryEntry = z.strictObject({
  epoch: z.number().int().min(1),
  holder_kind: LeaseHolderKind,
  holder_ref: PrincipalId.nullable(),
  status: LeaseStatus,
  cause: LeaseChangeCause,
  at: IsoDateTime,
});
export type LeaseHistoryEntry = z.infer<typeof LeaseHistoryEntry>;

/** The Lease of a Unit (DM §3.6): the epoch only increases; the Unit's `lease_epoch` reads it. */
export const Lease = z.strictObject({
  unit_id: z.string().min(1),
  item_id: WorkItemId,
  branch: z.string().min(1),
  epoch: z.number().int().min(1),
  holder_kind: LeaseHolderKind,
  holder_ref: PrincipalId.nullable(),
  status: LeaseStatus,
  history: z.array(LeaseHistoryEntry),
});
export type Lease = z.infer<typeof Lease>;

export const AdmissionGrant = z.strictObject({
  grant_id: z.string().min(1),
  item_id: WorkItemId,
  unit_id: z.string().min(1),
  project_id: ProjectId,
  lease_epoch: z.number().int().min(1),
  slot: AdmissionSlot,
  envelope: GrantEnvelope,
  status: GrantStatus,
  release_cause: GrantReleaseCause.nullable(),
  granted_at: IsoDateTime,
  released_at: IsoDateTime.nullable(),
  /** HUMAN-WAIT: the reference the waiting session was kept under. */
  snapshot_ref: SnapshotRef.nullable(),
  /** The envelope clock: ms it has been paused in all, and since when it is paused now. */
  clock: z.strictObject({
    paused_ms: z.number().int().min(0),
    paused_since: IsoDateTime.nullable(),
  }),
  /** The waiting grant this one continues (re-admission via 6.1). */
  resumes_grant_id: z.string().nullable(),
});
export type AdmissionGrant = z.infer<typeof AdmissionGrant>;
