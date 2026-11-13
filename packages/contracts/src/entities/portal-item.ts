import { z } from 'zod';
import { GateId } from '../flow.js';
import { DataClass, EntryChannel, Lane, Level, StepId } from '../values.js';
import { ArtefactType, AgentId, type ArtefactType as ArtefactTypeT } from './agent-definitions.js';
import { AgentRunView } from './agent-runs.js';
import { RepoFullName } from './codehost.js';
import {
  IsoDateTime,
  PrincipalId,
  ProjectId,
  Sha256Hex,
  WorkItemId,
  WorkRequestId,
} from './ids.js';
import { PLANNING_EVENT } from './planning.js';
import { AgentRegistryRow } from './portal-lists.js';
import { reachesClass } from './portal-verify.js';
import { GateStatus } from '../states/gate-instance.js';
import { InjectionReport, ItemEventTypeValues, ItemIntake, TaintedText } from './work-lifecycle.js';

// The item page's tabs (P2-1, portal-review §12; portal-coverage §2 `item-<KEY>`) and the agent page (P2-3). Core
// builds each from the record alone; the bff cuts it to the person's view level and data class:
//
//   GET /v1/items/:id/request     ItemRequestView     the request as kept: text, taint, flags, de-dupe, lane and why (V1; text D1)
//   GET /v1/items/:id/documents   ItemDocumentsView   every artefact by kind, its versions, the gates that bound each (V2; text D1)
//   GET /v1/items/:id/timeline    ItemTimelineView    the item's record events folded to plain steps (V1; codes only)
//   GET /v1/agents/:id            AgentDetailView     the registry row with its input and output JSON Schemas (quality.read)
//   GET /v1/agents/:id/runs       AgentRecentRunsView the agent's newest production runs, with their items (quality.read)
//
// The Intent tab reads the documents (the `intent_block` and `classification` versions and the G0/G1 that bound them).
// Nothing here is text an agent wrote except a document's markdown, and the request text is the requester's: both are
// withheld below D1 (`DOCUMENT_TEXT_CLASS`), the hashes stay so a person can still say what was decided.

/** The data class the request text and a document's text need: content of the work. */
export const DOCUMENT_TEXT_CLASS: DataClass = 'D1';

// ---------------------------------------------------------------- Request

export const ItemRequestView = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  repo: RepoFullName,
  request_id: WorkRequestId,
  requester: PrincipalId.nullable(),
  channel: EntryChannel.nullable(),
  /** 1.1: the text as kept with its taint mark, provenance and flags. `null`: none (a factory-raised item) or withheld. */
  request_text: TaintedText.nullable(),
  /** The text is there but the person's data class does not reach it (the hashes stay in `text_sha256`). */
  text_withheld: z.boolean(),
  /** sha256 of the normalised text (the de-dupe key), from intake. */
  text_sha256: Sha256Hex.nullable(),
  /** B27 at intake. */
  injection: InjectionReport.nullable(),
  dedupe_links: z.array(WorkItemId),
  conflict_candidates: z.array(WorkItemId),
  /** The lane the request asked for (the request's), the one the item runs as, and the bound one (`null` before G0). */
  asked_lane: Lane.nullable(),
  proposed_lane: Lane,
  lane: Lane.nullable(),
  /** How the lane was bound: the gate decision's key, or `ready_decision`. */
  lane_bound_by: z.string().nullable(),
  /** 1.4 at intake: where the asked lane went and why (P2-17). */
  intake_route: ItemIntake.shape.route,
  eligibility_reason: z.string().min(1),
  /** The lowest level whose catalogue row opens the asked lane (`null`: none does, or no lane was asked). */
  lane_opens_at: Level.nullable(),
  data_class: DataClass,
});
export type ItemRequestView = z.infer<typeof ItemRequestView>;

/** The request view cut to a data class: the text needs D1. */
export const cutRequestView = (v: ItemRequestView, dc: DataClass): ItemRequestView =>
  reachesClass(dc, DOCUMENT_TEXT_CLASS) || v.request_text === null
    ? { ...v, data_class: dc }
    : { ...v, request_text: null, text_withheld: true, data_class: dc };

// ---------------------------------------------------------------- Documents

/** How the item page groups the artefacts: what a person calls them. */
export const DocumentGroup = z.enum([
  'intent',
  'analysis',
  'spec',
  'design',
  'constitution',
  'plan',
  'build',
  'evidence',
  'other',
]);
export type DocumentGroup = z.infer<typeof DocumentGroup>;
export const DocumentGroupValues: readonly DocumentGroup[] = DocumentGroup.options;

/** The group of every artefact type (a new type fails to compile until it has one). */
export const ARTEFACT_DOCUMENT_GROUP: Readonly<Record<ArtefactTypeT, DocumentGroup>> = {
  request: 'intent',
  intent_block: 'intent',
  classification: 'intent',
  context_brief: 'analysis',
  reverse_engineering: 'analysis',
  impact: 'analysis',
  decision_brief: 'analysis',
  initiative: 'analysis',
  affected_requirements: 'spec',
  spec_delta: 'spec',
  validation_report: 'spec',
  oracle_specs: 'spec',
  spec_review: 'spec',
  design: 'design',
  adr: 'design',
  contracts: 'design',
  data_migration: 'design',
  nfr_threat_ops: 'design',
  constitution_report: 'constitution',
  plan: 'plan',
  unit_split: 'plan',
  unit_sequence: 'plan',
  verification_binding: 'plan',
  budget_envelope: 'plan',
  capacity_input: 'plan',
  diff: 'build',
  patch: 'build',
  oracle_code: 'build',
  spike_report: 'build',
  session_log: 'build',
  repo_snapshot: 'build',
  evidence_pack: 'evidence',
  config_history: 'other',
};

/** Who wrote a version: an agent run, a person (B5's hand-written plan), or the factory's deterministic step. */
export const DocumentAuthor = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('agent'),
    agent_id: AgentId.nullable(),
    run_id: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('person') }),
  z.strictObject({ kind: z.literal('factory') }),
]);
export type DocumentAuthor = z.infer<typeof DocumentAuthor>;

/** A gate whose subject hash bound a version, as the ledger decides it (`readGateState`: never a projection). */
export const DocumentGateBinding = z.strictObject({
  gate: GateId,
  gate_instance_id: z.string().min(1),
  subject_hash: Sha256Hex,
  status: GateStatus,
  /** The quorum decision (`approve`, `reject`, `request_changes`); `null` unless decided. */
  outcome: z.string().nullable(),
  approvers: z.array(PrincipalId),
  ended_at: IsoDateTime.nullable(),
  card_id: z.string().min(1).nullable(),
  ledger_entry_id: z.string().min(1).nullable(),
});
export type DocumentGateBinding = z.infer<typeof DocumentGateBinding>;

export const DocumentVersion = z.strictObject({
  version: z.number().int().min(1),
  sha256: Sha256Hex,
  step: StepId,
  stored_at: IsoDateTime,
  bytes: z.number().int().min(1),
  author: DocumentAuthor,
  /** Rendered from the content (`renderArtefact`); `null` when withheld below D1. */
  markdown: z.string().nullable(),
  withheld: z.boolean(),
  /** The gates that bound exactly this version, in the order they opened. */
  gates: z.array(DocumentGateBinding),
});
export type DocumentVersion = z.infer<typeof DocumentVersion>;

export const ItemDocument = z.strictObject({
  type: ArtefactType,
  group: DocumentGroup,
  /** Oldest first. */
  versions: z.array(DocumentVersion).min(1),
});
export type ItemDocument = z.infer<typeof ItemDocument>;

export const ItemDocumentsView = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  /** In the order each type was first stored. */
  documents: z.array(ItemDocument),
  /** Stored rows whose bytes do not hash to their hash or whose event is missing: not served, counted. */
  not_intact: z.number().int().min(0),
  data_class: DataClass,
});
export type ItemDocumentsView = z.infer<typeof ItemDocumentsView>;

/** The documents cut to a data class: the markdown needs D1. */
export const cutDocumentsView = (v: ItemDocumentsView, dc: DataClass): ItemDocumentsView =>
  reachesClass(dc, DOCUMENT_TEXT_CLASS)
    ? { ...v, data_class: dc }
    : {
        ...v,
        documents: v.documents.map((d) => ({
          ...d,
          versions: d.versions.map((x) => ({
            ...x,
            markdown: null,
            withheld: x.withheld || x.markdown !== null,
          })),
        })),
        data_class: dc,
      };

// ---------------------------------------------------------------- Timeline

/** A timeline entry's kind: an item event, or a document stored on the item's planning stream. */
export const ItemTimelineKind = z.enum([...ItemEventTypeValues, PLANNING_EVENT.artefact_stored]);
export type ItemTimelineKind = z.infer<typeof ItemTimelineKind>;

/** A code a timeline entry carries (an outcome, an edge, a reason code): never free text. */
export const TimelineCode = z.string().regex(/^[A-Za-z0-9_.:+-]{1,64}$/);

export const ItemTimelineEntry = z.strictObject({
  /** The record's global order. */
  global_seq: z.number().int().min(1),
  at: IsoDateTime,
  kind: ItemTimelineKind,
  /** Who recorded it: a principal, or the factory's `system.*` actor. */
  actor: z.string().min(1),
  /** The person the event names (`by`), when it is not the actor. */
  by: PrincipalId.nullable(),
  step: StepId.nullable(),
  gates: z.array(GateId),
  /** Short codes from the event: an outcome, an edge, a trigger, a reason code, a lane, a document type. */
  codes: z.array(TimelineCode),
});
export type ItemTimelineEntry = z.infer<typeof ItemTimelineEntry>;

export const ItemTimelineView = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  /** Oldest first. */
  entries: z.array(ItemTimelineEntry),
});
export type ItemTimelineView = z.infer<typeof ItemTimelineView>;

// ---------------------------------------------------------------- Agents (P2-3)

export const AgentDetailView = z.strictObject({
  agent: AgentRegistryRow,
  input_schema_id: z.string().min(1),
  /** JSON Schema (draft 2020-12) generated from the contract's Zod. */
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
  lock_format: z.string().min(1),
});
export type AgentDetailView = z.infer<typeof AgentDetailView>;

export const AgentRecentRunsView = z.strictObject({
  agent_id: AgentId,
  /** Newest first, at most `limit`. */
  runs: z.array(AgentRunView),
  /** The runs of the agent read (the newest 5000 at most, every project): `runs` is the viewable newest of them. */
  total: z.number().int().min(0),
});
export type AgentRecentRunsView = z.infer<typeof AgentRecentRunsView>;
