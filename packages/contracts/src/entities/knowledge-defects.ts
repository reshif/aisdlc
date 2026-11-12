import { z } from 'zod';
import { RepoFullName } from './codehost.js';
import { KnowledgeDefectKind } from './context.js';
import { Level } from '../values.js';
import { AreaId, IsoDateTime, LedgerEntryId, PrincipalId, S0RecordId, Sha256Hex } from './ids.js';
import { LintRuleId } from './detectors.js';

// Knowledge defects as a re-onboarding trigger (PLAN M17; OB §8 "≥3 knowledge defects in 30 d" -> "Re-onboarding
// proposal item"; OB §8 R3: "≥3 knowledge-defect trips in an area become a re-onboarding trigger").
//
// The context builder (`buildContext`) LOGS a knowledge defect when repo text carries a directive, contradicts a higher
// level, fails its provenance or comes from an unmerged commit. Core now RECORDS each one that names a repository path
// (`knowledge.defect_recorded` on `kdefect:<repo>`), attributed to the area of the governing readiness record that
// holds the path (DEC-25; `.` for a repo-wide record). When an area reaches the threshold within the window (config
// `onboarding.reonboard_triggers`, M1-gated, the spec's numbers as defaults: 3 in 30 days), a re-onboarding proposal
// is RECORDED first (`reonboard.proposed` on `reonboard:<repo>`), once per area while it is open. Accepting it is a new
// S0 from 0.1, a new version and an M4 (OB §8): the proposal never changes a level itself, and R3 never raises one.

export const kdefectStream = (repo: string): string => `kdefect:${repo.toLowerCase()}`;
export const reonboardStream = (repo: string): string => `reonboard:${repo.toLowerCase()}`;

export const KDEFECT_EVENT = { recorded: 'knowledge.defect_recorded' } as const;
export const REONBOARD_EVENT = {
  proposed: 'reonboard.proposed',
  /** A person decided the proposal (accept or decline): recorded with its ledger entry (M17 part 2). */
  decided: 'reonboard.decided',
} as const;

/** The ledger entry a re-onboarding decision writes (subject: the governing S0 record). */
export const REONBOARD_LEDGER_ENTRY = 'reonboard.decided';

export const REONBOARD_TRIGGERS_KEY = 'onboarding.reonboard_triggers';

export const ReonboardTriggersConfig = z.strictObject({
  knowledge_defects: z.strictObject({
    /** How many defects in one area trigger a proposal (OB §8: ≥3). */
    count: z.number().int().min(1).max(1000),
    /** Over how many days (OB §8: 30). */
    window_days: z.number().int().min(1).max(365),
  }),
});
export type ReonboardTriggersConfig = z.infer<typeof ReonboardTriggersConfig>;

/** The spec's numbers (OB §8): three knowledge defects in an area within 30 days. */
export const DEFAULT_REONBOARD_TRIGGERS: ReonboardTriggersConfig = {
  knowledge_defects: { count: 3, window_days: 30 },
};

/** Where a defect was seen: the agent step that built the context. */
export const KnowledgeDefectSource = z.strictObject({
  kind: z.enum(['item_step', 'assistant', 'other']),
  ref: z.string().min(1).max(200),
});
export type KnowledgeDefectSource = z.infer<typeof KnowledgeDefectSource>;

export const KnowledgeDefectRecordedPayload = z.strictObject({
  /** sha256 of the canonical JSON of {repo, source, kind, path, rules}: one record per defect per source. */
  defect_id: Sha256Hex,
  repo: RepoFullName,
  project_id: z.string().min(1),
  area: AreaId,
  kind: KnowledgeDefectKind,
  /** The repository path the defect is about (never the text: a defect is logged, never quoted). */
  path: z.string().min(1).max(512),
  rules: z.array(LintRuleId),
  source: KnowledgeDefectSource,
  detected_at: IsoDateTime,
});
export type KnowledgeDefectRecordedPayload = z.infer<typeof KnowledgeDefectRecordedPayload>;

export const ReonboardTrigger = z.enum(['knowledge_defects']);
export type ReonboardTrigger = z.infer<typeof ReonboardTrigger>;

export const ReonboardProposedPayload = z.strictObject({
  proposal_id: Sha256Hex,
  repo: RepoFullName,
  project_id: z.string().min(1),
  area: AreaId,
  trigger: ReonboardTrigger,
  /** The defects in the window when it tripped, and the numbers in force. */
  count: z.number().int().min(1),
  threshold: z.number().int().min(1),
  window_days: z.number().int().min(1),
  defect_ids: z.array(Sha256Hex).min(1),
  /** The readiness record version it is about (`null`: none active). */
  prr_version: z.number().int().min(1).nullable(),
  proposed_at: IsoDateTime,
});
export type ReonboardProposedPayload = z.infer<typeof ReonboardProposedPayload>;

// ---------------------------------------------------------------- deciding a proposal (M17 part 2)
//
// OB §8: "Accept -> S0 from 0.1 -> new version -> M4". A proposal is a card in the project admin's inbox (the `admin`
// slot, the M1 slot that decides every after-onboarding change, OB §1B "any later change is a ledgered decision by the
// project admin"). Accepting it is ONE ledgered decision (`reonboard.decided`, recorded first) that starts a new S0
// record at the governing record's signed level through the normal onboarding request: 0.1 re-runs at the current
// head, then the cards and M4 make a new version. The governing version stays in force until that M4 (expiry and drift
// still apply to it). Declining closes the proposal and changes nothing. Either way the proposal is no longer open, so
// the next trip in the area may propose again.

export const ReonboardDecision = z.enum(['accept', 'decline']);
export type ReonboardDecision = z.infer<typeof ReonboardDecision>;

export const ReonboardDecidedPayload = z.strictObject({
  proposal_id: Sha256Hex,
  repo: RepoFullName,
  project_id: z.string().min(1),
  area: AreaId,
  decision: ReonboardDecision,
  /** Why, in the person's words (never repo text). */
  reason: z.string().trim().min(1).max(500),
  by: PrincipalId,
  at: IsoDateTime,
  /** The governing version when it was decided, and its hash (what stays in force until the new M4). */
  prr_version: z.number().int().min(1),
  record_hash: Sha256Hex,
  /** Accept: the level the new onboarding asks for (the governing record's signed level) and its S0 record. */
  level: Level.nullable(),
  new_s0_id: S0RecordId.nullable(),
  ledger_entry_id: LedgerEntryId,
});
export type ReonboardDecidedPayload = z.infer<typeof ReonboardDecidedPayload>;

export const ReonboardProposalStatus = z.enum(['proposed', 'accepted', 'declined']);
export type ReonboardProposalStatus = z.infer<typeof ReonboardProposalStatus>;
export const ReonboardProposalView = ReonboardProposedPayload.extend({
  status: ReonboardProposalStatus,
  /** The decision, once there is one. */
  decision: ReonboardDecidedPayload.nullable().optional(),
});
export type ReonboardProposalView = z.infer<typeof ReonboardProposalView>;

/** `POST /v1/projects/:id/reonboarding/decide`: what the bff sends for the signed-in person. */
export const ReonboardDecideRequest = z.strictObject({
  repo: RepoFullName,
  proposal_id: Sha256Hex,
  decision: ReonboardDecision,
  reason: z.string().trim().min(1).max(500),
  on_behalf_of: PrincipalId,
});
export type ReonboardDecideRequest = z.infer<typeof ReonboardDecideRequest>;

export const ReonboardDecideResult = z.strictObject({
  proposal_id: Sha256Hex,
  decision: ReonboardDecision,
  status: ReonboardProposalStatus,
  new_s0_id: S0RecordId.nullable(),
  ledger_entry_id: LedgerEntryId,
  /** The same decision was already recorded: nothing new was written. */
  duplicate: z.boolean(),
});
export type ReonboardDecideResult = z.infer<typeof ReonboardDecideResult>;
