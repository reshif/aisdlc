import { z } from 'zod';
import { GateId } from '../flow.js';
import { DataClass, Lane, StepId } from '../values.js';
import { CatalogueRef } from './config.js';
import { EvidenceGate, EvidenceStep, S7Disposition } from './evidence.js';
import { GateCheckOutcome, GateCheckReason } from './gate-check.js';
import { RepoFullName } from './codehost.js';
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
    card: z.enum(['C2', 'C3']),
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
 * triage, E6, X2, E2 at 7.5), by S6 (X3, X2 at 6.6, E6) or at 4.5 (E2), and what its subject hash binds. M16: also
 * the X2 of an S0 record's onboarding pack (`subject_kind: s0_record`, `item_id` null, `onboarding_pack` set).
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

/** The gate context cut to a data class (the constitution's text needs D1). */
export const cutGateContext = (c: GateCardContext, dc: DataClass): GateCardContext => ({
  ...c,
  check: c.check === null ? null : cutStep(c.check, dc),
  constitution:
    c.constitution === null
      ? null
      : { ...c.constitution, markdown: reachesClass(dc, 'D1') ? c.constitution.markdown : null },
  data_class: dc,
});
