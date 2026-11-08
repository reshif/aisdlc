import { z } from 'zod';
import { hashCanonical } from '@aisdlc/kernel';
import { Scope, Tier } from '../values.js';
import { B4Report, BranchRules, GithubPermissions, RepoFullName } from './codehost.js';
import {
  GitSha,
  IsoDateTime,
  PrincipalId,
  ProjectId,
  S0RecordId,
  Sha256Hex,
  CardId,
} from './ids.js';
import { CARD_PAYLOAD_MAX_ROWS } from './inbox.js';
import { FindingState } from './knowledge.js';
import {
  CardKind,
  CardStatus,
  ControlsAttestation,
  GapWaiverRequest,
  OnboardingStepId,
} from './onboarding.js';
import { GatingProfile, RoleMap, RoleSlot } from './projects.js';
import { GapDisposition } from './readiness.js';
import { VoteDecision } from './decisions.js';

// The S0 cards 1, 4, 5 and the security card (PLAN M7.3; OB §1A, §1B, §1C, §5.3 item 11, §5.5,
// §6.2 rows 0.1 and 0.4, §7): the controls report card 4 shows, what a person sends to decide each
// card, and the shapes the portal reads. The decisions themselves are rows of the card's list
// payload (`CardPayloadItem` in onboarding.ts), so one payload hash binds them in the ledger.

// ---------------------------------------------------------------- Controls report (card 4)

export const CONTROLS_SCHEMA_ID = 'controls/1';

/** `unknown` and `unreadable` are both "not met" for a blocking control (fail closed). */
export const ControlRead = z.enum(['ok', 'unknown', 'unreadable']);
export type ControlRead = z.infer<typeof ControlRead>;

export const ControlStatus = z.enum(['met', 'not_met', 'unknown', 'recorded']);
export type ControlStatus = z.infer<typeof ControlStatus>;

/**
 * What the report judges. `B4a`/`B4b` block M4 whatever the level; `B4c` is an amber remediation.
 * `protect_main` blocks except in the reduced 0.4 at Census, where it is RECORDED (OB §6.2 notes).
 */
export const ControlId = z.enum([
  'B4a',
  'B4b',
  'B4c',
  'protect_main',
  'app_scope',
  'codeowners',
  'instructions',
]);
export type ControlId = z.infer<typeof ControlId>;
export const ControlIdValues: readonly ControlId[] = ControlId.options;

export const Control = z.strictObject({
  id: ControlId,
  status: ControlStatus,
  blocking: z.boolean(),
  reasons: z.array(z.string().min(1)),
  /** What the person does on GitHub (the factory never does it). `null`: nothing to do. */
  instruction: z.string().min(1).nullable(),
});
export type Control = z.infer<typeof Control>;

const Presence = z.enum(['present', 'absent', 'unknown']);

/**
 * The controls report: deterministic from the code host's reads, no clock inside. The same reads
 * give the same bytes and the same `report_hash`. Unknown is never met.
 */
export const ControlsReport = z.strictObject({
  schema: z.literal(CONTROLS_SCHEMA_ID),
  repo: RepoFullName,
  branch: z.string().min(1).nullable(),
  head_sha: GitSha.nullable(),
  /** The reduced 0.4 of a Census onboarding: protect-main is recorded, B4 applies. */
  reduced: z.boolean(),
  effective_rules: z.strictObject({
    read: ControlRead,
    rules: BranchRules.nullable(),
    rules_hash: Sha256Hex.nullable(),
  }),
  app_installation: z.strictObject({
    read: ControlRead,
    installation_id: z.number().int().min(0).nullable(),
    repository_selection: z.enum(['all', 'selected']).nullable(),
    permissions: GithubPermissions.nullable(),
  }),
  b4: B4Report,
  codeowners: z.strictObject({
    read: ControlRead,
    path: z.string().min(1).nullable(),
    blob_sha: GitSha.nullable(),
    parse_errors: z.number().int().min(0).nullable(),
    /** What GitHub reports; `unknown` when it could not be read. */
    github_errors: z.union([z.number().int().min(0), z.literal('unknown')]),
    /** Protected paths with no owner; `null` when CODEOWNERS could not be read. */
    protected_uncovered: z.array(z.string().min(1)).nullable(),
  }),
  sensitive_paths: z.array(z.string().min(1)),
  sensitive_paths_hash: Sha256Hex,
  /** Read-only: the factory never writes an instruction file here. */
  instructions: z.strictObject({ agents_md: Presence, claude_md: Presence }),
  controls: z.array(Control),
  /** Blocking controls not met (empty: card 4 can be decided). */
  blocking_open: z.array(ControlId),
  report_hash: Sha256Hex,
});
export type ControlsReport = z.infer<typeof ControlsReport>;

/** The hash of a report: the canonical JSON of the report minus the hash itself. */
export function controlsReportHash(report: object): string {
  return hashCanonical(
    Object.fromEntries(Object.entries(report).filter(([k]) => k !== 'report_hash')),
  );
}

// ---------------------------------------------------------------- What a person sends

export const GapDispositionInput = z.strictObject({
  gap_id: z.string().min(1),
  disposition: GapDisposition,
  /** Only with `waive`: a reason and an expiry at most 90 days out. */
  waiver: GapWaiverRequest.optional(),
});
export type GapDispositionInput = z.infer<typeof GapDispositionInput>;

/** Card 1 (0.1): owner(s), tier, evidence disputes and the disposition of every gap. */
export const C1DecisionContent = z.strictObject({
  owners: z.array(PrincipalId).min(1).max(20),
  tier: Tier,
  /** "no prod, no real data, no dependants" (DEC-4); required to sign T0 where the config says so. */
  t0_attestation: z.boolean().optional(),
  regulatory_attested: z.boolean().optional(),
  criticality_attested: z.boolean().optional(),
  disputes: z
    .array(z.strictObject({ ref: z.string().min(1).max(120), note: z.string().min(1).max(500) }))
    .max(50)
    .optional(),
  gaps: z.array(GapDispositionInput).max(CARD_PAYLOAD_MAX_ROWS),
});
export type C1DecisionContent = z.infer<typeof C1DecisionContent>;

/** A kill delegation a person asks for; the grant (who, when) is stamped by the server. */
export const KillDelegationInput = z.strictObject({ delegate: PrincipalId, scope: Scope });
export type KillDelegationInput = z.infer<typeof KillDelegationInput>;

/** Card 4 (0.4): the attestations, the role map, two-person, the gating profile, kill delegations. */
export const C4DecisionContent = z.strictObject({
  /** The report the person was shown; a decision on a report that changed is refused. */
  controls_report_hash: Sha256Hex,
  attestations: ControlsAttestation,
  role_map: RoleMap,
  two_person_enabled: z.boolean(),
  gating_profile: GatingProfile,
  kill_delegations: z.array(KillDelegationInput).max(100),
});
export type C4DecisionContent = z.infer<typeof C4DecisionContent>;

/** Card 5 (0.5): nothing to enter; the factory assembled the package. */
export const C5DecisionContent = z.strictObject({});
export type C5DecisionContent = z.infer<typeof C5DecisionContent>;

/** The security card, one finding: the new state and the person's reason (kept in the Security store). */
export const SecrDecisionContent = z.strictObject({
  state: FindingState.exclude(['open']),
  reason: z.string().min(1).max(2000),
});
export type SecrDecisionContent = z.infer<typeof SecrDecisionContent>;

// ---------------------------------------------------------------- HTTP

export const CardPrepareRequest = z.strictObject({ on_behalf_of: PrincipalId });
export type CardPrepareRequest = z.infer<typeof CardPrepareRequest>;

export const CardEvidenceRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  nonce: z.string().min(1),
  evidence_hash: Sha256Hex,
});
export type CardEvidenceRequest = z.infer<typeof CardEvidenceRequest>;

export const CardDecideRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  nonce: z.string().min(1),
  decision: VoteDecision,
  /** The card's decision content (`C1DecisionContent`...); absent on a send-back or a rejection. */
  content: z.unknown().optional(),
  reason: z.string().min(1).max(500).optional(),
});
export type CardDecideRequest = z.infer<typeof CardDecideRequest>;

export const CardRecheckRequest = z.strictObject({ on_behalf_of: PrincipalId });
export type CardRecheckRequest = z.infer<typeof CardRecheckRequest>;

/** One card of an S0 record, as the portal lists it. */
export const OnboardingCardSummary = z.strictObject({
  card_id: CardId,
  s0_id: S0RecordId,
  project_id: ProjectId,
  card: CardKind,
  step: OnboardingStepId,
  status: CardStatus,
  /** Whose inbox: the slot that decides it. */
  slot: RoleSlot,
  opened_at: IsoDateTime,
  payload_hash: Sha256Hex.nullable(),
  /** The record is waiting at this card: it can be prepared and decided now. */
  actionable: z.boolean(),
});
export type OnboardingCardSummary = z.infer<typeof OnboardingCardSummary>;
