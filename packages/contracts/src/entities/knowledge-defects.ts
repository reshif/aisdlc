import { z } from 'zod';
import { RepoFullName } from './codehost.js';
import { KnowledgeDefectKind } from './context.js';
import { AreaId, IsoDateTime, Sha256Hex } from './ids.js';
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
export const REONBOARD_EVENT = { proposed: 'reonboard.proposed' } as const;

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

export const ReonboardProposalStatus = z.enum(['proposed']);
export const ReonboardProposalView = ReonboardProposedPayload.extend({
  status: ReonboardProposalStatus,
});
export type ReonboardProposalView = z.infer<typeof ReonboardProposalView>;
