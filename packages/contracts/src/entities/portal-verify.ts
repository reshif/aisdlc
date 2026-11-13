import { z } from 'zod';
import { GateId } from '../flow.js';
import { DataClass, Lane, StepId } from '../values.js';
import { G6Acceptance } from './closeout.js';
import { RepoFullName } from './codehost.js';
import { CatalogueRef } from './config.js';
import { EvidenceGate, EvidenceStep, S7Disposition } from './evidence.js';
import { GateCheckOutcome, GateCheckReason } from './gate-check.js';
import {
  ReleaseBinding,
  ReleaseEnvironment,
  ReleaseRefusal,
  ReleaseSetting,
  ReleaseStatusState,
} from './gate-relay.js';
import {
  GitSha,
  IsoDateTime,
  PrincipalId,
  ProjectId,
  S0RecordId,
  Sha256Hex,
  WorkItemId,
} from './ids.js';
import { PackCodeownersOutcome, PackFile, PackKind } from './onboarding-pack.js';
import { UnitKey } from './planning.js';
import { G4Review, G4StandingState } from './review.js';
import {
  HandoffChoice,
  HandoffCode,
  HandoffPackRef,
  HandoffUuid,
  IrreversibleOperationDetail,
  OracleDeviationKind,
} from './work-lifecycle.js';
import {
  CheckVerdict,
  FindingKind,
  FindingSeverity,
  MutationScore,
  RepairClass,
  VerifyCheckId,
  VerifyRaise,
  VerifyStep,
} from './verify.js';

// What the portal reads about S7 (PLAN M14.6, portal-coverage §3 "S7 Verify on the item page", the gate screens
// of Q1, E6, X2, X3 and E2). Core builds each from the record alone (the `verify.check_recorded` events on
// `verify:<item>`, the item's stream, `core.evidence_pack`, the gates' streams and the ledger) and the bff cuts it to
// what the person may read:
//
//   GET /v1/items/:id/verify[?head=]          ItemVerifyView      the checks 7.1 to 7.5 of one Unit head
//   GET /v1/items/:id/evidence[?pack=]        EvidencePackView    the signed Evidence Pack(s) of 7.6
//   GET /v1/items/:id/evidence/:pack/signed   the signed bytes (aisdlc-signed-evidence-pack/1), for offline checking
//   GET /v1/cards/:id/gate/context            GateCardContext     what an S7-raised (or 4.5) gate binds and decides
//   bff GET /api/items/:id/gate-check         GateCheckRunsView   gate-check's verdicts on the item's PRs
//
// Nothing here is text an agent or a repo wrote except a finding's `message` (the verify service's own fixed
// sentences, never a secret's value) and a constitution report's markdown: both are withheld below the data
// class that reaches them (`findingNeedsClass`). The bff answers 403 below view level V2 (content of the work).

// ---------------------------------------------------------------- one check of 7.1 to 7.5

/** How a step reads on the item page: the verdict, or `raised` (a gate or ET10 it raised), or `not_run`. */
export const VerifyStepStatus = z.enum(['passed', 'failed', 'unknown', 'raised', 'not_run']);
export type VerifyStepStatus = z.infer<typeof VerifyStepStatus>;

export const VerifyFindingView = z.strictObject({
  kind: FindingKind,
  severity: FindingSeverity,
  repair_class: RepairClass,
  rule_id: z.string().min(1).max(64).nullable(),
  path: z.string().min(1).max(1024).nullable(),
  line: z.number().int().min(1).nullable(),
  /** `null` when withheld (`withheld: true`): the person's data class does not reach it. */
  message: z.string().max(500).nullable(),
  withheld: z.boolean(),
});
export type VerifyFindingView = z.infer<typeof VerifyFindingView>;

/** The gate (or the SECT triage of an ET10) a step's raise opened on the item, where it stands. */
export const RaisedGateView = z.strictObject({
  gate: GateId,
  gate_instance_id: z.string().min(1),
  status: z.string().min(1),
  outcome: z.string().nullable(),
  card_id: z.string().min(1).nullable(),
});
export type RaisedGateView = z.infer<typeof RaisedGateView>;

export const VerifyStepView = z.strictObject({
  step: VerifyStep,
  check: VerifyCheckId,
  status: VerifyStepStatus,
  /** The latest result's verdict for this head (`null`: no result). `unknown` is unmet. */
  verdict: CheckVerdict.nullable(),
  result_sha256: Sha256Hex.nullable(),
  recorded_at: IsoDateTime.nullable(),
  raised: VerifyRaise.nullable(),
  gate: RaisedGateView.nullable(),
  mutation: MutationScore.nullable(),
  rules_version: z.string().max(64).nullable(),
  kits: z.strictObject({
    total: z.number().int().min(0),
    answered: z.number().int().min(0),
  }),
  findings: z.strictObject({
    total: z.number().int().min(0),
    /** high and critical: what fails a check */
    failing: z.number().int().min(0),
    items: z.array(VerifyFindingView).max(100),
  }),
  /** How many results this step has for this head (the latest is shown). */
  runs: z.number().int().min(0),
});
export type VerifyStepView = z.infer<typeof VerifyStepView>;

// ---------------------------------------------------------------- the Evidence Pack

export const EvidencePackSummary = z.strictObject({
  pack_sha256: Sha256Hex,
  unit_key: z.string().min(1).max(128),
  base_sha: GitSha,
  head_sha: GitSha,
  passing: z.boolean(),
  disposition: S7Disposition,
  key_id: z.string().min(1).max(128),
  bucket: z.string().min(3).max(63),
  object_key: Sha256Hex,
  handoff_pack_sha256: Sha256Hex.nullable(),
  produced_at: IsoDateTime,
});
export type EvidencePackSummary = z.infer<typeof EvidencePackSummary>;

/** `GET /v1/items/:id/verify`: the S7 checks of one Unit head. */
export const ItemVerifyView = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  lane: Lane,
  /** The item's phase (S7 has not started while it is earlier). */
  phase: z.string().min(1),
  step: StepId.nullable(),
  /** The head shown (the newest head with a result unless `?head=` asked for another). */
  unit_key: z.string().min(1).max(128).nullable(),
  base_sha: GitSha.nullable(),
  head_sha: GitSha.nullable(),
  /** Every head S7 has results for, newest first. */
  heads: z.array(
    z.strictObject({
      head_sha: GitSha,
      unit_key: z.string().min(1).max(128),
      results: z.number().int().min(1),
      last_recorded_at: IsoDateTime,
    }),
  ),
  steps: z.array(VerifyStepView).length(5),
  /** The newest Evidence Pack signed for the head shown (`null`: none yet). */
  pack: EvidencePackSummary.nullable(),
  /** The data class the view was cut to (the bff sets it; core answers with D2). */
  data_class: DataClass,
});
export type ItemVerifyView = z.infer<typeof ItemVerifyView>;

/** The parts of a signed pack the viewer shows (ids, hashes, verdicts and counts: the pack holds nothing else). */
export const EvidencePackContents = z.strictObject({
  format: z.string().min(1),
  lane: Lane,
  tier: z.string().min(1),
  profile_sha256: Sha256Hex,
  catalogue_ref: CatalogueRef,
  units: z.array(z.string().min(1).max(128)),
  steps: z.array(EvidenceStep).length(5),
  gates: z.array(EvidenceGate),
  push_receipt: z
    .strictObject({
      receipt_id: z.string().min(1),
      patch_hash: Sha256Hex,
      head_sha: GitSha,
      pr_number: z.number().int().min(1),
    })
    .nullable(),
  oracle_locks: z.number().int().min(0),
  signature: z.strictObject({ alg: z.string().min(1), key_id: z.string().min(1) }),
  /** The bytes were read back and verified against the recorded object key and pack id. */
  verified: z.literal(true),
});
export type EvidencePackContents = z.infer<typeof EvidencePackContents>;

/** `GET /v1/items/:id/evidence`: the packs of an item and the contents of one. */
export const EvidencePackView = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  /** Every pack of the item, newest first. */
  packs: z.array(EvidencePackSummary),
  /** The pack asked for (`?pack=`), else the newest; `null` when the item has none. */
  pack: EvidencePackSummary.nullable(),
  contents: EvidencePackContents.nullable(),
  /** Why `contents` is `null` though a pack exists: the object store is not configured here, or did not answer. */
  contents_problem: z.string().max(200).nullable(),
  /** The offline check, as a person runs it on the downloaded bytes. */
  verify_command: z.string().min(1).nullable(),
});
export type EvidencePackView = z.infer<typeof EvidencePackView>;

// ---------------------------------------------------------------- gate-check on the item's PRs

export const GateCheckRunView = z.strictObject({
  seq: z.number().int().min(1),
  recorded_at: IsoDateTime,
  check_run_id: z.number().int().min(1).nullable(),
  verdict_sha256: Sha256Hex,
  repo: z.string().min(1),
  pr_number: z.number().int().min(1),
  head_sha: GitSha,
  outcome: GateCheckOutcome,
  reason: GateCheckReason,
  detail: z.string().max(300),
  pack_sha256: Sha256Hex.nullable(),
});
export type GateCheckRunView = z.infer<typeof GateCheckRunView>;

/**
 * bff `GET /api/items/:id/gate-check`: what gate-check recorded for the item's PRs, newest first. `unknown` when the
 * bff has no gate-check to ask or it did not answer: the portal then says unknown, never success.
 */
export const GateCheckRunsView = z.strictObject({
  item_id: WorkItemId,
  status: z.enum(['ok', 'unknown']),
  verdicts: z.array(GateCheckRunView),
});
export type GateCheckRunsView = z.infer<typeof GateCheckRunsView>;

// ---------------------------------------------------------------- what an exception or quarantine gate decides

/** One ledger decision on the gate (a two-person gate shows the first while it waits for the second). */
export const GateDecisionView = z.strictObject({
  ledger_seq: z.number().int().min(1),
  actor: z.string().min(1),
  decision: z.string().min(1),
  at: IsoDateTime,
  sod_waiver: z.boolean(),
});
export type GateDecisionView = z.infer<typeof GateDecisionView>;

// ---------------------------------------------------------------- what a merge, release, acceptance, X1 or G3o decides
//
// P1-3, P1-7, P1-8 (portal review §12): the subject facts of G4, G5, G6, X1 and G3o, built by core from the gate's own
// facts (what its subject hash binds: `g4_review`, `release`, `g6_acceptance`, `gate_needed`) and the record around
// it. Nothing here is decided; text an agent or a person wrote (an X1 command, an agent's note, the intent, the oracle
// specs) is withheld below the data class that reaches it (`cutGateContext`).

/** A pull request as a card links it. `url` is the code host's web page of the PR. */
export const PullRequestLink = z.strictObject({
  repo: RepoFullName,
  number: z.number().int().min(1),
  head_ref: z.string().min(1).max(255).nullable(),
  state: z.enum(['open', 'closed']).nullable(),
  url: z.string().min(1).max(500),
});
export type PullRequestLink = z.infer<typeof PullRequestLink>;

/** One changed path of a PR head, flagged against the sensitive and the protected globs. */
export const ChangedPathView = z.strictObject({
  path: z.string().min(1).max(1024),
  /** In the review's sensitive paths (a sensitive or protected glob): codeowner plus the D37 step-up. */
  sensitive: z.boolean(),
  /** Matches the protected globs (DEFAULT_PROTECTED_GLOBS). */
  protected: z.boolean(),
});
export type ChangedPathView = z.infer<typeof ChangedPathView>;

/** One S7 step of a head, as a card summarises it (the item's Verify tab has the findings). */
export const StepStatusView = z.strictObject({
  step: VerifyStep,
  check: VerifyCheckId,
  status: VerifyStepStatus,
});
export type StepStatusView = z.infer<typeof StepStatusView>;

/** One Unit of a G4: its PR, the pack G4 binds, the steps of the head, the diff by path. */
export const MergeReviewUnitView = z.strictObject({
  unit_key: UnitKey,
  head_sha: GitSha,
  base_sha: GitSha,
  pack_sha256: Sha256Hex,
  pr: PullRequestLink,
  /** The recorded pack G4 binds (`null`: not in the record, so not verified here: never a pass). */
  pack: EvidencePackSummary.nullable(),
  steps: z.array(StepStatusView).max(5),
  /** The paths the head changed (the push intent); `null` when the record does not have them (mode C, step-up). */
  paths: z.array(ChangedPathView).max(500).nullable(),
  paths_truncated: z.boolean(),
});
export type MergeReviewUnitView = z.infer<typeof MergeReviewUnitView>;

export const MergeReviewSubject = z.strictObject({
  kind: z.literal('merge_review'),
  /** The review the gate opened with and binds (mode C/E, why, step-up, deciders, CODEOWNERS). */
  review: G4Review,
  units: z.array(MergeReviewUnitView).min(1).max(50),
  /** Whether this G4 still stands for the PRs as they are now. */
  standing: G4StandingState,
  /** B13 "G4 changes requested" under the item's pinned catalogue: rounds used, its limit, what is left. */
  b13: z.strictObject({
    used: z.number().int().min(0),
    limit: z.number().int().min(0).nullable(),
    left: z.number().int().min(0).nullable(),
    /** Where the item goes when no round is left (the catalogue's exit: D3). */
    exhausted_to: z.string().min(1).max(32).nullable(),
  }),
});
export type MergeReviewSubject = z.infer<typeof MergeReviewSubject>;

export const ReleaseSubject = z.strictObject({
  kind: z.literal('release'),
  /** What G5 binds (merged commit to pack head to target); `null`: the facts carry none (nothing is released). */
  binding: ReleaseBinding.nullable(),
  /** The project's release setting now (`unreadable`: unknown, and unknown is not released). */
  target_now: z.strictObject({
    state: z.enum(['ok', 'unreadable']),
    setting: ReleaseSetting.nullable(),
  }),
  /** The setting now names another environment, or no target: gate-relay would refuse (`target_changed`). */
  target_changed: z.boolean(),
  pr: PullRequestLink.nullable(),
  /** The release evidence: the pack the binding names, as recorded. */
  pack: EvidencePackSummary.nullable(),
  steps: z.array(StepStatusView).max(5),
  /** gate-relay's deployment state for THIS G5 instance (its `gaterelay:` stream). */
  deployment: z.strictObject({
    state: ReleaseStatusState,
    refusal: ReleaseRefusal.nullable(),
    marker: z
      .strictObject({
        marker_id: z.uuid(),
        environment: ReleaseEnvironment,
        merged_sha: GitSha,
        deployment_id: z.number().int().min(1),
        created_at: IsoDateTime,
      })
      .nullable(),
    rollback_marker_id: z.uuid().nullable(),
  }),
});
export type ReleaseSubject = z.infer<typeof ReleaseSubject>;

export const AcceptanceSubject = z.strictObject({
  kind: z.literal('acceptance'),
  /** What G6 binds: the requester, the merged commit, the release output. */
  acceptance: G6Acceptance.nullable(),
  /** The intent block G0/G1 approved (1.5): what the requester asked for. */
  intent: z
    .strictObject({
      sha256: Sha256Hex,
      /** The gate whose approval bound it (`gate:<id>`), `null` when no approved G0/G1 binds it. */
      bound_by: z.string().min(1).nullable(),
      intact: z.boolean(),
      /** `null` (and the lists empty) when withheld: the text needs data class D1. */
      goal: z.string().max(1000).nullable(),
      acceptance_criteria: z.array(z.string().max(500)).max(30),
      non_goals: z.array(z.string().max(500)).max(20),
      withheld: z.boolean(),
    })
    .nullable(),
  /** What merged: each PR with the pack of its head and the steps of that head. */
  merged: z.array(
    z.strictObject({
      unit_key: UnitKey,
      pr: PullRequestLink,
      head_sha: GitSha,
      pack: EvidencePackSummary.nullable(),
      steps: z.array(StepStatusView).max(5),
    }),
  ),
  /** S8b's release, when the project releases (`null`: nothing released). */
  release: z
    .strictObject({
      environment: ReleaseEnvironment.nullable(),
      state: ReleaseStatusState,
    })
    .nullable(),
});
export type AcceptanceSubject = z.infer<typeof AcceptanceSubject>;

export const IrreversibleSubject = z.strictObject({
  kind: z.literal('irreversible_operation'),
  reason_code: z.string().min(1).max(64).nullable(),
  /** The operation the gate binds (`null`: the stage reported none: the card says unknown). */
  operation: IrreversibleOperationDetail.nullable(),
  /** The command and the agent's note need D2 (tripwire evidence); below it they are `null` and this is true. */
  command_withheld: z.boolean(),
});
export type IrreversibleSubject = z.infer<typeof IrreversibleSubject>;

/** How one oracle reads against the specs G2 approved: as approved, the deviation 6.3 found, or unknown (not reported). */
export const OracleDiffStatus = z.enum(['as_approved', 'unknown', ...OracleDeviationKind.options]);
export type OracleDiffStatus = z.infer<typeof OracleDiffStatus>;

export const OracleDeviationSubject = z.strictObject({
  kind: z.literal('oracle_deviation'),
  reason_code: z.string().min(1).max(64).nullable(),
  /** G3o chained after an approved E6 (6.4, 7.2): the locked tests will change; `null` at 6.3. */
  chained_from: z.literal('E6').nullable(),
  /** The oracle specs the newest approved G2 bound (3.4). */
  approved: z.strictObject({
    gate_instance_id: z.string().min(1).nullable(),
    sha256: Sha256Hex.nullable(),
    intact: z.boolean(),
    oracles: z
      .array(
        z.strictObject({
          oracle_id: z.string().min(1).max(64),
          requirement_id: z.string().min(1).max(128).nullable(),
          /** What an oracle marker must carry (`specHashOf`). */
          spec_sha256: Sha256Hex,
          /** `null` when withheld (D1). */
          description: z.string().max(2000).nullable(),
          expected_failure: z.string().max(2000).nullable(),
        }),
      )
      .max(100),
  }),
  /** Every approved oracle with its status, then every oracle file no spec approved. */
  diff: z
    .array(
      z.strictObject({
        oracle_id: z.string().min(1).max(64).nullable(),
        path: z.string().min(1).max(1024).nullable(),
        status: OracleDiffStatus,
      }),
    )
    .max(200),
  /** The deviations are in the record (6.3 reported them); `false`: unknown, never "as approved". */
  deviations_known: z.boolean(),
  text_withheld: z.boolean(),
});
export type OracleDeviationSubject = z.infer<typeof OracleDeviationSubject>;

export const GateSubjectView = z.discriminatedUnion('kind', [
  MergeReviewSubject,
  ReleaseSubject,
  AcceptanceSubject,
  IrreversibleSubject,
  OracleDeviationSubject,
]);
export type GateSubjectView = z.infer<typeof GateSubjectView>;

/**
 * X2 on an S0 record (M16 R2b, M17): what the onboarding pack's X2 binds, read from the record. The files the gate
 * opened with (each by path, sha256 and the protected-path rule it falls under) against the recorded render
 * (`pack.rendered`: `intact`), the patch hash against the gate's subject hash (`bound`), the deciding card (card 2 for
 * Light, card 3 for Full) by its payload hash, who CODEOWNERS names and why (`pack.codeowners_resolved`), and for
 * Full the oracle lock and the seeds card 3 made `intended`. Hashes and paths only: no file content.
 */
export const S0PackGateContext = z.strictObject({
  kind: PackKind,
  s0_id: S0RecordId,
  repo: RepoFullName,
  base_sha: GitSha,
  branch: z.string().min(1).max(300),
  patch_hash: Sha256Hex,
  /** The gate's subject hash is exactly this patch hash. */
  bound: z.boolean(),
  /** The files the gate opened with are the recorded render's, byte for byte (by sha256). `false`: do not decide. */
  intact: z.boolean(),
  deciding_card: z.strictObject({
    card: z.enum(['C1', 'C2', 'C3']),
    card_id: z.string().uuid(),
    payload_hash: Sha256Hex,
  }),
  files: z.array(PackFile).max(50),
  /** Light: who the pack's CODEOWNERS names, resolved once and recorded; `null` when not recorded (Full). */
  codeowners: z
    .strictObject({
      outcome: PackCodeownersOutcome,
      rendered: z.boolean(),
      owners: z.array(
        z.strictObject({
          principal_id: z.string().min(1).max(200),
          login: z.string().min(1).max(39).nullable(),
          reason: z.enum(['mapped', 'no_linked_login']),
        }),
      ),
    })
    .nullable(),
  /** Full: the oracle lock card 3 affirmed (`null` for Light, or when the baseline is not on the record). */
  oracle_lock: z
    .strictObject({
      path: z.string().min(1).max(300),
      lock_hash: Sha256Hex,
      tests: z.number().int().min(0),
      truncated: z.boolean(),
      /** sha256 of the rendered lock file in the pack, `null` when the pack holds none. */
      file_sha256: Sha256Hex.nullable(),
    })
    .nullable(),
  /** Full: the seeds card 3 made `intended`, by the hash of the text affirmed. */
  seeds: z
    .array(
      z.strictObject({
        seed_id: z.string().min(1).max(64),
        area: z.string().min(1).max(300),
        path: z.string().min(1).max(300),
        text_sha256: Sha256Hex,
      }),
    )
    .max(100),
});
export type S0PackGateContext = z.infer<typeof S0PackGateContext>;

/**
 * `GET /v1/cards/:id/gate/context`: the gate-specific facts of a work-item card raised by S7 (Q1 through its SECT
 * triage, E6, X2, E2 at 7.5), by S6 (X3, X2 at 6.6, E6, X1, G3o) or at 4.5 (E2), and of G4, G5 and G6, and what its
 * subject hash binds. M16: also the X2 of an S0 record's onboarding pack (`subject_kind: s0_record`, `item_id` null,
 * `onboarding_pack` set).
 */
export const GateCardContext = z.strictObject({
  card_id: z.string().min(1),
  project_id: ProjectId,
  subject_kind: z.enum(['item', 's0_record']),
  /** `null` for an S0 record's card. */
  item_id: WorkItemId.nullable(),
  /** The S0 record of an onboarding card; `null` for a work item's. */
  s0_id: S0RecordId.nullable(),
  gate: GateId,
  gate_instance_id: z.string().min(1),
  /** The station key (`7.4!X2`, `sect:1`) and the step that raised it (`null` for SECT). */
  station: z.string().min(1),
  step: StepId.nullable(),
  requester: PrincipalId.nullable(),
  /** Approvals needed (2 on a two-person gate with the project's two-person rule on). */
  quorum_required: z.number().int().min(1),
  decisions: z.array(GateDecisionView),
  subject_hash: Sha256Hex,
  /** What the subject hash binds, as the gate opened with it. */
  binds: z.array(z.strictObject({ label: z.string().min(1), value: z.string().min(1) })),
  step_up: z.strictObject({ required: z.boolean(), bound_hash: Sha256Hex }),
  /** The S7 check of the step that raised the gate, for the item's current head (`null`: not an S7 step or no result). */
  check: VerifyStepView.nullable(),
  head_sha: GitSha.nullable(),
  /** Q1: the quarantine the SECT triage is about. */
  quarantine: z
    .strictObject({
      n: z.number().int().min(1),
      cause: z.string().min(1),
      origin_phase: z.string().min(1),
      origin_step: z.string().min(1),
      pack_sha256: Sha256Hex.nullable(),
    })
    .nullable(),
  /** X2: the patch the decision is bound to (6.6's patch artefact) or the Push Broker's receipt for the head. */
  patch: z
    .strictObject({
      patch_hash: Sha256Hex,
      source: z.enum(['bound_artefact', 'push_receipt']),
      bound: z.boolean(),
    })
    .nullable(),
  /** X3 and 7.4: the new packages the check found; licence and advisories `null` (unknown) when not known. */
  dependencies: z.array(
    z.strictObject({
      name: z.string().min(1).max(214),
      manifest: z.string().min(1).max(1024).nullable(),
      licence: z.string().max(100).nullable(),
      advisories: z.string().max(200).nullable(),
    }),
  ),
  /** E2 at 4.5: the constitution report the gate binds (markdown withheld below D1). */
  constitution: z
    .strictObject({
      sha256: Sha256Hex,
      intact: z.boolean(),
      markdown: z.string().nullable(),
    })
    .nullable(),
  /** X2 on an S0 record: the onboarding pack it binds. */
  onboarding_pack: S0PackGateContext.nullable(),
  /**
   * E4 (and E3/E5 of a handoff): the handoff the owner of record decides, as the gate opened with it (the subject
   * hash binds it, the pack included), and the choices the flow allows once E4 is approved.
   */
  handoff: z
    .strictObject({
      handoff_id: HandoffUuid,
      n: z.number().int().min(1),
      code: HandoffCode,
      trigger: z.string().min(1),
      origin_phase: z.string().min(1),
      origin_step: StepId.nullable(),
      pack: HandoffPackRef,
      /** The choices open when the gate opened (the item's page has the ones open now). */
      valid_choices: z.array(HandoffChoice),
      status: z.enum(['open', 'chosen']),
      choice: HandoffChoice.nullable(),
    })
    .nullable(),
  /** G4, G5, G6, X1, G3o: what the gate decides (P1-3, P1-7, P1-8); `null` for the other gates. */
  subject: GateSubjectView.nullable(),
  data_class: DataClass,
});
export type GateCardContext = z.infer<typeof GateCardContext>;

// ---------------------------------------------------------------- data classes

/** The data class a finding's message needs: tripwire evidence and secret findings are D2, the rest D1. */
export function findingNeedsClass(kind: FindingKind): DataClass {
  return kind === 'secret_new' ||
    kind === 'locked_test_edit' ||
    kind === 'stub_test' ||
    kind === 'stub_probe_passed'
    ? 'D2'
    : 'D1';
}

const RANK: Readonly<Record<DataClass, number>> = { D0: 0, D1: 1, D2: 2, D3: 3 };
/** Whether `have` reaches `need`. */
export const reachesClass = (have: DataClass, need: DataClass): boolean => RANK[have] >= RANK[need];

/** A finding cut to a data class: the message withheld where the class does not reach it. */
export function cutFinding(f: VerifyFindingView, dc: DataClass): VerifyFindingView {
  if (f.message === null || reachesClass(dc, findingNeedsClass(f.kind))) return f;
  return { ...f, message: null, withheld: true };
}

/** A step cut to a data class. */
export const cutStep = (s: VerifyStepView, dc: DataClass): VerifyStepView => ({
  ...s,
  findings: { ...s.findings, items: s.findings.items.map((f) => cutFinding(f, dc)) },
});

/** The verify view cut to a data class. */
export const cutVerifyView = (v: ItemVerifyView, dc: DataClass): ItemVerifyView => ({
  ...v,
  steps: v.steps.map((s) => cutStep(s, dc)),
  data_class: dc,
});

/**
 * A gate's subject cut to a data class: an X1's command and the agent's note need D2 (tripwire evidence, the agent's
 * own text); the intent and the oracle specs need D1 (the content of the work). Ids, hashes, paths and verdicts stay.
 */
export function cutGateSubject(s: GateSubjectView, dc: DataClass): GateSubjectView {
  switch (s.kind) {
    case 'irreversible_operation': {
      if (s.operation === null || reachesClass(dc, 'D2')) return s;
      const withheld = s.operation.command !== null || s.operation.agent_note !== null;
      return {
        ...s,
        operation: { ...s.operation, command: null, agent_note: null },
        command_withheld: s.command_withheld || withheld,
      };
    }
    case 'oracle_deviation':
      return reachesClass(dc, 'D1')
        ? s
        : {
            ...s,
            approved: {
              ...s.approved,
              oracles: s.approved.oracles.map((o) => ({
                ...o,
                description: null,
                expected_failure: null,
              })),
            },
            text_withheld: true,
          };
    case 'acceptance':
      return s.intent === null || reachesClass(dc, 'D1')
        ? s
        : {
            ...s,
            intent: {
              ...s.intent,
              goal: null,
              acceptance_criteria: [],
              non_goals: [],
              withheld: true,
            },
          };
    default:
      return s;
  }
}

/** The gate context cut to a data class (the constitution's text needs D1; the subject as `cutGateSubject`). */
export const cutGateContext = (c: GateCardContext, dc: DataClass): GateCardContext => ({
  ...c,
  check: c.check === null ? null : cutStep(c.check, dc),
  constitution:
    c.constitution === null
      ? null
      : { ...c.constitution, markdown: reachesClass(dc, 'D1') ? c.constitution.markdown : null },
  subject: c.subject === null ? null : cutGateSubject(c.subject, dc),
  data_class: dc,
});
