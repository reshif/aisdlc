import { z } from 'zod';
import { DataClass } from '../values.js';
import { CardKind } from './onboarding.js';
import { GitSha, IsoDateTime, PrincipalId, ProjectId, S0RecordId, Sha256Hex } from './ids.js';
import { ActionId, PdpResource } from './policy.js';

// The Conversation context (PLAN M18; DM §3.2 AssistantTurn, §3.9; docs/design/portal-config.md §4): the onboarding
// assistant beside the S0 page and "Ask the factory". One vocabulary for core (which records threads and turns and runs
// the assistant), the agent registry (whose `assistant` OutputSchema reuses `Citation` and `ProposalActionId`), the
// bff and the portal.
//
// THE RULES
//  - The assistant answers; it never decides, writes or clicks. What it may suggest is a ProposalButton: an action id
//    from a closed list, which the FACTORY turns into the normal route it calls and the PDP action that route needs.
//    The portal renders it; the person clicks it; the route runs under the person's own PDP decision. Nothing a model
//    says names a route, a method or a resource.
//  - Every answer cites what it says: a file at the commit the thread is grounded on (with lines), or a record or
//    ledger reference the context carried. A citation the context did not carry refuses the answer.
//  - What a person types and what the assistant answers are RedactablePayloads: the text lives off the hash chain
//    (core's `conversation_payload` table, erasable) with any secret masked before it is stored or sent to a model; the
//    record carries only the payload's id, its hash and the redaction counts.
//  - A thread belongs to one person and is never shown to anyone else.

// ---------------------------------------------------------------- ids and subjects

export const ThreadId = z.uuid();
export type ThreadId = z.infer<typeof ThreadId>;
export const AskId = z.uuid();
export type AskId = z.infer<typeof AskId>;
export const PayloadId = z.uuid();
export type PayloadId = z.infer<typeof PayloadId>;

/** What a thread is about: one S0 record (the onboarding assistant) or a project ("Ask the factory"). */
export const ThreadSubject = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('s0'), s0_id: S0RecordId, project_id: ProjectId }),
  z.strictObject({ kind: z.literal('project'), project_id: ProjectId }),
]);
export type ThreadSubject = z.infer<typeof ThreadSubject>;

/** What the browser names when it starts a thread: the project of an S0 subject is core's to look up. */
export const ThreadSubjectRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('s0'), s0_id: S0RecordId }),
  z.strictObject({ kind: z.literal('project'), project_id: ProjectId }),
]);
export type ThreadSubjectRequest = z.infer<typeof ThreadSubjectRequest>;

// ---------------------------------------------------------------- citations

const Path = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\0\n]+$/);

/**
 * Where a sentence of an answer comes from. `file`: a path at a commit, lines inclusive and 1-based; the commit must be
 * the thread's grounding head and the lines must lie inside an excerpt the context served. `record`: a record fact the
 * context carried (`s0:<id>`, `card:<id>`, `item:<id>`, `step:<s0>/<step>`). `ledger`: a ledger entry the context
 * carried (`ledger:<entry id>`).
 */
export const Citation = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('file'),
      path: Path,
      commit_sha: GitSha,
      line_from: z.number().int().min(1),
      line_to: z.number().int().min(1),
    })
    .refine((c) => c.line_to >= c.line_from, {
      message: 'line_to is before line_from',
      path: ['line_to'],
    }),
  z.strictObject({
    kind: z.literal('record'),
    ref: z.string().regex(/^(s0|card|item|step|project):[A-Za-z0-9_.:/-]{1,200}$/),
  }),
  z.strictObject({
    kind: z.literal('ledger'),
    ref: z.string().regex(/^ledger:[A-Za-z0-9_.:-]{1,128}$/),
  }),
]);
export type Citation = z.infer<typeof Citation>;

// ---------------------------------------------------------------- proposal buttons

/**
 * What the assistant may suggest, as a closed list. Each maps (in core, `proposalButton`) to ONE normal route and the
 * PDP action that route asks for; the target must be something the thread's context carried.
 *   open_card         the card's page                     (card.decide is asked there; the button only navigates)
 *   recheck_controls  POST /api/cards/:id/recheck         (card.decide)
 *   open_s0           the S0 page                         (project.view)
 *   open_item         the item page                       (item.view_floor)
 *   ask_for_work      the Ask-for-work page of a project  (work.request)
 */
export const ProposalActionId = z.enum([
  'open_card',
  'recheck_controls',
  'open_s0',
  'open_item',
  'ask_for_work',
]);
export type ProposalActionId = z.infer<typeof ProposalActionId>;

/**
 * A button the portal renders under an answer. `navigate`: a portal page (`route.path` is the page); `call`: the bff
 * route the button posts to under the person's session. `pdp_action` and `resource` are what the portal asks the
 * access layer to lock or show the button with, and what the route itself asks the PDP again. Never executed by the
 * model or by core.
 */
export const ProposalButton = z.strictObject({
  action_id: ProposalActionId,
  label: z.string().min(1).max(80),
  kind: z.enum(['navigate', 'call']),
  route: z.strictObject({
    method: z.enum(['GET', 'POST']),
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^\/[A-Za-z0-9/_-]*$/),
  }),
  pdp_action: ActionId,
  resource: PdpResource,
});
export type ProposalButton = z.infer<typeof ProposalButton>;

// ---------------------------------------------------------------- drafts

/**
 * Text the assistant drafts for the person to edit and put on a card themselves ("Use in card N" copies it into the
 * card's field; the person still submits the card). Never sent anywhere by the factory.
 */
export const Draft = z.strictObject({
  draft_id: z.string().regex(/^d[0-9]{1,2}$/),
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(4000),
  /** The card the text is meant for, if any. */
  card: CardKind.nullable(),
  /** Lint rule ids the text tripped (advisory for the person; a blocking one refuses the answer). */
  lint: z.array(z.string().min(1).max(32)).max(20),
});
export type Draft = z.infer<typeof Draft>;

// ---------------------------------------------------------------- redactable payloads

/** One secret rule that matched, and how many times its values were masked. Never the value. */
export const PayloadRedaction = z.strictObject({
  rule_id: z.string().min(1).max(64),
  count: z.number().int().min(1),
});
export type PayloadRedaction = z.infer<typeof PayloadRedaction>;

/**
 * The text of a turn, kept OFF the hash chain: the record names it by id and the sha256 of the stored (masked) text.
 * Erasing it removes the text and keeps the hash, so the record still verifies and says that something was said.
 */
export const RedactablePayload = z.strictObject({
  payload_id: PayloadId,
  sha256: Sha256Hex,
  redactions: z.array(PayloadRedaction).max(64),
  erased_at: IsoDateTime.nullable(),
});
export type RedactablePayload = z.infer<typeof RedactablePayload>;

/** The mark a masked secret leaves in stored text (the gateway's redaction uses the same one). */
export const redactionMark = (rule: string): string => `[REDACTED:${rule}]`;

// ---------------------------------------------------------------- turns and threads

export const TurnRole = z.enum(['person', 'assistant']);
export type TurnRole = z.infer<typeof TurnRole>;

/** DM §3.9 AssistantTurn kinds, those the assistant uses: a person's `message`, an `answer`, `drafts`, a `refusal`. */
export const TurnKind = z.enum(['message', 'answer', 'drafts', 'refusal']);
export type TurnKind = z.infer<typeof TurnKind>;

/**
 * Why the factory answered with a refusal instead of the model's words. The model's own refusals (a question outside
 * the person's view, a secret asked for) are `declined`.
 */
export const RefusalCode = z.enum([
  'budget_exhausted',
  'stale_head',
  'no_census',
  'not_visible',
  'output_invalid',
  'secret_in_output',
  'gateway_refused',
  'unavailable',
  'declined',
]);
export type RefusalCode = z.infer<typeof RefusalCode>;
export const RefusalCodeValues: readonly RefusalCode[] = RefusalCode.options;

/** What the factory noticed about a question or the context (shown on the turn). */
export const AssistantFlag = z.enum([
  /** Repo or request text carried an instruction (approve, push, reveal...): quoted as data and ignored. */
  'planted_instruction',
  /** The person asked for something outside their view: the answer says it cannot see it. */
  'outside_view',
  /** The person asked for a secret value. */
  'secret_requested',
  /** The head moved since the census the thread is grounded on. */
  'stale_head',
  /** The model proposed an action on something the context did not carry: the button was dropped. */
  'proposal_dropped',
  /** A secret was masked in the person's message before it was stored or sent. */
  'secret_masked',
]);
export type AssistantFlag = z.infer<typeof AssistantFlag>;

/** The fixed text of each factory refusal (the model's words are never used for one). */
export const REFUSAL_TEXT: Readonly<Record<RefusalCode, string>> = {
  budget_exhausted:
    'Your assistant budget for today (assistant_user_day) is spent. It resets at 00:00 UTC; nothing else in the portal is affected.',
  stale_head:
    'The repository moved on since the census this thread is grounded on. I answer nothing about the new head until a re-census.',
  no_census: 'There is no census of this repository yet, so there is nothing I can cite.',
  not_visible: 'I can only answer about what you can see yourself.',
  output_invalid:
    'I could not produce an answer that passes the factory checks (schema, citations, lint). Ask again, or more narrowly.',
  secret_in_output: 'My answer would have contained a secret, so it was withheld.',
  gateway_refused: 'The model gateway refused the call (a kill switch, route or data class).',
  unavailable: 'The assistant is not available right now. Nothing was changed.',
  declined: 'I cannot help with that here.',
};

export const Turn = z.strictObject({
  thread_id: ThreadId,
  seq: z.number().int().min(1),
  role: TurnRole,
  kind: TurnKind,
  at: IsoDateTime,
  payload: RedactablePayload,
  /** The stored text; `null` once the payload is erased. */
  text: z.string().max(8000).nullable(),
  citations: z.array(Citation).max(20),
  proposals: z.array(ProposalButton).max(5),
  drafts: z.array(Draft).max(3),
  flags: z.array(AssistantFlag).max(8),
  refusal: RefusalCode.nullable(),
  /** Assistant turns: the commit the answer is grounded on (`null`: no repo grounding). */
  grounding_sha: GitSha.nullable(),
  ask_id: AskId.nullable(),
});
export type Turn = z.infer<typeof Turn>;

export const Thread = z.strictObject({
  thread_id: ThreadId,
  owner: PrincipalId,
  subject: ThreadSubject,
  title: z.string().min(1).max(120),
  turns: z.number().int().min(0),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type Thread = z.infer<typeof Thread>;

/**
 * One question and its answer (the "Ask the factory" session of DM): who asked, under which per-ask key and which budget
 * group, grounded on what, and how it ended. Ids, hashes and counts only.
 */
export const AskSession = z.strictObject({
  ask_id: AskId,
  thread_id: ThreadId,
  principal: PrincipalId,
  budget_group: z.string().min(1).max(128),
  vkey_id: z.string().min(1).max(128).nullable(),
  grounding_sha: GitSha.nullable(),
  context_sha256: Sha256Hex.nullable(),
  outcome: z.enum(['answered', 'refused']),
  refusal: RefusalCode.nullable(),
  attempts: z.number().int().min(0).max(8),
  tokens_in: z.number().int().min(0),
  tokens_out: z.number().int().min(0),
  started_at: IsoDateTime,
  finished_at: IsoDateTime,
});
export type AskSession = z.infer<typeof AskSession>;

// ---------------------------------------------------------------- the per-person day budget

/** The gateway budget group family of the assistant: one group per person per UTC day. */
export const ASSISTANT_BUDGET_FAMILY = 'assistant_user_day';
/** `assistant_user_day:<24 hex of sha256(principal)>:<YYYY-MM-DD>`: no principal id leaves for the gateway. */
export const AssistantBudgetGroupId = z
  .string()
  .regex(/^assistant_user_day:[0-9a-f]{24}:[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

export const AssistantBudgetView = z.strictObject({
  group_id: AssistantBudgetGroupId,
  max_tokens: z.number().int().min(1),
  max_cost_micro_usd: z.number().int().min(1),
  used_tokens: z.number().int().min(0),
  used_cost_micro_usd: z.number().int().min(0),
  exhausted: z.boolean(),
  resets_at: IsoDateTime,
});
export type AssistantBudgetView = z.infer<typeof AssistantBudgetView>;

// ---------------------------------------------------------------- record events

export const CONVERSATION_EVENT = {
  thread_opened: 'conversation.thread_opened',
  turn_recorded: 'conversation.turn_recorded',
  ask_recorded: 'conversation.ask_recorded',
  payload_erased: 'conversation.payload_erased',
} as const;
export type ConversationEventType = (typeof CONVERSATION_EVENT)[keyof typeof CONVERSATION_EVENT];

export const threadStream = (id: string): string => `thread:${id}`;

export const ThreadOpenedPayload = z.strictObject({
  thread_id: ThreadId,
  owner: PrincipalId,
  subject: ThreadSubject,
  /** The title is the person's words, so it is a payload too; the read model shows it. */
  title_payload: RedactablePayload.omit({ erased_at: true }),
});
export type ThreadOpenedPayload = z.infer<typeof ThreadOpenedPayload>;

export const TurnRecordedPayload = z.strictObject({
  thread_id: ThreadId,
  seq: z.number().int().min(1),
  role: TurnRole,
  kind: TurnKind,
  payload: RedactablePayload.omit({ erased_at: true }),
  citations: z.array(Citation).max(20),
  proposals: z.array(ProposalButton).max(5),
  /** Drafts by id and hash only: their text is in the turn's payload. */
  drafts: z
    .array(
      z.strictObject({
        draft_id: z.string().regex(/^d[0-9]{1,2}$/),
        card: CardKind.nullable(),
        sha256: Sha256Hex,
      }),
    )
    .max(3),
  flags: z.array(AssistantFlag).max(8),
  refusal: RefusalCode.nullable(),
  grounding_sha: GitSha.nullable(),
  ask_id: AskId.nullable(),
});
export type TurnRecordedPayload = z.infer<typeof TurnRecordedPayload>;

export const AskRecordedPayload = AskSession;
export type AskRecordedPayload = AskSession;

export const PayloadErasedPayload = z.strictObject({
  thread_id: ThreadId,
  payload_id: PayloadId,
  sha256: Sha256Hex,
});
export type PayloadErasedPayload = z.infer<typeof PayloadErasedPayload>;

// ---------------------------------------------------------------- API shapes (core `/v1/assistant/*`, bff `/api/assistant/*`)

export const ASSISTANT_QUESTION_MAX = 2000;

/**
 * What the PDP must allow on the subject's project before the assistant is asked or a thread is shown (PLAN §7a,
 * 2026-11-12): seeing the project AND using the assistant. Core and the bff ask both, every time, and the portal's
 * hint asks both too.
 */
export const ASSISTANT_ACTIONS = [
  'project.view',
  'assistant.use',
] as const satisfies readonly ActionId[];

/** `POST /v1/assistant/ask`: a new thread (`subject`) or a turn on an existing one (`thread_id`). */
export const AskRequest = z
  .strictObject({
    thread_id: ThreadId.optional(),
    subject: ThreadSubjectRequest.optional(),
    text: z.string().trim().min(1).max(ASSISTANT_QUESTION_MAX),
    on_behalf_of: PrincipalId,
    /** The person's data class on the subject's project (the bff's reading of their roles). The assistant caps it at D1. */
    viewer_data_class: DataClass,
  })
  .refine((r) => (r.thread_id === undefined) !== (r.subject === undefined), {
    message: 'name either thread_id or subject',
  });
export type AskRequest = z.infer<typeof AskRequest>;

/** What a thread is grounded on now, as the panel's header shows it. */
export const ThreadGrounding = z.strictObject({
  repo: z.string().nullable(),
  /** The census head the thread answers about (`null`: no census). */
  census_sha: GitSha.nullable(),
  /** The head moved since that census (or knowledge says the index is stale): nothing is answered about the new head. */
  stale: z.boolean(),
});
export type ThreadGrounding = z.infer<typeof ThreadGrounding>;

export const ThreadView = z.strictObject({
  thread: Thread,
  turns: z.array(Turn),
  grounding: ThreadGrounding,
  budget: AssistantBudgetView.nullable(),
});
export type ThreadView = z.infer<typeof ThreadView>;

export const ThreadList = z.strictObject({ threads: z.array(Thread) });
export type ThreadList = z.infer<typeof ThreadList>;

export const AskResult = z.strictObject({
  thread: Thread,
  turns: z.array(Turn),
  ask: AskSession,
  budget: AssistantBudgetView.nullable(),
});
export type AskResult = z.infer<typeof AskResult>;
