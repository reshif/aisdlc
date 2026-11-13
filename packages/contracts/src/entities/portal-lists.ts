import { z } from 'zod';
import { GateId, HoldReason } from '../flow.js';
import { DataClass, Lane, Scope, StageId, StepId } from '../values.js';
import { WorkItemPhase } from '../states/work-item.js';
import { AgentId, AgentTool, PromptRef } from './agent-definitions.js';
import { PrincipalSummary, ViewLevel } from './access.js';
import { CatalogueRef } from './config.js';
import { AdmissionGrant } from './admission.js';
import {
  Banner,
  KillEventKind,
  KillRecord,
  KillScope,
  OpsControl,
  projectOfScope,
} from './controls.js';
import { Team } from './identity.js';
import { IsoDateTime, PrincipalId, ProjectId, RoleId, Sha256Hex, WorkItemId } from './ids.js';
import { IntegrationEvent, IntegrationHealthTiles } from './integrations.js';
import { ActionId, PdpResource, pdpResource } from './policy.js';
import { AuditOutcome, CloseOutRecord, EscapeReportedPayload } from './closeout.js';

// The portal's list and read views (2026-11-12, the screens whose backends were on main). Each is the
// thinnest read over what core or the bff already holds; every route is PDP-guarded like its neighbours.
//
//   core GET /v1/items              ItemListView        (item.view_floor per row)
//   core GET /v1/agents             AgentRegistryView   (quality.read on the fleet)
//   core GET /v1/catalogue          CatalogueView       (signed in: the catalogue is everyone's)
//   core GET /v1/admission          AdmissionView       (ops.read on the fleet)
//   core GET /v1/controls           ControlsView        (ops.read on the fleet)
//   core GET /v1/kills              KillsView           (ops.read on the fleet)
//   core GET /v1/audit/decisions    AuditDecisionsView  (audit.read on the fleet)
//   bff  GET /api/integrations      IntegrationsView    (quality.read or ops.read on the fleet)
//   bff  GET /api/directory         DirectoryView       (audit.read on the fleet)
//   bff  GET /api/projects/:id/explain  AccessExplainView (access.explain on the project)

// ---------------------------------------------------------------- items

/** One item of a list or board. Items carry no title: the request text stays on the item page (cut by data class). */
export const ItemListRow = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  repo: z.string().min(1),
  lane: Lane.nullable(),
  proposed_lane: Lane,
  phase: WorkItemPhase,
  /** The phase under the holds: what a held item resumes to (the board's column). */
  underlying: WorkItemPhase,
  terminal: z.string().nullable(),
  holds: z.number().int().min(0),
  in_flight: z.boolean(),
  /** The person asking is the item's requester. */
  mine: z.boolean(),
  catalogue_version: z.string().min(1),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type ItemListRow = z.infer<typeof ItemListRow>;

export const ItemListView = z.strictObject({ items: z.array(ItemListRow) });
export type ItemListView = z.infer<typeof ItemListView>;

// ---------------------------------------------------------------- agents (the registry is code)

export const AgentRegistryRow = z.strictObject({
  agent_id: AgentId,
  name: z.string().nullable(),
  role: z.string().nullable(),
  note: z.string().nullable(),
  steps: z.array(StepId),
  specialist_steps: z.array(StepId),
  contract_version: z.string().min(1),
  output_schema_id: z.string().min(1),
  tools: z.array(AgentTool),
  data_class_max: DataClass,
  models: z.array(z.string().min(1)),
  prompt: PromptRef,
});
export type AgentRegistryRow = z.infer<typeof AgentRegistryRow>;

export const AgentRegistryView = z.strictObject({
  /** `aisdlc-prompts-lock/v1`: the lock the prompt hashes are read from. */
  lock_format: z.string().min(1),
  agents: z.array(AgentRegistryRow),
});
export type AgentRegistryView = z.infer<typeof AgentRegistryView>;

// ---------------------------------------------------------------- catalogue (immutable releases)

export const CatalogueLaneRow = z.strictObject({
  lane: Lane,
  label: z.string().nullable(),
  enter_at: z.string().nullable(),
  stages: z.array(StageId),
  gates: z.array(z.strictObject({ gate: GateId, step: StepId, presence: z.string().min(1) })),
});
export type CatalogueLaneRow = z.infer<typeof CatalogueLaneRow>;

export const CatalogueVersionRow = z.strictObject({
  ref: CatalogueRef,
  /** The version new items pin. */
  current: z.boolean(),
  /** Items (any state) pinned to exactly this release. */
  pinned_items: z.number().int().min(0),
  lanes: z.array(CatalogueLaneRow),
});
export type CatalogueVersionRow = z.infer<typeof CatalogueVersionRow>;

export const CatalogueView = z.strictObject({ versions: z.array(CatalogueVersionRow) });
export type CatalogueView = z.infer<typeof CatalogueView>;

// ---------------------------------------------------------------- admission (scheduler)

export const HeldItemRow = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  lane: Lane.nullable(),
  underlying: WorkItemPhase,
  reasons: z.array(HoldReason),
  since: IsoDateTime.nullable(),
});
export type HeldItemRow = z.infer<typeof HeldItemRow>;

export const AdmissionView = z.strictObject({
  as_of: IsoDateTime,
  /** H2: coding sessions the factory allows at once (contracts `CODING_SESSION_CAP`). */
  coding_session_cap: z.number().int().min(0),
  /** Active grants whose lease is held: the coding sessions in a slot now. */
  sessions_in_slot: z.number().int().min(0),
  active: z.array(AdmissionGrant),
  /** HUMAN-WAIT: slot and lease released, snapshot kept, envelope clock paused. */
  waiting: z.array(AdmissionGrant),
  held: z.array(HeldItemRow),
});
export type AdmissionView = z.infer<typeof AdmissionView>;

// ---------------------------------------------------------------- controls and kills

export const ControlsView = z.strictObject({
  controls: z.array(OpsControl),
  banners: z.array(Banner),
});
export type ControlsView = z.infer<typeof ControlsView>;

/** One verified entry of the kill switch's journal, as core observed it (`kill.observed`). */
export const KillJournalRow = z.strictObject({
  ks_seq: z.number().int().min(1),
  kind: KillEventKind,
  subject: z.string().min(1),
  actor: PrincipalId.nullable(),
  entry_hash: Sha256Hex,
  /** False while the kill switch's signature is pending (the KMS was away). */
  signed: z.boolean(),
  at: IsoDateTime,
});
export type KillJournalRow = z.infer<typeof KillJournalRow>;

export const KillsView = z.strictObject({
  /** The newest journal entry core has observed: the view is as fresh as this, never fresher. */
  observed_head: z.number().int().min(0),
  journal: z.array(KillJournalRow),
});
export type KillsView = z.infer<typeof KillsView>;

// RC-UI-1: a kill requested and released in the portal. The bff asks the PDP (the same actions the kill switch asks:
// `kill.request`, `kill.release` on the scope's resource), the person steps up for exactly the act's hash
// (`killActHash`), and the bff forwards the act with that proof to the kill switch, which verifies the proof and takes
// the actor from it. The bff never acts in a name the proof does not carry.
//
//   POST /api/kills/prepare                {scope, reason}   -> KillActPrepared
//   POST /api/kills                        {scope, reason, step_up: {proof}} -> KillRecord
//   POST /api/kills/:id/release/prepare    {}                -> KillActPrepared
//   POST /api/kills/:id/release            {step_up: {proof}} -> KillRecord
//   GET  /api/kills/active                                   -> ActiveKillsView

/** The PDP resource a kill of `scope` is decided on: the fleet, the project, the lane; a session: its project. */
export function killScopeResource(scope: KillScope): PdpResource {
  switch (scope.kind) {
    case 'fleet':
      return pdpResource.fleet();
    case 'lane': {
      const [p, lane] = scope.ref.split('/');
      return pdpResource.lane(p as string, lane as string);
    }
    case 'project':
      return pdpResource.project(scope.ref);
    default:
      return pdpResource.project(projectOfScope(scope) as string);
  }
}

export const PortalKillPrepareRequest = z.strictObject({
  scope: KillScope,
  reason: KillRecord.shape.reason,
});
export type PortalKillPrepareRequest = z.infer<typeof PortalKillPrepareRequest>;

const PortalStepUpProof = z.strictObject({ proof: z.string().min(1).max(8192) });

export const PortalKillRequest = PortalKillPrepareRequest.extend({ step_up: PortalStepUpProof });
export type PortalKillRequest = z.infer<typeof PortalKillRequest>;

export const PortalKillReleaseRequest = z.strictObject({ step_up: PortalStepUpProof });
export type PortalKillReleaseRequest = z.infer<typeof PortalKillReleaseRequest>;

/** What the person steps up for: the hash of exactly this act (`killActHash`). */
export const KillActPrepared = z.strictObject({ bound_hash: Sha256Hex });
export type KillActPrepared = z.infer<typeof KillActPrepared>;

/** The kills that still kill, as the kill switch says now, and what this person may do about each. */
export const ActiveKillsView = z.strictObject({
  kills: z.array(
    KillRecord.extend({
      /** The PDP's `kill.release` for this person on the kill's scope (a hint; the kill switch decides again). */
      may_release: z.boolean(),
      /** This person already approved its release (a second approval must be someone else's). */
      approved_by_me: z.boolean(),
    }),
  ),
});
export type ActiveKillsView = z.infer<typeof ActiveKillsView>;

// ---------------------------------------------------------------- audit (the PDP decision log)

export const AuditDecisionRow = z.strictObject({
  decision_id: z.string().min(1),
  principal: PrincipalId,
  action: z.string().min(1),
  resource: PdpResource,
  decision: z.enum(['allow', 'deny']),
  reasons: z.array(z.string()),
  bundle_version: z.string().nullable(),
  at: IsoDateTime,
  logged_because: z.enum(['deny', 'action', 'sampled']),
});
export type AuditDecisionRow = z.infer<typeof AuditDecisionRow>;

export const AuditDecisionsView = z.strictObject({ decisions: z.array(AuditDecisionRow) });
export type AuditDecisionsView = z.infer<typeof AuditDecisionsView>;

// ---------------------------------------------------------------- integrations

export const IntegrationsView = z.strictObject({
  health: IntegrationHealthTiles,
  events: z.array(IntegrationEvent),
});
export type IntegrationsView = z.infer<typeof IntegrationsView>;

// ---------------------------------------------------------------- directory and explain

export const DirectoryView = z.strictObject({
  principals: z.array(PrincipalSummary),
  teams: z.array(Team),
});
export type DirectoryView = z.infer<typeof DirectoryView>;

/** Who holds a role on the project (a binding in force) and what the PDP allows them there. */
export const ExplainHolder = z.strictObject({
  principal_id: PrincipalId,
  display_name: z.string().min(1),
  roles: z.array(RoleId),
  scopes: z.array(Scope),
  view_level: ViewLevel.nullable(),
  data_class: DataClass.nullable(),
  actions: z.array(ActionId),
});
export type ExplainHolder = z.infer<typeof ExplainHolder>;

export const AccessExplainView = z.strictObject({
  project_id: ProjectId,
  as_of: IsoDateTime,
  holders: z.array(ExplainHolder),
});
export type AccessExplainView = z.infer<typeof AccessExplainView>;

// ---------------------------------------------------------------- 9.3 close-out (M15), as core serves it

/** `GET /v1/items/:id/closeout`: the record with its id, the escapes reported after it (B17), and its 9.5 audit. */
export const ItemCloseOutView = z.strictObject({
  closeout_sha256: Sha256Hex,
  record: CloseOutRecord,
  escapes: z.array(EscapeReportedPayload),
  audit: z
    .strictObject({
      sampled: z.boolean(),
      outcome: AuditOutcome.nullable(),
      audited_by: PrincipalId.nullable(),
    })
    .nullable(),
});
export type ItemCloseOutView = z.infer<typeof ItemCloseOutView>;
