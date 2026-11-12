import { z } from 'zod';
import { ReleaseSetting } from './gate-relay.js';
import { Tier } from '../values.js';
import { RepoFullName } from './codehost.js';
import { VoteDecision } from './decisions.js';
import { GateStatus } from '../states/gate-instance.js';
import {
  CardId,
  GateInstanceId,
  IsoDateTime,
  PrincipalId,
  ProjectId,
  S0RecordId,
  WorkItemId,
  Sha256Hex,
} from './ids.js';
import { CardKind } from './onboarding.js';
import { GateId } from '../flow.js';
import { GateFeasibilityState } from './floor.js';
import { GatingProfile, KillDelegation, RoleMap, RoleSlot, TwoPerson } from './projects.js';
import { ProjectReadinessRecord } from './readiness.js';
import { ReadinessStatus } from '../states/readiness.js';

// What the portal reads beyond the cards (PLAN M8.3, M8.4): the inbox across projects, the pending
// settings revision of a first onboarding, the readiness record of a project and the ledger entries
// of a project. Core serves the plain shapes; the bff adds what only the signed-in person's PDP
// answers (`may_decide`) and the names the directory knows. Read-only except where a decision is made.

/** Who decides something, from the project's role map (or the bootstrap grant). */
export const CardDeciders = z.strictObject({
  slot: RoleSlot,
  holders: z.array(PrincipalId),
  /** One person holds the slot: they decide alone and the entry is stamped `sod_waiver`. */
  single_operator: z.boolean(),
  sod_waiver: z.boolean(),
  tier: Tier.nullable(),
  /** T2 allows no waiver: a sole holder cannot decide. */
  t2: z.boolean(),
  can_decide: z.boolean(),
  error: z.string().nullable(),
});
export type CardDeciders = z.infer<typeof CardDeciders>;

// ---------------------------------------------------------------- Inbox

/**
 * `onboarding_card`: a card of an S0 record (C1, C2, C4, C5, SECR, and the X2 of its pack); `settings_revision`: the M1
 * gate that publishes card 4's settings; `work_gate` (M19): a gate a work item waits at (from the floor's read model;
 * decided on the item's page); M16 after onboarding (OB §8): `drift_reaffirm` (instruction or pack text drifted:
 * re-affirm it), `prr_restore` (the record is suspended for drift: restore it once the re-check passes), `prr_resign`
 * (the record expired: re-sign it as a new version). For these three `id` is the repo.
 */
export const InboxItemKind = z.enum([
  'onboarding_card',
  'settings_revision',
  'work_gate',
  'drift_reaffirm',
  'prr_restore',
  'prr_resign',
  /** M16 part 3 (OB §8): a security event holds the repo's agent work (installation widened, new history secret). */
  'drift_security',
]);
export type InboxItemKind = z.infer<typeof InboxItemKind>;

/** One open thing in the factory's inbox, as core knows it. */
export const CoreInboxItem = z.strictObject({
  kind: InboxItemKind,
  /** The card id, the gate instance id of a settings revision, or the repo of an after-onboarding item. */
  id: z.string().min(1),
  project_id: ProjectId,
  s0_id: S0RecordId.nullable(),
  /** The onboarding card (C1, C4, C5, SECR); `null` for a settings revision. */
  label: CardKind.nullable(),
  /** Whose inbox: the slot that decides it. */
  slot: RoleSlot,
  opened_at: IsoDateTime,
  /** B21: one business day after opening. `null` for a settings revision (the gate's own expiry applies). */
  sla_due_at: IsoDateTime.nullable(),
  overdue: z.boolean(),
  escalated: z.boolean(),
  /** Who decides it now (the role map, or the bootstrap grantee). Empty: nobody does yet. */
  holders: z.array(PrincipalId),
  /** A `work_gate`'s item and gate; `null` for the other kinds. */
  item_id: WorkItemId.nullable(),
  gate: GateId.nullable(),
  /**
   * The card it is decided on: the card itself for an `onboarding_card`, the decision card a `work_gate` was opened
   * on (from the record); `null` for the other kinds, and for a work gate whose card the record does not name.
   */
  card_id: CardId.nullable(),
  /** M19 GateFeasibility: `infeasible` or `unknown` is flagged (fail closed), never shown as on its way. */
  feasibility: GateFeasibilityState,
  feasibility_reason: z.string().nullable(),
});
export type CoreInboxItem = z.infer<typeof CoreInboxItem>;

export const PortalInboxItem = CoreInboxItem.extend({
  /** The PDP's answer for the signed-in person (what the button shows; deciding asks again). */
  may_decide: z.boolean(),
  deciders: z.array(z.strictObject({ principal_id: PrincipalId, display_name: z.string() })),
});
export type PortalInboxItem = z.infer<typeof PortalInboxItem>;

export const PortalInbox = z.strictObject({
  /** Open items the person may decide, most overdue first. */
  decide: z.array(PortalInboxItem),
  /** Open items in projects they can see but may not decide, with who does. */
  view: z.array(PortalInboxItem),
});
export type PortalInbox = z.infer<typeof PortalInbox>;

// ---------------------------------------------------------------- Settings revision (card 4's M1 gate)

export const SettingsRevisionView = z.strictObject({
  gate_instance_id: GateInstanceId,
  project_id: ProjectId,
  s0_id: S0RecordId.nullable(),
  rev_hash: Sha256Hex,
  proposed_by: PrincipalId,
  status: GateStatus,
  outcome: VoteDecision.nullable(),
  /** The revision is in force: decided `approve` and published. */
  published: z.boolean(),
  settings: z.strictObject({
    role_map: RoleMap,
    two_person: TwoPerson,
    gating_profile: GatingProfile,
    kill_delegations: z.array(KillDelegation),
  }),
  /** M15.5: the release choice the revision carries (`project.release`); `null`: not chosen. */
  release: ReleaseSetting.nullable().optional(),
  /** What a decision is bound to (the gate's evidence hash). */
  evidence_hash: Sha256Hex,
  deciders: CardDeciders,
});
export type SettingsRevisionView = z.infer<typeof SettingsRevisionView>;

export const PortalSettingsRevision = SettingsRevisionView.extend({ may_decide: z.boolean() });
export type PortalSettingsRevision = z.infer<typeof PortalSettingsRevision>;

/** `GET /v1/s0/:id/revision`: the settings revision card 4 proposed for this record, if any. */
export const S0Revision = z.strictObject({ revision: SettingsRevisionView.nullable() });
export type S0Revision = z.infer<typeof S0Revision>;
export const PortalS0Revision = z.strictObject({ revision: PortalSettingsRevision.nullable() });
export type PortalS0Revision = z.infer<typeof PortalS0Revision>;

export const RevisionPrepared = z.strictObject({
  nonce: z.string().min(1),
  expires_at: IsoDateTime,
  evidence_hash: Sha256Hex,
});
export type RevisionPrepared = z.infer<typeof RevisionPrepared>;

export const RevisionEvidenceRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  nonce: z.string().min(1),
  evidence_hash: Sha256Hex,
});
export const RevisionDecideRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  nonce: z.string().min(1),
  decision: VoteDecision,
});
export const RevisionPrepareRequest = z.strictObject({ on_behalf_of: PrincipalId });
export type RevisionDecideRequest = z.infer<typeof RevisionDecideRequest>;

// ---------------------------------------------------------------- Readiness record view (M8.4)

export const PrrVersionView = z.strictObject({
  version: z.number().int().min(1),
  /** As stored. */
  status: ReadinessStatus,
  /** What the factory acts on: an `active` record past `fresh_until` reads `expired` (expiry never approves). */
  effective_status: ReadinessStatus,
  s0_id: S0RecordId,
  proposed_at: IsoDateTime,
  activated_at: IsoDateTime.nullable(),
  record: ProjectReadinessRecord,
});
export type PrrVersionView = z.infer<typeof PrrVersionView>;

export const ProjectPrrRepo = z.strictObject({
  repo: RepoFullName,
  /** The version that governs the repo (made active by an M4 at some point), or `null`. */
  governing: PrrVersionView.nullable(),
  /** A newer version still waiting for its M4, if any. */
  proposed: z
    .strictObject({
      version: z.number().int().min(1),
      record_hash: Sha256Hex,
      s0_id: S0RecordId,
      proposed_at: IsoDateTime,
    })
    .nullable(),
});
export type ProjectPrrRepo = z.infer<typeof ProjectPrrRepo>;

export const ProjectPrrView = z.strictObject({
  project_id: ProjectId,
  repos: z.array(ProjectPrrRepo),
});
export type ProjectPrrView = z.infer<typeof ProjectPrrView>;

// ---------------------------------------------------------------- Ledger audit view (M8.4)

export const LedgerAuditEntry = z.strictObject({
  ledger_seq: z.number().int().min(1),
  entry_id: z.string().min(1),
  entry_type: z.string().min(1),
  gate_id: z.string().nullable(),
  gate_instance_id: z.string().nullable(),
  /** The onboarding step a card decision is about (`0.1`), where the entry says one. */
  step: z.string().nullable(),
  card_id: z.string().nullable(),
  subject_kind: z.string().nullable(),
  subject_id: z.string().nullable(),
  decision: z.string().nullable(),
  actor: z.string().nullable(),
  sod_waiver: z.boolean(),
  created_at: IsoDateTime,
  entry_hash: Sha256Hex,
  prev_hash: Sha256Hex.nullable(),
});
export type LedgerAuditEntry = z.infer<typeof LedgerAuditEntry>;

export const LedgerAuditView = z.strictObject({
  project_id: ProjectId,
  /** Set when the view is limited to one S0 record. */
  s0_id: S0RecordId.nullable(),
  entries: z.array(LedgerAuditEntry),
  /** The newest entry of the whole ledger, so a reader can see how far this view reaches. */
  head: z.strictObject({ ledger_seq: z.number().int().min(1), entry_hash: Sha256Hex }).nullable(),
});
export type LedgerAuditView = z.infer<typeof LedgerAuditView>;
