import { z } from 'zod';
import { StepId, type StepId as StepIdT } from '../values.js';
import { ArtefactType, AgentId } from './agent-definitions.js';
import { AgentRunId } from './agent-runs.js';
import { IsoDateTime, ProjectId, Sha256Hex, WorkItemId } from './ids.js';

// Planning, S2 and S3 (PLAN M12.1, M12.2; DM §3.5 Proposal and Artefact, §8 gap 6): what a planning step
// stores and how a gate binds it. An Artefact is content-addressed (sha256 of the canonical JSON of what
// the step produced); a Proposal is one agent's answer to one run, accepted (it became an Artefact) or
// rejected (it did not validate, or it held a secret: only a hash and the reasons are kept, never the
// text). Both are record events on `planning:<item>` (authoritative for existence and hash); the bodies
// are in core's `artefact` table, which every read checks against the event's hash.

export const planningStream = (itemId: string): string => `planning:${itemId}`;
export const PLANNING_STREAM_PREFIX = 'planning:';

export const PLANNING_EVENT = {
  artefact_stored: 'artefact.stored',
  proposal_recorded: 'proposal.recorded',
} as const;
export type PlanningEventType = (typeof PLANNING_EVENT)[keyof typeof PLANNING_EVENT];

/**
 * The artefact each S2 and S3 step produces (a step stores exactly one primary artefact; its hash is
 * the step's `output_hash`). 3.3 is deterministic and stores its report; the rest are agent proposals.
 */
export const STEP_ARTEFACT: Readonly<Partial<Record<StepIdT, ArtefactType>>> = {
  '2.1': 'context_brief',
  '2.1b': 'reverse_engineering',
  '2.2': 'impact',
  '2.3': 'decision_brief',
  '2.4': 'initiative',
  '3.1': 'affected_requirements',
  '3.2': 'spec_delta',
  '3.3': 'validation_report',
  '3.4': 'oracle_specs',
  '3.5': 'spec_review',
};

/**
 * The steps whose artefacts a gate decides, in the order the card shows them. G2 approves the spec AND
 * the oracle specs together (FL FIX 9), with the clean-context review as the evidence beside them; G1f
 * is the final acceptance of the intent against everything S2 produced. The engine binds the latest
 * output hash of each step into the gate's subject hash, so changing any one changes what is decided.
 */
export const GATE_ARTEFACT_STEPS: Readonly<Partial<Record<string, readonly StepIdT[]>>> = {
  G1f: ['2.1', '2.1b', '2.2', '2.3', '2.4'],
  G2: ['3.2', '3.4', '3.5'],
};

/** An artefact as a gate binds it: which step produced it, its type, and its content hash. */
export const GateArtefactRef = z.strictObject({
  step: StepId,
  type: ArtefactType,
  sha256: Sha256Hex,
});
export type GateArtefactRef = z.infer<typeof GateArtefactRef>;

export const ARTEFACT_SCHEMA_ID = 'artefact/1';

/** A stored artefact: the event on the item's planning stream. The body is in core's table under `sha256`. */
export const ArtefactStoredPayload = z.strictObject({
  schema: z.literal(ARTEFACT_SCHEMA_ID),
  item_id: WorkItemId,
  project_id: ProjectId,
  type: ArtefactType,
  /** 1, 2, ... per item and type: a redraft (B3, B10, B23) is the next version. */
  version: z.number().int().min(1),
  sha256: Sha256Hex,
  bytes: z.number().int().min(1),
  step: StepId,
  command_key: z.string().min(1),
  /** The agent run that proposed it; `null` for a deterministic step (3.3). */
  run_id: AgentRunId.nullable(),
});
export type ArtefactStoredPayload = z.infer<typeof ArtefactStoredPayload>;

/** DM Proposal.kind (`plan spec design triage intent learn`), with the kinds S2 and S3 add. */
export const ProposalKind = z.enum([
  'triage',
  'intent',
  'shape',
  'reverse_engineering',
  'spec',
  'oracle',
  'review',
  'design',
  'plan',
  'learn',
]);
export type ProposalKind = z.infer<typeof ProposalKind>;

/** Why a proposal was refused: field-level codes and paths, never the text of the output. */
export const ProposalReason = z.strictObject({
  path: z.string().max(200),
  code: z.string().min(1).max(64),
});
export type ProposalReason = z.infer<typeof ProposalReason>;

export const ProposalRecordedPayload = z.strictObject({
  proposal_id: z.string().min(1),
  item_id: WorkItemId,
  project_id: ProjectId,
  step: StepId,
  run_id: AgentRunId,
  command_key: z.string().min(1),
  agent_id: AgentId,
  /** Which model call of the command this answers (B3: three automatic attempts). */
  attempt: z.number().int().min(1),
  kind: ProposalKind,
  status: z.enum(['accepted', 'rejected']),
  /** `accepted`: the artefact it became. */
  artefact_sha256: Sha256Hex.nullable(),
  /** The hash of what the model said (its text, before parsing): all that is kept of a refused output. */
  output_sha256: Sha256Hex,
  reasons: z.array(ProposalReason).max(50),
});
export type ProposalRecordedPayload = z.infer<typeof ProposalRecordedPayload>;

export const PlanningEventPayloads = {
  [PLANNING_EVENT.artefact_stored]: ArtefactStoredPayload,
  [PLANNING_EVENT.proposal_recorded]: ProposalRecordedPayload,
} as const satisfies Record<PlanningEventType, z.ZodType>;

/** One artefact as the portal and an agent's input read it: its identity, the content and the rendered markdown. */
export const ArtefactView = z.strictObject({
  item_id: WorkItemId,
  step: StepId,
  type: ArtefactType,
  version: z.number().int().min(1),
  sha256: Sha256Hex,
  stored_at: IsoDateTime,
  /** Rendered for people from the content by one pure function (never stored, always reproducible). */
  markdown: z.string(),
});
export type ArtefactView = z.infer<typeof ArtefactView>;

/** What a gate card shows: the artefacts its subject hash binds, rendered, each with its hash. */
export const GateArtefactsView = z.strictObject({
  card_id: z.string().min(1),
  project_id: ProjectId,
  item_id: WorkItemId,
  gates: z.array(z.string()),
  subject_hash: Sha256Hex,
  /** `false`: an artefact the card names is missing or its stored bytes do not hash to the bound hash. */
  intact: z.boolean(),
  artefacts: z.array(
    z.strictObject({
      step: StepId,
      type: ArtefactType,
      sha256: Sha256Hex,
      version: z.number().int().min(1).nullable(),
      markdown: z.string().nullable(),
      intact: z.boolean(),
    }),
  ),
});
export type GateArtefactsView = z.infer<typeof GateArtefactsView>;
