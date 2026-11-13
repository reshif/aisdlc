import { z } from 'zod';
import { hashCanonical } from '@aisdlc/kernel';
import { Level, Tier } from '../values.js';
import { OnboardingStatus } from '../states/onboarding.js';
import { RepoFullName } from './codehost.js';
import { GitSha, PrincipalId, S0RecordId, Sha256Hex } from './ids.js';
import { C1DecisionContent, C4DecisionContent } from './onboarding-cards.js';
import { C2DecisionContent } from './onboarding-light.js';
import { CardKind, OnboardingStepId, OnboardingStepState } from './onboarding.js';
import { RoleMap } from './projects.js';

// Portal v2, agent-led onboarding (intent §4; screen-map §2.10, N10-N13; gap G4). The onboarding agent reads an S0
// record's census and controls and PROPOSES (what it learned, claims with evidence, fixes as one draft PR, gap
// dispositions); the person reads ONE summary and signs off ONCE. The cards C1, C2, C4, C5 stay the record
// underneath: the sign-off decides each of them as that person (prepare, evidence viewed, decide; every decision a
// ledger entry with its payload hash), in the order the S0 driver opens them, with step-up where the policy requires
// it. Nothing here approves anything by itself, and the factory never merges.

// ---------------------------------------------------------------- the agent's proposal, on the record

export const onboardingAgentStream = (s0Id: string): string => `onboarding-agent:${s0Id}`;
export const ONBOARDING_AGENT_EVENT = {
  /** The agent's validated output, recorded first (before any fix is rendered or offered). */
  proposed: 'onboarding_agent.proposed',
  /** A person began the one sign-off on exactly this summary (its hash). Decisions follow as ledger entries. */
  sign_off_started: 'onboarding_agent.sign_off_started',
} as const;
/** The record's actor of the agent's proposals: never a person, so never the signer. */
export const ONBOARDING_AGENT_ACTOR = 'agent.onboarding';

export const OnboardingAgentProposedPayload = z.strictObject({
  s0_id: S0RecordId,
  agent_id: z.literal('onboarding'),
  contract_version: z.string().min(1),
  prompt_sha256: Sha256Hex,
  model: z.string().min(1).max(120),
  /** The census the agent read (the record's) and its head. */
  census_hash: Sha256Hex,
  base_sha: GitSha,
  controls_report_hash: Sha256Hex.nullable(),
  /** sha256 of the canonical JSON of `output`. */
  output_hash: Sha256Hex,
  /** The output, validated against `onboarding.v1` and secret-scanned before it is recorded. */
  output: z.record(z.string(), z.unknown()),
  /** Fix files the factory dropped (a path outside its kind, a secret): `fix_id:path` and why. */
  dropped: z.array(z.strictObject({ ref: z.string().min(1).max(400), why: z.string().max(200) })),
  proposed_at: z.string().datetime(),
});
export type OnboardingAgentProposedPayload = z.infer<typeof OnboardingAgentProposedPayload>;

export const OnboardingSignOffStartedPayload = z.strictObject({
  s0_id: S0RecordId,
  summary_hash: Sha256Hex,
  by: PrincipalId,
  /** The factory admin signed outside the rules: the reason (recorded, never blocking). */
  override_reason: z.string().max(2000).nullable(),
  /**
   * What the person signed, recorded once: each card is decided with exactly this content when the driver opens it,
   * so a page reloaded between two cards loses nothing. No secret: these are the cards' own decision contents.
   */
  content: z.strictObject({
    c1: C1DecisionContent.optional(),
    c4: C4DecisionContent.optional(),
    c2: C2DecisionContent.optional(),
  }),
});
export type OnboardingSignOffStartedPayload = z.infer<typeof OnboardingSignOffStartedPayload>;

// ---------------------------------------------------------------- the summary (N12)

export const SummaryFixState = z.enum([
  /** Proposed; opening it as a PR waits for its approval (X2). */
  'awaiting_approval',
  /** Opening it was approved; the factory is opening the PR. */
  'opening',
  /** A draft PR is open on GitHub: a person reviews and merges it there. */
  'pr_open',
  'pr_merged',
  'pr_closed',
  /** Opening it was refused, or the Push Broker refused it. */
  'refused',
  /** Only a person can do it, on GitHub. */
  'manual',
]);
export type SummaryFixState = z.infer<typeof SummaryFixState>;

export const SummaryFix = z.strictObject({
  fix_id: z.string(),
  fix_kind: z.string(),
  title: z.string(),
  why: z.string(),
  paths: z.array(z.string()),
  manual_steps: z.array(z.string()),
  state: SummaryFixState,
  pr: z
    .strictObject({ number: z.number().int(), url: z.string().nullable(), branch: z.string() })
    .nullable(),
  /** The approval that opens the PR (X2), when one is open. */
  approval: z
    .strictObject({ card_id: z.string(), status: z.string(), may_decide: z.boolean() })
    .nullable(),
});
export type SummaryFix = z.infer<typeof SummaryFix>;

export const SummaryCard = z.strictObject({
  card: CardKind,
  card_id: z.string(),
  status: z.string(),
  /** Open and the record waits for it. */
  live: z.boolean(),
  /** Decided by the one sign-off (C1, C2, C4, C5), or its own approval (C3, SECR, X2) decided by its slot. */
  by_sign_off: z.boolean(),
});

export const SignOffState = z.enum([
  /** The agent has not finished, or the census is not in. */
  'not_ready',
  /** The summary can be signed. */
  'ready',
  /** Signing: some cards are decided, the factory is opening the next. */
  'in_progress',
  /** A confirm-it's-you is needed before the next decision (bound to `step_up.bound_hash`). */
  'needs_step_up',
  /** Another person must decide something first (or something must be fixed on GitHub). */
  'waiting',
  'done',
  /** The record ended another way (rejected, withdrawn, superseded). */
  'closed',
]);
export type SignOffState = z.infer<typeof SignOffState>;

export const OnboardingSummaryView = z.strictObject({
  s0_id: S0RecordId,
  project_id: z.string(),
  repo: RepoFullName,
  status: OnboardingStatus,
  requested_level: Level,
  signable_level: Level,
  steps: z.array(
    z.strictObject({
      step: OnboardingStepId,
      state: OnboardingStepState,
      cause: z.string().nullable(),
    }),
  ),
  waiting: z.string().nullable(),
  /** The agent's run: `null` until it proposed. */
  agent: z
    .strictObject({
      output_hash: Sha256Hex,
      model: z.string(),
      proposed_at: z.string(),
      summary: z.string(),
      learned: z.array(
        z.strictObject({
          topic: z.string(),
          status: z.string(),
          text: z.string(),
          evidence: z.array(z.string()),
        }),
      ),
      claims: z.array(
        z.strictObject({
          claim_id: z.string(),
          text: z.string(),
          confidence: z.string(),
          evidence: z.array(z.string()),
        }),
      ),
      questions: z.array(z.string()),
      dropped: z.number().int(),
    })
    .nullable(),
  fixes: z.array(SummaryFix),
  /** The census, by count; the tier floor the detectors set (raise only). */
  census: z
    .strictObject({
      census_hash: Sha256Hex,
      baseline_sha: GitSha,
      posture: z.string(),
      tier_floor: Tier,
      /** Signing the lowest risk needs the owner's "no prod, no real data, no dependants". */
      t0_required: z.boolean(),
      /** What only the owner can attest before the scorecard can be signed. */
      attest: z.array(z.enum(['regulatory', 'criticality'])),
      blockers_open: z.array(z.string()),
      gaps: z.array(
        z.strictObject({
          gap_id: z.string(),
          criterion: z.string(),
          severity: z.string(),
          allowed: z.array(z.string()),
          suggested: z.string(),
          why: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  /** The controls the factory read (protection, the App, CODEOWNERS, instructions) and what a person must do. */
  controls: z
    .strictObject({
      report_hash: Sha256Hex,
      blocking_open: z.array(z.string()),
      rows: z.array(
        z.strictObject({
          id: z.string(),
          status: z.string(),
          blocking: z.boolean(),
          instruction: z.string().nullable(),
        }),
      ),
      attestations_required: z.array(z.string()),
      operations_md: z.boolean(),
    })
    .nullable(),
  /** The role map the factory proposes (CODEOWNERS and collaborators), or the one in force. */
  role_map: z
    .strictObject({ proposed: RoleMap, unmapped_logins: z.array(z.string()), tier: Tier })
    .nullable(),
  /** Card 2's proposal (Light): the claims, questions and instruction files to affirm. */
  light: z.record(z.string(), z.unknown()).nullable(),
  /** What it will sign: the level, and the readiness scorecard once proposed (card 5). */
  readiness: z.strictObject({
    level: Level,
    prr: z
      .strictObject({
        record_hash: Sha256Hex,
        composite: z.unknown(),
        pillars: z.array(z.strictObject({ pillar: z.string(), level: z.unknown() })),
        lanes: z.array(z.string()),
      })
      .nullable(),
  }),
  cards: z.array(SummaryCard),
  sign_off: z.strictObject({
    state: SignOffState,
    /** What the sign-off is waiting for, in words. */
    note: z.string().nullable(),
    /** The person may sign (holds the slot of every sign-off card, or the bootstrap grant, or is the factory admin). */
    may_sign: z.boolean(),
    step_up: z.strictObject({ bound_hash: Sha256Hex, card: CardKind }).nullable(),
    started_by: z.string().nullable(),
  }),
  /** `onboardingSummaryHash` of this view. */
  summary_hash: Sha256Hex,
});
export type OnboardingSummaryView = z.infer<typeof OnboardingSummaryView>;

/**
 * The hash a sign-off is bound to: what the person is asked to agree to (the repo, the level, the agent's proposal,
 * the census, the controls, the role map, card 2's proposal, the readiness to sign, the fixes), never the progress
 * around it (steps, cards, a PR's state), so the page's polling does not move it.
 */
export function onboardingSummaryHash(v: OnboardingSummaryView): string {
  return hashCanonical({
    s0_id: v.s0_id,
    repo: v.repo,
    requested_level: v.requested_level,
    signable_level: v.signable_level,
    agent: v.agent === null ? null : v.agent.output_hash,
    census: v.census,
    controls: v.controls,
    role_map: v.role_map,
    light: v.light,
    readiness: v.readiness,
    fixes: v.fixes.map((f) => ({ fix_id: f.fix_id, fix_kind: f.fix_kind, paths: f.paths })),
  });
}

// ---------------------------------------------------------------- the one sign-off (N13)

/**
 * `POST /v1/s0/:id/sign-off`: what the person adjusted on the summary, and the summary hash they read. Each card's
 * content is validated by the card's own schema when that card is decided; a content the record does not need (C2 at
 * Census) is ignored. The page sends the same body again to continue (idempotent: decided cards are not decided
 * twice), with a step-up proof when the last answer asked for one.
 */
export const SignOffRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  /** The summary read; checked when the sign-off starts. */
  summary_hash: Sha256Hex.optional(),
  /** Sent with the start (absent once that card is decided); absent on a continuation (the recorded content is used). */
  c1: C1DecisionContent.optional(),
  /** `controls_report_hash` is the summary's; a card 4 opened on another report stops the sign-off. */
  c4: C4DecisionContent.optional(),
  c2: C2DecisionContent.optional(),
  step_up: z.strictObject({ proof: z.string().min(1), bound_hash: Sha256Hex }).optional(),
});
export type SignOffRequest = z.infer<typeof SignOffRequest>;

export const SignOffResult = z.strictObject({
  state: SignOffState,
  note: z.string().nullable(),
  /** The decisions this call recorded, in order (each a ledger entry). */
  decided: z.array(
    z.strictObject({
      card: z.string(),
      card_id: z.string(),
      ledger_seqs: z.array(z.number().int()),
    }),
  ),
  step_up: z.strictObject({ bound_hash: Sha256Hex, card: CardKind }).nullable(),
});
export type SignOffResult = z.infer<typeof SignOffResult>;
