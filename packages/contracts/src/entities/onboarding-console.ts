import { z } from 'zod';
import { hashCanonical } from '@aisdlc/kernel';
import { Tier } from '../values.js';
import { GapDisposition } from './readiness.js';
import { RoleSlot } from './projects.js';
import { IsoDateTime, PrincipalId, S0RecordId, Sha256Hex } from './ids.js';
import { PayloadRedaction } from './conversation.js';

// The onboarding agent console (docs/design/onboarding-console.md; P1): ONE agent surface for an onboarding. A SESSION
// has a SUBJECT (today an S0 record); the agent `onboarder` runs a server-side tool loop in core, on behalf of the
// person who started it. The vocabulary is here once for core, the agent registry, the bff and the portal.
//
// THE RULES
//  - The agent decides nothing. Reading and the factory's own re-checks run by themselves; every change of a person's
//    choice is a PROPOSAL the person accepts, edits or rejects; every gate stays a person's (card decisions, step-ups,
//    M1, X2, the security slot). "Acts more" means more tools run without a click, never a gate.
//  - A tool's targets are bound by the session (s0, repo, census commit, card ids); the model supplies only ids from
//    closed sets the session listed.
//  - What a person types and what the agent says are RedactablePayloads (text off the hash chain, erasable); the record
//    carries ids, hashes and counts.

// ---------------------------------------------------------------- ids, stream, events

export const onboardingSessionStream = (s0Id: string): string => `onboarding-session:${s0Id}`;
/** The record's actor of the agent's own events: never a person, so never a decider. */
export const ONBOARDING_SESSION_ACTOR = 'agent.onboarder';
/** The record's actor of the session's plumbing (waking, pausing): the factory, not a person. */
export const ONBOARDING_SESSION_SYSTEM = 'system.onboarding_console';

export const ONBOARDING_SESSION_EVENT = {
  /** A person started the session on an S0 record (or the factory did, on the first census). */
  opened: 'onboarding_session.opened',
  /** A turn: a person's message, the agent's, or an observation the factory appended (census, probe, card changed). */
  turn_recorded: 'onboarding_session.turn_recorded',
  /** One tool call and its outcome (ids, hashes, counts; never the output text). */
  tool_called: 'onboarding_session.tool_called',
  /** The agent proposed something for the person to accept, edit or reject. */
  proposal_recorded: 'onboarding_session.proposal_recorded',
  /** The person's answer to a proposal. */
  proposal_decided: 'onboarding_session.proposal_decided',
  /** running | awaiting_person | paused | stopped | done. */
  state_changed: 'onboarding_session.state_changed',
} as const;
export type OnboardingSessionEventType =
  (typeof ONBOARDING_SESSION_EVENT)[keyof typeof ONBOARDING_SESSION_EVENT];

// ---------------------------------------------------------------- state

export const ConsoleSessionState = z.enum([
  'running',
  'awaiting_person',
  'paused',
  'stopped',
  'done',
]);
export type ConsoleSessionState = z.infer<typeof ConsoleSessionState>;

/** Why a session is in its state when the person did not say: the factory's own reasons. */
export const ConsoleStateCause = z.enum([
  'person',
  'agent_asked',
  'record_changed',
  'kill_switch',
  'budget',
  'disabled',
  'onboarding_closed',
  'error',
]);
export type ConsoleStateCause = z.infer<typeof ConsoleStateCause>;

// ---------------------------------------------------------------- tools (closed lists)

/** What `OnboardingRead` may read, by name. The record, knowledge and the code host answer; nothing is written. */
export const ConsoleReadTopic = z.enum([
  'census_facts',
  'controls',
  'floors',
  'probe',
  'cards',
  'blockers',
  'signoff_feasibility',
]);
export type ConsoleReadTopic = z.infer<typeof ConsoleReadTopic>;

/**
 * What `OnboardingAct` may do. Each is something the factory does under its own record already (re-reading GitHub,
 * re-reading the repo, running the probe under DEC-18 and B1, rendering the fix pack for X2, syncing the cards): none
 * decides a gate, and `render_fix_pack` never pushes before X2 is approved in the ledger.
 */
export const ConsoleActTool = z.enum([
  'recheck_controls',
  'rerun_census',
  'run_probe',
  'render_fix_pack',
  'sync_cards',
]);
export type ConsoleActTool = z.infer<typeof ConsoleActTool>;

/** What `OnboardingPropose` may propose: a thing for the person to accept, edit or reject. */
export const ConsoleProposalKind = z.enum([
  'tier',
  'gap_disposition',
  'role_map',
  'settings',
  'claim',
  'instruction_text',
  'fix_file',
  'manual_step',
  'test_command',
  // an act the autonomy setting says to ask about first: accepting it runs it, as the person
  'act',
]);
export type ConsoleProposalKind = z.infer<typeof ConsoleProposalKind>;

export const ConsoleProposalState = z.enum([
  'open',
  'accepted',
  'edited',
  'rejected',
  'superseded',
]);
export type ConsoleProposalState = z.infer<typeof ConsoleProposalState>;

// ---------------------------------------------------------------- config

/** How an act tool runs: by itself, only after the person says so, or never. */
export const ConsoleAutonomy = z.enum(['auto', 'ask', 'off']);
export type ConsoleAutonomy = z.infer<typeof ConsoleAutonomy>;

/** The config key (factory layer, M1-gated): whether the console runs and how much the agent does by itself. */
export const ONBOARDING_CONSOLE_KEY = 'onboarding.console';

export const OnboardingConsoleConfig = z.strictObject({
  /** `false`: no session runs (every session reads as paused with cause `disabled`). */
  enabled: z.boolean(),
  /** Per act tool. Reads and proposals need no entry: they change nothing a person has not been asked about. */
  autonomy: z.strictObject({
    recheck_controls: ConsoleAutonomy,
    rerun_census: ConsoleAutonomy,
    run_probe: ConsoleAutonomy,
    render_fix_pack: ConsoleAutonomy,
    sync_cards: ConsoleAutonomy,
  }),
  /** Model calls in one wake, tool rounds included. */
  max_model_calls_per_wake: z.number().int().min(1).max(40),
  /** Tool calls in one wake. */
  max_tool_calls_per_wake: z.number().int().min(1).max(60),
});
export type OnboardingConsoleConfig = z.infer<typeof OnboardingConsoleConfig>;

/** The defaults: the owner's decision 2 (read and re-check automatically; draft the fix PR, X2 still gates the push). */
export const DEFAULT_ONBOARDING_CONSOLE: OnboardingConsoleConfig = {
  enabled: true,
  autonomy: {
    recheck_controls: 'auto',
    rerun_census: 'auto',
    run_probe: 'auto',
    render_fix_pack: 'auto',
    sync_cards: 'auto',
  },
  max_model_calls_per_wake: 12,
  max_tool_calls_per_wake: 24,
};

/** The config key (factory layer, M1-gated): the factory's guidelines for the onboarder, read as fenced Guidance. */
export const ONBOARDING_AGENT_GUIDELINES_KEY = 'onboarding.agent_guidelines';

export const AgentGuidelines = z.strictObject({
  /** Plain text. It is DATA to the agent (Guidance, level 3): it can narrow what the agent does, never widen it. */
  text: z.string().max(4000),
});
export type AgentGuidelines = z.infer<typeof AgentGuidelines>;
export const DEFAULT_AGENT_GUIDELINES: AgentGuidelines = { text: '' };

// ---------------------------------------------------------------- the session, as recorded

const PayloadRef = z.strictObject({
  payload_id: z.uuid(),
  sha256: Sha256Hex,
  redactions: z.array(PayloadRedaction).max(50),
});

export const SessionOpenedPayload = z.strictObject({
  s0_id: S0RecordId,
  project_id: z.string().min(1).max(128),
  /** The person the session acts for. Their PDP decisions are what every proposal's button is checked against. */
  started_by: PrincipalId,
  opened_at: IsoDateTime,
});
export type SessionOpenedPayload = z.infer<typeof SessionOpenedPayload>;

export const SessionTurnRole = z.enum(['person', 'agent', 'observation']);
export type SessionTurnRole = z.infer<typeof SessionTurnRole>;

export const SessionTurnPayload = z.strictObject({
  s0_id: S0RecordId,
  seq: z.number().int().min(1),
  role: SessionTurnRole,
  payload: PayloadRef,
  /** Agent turns: the prompt's sha256 and the factory's guideline revision, so a turn can be explained later. */
  prompt_sha256: Sha256Hex.nullable(),
  guidelines_revision: z.string().max(80).nullable(),
  /** Observation turns: what changed (`census_ready`, `probe_recorded`, `card_changed`, ...). */
  observed: z.string().max(80).nullable(),
  /** Observation turns: the hash of the state they describe (the blockers), so the same state is not observed twice. */
  observed_sha: Sha256Hex.nullable(),
  recorded_at: IsoDateTime,
});
export type SessionTurnPayload = z.infer<typeof SessionTurnPayload>;

export const SessionToolCalledPayload = z.strictObject({
  s0_id: S0RecordId,
  seq: z.number().int().min(1),
  tool: z.enum([
    'OnboardingRead',
    'KnowledgeSearch',
    'RepoRead',
    'OnboardingPropose',
    'OnboardingAct',
  ]),
  /** The topic, act tool or proposal kind (closed sets), or the search/read target for the two repo tools. */
  name: z.string().min(1).max(200),
  outcome: z.enum(['ok', 'refused', 'error', 'asked']),
  /** sha256 of what the tool returned (never the text). */
  result_sha256: Sha256Hex.nullable(),
  recorded_at: IsoDateTime,
});
export type SessionToolCalledPayload = z.infer<typeof SessionToolCalledPayload>;

export const SessionStateChangedPayload = z.strictObject({
  s0_id: S0RecordId,
  state: ConsoleSessionState,
  cause: ConsoleStateCause,
  /** The person who paused, stopped or resumed it (`null`: the factory). */
  by: PrincipalId.nullable(),
  at: IsoDateTime,
});
export type SessionStateChangedPayload = z.infer<typeof SessionStateChangedPayload>;

export const ConsoleProposal = z.strictObject({
  proposal_id: z.uuid(),
  kind: ConsoleProposalKind,
  /** What it is about, from a closed set the session listed (a gap id, a card id, a fix id, a role slot, ...). */
  target: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  title: z.string().min(1).max(200),
  why: z.string().min(1).max(1000),
  /** The proposed value, as the kind's own shape (validated by core against the kind); never executable. */
  value: z.unknown(),
});
export type ConsoleProposal = z.infer<typeof ConsoleProposal>;

export const SessionProposalRecordedPayload = z.strictObject({
  s0_id: S0RecordId,
  proposal: ConsoleProposal,
  /** The census head the proposal was made at (a test command binds to it). */
  census_hash: Sha256Hex.nullable(),
  /** sha256 over the canonical proposal: what an accept binds to. */
  proposal_sha256: Sha256Hex,
  turn_seq: z.number().int().min(1),
  recorded_at: IsoDateTime,
});
export type SessionProposalRecordedPayload = z.infer<typeof SessionProposalRecordedPayload>;

export const SessionProposalDecidedPayload = z.strictObject({
  s0_id: S0RecordId,
  proposal_id: z.uuid(),
  proposal_sha256: Sha256Hex,
  state: z.enum(['accepted', 'edited', 'rejected', 'superseded']),
  /** The person's value when `edited` (the edit is theirs; it is validated like the proposal). */
  edited_value: z.unknown().optional(),
  /** The person who decided; `null` when the factory superseded it (the agent proposed the same thing again). */
  by: PrincipalId.nullable(),
  at: IsoDateTime,
});
export type SessionProposalDecidedPayload = z.infer<typeof SessionProposalDecidedPayload>;

export const proposalSha256 = (p: ConsoleProposal): string => hashCanonical(p);

// ---------------------------------------------------------------- what a proposal may hold, by kind

/**
 * The value of each kind of proposal. The TARGET names what it is about (the tier: `tier`; a gap: its id; a role map
 * slot; a claim id; an instruction file `AGENTS.md`; a fix id; a step id; the test command: `test`; an act: its name).
 * Core checks the value against the kind AND against the session (the tier at or above the census floor, a disposition
 * the gap allows, a slot that exists, a fix path the factory may write, a plain test command) and the secret ruleset.
 */
export const ProposalValues = {
  tier: z.strictObject({ tier: Tier }),
  gap_disposition: z.strictObject({ disposition: GapDisposition }),
  role_map: z.strictObject({ principals: z.array(PrincipalId).max(20) }),
  settings: z.strictObject({ two_person_enabled: z.boolean() }),
  claim: z.strictObject({
    stance: z.enum(['affirm', 'correct', 'unknown']),
    text: z.string().max(1000).optional(),
  }),
  instruction_text: z.strictObject({ text: z.string().min(1).max(20_000) }),
  fix_file: z.strictObject({
    path: z.string().min(1).max(300),
    content: z.string().min(1).max(20_000),
  }),
  manual_step: z.strictObject({ text: z.string().min(1).max(500) }),
  test_command: z.strictObject({
    command: z.string().min(2).max(300),
    setup: z.string().min(2).max(300).optional(),
  }),
  act: z.strictObject({ act: ConsoleActTool }),
} as const satisfies Record<ConsoleProposalKind, z.ZodType>;

/** Whether a `role_map` proposal's target names a real slot. */
export const isRoleSlotTarget = (t: string): boolean => RoleSlot.safeParse(t).success;

/** The summary draft: what the person accepted in the console, as defaults for the one sign-off. Never a decision. */
export const ConsoleDraft = z.strictObject({
  tier: Tier.optional(),
  gaps: z.record(z.string(), GapDisposition),
  role_map: z.record(z.string(), z.array(PrincipalId)),
  two_person_enabled: z.boolean().optional(),
  /** The person-attested test command, bound to the census head it was accepted at. */
  test_command: z
    .strictObject({
      command: z.string(),
      setup: z.string().optional(),
      census_hash: Sha256Hex.nullable(),
    })
    .optional(),
  /** Paths of the fix files the person accepted (rendered by `render_fix_pack`). */
  fix_files: z.array(z.string()),
});
export type ConsoleDraft = z.infer<typeof ConsoleDraft>;

/** `POST /v1/s0/:id/console/proposals/:pid/decide`. */
export const ConsoleProposalDecideRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  decision: z.enum(['accept', 'edit', 'reject']),
  /** What the person saw: a proposal that changed since is refused. */
  proposal_sha256: Sha256Hex,
  /** With `edit`: the person's own value for the same kind. */
  edited_value: z.unknown().optional(),
});
export type ConsoleProposalDecideRequest = z.infer<typeof ConsoleProposalDecideRequest>;

/** `PATCH /v1/s0/:id/summary`: the person sets draft defaults directly; each is recorded as their own edit. */
export const ConsoleDraftPatch = z.strictObject({
  on_behalf_of: PrincipalId,
  tier: Tier.optional(),
  gaps: z.record(z.string(), GapDisposition).optional(),
  role_map: z.record(RoleSlot, z.array(PrincipalId).max(20)).optional(),
  two_person_enabled: z.boolean().optional(),
});
export type ConsoleDraftPatch = z.infer<typeof ConsoleDraftPatch>;

// ---------------------------------------------------------------- the views

export const ConsoleTurn = z.strictObject({
  seq: z.number().int().min(1),
  role: SessionTurnRole,
  text: z.string(),
  observed: z.string().nullable(),
  at: IsoDateTime,
});
export type ConsoleTurn = z.infer<typeof ConsoleTurn>;

export const ConsoleSessionView = z.strictObject({
  s0_id: S0RecordId,
  project_id: z.string(),
  started_by: PrincipalId,
  state: ConsoleSessionState,
  cause: ConsoleStateCause.nullable(),
  turns: z.array(ConsoleTurn),
  proposals: z.array(
    ConsoleProposal.extend({
      state: ConsoleProposalState,
      proposal_sha256: Sha256Hex,
      turn_seq: z.number().int(),
    }),
  ),
  /** The tier the person may still choose is the console's to say; the floor is the census's. */
  tier_floor: Tier.nullable(),
  /** What the person accepted so far (defaults for the sign-off). */
  draft: ConsoleDraft.optional(),
});
export type ConsoleSessionView = z.infer<typeof ConsoleSessionView>;

// ---------------------------------------------------------------- requests

/** The most a person may type to the onboarder in one message. */
export const CONSOLE_MESSAGE_MAX = 2000;

/** `POST /v1/s0/:id/console/start`, `.../pause`, `.../resume`, `.../stop`: the person the action is for. */
export const ConsoleControlRequest = z.strictObject({ on_behalf_of: PrincipalId });
export type ConsoleControlRequest = z.infer<typeof ConsoleControlRequest>;

/** `POST /v1/s0/:id/console/messages`. */
export const ConsoleMessageRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  text: z.string().min(1).max(CONSOLE_MESSAGE_MAX),
});
export type ConsoleMessageRequest = z.infer<typeof ConsoleMessageRequest>;

/** One row of the session list (`/assistant`): a session, what it is about, where it stands. */
export const ConsoleSessionRow = z.strictObject({
  s0_id: S0RecordId,
  project_id: z.string(),
  subject: z.literal('onboarding'),
  state: ConsoleSessionState,
  cause: ConsoleStateCause.nullable(),
  turns: z.number().int().min(0),
  started_by: PrincipalId,
  opened_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type ConsoleSessionRow = z.infer<typeof ConsoleSessionRow>;

export const ConsoleSessionList = z.strictObject({ sessions: z.array(ConsoleSessionRow) });
export type ConsoleSessionList = z.infer<typeof ConsoleSessionList>;
