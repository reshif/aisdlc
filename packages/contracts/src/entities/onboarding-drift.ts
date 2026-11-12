import { z } from 'zod';
import { Level } from '../values.js';
import { ReadinessStatus } from '../states/readiness.js';
import { RepoFullName } from './codehost.js';
import { LintSeverity } from './detectors.js';
import { ReonboardProposalView } from './knowledge-defects.js';
import {
  GitSha,
  IsoDateTime,
  LedgerEntryId,
  PrincipalId,
  ProjectId,
  S0RecordId,
  Sha256Hex,
} from './ids.js';
import { hashCanonical } from '@aisdlc/kernel';

// After onboarding (PLAN M16; onboarding-roadmap §4.2 "Drift and re-affirmation", §8 "After onboarding", R4; DEC-21,
// DEC-10 refined, DEC-11 refined, DEC-12(a) record-first).
//
// The factory learns what changed on the code host by polling, and every poll is RECORDED FIRST as an inbound fact
// (`inbound:<kind>:<repo>`): the default branch's head, the effective rules, and (new here) `affirmed_files`, the
// bytes' hashes of every file the record affirmed or projected at that head (AGENTS.md / CLAUDE.md sections, the pack's
// `.factory/**` files, CODEOWNERS). Everything below is a fold of those facts against the governing readiness record,
// its pack and the people's later decisions; nothing reads the code host to decide.
//
//   instruction text or a pack file differs   -> `reaffirm`: the factory keeps serving the last affirmed text, the new
//                                                text is data, and a re-affirm card opens (one step-up click, ledgered)
//   protect-main loosened, a required check    -> `suspend`: the record goes `suspended` (recorded AND ledgered), agent
//   removed or unpinned from its App, the        lanes close, new items go L8 through the 1.4 rule, the Push Broker
//   CODEOWNERS file gone, broken or changed      refuses an agent push
//
// A suspension is lifted only by a person (DEC-21(b)): the re-check passes (a fresh poll, recorded, folds clean), then a
// one-click confirm WITH the bypass re-attestation (the per-repo bypass list of DEC-10 refined, which the factory can
// never read on GitHub, is attested to be exactly the config list and to hold no App). The restore is a ledger entry;
// the controls it saw become the baseline later polls compare with. The kill switch is offered, never automatic.

export const driftStream = (repo: string): string => `drift:${repo.toLowerCase()}`;

export const DRIFT_EVENT = {
  /** The findings for a repo changed (a fold of the newest facts against the governing record). */
  evaluated: 'drift.evaluated',
  /** A `suspend` finding took the governing record to `suspended` (the PRR event is in the same transaction). */
  suspended: 'drift.suspended',
  /** A person lifted the suspension: the re-check, the confirm and the bypass re-attestation. */
  restored: 'drift.restored',
  /** A person re-affirmed an instruction or pack file's new text at a head (step-up bound to its hash). */
  reaffirmed: 'drift.reaffirmed',
  /** A person asked for a new onboarding version: a level-up, or the re-sign of an expired record. */
  version_requested: 'drift.version_requested',
} as const;
export type DriftEventType = (typeof DRIFT_EVENT)[keyof typeof DRIFT_EVENT];

/** The `entry_type` of the ledger entries the lifecycle writes. */
export const DRIFT_LEDGER_ENTRY = {
  suspended: 'prr.suspended',
  restored: 'prr.restored',
  reaffirmed: 'instructions.reaffirmed',
} as const;

/** The cause codes the lifecycle writes on `prr.status_changed`. */
export const DRIFT_CAUSE = {
  suspended: 'drift.controls',
  restored: 'drift.restored',
  expired: 'fresh_until.passed',
} as const;

// ---------------------------------------------------------------- the `affirmed_files` inbound fact

/** One tracked path at the head: `null` hashes when the file is absent there. */
export const AffirmedFileObservation = z.strictObject({
  path: z.string().min(1).max(300),
  /** git's blob id of the file at the head. */
  blob_sha: GitSha.nullable(),
  /** sha256 of the file's bytes (what affirmed text is pinned by). */
  sha256: Sha256Hex.nullable(),
});
export type AffirmedFileObservation = z.infer<typeof AffirmedFileObservation>;

export const CodeownersObservation = z.strictObject({
  path: z.string().min(1),
  blob_sha: GitSha,
  /** What GitHub reports wrong with it; `unknown` when that could not be read. */
  errors: z.union([z.number().int().min(0), z.literal('unknown')]),
});
export type CodeownersObservation = z.infer<typeof CodeownersObservation>;

/** The value of an `affirmed_files` fact: what the tracked files are at one head. */
export const AffirmedFilesValue = z.strictObject({
  sha: GitSha,
  files: z.array(AffirmedFileObservation).max(60),
  /** `null`: no CODEOWNERS file at the head. */
  codeowners: CodeownersObservation.nullable(),
});
export type AffirmedFilesValue = z.infer<typeof AffirmedFilesValue>;

// ---------------------------------------------------------------- findings

export const DriftFindingKind = z.enum([
  /** An affirmed AGENTS.md / CLAUDE.md section's file differs from the affirmed text. */
  'instruction_text',
  /** A file the pack projected into git (`.factory/**`) differs from what was rendered. */
  'pack_file',
  /** The CODEOWNERS file the record observed is gone, broken or changed. */
  'codeowners',
  /** protect-main is weaker than the record's level requires (OB §3.3 LF2). */
  'protect_main',
  /** A required check the record observed is gone, or no longer pinned to the App it was. */
  'required_check',
]);
export type DriftFindingKind = z.infer<typeof DriftFindingKind>;

/** What a finding does: `reaffirm` serves the last affirmed text and opens the card; `suspend` suspends the record. */
export const DriftEffect = z.enum(['reaffirm', 'suspend']);
export type DriftEffect = z.infer<typeof DriftEffect>;

export const DriftFinding = z.strictObject({
  kind: DriftFindingKind,
  effect: DriftEffect,
  /** The file's path, the check's name, or `null` for protect-main as a whole. */
  subject: z.string().max(300).nullable(),
  /** Short machine reasons (`gate_check_not_pinned`, `file_changed`, `file_deleted`, ...). */
  reasons: z.array(z.string().min(1).max(64)).max(20),
  /** What the record holds (affirmed / rendered sha256, or the check's App id) and what the head shows. */
  expected: z.string().max(80).nullable(),
  observed: z.string().max(80).nullable(),
});
export type DriftFinding = z.infer<typeof DriftFinding>;

/** The hash a set of findings is compared and bound by: sorted, canonical. */
export const driftFindingsHash = (findings: readonly DriftFinding[]): string =>
  hashCanonical(
    [...findings].sort((a, b) =>
      `${a.kind}|${a.subject ?? ''}` < `${b.kind}|${b.subject ?? ''}` ? -1 : 1,
    ),
  );

const RepoFacts = {
  repo: RepoFullName,
  project_id: ProjectId,
  s0_id: S0RecordId,
  prr_version: z.number().int().min(1),
  record_hash: Sha256Hex,
};

export const DriftEvaluatedPayload = z.strictObject({
  ...RepoFacts,
  /** The head the `affirmed_files` fact was read at; `null` when no such fact exists yet. */
  head_sha: GitSha.nullable(),
  /** `value_hash` of the effective-rules fact folded; `null` when none exists yet. */
  rules_hash: Sha256Hex.nullable(),
  findings: z.array(DriftFinding).max(80),
  findings_hash: Sha256Hex,
});
export type DriftEvaluatedPayload = z.infer<typeof DriftEvaluatedPayload>;

export const DriftSuspendedPayload = z.strictObject({
  ...RepoFacts,
  from: ReadinessStatus,
  /** The `suspend` findings that took it there. */
  findings: z.array(DriftFinding).min(1).max(80),
  findings_hash: Sha256Hex,
  ledger_entry_id: LedgerEntryId,
});
export type DriftSuspendedPayload = z.infer<typeof DriftSuspendedPayload>;

/** The controls a restore saw and accepted: later polls compare with these instead of the record's 0.4 reads. */
export const DriftBaseline = z.strictObject({
  required_checks: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        integration_id: z.number().int().min(0).nullable(),
      }),
    )
    .max(100)
    .nullable(),
  codeowners: CodeownersObservation.nullable(),
});
export type DriftBaseline = z.infer<typeof DriftBaseline>;

/** What the person attests at a restore (OB §8 "Bypass list: re-attest ... on restore"; DEC-21(b), DEC-10 refined). */
export const BypassAttestation = z.strictObject({
  /** The bypass actors on the default branch's rules on GitHub are exactly the people of the config list shown. */
  bypass_matches_list: z.literal(true),
  /** No App (the factory's or any other) is a bypass actor. */
  bypass_has_no_app: z.literal(true),
});
export type BypassAttestation = z.infer<typeof BypassAttestation>;

/** The per-repo bypass list as the person was shown it: the logins from config `codehost.merge_bypass`. */
export const BypassListShown = z.strictObject({
  logins: z.array(z.string().min(1).max(64)).max(50),
  /** `hashCanonical` of the sorted logins: a restore with a stale list is refused. */
  list_hash: Sha256Hex,
});
export type BypassListShown = z.infer<typeof BypassListShown>;

export const bypassListHash = (logins: readonly string[]): string =>
  hashCanonical([...logins].map((l) => l.toLowerCase()).sort());

export const DriftRestoredPayload = z.strictObject({
  ...RepoFacts,
  by: PrincipalId,
  at: IsoDateTime,
  /** The re-check's findings hash (clean of `suspend` findings) and the head and rules it folded. */
  recheck: z.strictObject({
    findings_hash: Sha256Hex,
    head_sha: GitSha.nullable(),
    rules_hash: Sha256Hex.nullable(),
  }),
  baseline: DriftBaseline,
  bypass: BypassListShown,
  attestation: BypassAttestation,
  ledger_entry_id: LedgerEntryId,
});
export type DriftRestoredPayload = z.infer<typeof DriftRestoredPayload>;

/** The largest instruction text a re-affirmation stores (the same bound as card 2's proposals). */
export const REAFFIRM_TEXT_MAX = 65_536;

export const DriftReaffirmedPayload = z.strictObject({
  ...RepoFacts,
  path: z.string().min(1).max(300),
  /** The text now affirmed, in the record (secret-scanned before it is stored): the copy agents receive. */
  text: z.string().max(REAFFIRM_TEXT_MAX),
  /** Its hash, and the one it replaces. */
  text_sha256: Sha256Hex,
  previous_sha256: Sha256Hex.nullable(),
  head_sha: GitSha,
  blob_sha: GitSha,
  lint_report_hash: Sha256Hex,
  /** The step-up proof's reference (its hash), bound to `text_sha256`. */
  step_up_ref: z.string().min(1).max(100),
  by: PrincipalId,
  at: IsoDateTime,
  ledger_entry_id: LedgerEntryId,
});
export type DriftReaffirmedPayload = z.infer<typeof DriftReaffirmedPayload>;

/** Why a new onboarding version was asked for (OB §8 "Level changes", "`fresh_until` passed -> Re-sign card"). */
export const OnboardingVersionReason = z.enum(['level_up', 're_sign']);
export type OnboardingVersionReason = z.infer<typeof OnboardingVersionReason>;

export const DriftVersionRequestedPayload = z.strictObject({
  ...RepoFacts,
  reason: OnboardingVersionReason,
  from_level: Level,
  level: Level,
  /** The S0 record the request made (0.1 re-runs mechanically at the current head). */
  new_s0_id: S0RecordId,
  /**
   * What the new record opens beyond Light's steps. A level-up to Full (the ONLY path to Full, user decision
   * 2026-11-12) opens the Full baseline (step 0.3) and card 3, decided by the intent slot the Light record's card 4
   * published; their content is M17.1's. Empty for any other request.
   */
  opens: z.array(z.enum(['0.3', 'C3'])).max(2),
  by: PrincipalId,
});
export type DriftVersionRequestedPayload = z.infer<typeof DriftVersionRequestedPayload>;

// ---------------------------------------------------------------- requests

export const RestoreRequest = z.strictObject({
  repo: RepoFullName,
  bypass: BypassListShown,
  attestation: BypassAttestation,
  on_behalf_of: PrincipalId,
});
export type RestoreRequest = z.infer<typeof RestoreRequest>;

export const ReaffirmRequest = z.strictObject({
  repo: RepoFullName,
  path: z.string().min(1).max(300),
  /** The text the person was shown (the repo's file at the head), by hash: the step-up is bound to it. */
  text_sha256: Sha256Hex,
  step_up: z.strictObject({ proof: z.string().min(1).max(4096) }),
  on_behalf_of: PrincipalId,
});
export type ReaffirmRequest = z.infer<typeof ReaffirmRequest>;

export const OnboardingVersionRequest = z.strictObject({
  repo: RepoFullName,
  reason: OnboardingVersionReason,
  level: Level,
  on_behalf_of: PrincipalId,
});
export type OnboardingVersionRequest = z.infer<typeof OnboardingVersionRequest>;

export const RestoreResult = z.strictObject({
  prr_version: z.number().int().min(1),
  status: ReadinessStatus,
  ledger_entry_id: LedgerEntryId,
});
export type RestoreResult = z.infer<typeof RestoreResult>;

export const ReaffirmResult = z.strictObject({
  path: z.string().min(1),
  text_sha256: Sha256Hex,
  ledger_entry_id: LedgerEntryId,
});
export type ReaffirmResult = z.infer<typeof ReaffirmResult>;

export const OnboardingVersionResult = z.strictObject({
  s0_id: S0RecordId,
  level: Level,
  reason: OnboardingVersionReason,
  duplicate: z.boolean(),
});
export type OnboardingVersionResult = z.infer<typeof OnboardingVersionResult>;

// ---------------------------------------------------------------- the portal's view

export const DriftHistoryRow = z.strictObject({
  at: IsoDateTime,
  type: z.enum([
    'evaluated',
    'suspended',
    'restored',
    'reaffirmed',
    'version_requested',
    'expired',
    'activated',
  ]),
  summary: z.string().max(300),
  by: z.string().max(100).nullable(),
  ledger_entry_id: LedgerEntryId.nullable(),
});
export type DriftHistoryRow = z.infer<typeof DriftHistoryRow>;

/** The state of one tracked instruction or pack file (OB §4.1: absent, data, affirmed@sha, drift). */
export const ServedFileState = z.enum(['affirmed', 'pending_projection', 'drift', 'absent']);
export type ServedFileState = z.infer<typeof ServedFileState>;

export const ServedFile = z.strictObject({
  path: z.string().min(1),
  state: ServedFileState,
  /** The text the factory serves as guidance (the last affirmed), by hash. */
  served_sha256: Sha256Hex,
  observed_sha256: Sha256Hex.nullable(),
});
export type ServedFile = z.infer<typeof ServedFile>;

export const RepoDriftView = z.strictObject({
  repo: RepoFullName,
  prr: z
    .strictObject({
      version: z.number().int().min(1),
      status: ReadinessStatus,
      level: Level,
      fresh_until: IsoDateTime,
      /** `fresh_until` has passed (an active record is read as expired before the sweep writes it). */
      expired: z.boolean(),
    })
    .nullable(),
  head_sha: GitSha.nullable(),
  files_polled_at: IsoDateTime.nullable(),
  rules_polled_at: IsoDateTime.nullable(),
  findings: z.array(DriftFinding),
  files: z.array(ServedFile),
  suspension: z.strictObject({ at: IsoDateTime, findings: z.array(DriftFinding) }).nullable(),
  restore: z.strictObject({
    /** The record is suspended and the newest facts fold clean of `suspend` findings (the re-check runs again on restore). */
    ready: z.boolean(),
    why_not: z.string().max(300).nullable(),
    bypass: BypassListShown,
  }),
  /** Levels a level-up may ask for from the signed one (Full is M17's 0.3: the request runs as the spec says). */
  level_up: z.array(Level),
  /** M17: the re-onboarding proposals knowledge defects raised (open first is the card; decided ones with the decision). */
  reonboarding: z.array(ReonboardProposalView),
  history: z.array(DriftHistoryRow),
});
export type RepoDriftView = z.infer<typeof RepoDriftView>;

export const ProjectDriftView = z.strictObject({
  project_id: ProjectId,
  repos: z.array(RepoDriftView),
});
export type ProjectDriftView = z.infer<typeof ProjectDriftView>;

/** The re-affirm card's content: the affirmed text and the repo's new text, for the diff. */
export const ReaffirmView = z.strictObject({
  repo: RepoFullName,
  path: z.string().min(1),
  head_sha: GitSha,
  affirmed_sha256: Sha256Hex,
  /** `null`: the record holds the hash only (the text was never rendered, or is not readable now). */
  affirmed_text: z.string().nullable(),
  repo_sha256: Sha256Hex.nullable(),
  /** `null`: the file is gone at the head (nothing to re-affirm: the affirmed text keeps being served). */
  repo_text: z.string().nullable(),
  /** The content lint over the repo text (a blocking finding refuses the re-affirmation: fix the file). */
  lint: z.array(
    z.strictObject({
      rule: z.string().min(1),
      severity: LintSeverity,
      line: z.number().int().min(1),
    }),
  ),
  /** A secret-ruleset hit blocks the re-affirmation, with no override (OB §4.1 item 4). */
  secret_hit: z.boolean(),
  /** What the step-up is bound to (`text_sha256` of the repo text), or `null` when it cannot be re-affirmed. */
  bound_hash: Sha256Hex.nullable(),
  why_not: z.string().max(300).nullable(),
});
export type ReaffirmView = z.infer<typeof ReaffirmView>;

/** The bff's view: core's, plus what the signed-in person may do (hints for the buttons; every write asks again). */
export const PortalProjectDriftView = ProjectDriftView.extend({
  may: z.strictObject({
    /** `project.settings.edit` (restore, re-affirm; core also requires the admin slot). */
    restore: z.boolean(),
    reaffirm: z.boolean(),
    /** `config.propose` ("Poll now"). */
    recheck: z.boolean(),
    /** `project.onboard` (a level-up or a re-sign is an onboarding request). */
    request_version: z.boolean(),
    /** `project.settings.edit` (accept or decline a re-onboarding proposal; core also requires the admin slot). */
    reonboard: z.boolean(),
  }),
});
export type PortalProjectDriftView = z.infer<typeof PortalProjectDriftView>;
