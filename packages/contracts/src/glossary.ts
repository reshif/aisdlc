import type {
  ArtefactType,
  AgentId,
  ActionId,
  BannerSeverity,
  BlockerId,
  CardKind,
  CardStatus,
  CheckVerdict,
  ClaimVerdict,
  ConfigLayerKind,
  ConfigRevisionState,
  ControlId,
  SettingApplies,
  SettingsSection,
  ControlKind,
  ControlState,
  DriftEffect,
  EvalCaseKind,
  ExamGrade,
  FloorItemStatus,
  FloorMoveKind,
  FloorRoom,
  GapDisposition,
  GapStatus,
  GateFeasibilityState,
  InboxEntryReason,
  IntegrationAdapter,
  IntegrationKind,
  IntegrationStatus,
  KillState,
  LightFloorId,
  NotificationKind,
  NotificationReason,
  PostureState,
  PrincipalKind,
  ReadinessPillar,
  RepairClass,
  ReviewMode,
  RoleSlot,
  SandboxClass,
  SeedStatus,
  ServedFileState,
  UnitSize,
  VerifyCheckId,
  ViewLevel,
} from './entities/index.js';
import type {
  BackEdgeId,
  GateFamily,
  GateId,
  HandoffId,
  HoldReason,
  ProjectToggleGroup,
  RelaneId,
  TriggerId,
  WaitState,
} from './flow.js';
import type {
  AgentSessionState,
  GateStatus,
  HealthState,
  LedgerDecision,
  OnboardingStatus,
  ReadinessStatus,
  UnitState,
  WorkItemPhase,
} from './states/index.js';
import type { Autonomy, DataClass, Lane, Level, StageId, StepId, Tier } from './values.js';

// The portal's words (docs/design/glossary.md, approved by the owner on 2026-11-13; §21 is this file's shape).
// Every family is a `Record<ContractEnum, Term>`, so a value added to a contract enum is a type error here
// until it has a plain label. Screens, the bff (locked-button reasons), the notifier and core read the words
// from here and nowhere else: a term cannot drift between screens. The codes stay in the record, the ledger
// and the API; `code` says when a screen may show one as a small grey chip after the label.
//
// Changing a label is a change the owner approves (glossary.md first, then this file); the snapshot test
// (`test/glossary.test.ts`) makes every change a visible diff. Free text from the record and agent output
// are data and never go through here.

/**
 * `secondary`: the code may follow the label as a small grey chip on the screens the glossary names.
 * `audit`: the code shows only on Decision log & audit, the evidence pack viewer and exports.
 * `false` (or omitted): the code never shows.
 */
export type TermCode = 'secondary' | 'audit' | false;

export interface Term {
  /** What the screen shows. Sentence case, at most four words (approved exceptions: `LONG_LABELS`). */
  readonly label: string;
  /** The tooltip: one sentence, ending with a full stop. */
  readonly explain: string;
  readonly code?: TermCode;
}

const t = (label: string, explain: string, code: TermCode = false): Term =>
  code === false ? { label, explain } : { label, explain, code };

// ---------------------------------------------------------------- 2 Stages, 3 Steps

const stage: Readonly<Record<StageId, Term>> = {
  S0: t('Onboarding', 'Getting a repo ready so agents can work on it safely.', 'audit'),
  S1: t(
    'Intake',
    'The factory reads the request, checks for duplicates, picks a track and asks questions.',
    'audit',
  ),
  S2: t('Research', 'An agent studies the code and docs and lays out the options.', 'audit'),
  S3: t(
    'Spec',
    'An agent writes what will change and the acceptance tests that prove it.',
    'audit',
  ),
  S4: t('Design', 'An agent writes the design, contracts, data changes and risks.', 'audit'),
  S5: t('Plan', 'The work is split into parts, ordered and given a budget.', 'audit'),
  S6: t(
    'Build',
    'A coding agent writes the code in a locked-down sandbox and opens a draft PR.',
    'audit',
  ),
  S7: t(
    'Verify',
    'The factory checks the PR (tests, spec, secrets, rules) and signs the evidence.',
    'audit',
  ),
  S8: t('Review and merge', 'A code owner reviews the PR; a person merges it on GitHub.', 'audit'),
  S8a: t(
    'Merge',
    'The approved PR is merged on GitHub by a person, and re-checked if the base moved.',
    'audit',
  ),
  S8b: t(
    'Release',
    'The merged change is deployed, if this project releases through the factory.',
    'audit',
  ),
  S9: t(
    'Close',
    'The requester accepts the result and the factory records what it learned.',
    'audit',
  ),
};

const step: Readonly<Record<StepId, Term>> = {
  '0.1': t(
    'Read-only scan',
    'The factory and the onboarding agent read the repo: owners, tests, security, settings.',
    'audit',
  ),
  '0.2': t(
    'Small-changes review',
    'The agent checks the repo facts and agent instructions needed for small changes.',
    'audit',
  ),
  '0.3': t(
    'Full-work review',
    'The agent maps the code, drafts specs and locks the acceptance tests needed for all work.',
    'audit',
  ),
  '0.4': t(
    'Controls and people',
    'GitHub protections are read and who decides what is set.',
    'audit',
  ),
  '0.5': t('Sign-off', 'A person signs off the onboarding.', 'audit'),
  '1.1': t('Read the request', 'The request is cleaned up and marked as untrusted input.', 'audit'),
  '1.2': t(
    'Check for duplicates',
    'The factory looks for the same or conflicting requests.',
    'audit',
  ),
  '1.3': t(
    'Pick a track',
    'An agent sizes the work; the factory picks the track from the rules.',
    'audit',
  ),
  '1.4': t('Check eligibility', 'The factory checks this repo is ready for this track.', 'audit'),
  '1.5': t('Ask questions', 'An agent asks what is unclear and writes the agreed goal.', 'audit'),
  '1.6': t('Mark ready', 'The requester says the request is ready to be accepted.', 'audit'),
  '2.1': t(
    'Study the code',
    'An agent reads the relevant code and docs at the current commit.',
    'audit',
  ),
  '2.1b': t('Dig deeper', 'An agent reverse-engineers an unclear area.', 'audit'),
  '2.2': t('Find impact', 'An agent lists what and who the change affects.', 'audit'),
  '2.3': t('Lay out options', 'An agent writes the options and a decision brief.', 'audit'),
  '2.4': t(
    'Elaborate the initiative',
    'Large initiatives only: an agent breaks the goal down.',
    'audit',
  ),
  '2.5': t(
    'Final goal sign-off',
    'Large initiatives only: a person accepts the goal for good.',
    'audit',
  ),
  '3.1': t(
    'Find affected requirements',
    'An agent finds which existing requirements change.',
    'audit',
  ),
  '3.2': t('Draft the spec change', 'An agent writes the change to the spec.', 'audit'),
  '3.3': t('Validate the spec', 'The factory checks the spec is complete and consistent.', 'audit'),
  '3.4': t(
    'Write acceptance criteria',
    'An agent writes the tests that will prove the change.',
    'audit',
  ),
  '3.5': t(
    'Independent spec review',
    'A second agent with fresh context reviews the spec.',
    'audit',
  ),
  '4.1': t('Decisions', 'An agent records the design decisions.', 'audit'),
  '4.2': t('Contracts', 'An agent writes interface contracts; the factory checks them.', 'audit'),
  '4.3': t('Data and migrations', 'An agent writes the data and migration plan.', 'audit'),
  '4.4': t(
    'Risks and operations',
    'An agent writes performance, security and operations notes.',
    'audit',
  ),
  '4.5': t('Factory rules check', 'The design is checked against the factory rules.', 'audit'),
  '4.6': t('Design review', 'A person reviews the design and threats.', 'audit'),
  '5.1': t(
    'Split into parts',
    'An agent splits the work into parts that can be built separately.',
    'audit',
  ),
  '5.2': t('Order the parts', 'An agent decides which part goes first.', 'audit'),
  '5.3': t('Task list per part', 'An agent writes the task list for each part.', 'audit'),
  '5.4': t('Link the tests', 'Each part is linked to the tests that prove it.', 'audit'),
  '5.5': t('Set the budget', 'The factory works out the budget for each part.', 'audit'),
  '5.6': t('Check capacity', 'The factory checks there is room to build.', 'audit'),
  '5.7': t('Schedule', 'A person or the factory schedules the build.', 'audit'),
  '5.8': t('Plan approval', 'A person approves the plan.', 'audit'),
  '6.0': t('Start building', 'The factory gives the part a coding slot and budget.', 'audit'),
  '6.1': t('Prepare the sandbox', 'A clean sandbox is made from the approved commit.', 'audit'),
  '6.2': t('Run tests first', 'The existing tests are run before any change.', 'audit'),
  '6.3': t(
    'Confirm new tests fail',
    'The new acceptance tests are run and must fail first.',
    'audit',
  ),
  '6.4': t('Write the code', 'The coding agent works through the task list.', 'audit'),
  '6.5': t(
    'Self-check',
    'The factory checks the change against the scope, budget and safety rules.',
    'audit',
  ),
  '6.6': t('Open draft PR', 'The factory bot opens or updates the draft PR.', 'audit'),
  '7.1': t('Build and tests', "Build, lint and the full test suite on the PR's commit.", 'audit'),
  '7.2': t('Test integrity', 'Tests were not weakened and the acceptance tests are real.', 'audit'),
  '7.3': t('Matches the spec', 'The change does what the approved spec says.', 'audit'),
  '7.4': t('Secrets and dependencies', 'No new secret and no unapproved dependency.', 'audit'),
  '7.5': t('Factory rules', 'The change follows the factory rules.', 'audit'),
  '7.6': t(
    'Sign the evidence',
    'The factory signs the evidence pack for this exact commit.',
    'audit',
  ),
  '8.1': t('Code review', 'A code owner reviews the PR.', 'audit'),
  '8.2': t(
    'Merge on GitHub',
    'A person merges the PR on GitHub; the factory never merges.',
    'audit',
  ),
  S8b: t('Release', 'The change is deployed after release approval.', 'audit'),
  '9.2': t('Requester accepts', 'The requester checks the result does what they asked.', 'audit'),
  '9.3': t('Close-out record', 'The factory writes the final record of the item.', 'audit'),
  '9.4': t('Learn', 'The factory proposes improvements from finished work.', 'audit'),
  '9.5': t('Spot-check audit', 'A person audits a sample of lightly reviewed merges.', 'audit'),
};

// ---------------------------------------------------------------- 4 Approvals (gates), 5 Decisions

const gate: Readonly<Record<GateId, Term>> = {
  G0: t(
    'Accept the request',
    'Decide whether the factory should take this request on.',
    'secondary',
  ),
  G1: t(
    'Confirm the goal',
    'Agree what the request is for, before the factory studies it.',
    'secondary',
  ),
  G1f: t(
    'Final goal sign-off',
    'Large initiatives only: accept the goal after it has been worked out.',
    'secondary',
  ),
  G2: t('Approve the spec', 'Approve what will change and the acceptance criteria.', 'secondary'),
  G3: t('Approve the plan', 'Approve the full plan for this exact commit.', 'secondary'),
  G3d: t('Approve the design', 'Approve the design and the risks it names.', 'secondary'),
  G3s: t(
    'Approve the outline',
    'Approve how the work is split into parts and ordered.',
    'secondary',
  ),
  G3o: t(
    'Approve test changes',
    'The acceptance tests differ from the approved criteria; approve the difference.',
    'secondary',
  ),
  G4: t('Code review', 'A code owner approves the PR. Always required.', 'secondary'),
  G5: t(
    'Approve the release',
    'Approve deploying the merged change. Needs "confirm it\'s you".',
    'secondary',
  ),
  G6: t('Accept the result', 'The requester says the change does what they asked.', 'secondary'),
  X1: t(
    'Allow irreversible action',
    'The agent wants to do something that cannot be undone.',
    'secondary',
  ),
  X2: t(
    'Allow protected-file change',
    'The change touches files only people may change.',
    'secondary',
  ),
  X3: t('Allow new dependency', 'The change adds a new package.', 'secondary'),
  X4: t(
    'Review a bypassed merge',
    "Someone merged without the factory's check; review it after the fact.",
    'secondary',
  ),
  E1: t('Allow a lighter track', 'Move the work to a track with fewer steps.', 'secondary'),
  E2: t(
    'Allow a rule exception',
    'The work breaks a factory rule; allow it once or not.',
    'secondary',
  ),
  E3: t('Allow more budget', 'The work needs more budget than planned.', 'secondary'),
  E4: t(
    'Choose what happens next',
    'The agents are stuck; choose to resume, re-plan, take over or stop.',
    'secondary',
  ),
  E5: t(
    'Override an escalation',
    "Decide an overdue approval on someone else's behalf.",
    'secondary',
  ),
  E6: t(
    'Change a locked test',
    'A locked acceptance test must change; approve the change.',
    'secondary',
  ),
  M1: t(
    'Approve a settings change',
    "Approve a change to the factory's or a project's settings.",
    'secondary',
  ),
  M2: t('Approve a rule variance', 'Let one project differ from a standard rule.', 'secondary'),
  M3: t('Approve a process change', 'Change the standard tracks, steps or limits.', 'secondary'),
  M4: t(
    'Sign off onboarding',
    'Confirm the repo is ready for the level asked. Needs "confirm it\'s you".',
    'secondary',
  ),
  M5: t(
    'Raise agent autonomy',
    'Let agents do more on this project with less review.',
    'secondary',
  ),
  M6: t(
    'Grant approver rights',
    'Let a person decide approvals they could not before.',
    'secondary',
  ),
  Q1: t('Security hold', 'Work stopped because an agent did something unsafe.', 'secondary'),
  SECT: t(
    'Security review',
    'A security approver decides if the hold was real before anything else happens.',
    'secondary',
  ),
};

const gateFamily: Readonly<Record<GateFamily, Term>> = {
  stage: t('Step approval', 'An approval on the normal path of the work.'),
  action: t('Risky action approval', 'An approval for one risky action.'),
  exception: t('Exception approval', 'An approval for leaving the normal rules.'),
  meta: t('Factory change approval', 'An approval for changing how the factory works.'),
  quarantine: t('Security approval', 'An approval after a security hold.'),
  onboarding: t('Onboarding approval', 'The approval that ends onboarding.'),
};

const toggleGroup: Readonly<Record<ProjectToggleGroup, Term>> = {
  g0g1: t(
    'Accept and confirm goal',
    'Switch "Accept the request" and "Confirm the goal" on or off together.',
  ),
  g2: t('Spec approval', 'Switch "Approve the spec" on or off.'),
  g3d: t('Design approval', 'Switch "Approve the design" on or off.'),
  g3_g3s: t(
    'Plan approval',
    'Switch "Approve the outline" and "Approve the plan" on or off together.',
  ),
  g5: t('Release approval', 'Switch "Approve the release" on or off.'),
  g6: t('Result acceptance', 'Switch "Accept the result" on or off.'),
};

const decision: Readonly<Record<LedgerDecision, Term>> = {
  approve: t('Approve', 'Agree; the work moves on.', 'audit'),
  request_changes: t(
    'Request changes',
    'Send it back with what must change; the agent tries again.',
    'audit',
  ),
  reject: t('Reject', 'Say no; the work stops or goes back as the rules say.', 'audit'),
  supersede: t('Replaced', 'A newer version replaced this one before it was decided.', 'audit'),
  expire: t('Expired, not approved', 'Nobody decided in time; expiry never approves.', 'audit'),
  withdraw: t('Withdrawn', 'The request or approval was withdrawn.', 'audit'),
};

/** §5: the decision rail's words that are not ledger decisions. */
const decideWord = {
  reason: t('Reason', 'Why you decided this; saved with your decision.'),
  step_up: t("Confirm it's you", 'Sign in again with your security key before this decision.'),
  two_person: t('Needs two people', 'Two different people must approve this.'),
  sod_waiver: t(
    'Single-approver exception',
    'You decided your own request because you are the only person who can. Recorded.',
    'audit',
  ),
  admin_override: t(
    'Decide as factory admin',
    'You are deciding outside the normal rules. Your name and reason are recorded.',
  ),
  ask_for_work: t('Ask for work', 'Send a request to the factory.'),
  hand_back: t('Hand back', 'Give the work back to the agents.'),
  mark_done: t('Mark my work done', 'Tell the factory your human-led work is ready to be checked.'),
  unsure: t("I'm not sure", 'Ask a code owner to do a full review instead.'),
  always_required: t('Always required', 'No project can switch this approval off.'),
  switched_off: t(
    'Off: step skipped',
    'This approval does not exist on this project; nothing is approved automatically.',
  ),
  decided_together: t(
    'Decided together',
    'Several approvals shown and decided as one card when one person holds them all.',
  ),
} as const satisfies Readonly<Record<string, Term>>;

const gateStatus: Readonly<Record<GateStatus, Term>> = {
  pending: t('Waiting', 'Waiting for a decision.'),
  decided: t('Decided', 'Decided; the decision is shown.'),
  superseded: t('Replaced', 'A newer version replaced it before a decision.'),
  expired: t('Expired, not approved', 'Nobody decided in time. Nothing was approved.'),
  closed: t('Closed', 'The work ended, so the approval closed.'),
};

const CARD_STATUS_TIP = 'Where an inbox card stands.';
const cardStatus: Readonly<Record<CardStatus, Term>> = {
  open: t('Waiting', CARD_STATUS_TIP),
  decided: t('Decided', CARD_STATUS_TIP),
  sent_back: t('Changes requested', CARD_STATUS_TIP),
  rejected: t('Rejected', CARD_STATUS_TIP),
  withdrawn: t('Withdrawn', CARD_STATUS_TIP),
  expired: t('Expired', CARD_STATUS_TIP),
  superseded: t('Replaced', CARD_STATUS_TIP),
};

const FEASIBILITY_TIP = 'Whether someone holds the right to decide this approval.';
const feasibility: Readonly<Record<GateFeasibilityState, Term>> = {
  feasible: t('Can be decided', FEASIBILITY_TIP),
  infeasible: t('Nobody can decide', FEASIBILITY_TIP),
  unknown: t('Unknown', FEASIBILITY_TIP),
};

const INBOX_REASON_TIP = 'Why this is in your inbox.';
const inboxReason: Readonly<Record<InboxEntryReason, Term>> = {
  eligible: t('You can decide', INBOX_REASON_TIP),
  escalated_backup: t('Overdue: you are the backup', INBOX_REASON_TIP),
};

// ---------------------------------------------------------------- 6 Tracks (lanes)

const lane: Readonly<Record<Lane, Term>> = {
  L0: t(
    'Hotfix',
    'An urgent fix that skips planning; a follow-up small change is opened after.',
    'secondary',
  ),
  L1: t(
    'Quick fix',
    'The smallest change: spec and a short plan, no research or design.',
    'secondary',
  ),
  L2: t(
    'Readiness fix',
    'A fix the factory proposes to close a readiness gap in the repo.',
    'secondary',
  ),
  L3: t('Small change', 'A small change with a short spec and plan, no design step.', 'secondary'),
  L4: t('Feature', 'A normal feature: research, spec, design, plan, build.', 'secondary'),
  L5: t(
    'Higher-risk feature',
    'A feature with more risk; needs a separate staging environment.',
    'secondary',
  ),
  L6: t(
    'Large initiative',
    'A large piece of work whose goal is worked out and signed off first.',
    'secondary',
  ),
  L7: t(
    'Experiment',
    'A throwaway build to answer a question; ends in a report, never a PR.',
    'secondary',
  ),
  L8: t(
    'Done by a person',
    'A person does the work; the factory still checks and records it.',
    'secondary',
  ),
};

const relane: Readonly<Record<RelaneId, Term>> = {
  R1: t(
    'Moved to a bigger track',
    'The work turned out bigger; steps were added. No approval needed.',
    'audit',
  ),
  R2: t(
    'Moved to a lighter track',
    'The work is smaller than thought; needs "Allow a lighter track".',
    'audit',
  ),
  R3: t(
    'Agents paused on this track',
    'Too many items failed on this track; new work goes to a person until reset.',
    'audit',
  ),
  R4: t(
    'Hotfix follow-up',
    'The hotfix is done; a follow-up small change makes it permanent.',
    'audit',
  ),
};

// ---------------------------------------------------------------- 7 Onboarding

const level: Readonly<Record<Level, Term>> = {
  census: t(
    'Read only',
    "Agents may read the repo and plan, run experiments, and support people's own work; no agent code.",
    'audit',
  ),
  light: t(
    'Small changes',
    'Agents may also make small changes, hotfixes and readiness fixes.',
    'audit',
  ),
  full: t('All work', 'Agents may also build features and large initiatives.', 'audit'),
};

const tier: Readonly<Record<Tier, Term>> = {
  T0: t('Low risk', 'No production use and no real data; the owner confirms it.', 'secondary'),
  T1: t('Standard risk', 'A normal repo.', 'secondary'),
  T2: t(
    'High risk',
    'Production, money or personal data; more approvals and two people.',
    'secondary',
  ),
};

const autonomy: Readonly<Record<Autonomy, Term>> = {
  A0: t('Agents propose only', 'Every agent change gets a full human review.', 'secondary'),
  A1: t('Agents assisted', 'Agents work; every PR gets a full review.', 'secondary'),
  A2: t('Agents trusted', 'Agents work; low-risk PRs may get a light review.', 'secondary'),
  A3: t('Agents highly trusted', 'Most PRs get a light review with spot-checks.', 'secondary'),
};

const reviewMode: Readonly<Record<ReviewMode, Term>> = {
  C: t('Full review', 'A code owner reviews every line.'),
  E: t('Light review', 'A lighter review; some merges are spot-checked later.'),
};

const card: Readonly<Record<CardKind, Term>> = {
  C1: t(
    'Owners and risk',
    'Who owns the repo, its risk tier, and what to do about each gap.',
    'audit',
  ),
  C2: t(
    'Repo facts and instructions',
    'The facts the agent claims about the repo and the instructions agents will get.',
    'audit',
  ),
  C3: t(
    'Code map and tests',
    'The code map, draft specs and the tests that will be locked.',
    'audit',
  ),
  C4: t(
    'GitHub protection and people',
    "Main-branch protection, the GitHub App's access and who decides what.",
    'audit',
  ),
  C5: t('Sign-off', 'The final onboarding sign-off.', 'audit'),
  SECR: t(
    'Secrets found',
    'Secrets found in the repo or its history, and what was done with each.',
    'audit',
  ),
  BATCH: t('Issues to file', 'Gaps to file as GitHub issues.', 'audit'),
  X2: t(
    'Onboarding files change',
    'Approve the files the agent wants to add (AGENTS.md, CODEOWNERS, .factory/).',
    'audit',
  ),
};

const CLAIM_TIP = 'Your answer to one repo fact.';
const claimVerdict: Readonly<Record<ClaimVerdict, Term>> = {
  affirm: t('Confirm', CLAIM_TIP),
  correct: t('Correct', CLAIM_TIP),
  unknown: t("Don't know", CLAIM_TIP),
};

const GAP_DISPOSITION_TIP = 'What to do about one gap.';
const gapDisposition: Readonly<Record<GapDisposition, Term>> = {
  file_issue: t('Fix now (PR or issue)', GAP_DISPOSITION_TIP),
  track_only: t('Track', GAP_DISPOSITION_TIP),
  waive: t('Accept', GAP_DISPOSITION_TIP),
};

const GAP_STATUS_TIP = 'Where a gap stands.';
const gapStatus: Readonly<Record<GapStatus, Term>> = {
  open: t('Open', GAP_STATUS_TIP),
  closed_verified: t('Fixed', GAP_STATUS_TIP),
  waived: t('Accepted', GAP_STATUS_TIP),
};

const POSTURE_TIP = 'The overall result of the read-only scan.';
const posture: Readonly<Record<PostureState, Term>> = {
  red: t('Not safe yet', POSTURE_TIP),
  amber: t('Needs fixes', POSTURE_TIP),
  green: t('Ready', POSTURE_TIP),
};

/** Onboarding blockers: never "B1" on a screen (it clashes with the sent-back reasons); `OB-B1` in exports. */
const blocker: Readonly<Record<BlockerId, Term>> = {
  B1: t(
    'Open secret found',
    'A secret in the repo or its history has not been dealt with.',
    'audit',
  ),
  B2: t('Scan incomplete', 'The security scan did not finish or is out of date.', 'audit'),
  B3: t('Main branch not protected', 'The default branch lacks the required protection.', 'audit'),
  B4: t(
    'GitHub App too powerful',
    'The App holds a permission it must not have, or required checks are wrong.',
    'audit',
  ),
  B5: t('Unsafe workflow', 'A GitHub workflow could leak secrets to an agent PR.', 'audit'),
  B6: t(
    'Deploys on merge, undocumented',
    'Merging deploys, but operations are not documented.',
    'audit',
  ),
};

/** The export label of an onboarding blocker (glossary §7.2, §22.6). */
export const blockerExportCode = (b: BlockerId): string => `OB-${b}`;

const control: Readonly<Record<ControlId, Term>> = {
  B4a: blocker.B4,
  B4b: blocker.B4,
  B4c: blocker.B4,
  protect_main: t(
    'Main branch protected',
    'The default branch needs PRs, approval and the factory check.',
  ),
  app_scope: t(
    'App limited to this repo',
    'The GitHub App is installed on selected repos only, with the right permissions.',
  ),
  codeowners: t('Code owners file', 'A valid CODEOWNERS file exists.'),
  instructions: t('Agent instructions', 'Agent instructions exist and are approved.'),
};

const lightFloor: Readonly<Record<LightFloorId, Term>> = {
  LF1: t('No open security issues', 'No blocking security finding is open.', 'audit'),
  LF2: t(
    'Main branch protected',
    'Protection is in force and the factory check is required.',
    'audit',
  ),
  LF3: t('Tests run and pass', 'Setup and tests run cleanly in the sandbox.', 'audit'),
  LF4: t(
    'Agent tooling checked',
    'Files that run code or grant tools were checked, and isolation was tested.',
    'audit',
  ),
  LF5: t('Agent instructions approved', 'A person approved the agent instructions.', 'audit'),
  LF6: t(
    'Repo facts confirmed',
    'At least 90% of the repo facts are confirmed or marked unknown.',
    'audit',
  ),
  LF7: t('Operations documented', 'Whether a merge deploys is known and written down.', 'audit'),
  LF8: t('Network needs declared', 'Outside hosts the tests need are listed.', 'audit'),
};

const onboarding: Readonly<Record<OnboardingStatus, Term>> = {
  app: t('Waiting for the GitHub App', "Install the factory's GitHub App on this repo to start."),
  running: t('Agent working', 'The onboarding agent is working.'),
  card: t('Needs your review', 'The summary is ready for you.'),
  blocked: t('Blocked', 'Something must be fixed on GitHub before the agent can go on.'),
  starter: t('Needs starter files', 'The repo needs basic files first; the agent proposes them.'),
  parked: t('Paused: no answer', 'Nobody answered for 5 working days. Resume when ready.'),
  done: t('Onboarded', 'The repo is signed off at its level.'),
  rejected: t('Sign-off refused', 'The sign-off was refused; fix and ask again.'),
  superseded: t('Replaced', 'A newer onboarding replaced this one.'),
  withdrawn: t('Withdrawn', 'The onboarding was stopped.'),
};

const READINESS_TIP = 'Where the readiness scorecard stands.';
const readiness: Readonly<Record<ReadinessStatus, Term>> = {
  proposed: t('Awaiting sign-off', READINESS_TIP),
  active: t('In force', READINESS_TIP),
  stale: t('Out of date', READINESS_TIP),
  suspended: t('Suspended', READINESS_TIP),
  expired: t('Expired', READINESS_TIP),
  superseded: t('Replaced', READINESS_TIP),
};

const pillar: Readonly<Record<ReadinessPillar, Term>> = {
  VRL: t('Testing', 'Can agents check their own work.', 'secondary'),
  ERL: t('Environment', 'Can the code be built and run safely.', 'secondary'),
  ORL: t('Operations', 'Is it known how changes reach production.', 'secondary'),
  KRL: t('Knowledge', 'What agents are told and can read about the repo.', 'secondary'),
};

const DRIFT_TIP = 'What a change since onboarding means.';
const driftEffect: Readonly<Record<DriftEffect, Term>> = {
  reaffirm: t('Confirm again', DRIFT_TIP),
  suspend: t('Agents suspended', DRIFT_TIP),
  security: t('Security check needed', DRIFT_TIP),
};

const SERVED_TIP = 'The state of a file the factory placed.';
const servedFile: Readonly<Record<ServedFileState, Term>> = {
  affirmed: t('Approved', SERVED_TIP),
  pending_projection: t('Waiting for PR merge', SERVED_TIP),
  drift: t('Changed on GitHub', SERVED_TIP),
  absent: t('Missing', SERVED_TIP),
};

const EXAM_TIP = 'Questions that test what the agent learned about the repo.';
const examGrade: Readonly<Record<ExamGrade, Term>> = {
  correct: t('Correct', EXAM_TIP),
  incorrect: t('Incorrect', EXAM_TIP),
  unsure: t('Unsure', EXAM_TIP),
};

const SEED_TIP = 'A draft spec from the code, or confirmed as intended behaviour.';
const seedStatus: Readonly<Record<SeedStatus, Term>> = {
  observed: t('As found', SEED_TIP),
  intended: t('As intended', SEED_TIP),
};

// ---------------------------------------------------------------- 8 Item states

/** The stage name with the phase tooltip (glossary §8.1: "(the stage name, §2)"). */
const PHASE_STAGE_TIP = 'The stage the work is in now.';
const atStage = (s: StageId): Term => t(stage[s].label, PHASE_STAGE_TIP);

const phase: Readonly<Record<WorkItemPhase, Term>> = {
  Draft: t('Draft', 'Not sent yet.'),
  Clarifying: t('Questions asked', 'The factory asked questions; answer them to go on.'),
  S1: atStage('S1'),
  S2: atStage('S2'),
  S3: atStage('S3'),
  S4: atStage('S4'),
  S5: atStage('S5'),
  Scheduling: t('Queued for build', 'The plan is approved; waiting for a coding slot.'),
  S6: atStage('S6'),
  S7: atStage('S7'),
  G4: t('In code review', 'Waiting for a code owner to approve the PR.'),
  S8a: atStage('S8a'),
  S8b: atStage('S8b'),
  G5: t('Waiting for release approval', 'Merged; waiting for release approval.'),
  S9: atStage('S9'),
  G6: t('Waiting for your acceptance', 'Done; the requester must accept it.'),
  Held: t('On hold', 'Paused for a reason shown beside it.'),
  Handoff: t('Needs a person', 'The agents stopped; a person must choose what happens next.'),
  Quarantined: t('Security hold', 'Stopped after unsafe agent behaviour; security decides next.'),
  Parked: t(
    'Waiting for answers',
    'Paused until the questions are answered; ends after 5 working days.',
  ),
  Done: t('Done', 'Finished and accepted.'),
  Declined: t('Declined', 'The factory will not do this request.'),
  Abandoned: t('Abandoned', 'Stopped before it finished.'),
  Withdrawn: t('Withdrawn', 'The requester withdrew it.'),
  HandedOverClosed: t('Closed by a person', 'A person took the work over and closed it.'),
  Superseded: t('Replaced', 'Another item replaced this one.'),
  Deferred: t('Deferred', 'Put off to later.'),
};

const wait: Readonly<Record<WaitState, Term>> = {
  Parked: phase.Parked,
  Blocked: t(
    'Blocked: environment',
    'The tests fail before any change, or the sandbox is broken; fix and retry.',
  ),
  ReleaseHeld: t(
    'Release on hold',
    'The release was refused; fix and ask again, or open a new item.',
  ),
  SpikeReport: t('Experiment report', 'The experiment finished; read its report.'),
};

const room: Readonly<Record<FloorRoom, Term>> = {
  SCHED: t('Queue', 'Waiting to start building.'),
  HOLD: t('On hold', 'Paused items.'),
  QUAR: t('Security hold', 'Items stopped for security.'),
  DESK: t('Needs a person', 'Items waiting for a person to take over or choose.'),
  BIN: t('Declined', 'Requests the factory will not do.'),
  DONE: t('Done', 'Finished items.'),
};

const FLOOR_STATUS_TIP = 'What the item is doing now on the floor.';
const floorStatus: Readonly<Record<FloorItemStatus, Term>> = {
  working: t('Working', FLOOR_STATUS_TIP),
  waiting: t('Waiting', FLOOR_STATUS_TIP),
  held: t('On hold', FLOOR_STATUS_TIP),
  stuck: t('Stuck', 'No sign of life from the agent for longer than the set time.'),
  done: t('Done', FLOOR_STATUS_TIP),
  declined: t('Declined', FLOOR_STATUS_TIP),
};

const FLOOR_MOVE_TIP = 'How an item last moved.';
const floorMove: Readonly<Record<FloorMoveKind, Term>> = {
  F: t('Forward', FLOOR_MOVE_TIP),
  B: t('Sent back', FLOOR_MOVE_TIP),
  R: t('Moved track', FLOOR_MOVE_TIP),
};

// ---------------------------------------------------------------- 9 Sent back, handed over, paused

const backEdge: Readonly<Record<BackEdgeId, Term>> = {
  B1: t(
    'Needs more information',
    'Questions asked; up to 2 rounds, then paused 5 working days.',
    'audit',
  ),
  B2: t(
    'Goal unclear',
    'Research found the goal unclear; the goal is confirmed again (2 tries, then a person).',
    'audit',
  ),
  B3: t('Spec failed checks', 'The spec failed validation; the agent retries (3 tries).', 'audit'),
  B4: t(
    'Design found a spec gap',
    'The design shows the spec is missing something; back to spec once.',
    'audit',
  ),
  B5: t(
    'Plan changes requested',
    'The plan was sent back; after 2 times, a person writes the plan.',
    'audit',
  ),
  B6: t(
    'Blocked: environment',
    'Tests fail before any change; the build waits until the environment is fixed.',
    'audit',
  ),
  B7: t(
    'Checks failing, retrying',
    "The agent's own checks fail; it retries within its limits.",
    'audit',
  ),
  B8: t(
    'Out of scope: re-plan',
    'The change went beyond its part; the part is split and approved again.',
    'audit',
  ),
  B9: t('Fixing check findings', 'Verify found something fixable; the agent fixes it.', 'audit'),
  B10: t(
    'Spec unclear',
    'Verify found the spec ambiguous; the spec is approved again once.',
    'audit',
  ),
  B11: t(
    'Wrong approach: re-plan',
    'Verify found the approach wrong; the plan is approved again once.',
    'audit',
  ),
  B12: t(
    'Locked test must change',
    'A locked test must change; needs "Change a locked test".',
    'audit',
  ),
  B13: t(
    'Changes requested in review',
    'The code owner requested changes; up to 2 rounds.',
    'audit',
  ),
  B14: t(
    'Reviewer unsure',
    'A light reviewer was unsure; a code owner does a full review.',
    'audit',
  ),
  B15: t('Base branch moved', 'The main branch moved; checks run again (2 times).', 'audit'),
  B16: t(
    'Deploy unhealthy: rolled back',
    'The release was rolled back; a new fix item was opened.',
    'audit',
  ),
  B17: t(
    'Bug found after merge',
    'A problem was found after merge; a new fix item was opened.',
    'audit',
  ),
  B18: t(
    'Result not accepted',
    'The requester did not accept the result; a new linked item was opened.',
    'audit',
  ),
  B19: t(
    'Spot-check found a miss',
    'An audit found a missed problem; too many suspend light reviews.',
    'audit',
  ),
  B20: t('Scope changed', 'The requester changed the scope; back to spec (once).', 'audit'),
  B21: t(
    'Decision overdue',
    'Waited over 1 working day; sent to the backup approver. Never approved automatically.',
    'audit',
  ),
  B22: t('Not eligible', 'The request does not fit this repo or the factory.', 'audit'),
  B23: t('Spec rejected', 'The spec was rejected; 2 rounds, then a person chooses.', 'audit'),
  B24: t('Design rejected', 'The design was rejected; 2 rounds, then a person chooses.', 'audit'),
  B25: t(
    'Exception refused',
    'The rule exception was refused; redesign once, then a person chooses.',
    'audit',
  ),
  B26: t('Release refused', 'The release was refused; it is on hold.', 'audit'),
  B27: t(
    'Possible prompt injection',
    'The request contains text that looks like instructions to the agent; it is treated as data.',
    'audit',
  ),
  B28: t(
    'Rework limit reached',
    'The work was sent back too often; a person chooses what happens next.',
    'audit',
  ),
};

/** B15 has two faces the contract does not split (the flow's B15a and B15b). */
export const BASE_MOVED_CONFLICT: Term = t(
  'Merge conflict',
  'The PR conflicts; the agent resolves it and checks again.',
  'audit',
);

const handoff: Readonly<Record<HandoffId, Term>> = {
  D1: t('Needs a person: build', 'The agents stopped while building.', 'audit'),
  D2: t('Needs a person: checks', 'The agents stopped while fixing check findings.', 'audit'),
  D3: t('Needs a person: review', 'Review rejected the work twice.', 'audit'),
  D4: t('Hand back', 'A person gives the work back to the agents (once).', 'audit'),
  D5: t(
    'Mark my work done',
    'The person who took over says the work is ready for checks.',
    'audit',
  ),
};

const CHECK_LIMIT = t('Check limit reached', 'A verify check hit its retry limit.', 'audit');
const trigger: Readonly<Record<TriggerId, Term>> = {
  ET1: t('Budget used up', 'The work spent its whole budget.', 'audit'),
  ET2: t('Taking too long', 'Too many CI rounds or twice the planned time.', 'audit'),
  ET3: t('Keeps failing', 'The same check failed 3 times.', 'audit'),
  ET4: CHECK_LIMIT,
  ET5: CHECK_LIMIT,
  ET6: CHECK_LIMIT,
  ET7: t('Rejected twice', 'The review rejected the work twice.', 'audit'),
  ET8: t('Agent gave up', 'The agent said it cannot do this.', 'audit'),
  ET9: t('Scope drift', 'The change drifted out of scope twice.', 'audit'),
  ET10: t(
    'Unsafe agent behaviour',
    'The agent tried something not allowed; security hold.',
    'audit',
  ),
  ET11: t('Going in circles', 'The agent keeps undoing its own changes.', 'audit'),
  ET12: t('Unstable results', 'Results change between runs (flaky).', 'audit'),
  ET13: t('Bug found after merge', 'A problem was found after merge.', 'audit'),
  ET14: t(
    'Too many failures',
    'Too many items failed on this track; agents paused on it.',
    'audit',
  ),
};

/** §9.2: the choices of "Choose what happens next". */
const e4Choice = {
  resume: t('Resume', 'The options when the agents are stuck.'),
  replan: t('Re-plan', 'The options when the agents are stuck.'),
  respec: t('Rewrite spec', 'The options when the agents are stuck.'),
  take_over: t('Take over', 'The options when the agents are stuck.'),
  abandon: t('Stop the work', 'The options when the agents are stuck.'),
} as const satisfies Readonly<Record<string, Term>>;

const hold: Readonly<Record<HoldReason, Term>> = {
  H1: t('Waiting for an approver', 'Nobody who can approve the next step is available.', 'audit'),
  H2: t('Waiting for a coding slot', 'All coding sandboxes are busy.', 'audit'),
  H3: t('Waiting for environment', 'The build environment is not available.', 'audit'),
  WIP: t('Too much in progress', "The project's work-in-progress limit is reached.", 'audit'),
  N8: t('Repo not ready', 'The repo has no readiness scorecard in force for this track.', 'audit'),
  kill: t('Agents stopped', 'The emergency stop is on for this scope.', 'audit'),
  maintenance: t('Maintenance mode', 'Timers frozen and decisions disabled; drafts kept.', 'audit'),
  quota: t('Over quota', "The model provider's quota is reached.", 'audit'),
  control: t('Paused by an operator', 'An operator paused this scope.', 'audit'),
};

// ---------------------------------------------------------------- 10 Parts of the plan (Units)

const unitState: Readonly<Record<UnitState, Term>> = {
  Planned: t('Planned', 'In the plan; not started.'),
  Admitted: t('Ready to build', 'Has a coding slot and budget.'),
  Building: t('Building', 'The coding agent is working on it.'),
  Pushed: t('Draft PR open', 'The PR is open.'),
  Verifying: t('Being checked', 'The factory is checking the PR.'),
  InReview: t('In code review', 'A code owner is reviewing the PR.'),
  Merged: t('Merged', 'Merged on GitHub.'),
  Released: t('Released', 'Deployed.'),
  HumanHeld: t('Waiting for a person', 'Paused for an approval.'),
  Tainted: t('Flagged unsafe', 'Unsafe behaviour seen; going to a security hold.'),
  Quarantined: t('Security hold', 'Stopped for security review.'),
  Stopped: t('Stopped', 'Stopped by an operator, a budget or the emergency stop.'),
  GrantReleased: t('Slot released', 'Its slot and budget were released.'),
};

const UNIT_SIZE_TIP = 'How big the part is; sets its share of the budget.';
const unitSize: Readonly<Record<UnitSize, Term>> = {
  small: t('Small', UNIT_SIZE_TIP),
  medium: t('Medium', UNIT_SIZE_TIP),
  large: t('Large', UNIT_SIZE_TIP),
};

// ---------------------------------------------------------------- 11 Checks and evidence

const verifyCheck: Readonly<Record<VerifyCheckId, Term>> = {
  deterministic: step['7.1'],
  test_integrity: step['7.2'],
  spec_conformance: step['7.3'],
  secrets_dependencies: step['7.4'],
  constitution: step['7.5'],
};

const VERDICT_TIP = 'The result of one check.';
const verdict: Readonly<Record<CheckVerdict, Term>> = {
  passed: t('Passed', VERDICT_TIP),
  failed: t('Failed', VERDICT_TIP),
  unknown: t('Unknown (not passed)', VERDICT_TIP),
};

const repairClass: Readonly<Record<RepairClass, Term>> = {
  repairable: t('Agent can fix', 'The agent will fix this.'),
  spec_ambiguous: t('Spec unclear', 'The spec must be clarified.'),
  approach_wrong: t('Wrong approach', 'The plan must change.'),
  locked_test_change: t('Locked test change', 'A locked test must change; needs approval.'),
  hard_fail: t('Cannot go on', 'A person must decide.'),
  quarantine: t('Security hold', 'Unsafe; security decides.'),
};

// ---------------------------------------------------------------- 12 Roles, 13 Actions, 14 Access levels

/** The role catalogue's ids (contracts `ROLE_IDS`; a test holds the two lists equal). */
export const GLOSSARY_ROLE_IDS = [
  'project.admin',
  'project.requester',
  'project.intent_approver',
  'project.design_approver',
  'project.code_owner',
  'project.release_approver',
  'project.exception_approver',
  'project.security_approver',
  'project.onboarding_signer',
  'project.kill_holder',
  'project.viewer',
  'factory.admin',
  'factory.onboarder',
  'factory.auditor',
] as const;
export type GlossaryRoleId = (typeof GLOSSARY_ROLE_IDS)[number];

const role: Readonly<Record<GlossaryRoleId, Term>> = {
  'project.admin': t(
    'Project admin',
    'Runs the project: settings, people, project approvals.',
    'audit',
  ),
  'project.requester': t('Requester', 'Asks for work and accepts the result.', 'audit'),
  'project.intent_approver': t(
    'Request and spec approver',
    'Accepts requests, confirms goals, approves specs.',
    'audit',
  ),
  'project.design_approver': t(
    'Design and plan approver',
    'Approves designs, outlines and plans.',
    'audit',
  ),
  'project.code_owner': t(
    'Code reviewer',
    'Reviews agent PRs; the code owners on GitHub.',
    'audit',
  ),
  'project.release_approver': t('Release approver', 'Approves releases.', 'audit'),
  'project.exception_approver': t(
    'Exception approver',
    'Decides risky actions and exceptions.',
    'audit',
  ),
  'project.security_approver': t(
    'Security approver',
    'Decides security holds and reviews.',
    'audit',
  ),
  'project.onboarding_signer': t('Onboarding signer', 'Signs off onboarding.', 'audit'),
  'project.kill_holder': t(
    'Can stop agents',
    'Can stop and restart agents on the project.',
    'audit',
  ),
  'project.viewer': t('Viewer', 'Can see the project; no titles of restricted work.', 'audit'),
  'factory.admin': t(
    'Factory admin',
    'Can change and decide anything in the factory; every action is recorded.',
    'audit',
  ),
  'factory.onboarder': t('Can onboard repos', 'Can start onboarding a repo.', 'audit'),
  'factory.auditor': t('Auditor', 'Can read the whole factory record; decides nothing.', 'audit'),
};

/** A project role slot reads as the role it maps to (the slot code is never shown). */
const roleSlot: Readonly<Record<RoleSlot, Term>> = {
  admin: role['project.admin'],
  requesters: role['project.requester'],
  intent: role['project.intent_approver'],
  design: role['project.design_approver'],
  g4: role['project.code_owner'],
  g5: role['project.release_approver'],
  x: role['project.exception_approver'],
  sec: role['project.security_approver'],
  m4: role['project.onboarding_signer'],
  kill: role['project.kill_holder'],
};

const PRINCIPAL_TIP = 'Who or what acted.';
const principalKind: Readonly<Record<PrincipalKind, Term>> = {
  human: t('Person', PRINCIPAL_TIP),
  service: t('Service', PRINCIPAL_TIP),
};

const action: Readonly<Record<ActionId, Term>> = {
  'project.onboard': t('Onboard a repo', 'Start onboarding a repo.', 'audit'),
  'work.request': t('Ask for work', 'Send a request to the factory.', 'audit'),
  'item.ready': t(
    'Mark ready / Answer questions',
    "Say the request is ready, or answer the factory's questions.",
    'audit',
  ),
  'item.observe': t(
    'Raise a concern',
    'During design review, say the spec has a gap or the work is smaller than its track.',
    'audit',
  ),
  'item.plan': t(
    'Write the plan',
    'Write the plan yourself after it was sent back twice.',
    'audit',
  ),
  'item.release': t(
    'Ask to release again',
    'Ask for release approval again after a refusal.',
    'audit',
  ),
  'item.human_done': t(
    'Mark my work done',
    'Say your human-led work is ready for checks.',
    'audit',
  ),
  'item.unsure': t("I'm not sure", 'Ask for a full code review.', 'audit'),
  'item.escape': t(
    'Report a bug after merge',
    'Report a problem found after the item closed.',
    'audit',
  ),
  'audit.record': t(
    'Record a spot-check',
    'Record the audit of a lightly reviewed merge.',
    'audit',
  ),
  'closeout.read': t('See the close-out', "Read an item's final record.", 'audit'),
  'learn.propose': t(
    'Suggest improvements',
    'Ask the factory to propose changes from finished work.',
    'audit',
  ),
  'project.view': t('See the project', 'See a project and its settings.', 'audit'),
  'project.settings.edit': t(
    'Change project settings',
    'Change who decides what, approvals and two-person rules.',
    'audit',
  ),
  'floor.read': t('See the floor', 'See the live floor.', 'audit'),
  'item.view_floor': t('See the item', 'See an item on the floor.', 'audit'),
  'gate.view': t('See the approval', 'See an approval and its evidence.', 'audit'),
  'gate.decide': t('Decide approvals', 'Approve, request changes or reject.', 'audit'),
  'card.decide': t('Decide inbox cards', 'Decide a card that carries several approvals.', 'audit'),
  'kill.request': t('Stop agents', 'Emergency stop for a scope.', 'audit'),
  'kill.release': t('Restart agents', 'Lift an emergency stop (two people).', 'audit'),
  'config.propose': t(
    'Propose a settings change',
    'Draft a change to settings for approval.',
    'audit',
  ),
  'config.decide': t(
    'Approve factory settings',
    'Approve a change to factory-wide settings.',
    'audit',
  ),
  'audit.read': t('Read the audit trail', 'See the decision log and audit views.', 'audit'),
  'control.apply': t(
    'Pause or limit',
    'Pause, limit, halt or put a scope in maintenance.',
    'audit',
  ),
  'control.lift': t('Lift a pause', 'Lift a pause or limit.', 'audit'),
  'banner.publish': t('Post a notice', 'Show a notice to everyone in a scope.', 'audit'),
  'access.explain': t('See who can do what', 'See who can decide each approval.', 'audit'),
  'identity.admin': t(
    'Manage sign-in and data',
    'Sign-in, sessions, suspension, deleting personal data, legal hold.',
    'audit',
  ),
  'access.manage': t('Manage roles', 'Give and take away roles; answer access requests.', 'audit'),
  'ops.read': t('See operations', 'See scheduling, sandboxes, controls and health.', 'audit'),
  'session.stop': t('Stop a session', 'Stop one running agent sandbox.', 'audit'),
  'quality.read': t(
    'See agent quality',
    'See agents, evaluations, models and integrations.',
    'audit',
  ),
  'assistant.use': t(
    'Ask the assistant',
    'Ask the factory questions about what you can see.',
    'audit',
  ),
  // glossary.md "Delete (NEW)": remove the object and all its data for good; the log keeps hashes only.
  'project.delete': t(
    'Delete a project',
    'Remove the project, its repos and work, and all their data for good; the log keeps hashes only.',
    'audit',
  ),
  'repo.delete': t(
    'Delete a repo',
    'Remove a repo from its project and delete its data for good; the log keeps hashes only.',
    'audit',
  ),
  'item.delete': t(
    'Delete a work item',
    'Remove a work item and all its data for good; the log keeps hashes only.',
    'audit',
  ),
  'person.delete': t(
    'Delete a person',
    'Remove a person and their data for good; the log keeps hashes only.',
    'audit',
  ),
  'team.delete': t('Delete a team', 'Remove a team for good; the log keeps hashes only.', 'audit'),
  'binding.delete': t(
    'Remove a role',
    'Take a role away from a person or team and delete the grant.',
    'audit',
  ),
};

const viewLevel: Readonly<Record<ViewLevel, Term>> = {
  V1: t(
    'Overview',
    'Sees that work exists and where it is; no titles of restricted work.',
    'secondary',
  ),
  V2: t('Details', 'Sees requests, documents and checks.', 'secondary'),
  V3: t('Everything', 'Sees transcripts, settings and the full record.', 'secondary'),
};

const dataClass: Readonly<Record<DataClass, Term>> = {
  D0: t('Public', 'Safe to show anyone.', 'secondary'),
  D1: t('Internal', 'Company-internal; not personal or secret.', 'secondary'),
  D2: t('Confidential', 'Sensitive business or security detail.', 'secondary'),
  D3: t('Restricted', 'Never sent to a model and never shown in the portal.', 'secondary'),
};

// ---------------------------------------------------------------- 15 Agents

const NOT_IN_USE = t('Not in use', 'Reserved; does nothing today.', 'secondary');
const agent: Readonly<Record<AgentId, Term>> = {
  A1: t('Triage agent', 'Checks duplicates, sizes the work and checks eligibility.', 'secondary'),
  A2: t('Spec writer', 'Asks questions, writes the goal and the spec.', 'secondary'),
  A3: t('Planner', 'Researches, designs and plans.', 'secondary'),
  A4: t('Coding agent (one-shot)', 'The one-call coding agent.', 'secondary'),
  A5: t('Reviewer', 'Reviews specs, designs and changes with fresh context.', 'secondary'),
  A6: t('Test writer', 'Writes acceptance criteria and acceptance tests.', 'secondary'),
  A7: NOT_IN_USE,
  A8: NOT_IN_USE,
  A9: t('Repo reader', 'Reads the repo at onboarding and digs into unclear code.', 'secondary'),
  A10: NOT_IN_USE,
  A11: t('Handover writer', 'Writes the handover notes when agents stop.', 'secondary'),
  A12: t('Knowledge extractor', 'Builds the code map and draft specs at onboarding.', 'secondary'),
  coder: t('Coding agent', 'Writes the code in the sandbox and opens the draft PR.', 'secondary'),
  assistant: t('Assistant', 'Answers your questions from what you can see.'),
};

const SESSION_TIP = 'The live sandbox session.';
const sessionState: Readonly<Record<AgentSessionState, Term>> = {
  starting: t('Starting', SESSION_TIP),
  running: t('Running', SESSION_TIP),
  idle: t('Idle', SESSION_TIP),
  waiting_tool: t('Waiting for a tool', SESSION_TIP),
  interrupted: t('Interrupted', SESSION_TIP),
  ended: t('Finished', SESSION_TIP),
  stopped: t('Stopped', SESSION_TIP),
  tainted: t('Flagged unsafe', SESSION_TIP),
};

const EVAL_CASE_TIP = 'Kinds of evaluation case.';
const evalCaseKind: Readonly<Record<EvalCaseKind, Term>> = {
  regression: t('Regression', EVAL_CASE_TIP),
  holdout: t('Hidden', EVAL_CASE_TIP),
  pooled: t('Shared', EVAL_CASE_TIP),
  canary: t('Canary', EVAL_CASE_TIP),
  seeded_defect: t('Planted bug', EVAL_CASE_TIP),
};

// ---------------------------------------------------------------- 16 Operate

const KILL_TIP = 'Where an emergency stop stands.';
const killState: Readonly<Record<KillState, Term>> = {
  active: t('Stopped', KILL_TIP),
  release_pending: t('Restart waiting for second person', KILL_TIP),
  released: t('Restarted', KILL_TIP),
};

/** §16: what an emergency stop covers (`KillScope.kind` as a person reads it). */
const killScope = {
  fleet: t('Whole factory', 'What the stop covers.'),
  project: t('Project', 'What the stop covers.'),
  lane: t('Track', 'What the stop covers.'),
  session: t('Session', 'What the stop covers.'),
} as const satisfies Readonly<Record<string, Term>>;

const controlKind: Readonly<Record<ControlKind, Term>> = {
  hold: t('Pause', 'Pause new work in a scope.'),
  clamp: t('Limit', 'Allow at most N items in progress.'),
  halt: t('Halt', 'Stop work in a scope now.'),
  maintenance: t('Maintenance mode', 'Freeze timers and decisions everywhere.'),
};

const CONTROL_STATE_TIP = 'Where a control stands.';
const controlState: Readonly<Record<ControlState, Term>> = {
  active: t('In force', CONTROL_STATE_TIP),
  lifted: t('Lifted', CONTROL_STATE_TIP),
  expired: t('Ended', CONTROL_STATE_TIP),
};

const SEVERITY_TIP = 'How prominent the notice is.';
const bannerSeverity: Readonly<Record<BannerSeverity, Term>> = {
  info: t('Info', SEVERITY_TIP),
  warning: t('Warning', SEVERITY_TIP),
  critical: t('Critical', SEVERITY_TIP),
};

const sandboxClass: Readonly<Record<SandboxClass, Term>> = {
  K: t('Read-only scan', 'Reads files; runs nothing.', 'secondary'),
  'K-exec': t('Test run', "Runs the repo's setup and tests, offline.", 'secondary'),
  P: t('Planning', 'Agents read and plan; no code runs.', 'secondary'),
  W: t('Coding', 'The coding agent writes and runs code.', 'secondary'),
  O: t('Checks', 'Runs the verify checks.', 'secondary'),
  V: t('Verify', 'Runs the final verification.', 'secondary'),
};

const HEALTH_TIP = "A service's state; no reading in 2 minutes is unknown.";
const health: Readonly<Record<HealthState, Term>> = {
  ok: t('Healthy', HEALTH_TIP),
  degraded: t('Degraded', HEALTH_TIP),
  down: t('Down', HEALTH_TIP),
  unknown: t('Unknown', HEALTH_TIP),
};

// ---------------------------------------------------------------- 17 Integrations

const integrationKind: Readonly<Record<IntegrationKind, Term>> = {
  code_host: t('Code host', 'Where the code lives (GitHub).'),
  model_provider: t('Model provider', 'Who runs the AI models (Anthropic, OpenAI-compatible).'),
  notifier: t('Notifications', 'Slack and email.'),
  tracker: t('Issue tracker', 'Where gaps are filed as issues.'),
  identity: t('Sign-in', 'The sign-in provider (Keycloak, any OIDC).'),
};

const integrationAdapter: Readonly<Record<IntegrationAdapter, Term>> = {
  github_app: t('GitHub App', 'How the factory talks to the code host.'),
  fake_github: t('Test GitHub', 'How the factory talks to the code host.'),
  anthropic: t('Anthropic', 'How the factory talks to the model provider.'),
  openai_compat: t('OpenAI-compatible', 'How the factory talks to the model provider.'),
  fake: t('Test model', 'How the factory talks to the model provider.'),
};

const INTEGRATION_STATUS_TIP = 'Whether the integration is used.';
const integrationStatus: Readonly<Record<IntegrationStatus, Term>> = {
  draft: t('Draft', INTEGRATION_STATUS_TIP),
  enabled: t('On', INTEGRATION_STATUS_TIP),
  disabled: t('Off', INTEGRATION_STATUS_TIP),
  retired: t('Retired', INTEGRATION_STATUS_TIP),
};

const NOTIFICATION_TIP = 'What a notification is about.';
const notificationKind: Readonly<Record<NotificationKind, Term>> = {
  gate_waiting: t('Approval waiting', NOTIFICATION_TIP),
  sla_escalated: t('Approval overdue', NOTIFICATION_TIP),
  quarantine: t('Security hold', NOTIFICATION_TIP),
  handoff: t('Needs a person', NOTIFICATION_TIP),
  kill_engaged: t('Agents stopped', NOTIFICATION_TIP),
  kill_released: t('Agents restarted', NOTIFICATION_TIP),
  // Not in glossary.md §17 yet: built from its words (PROPOSED_TERMS), for the owner's approval.
  questions_waiting: t('Questions asked', NOTIFICATION_TIP),
  ready_waiting: t('Mark ready', NOTIFICATION_TIP),
  acceptance_waiting: t('Waiting for your acceptance', NOTIFICATION_TIP),
  item_parked: t('Waiting for answers', NOTIFICATION_TIP),
  item_done: t('Done', NOTIFICATION_TIP),
  item_ended: t('Work ended', NOTIFICATION_TIP),
  control_halt: t('Halt', NOTIFICATION_TIP),
  breaker_tripped: t('Agents paused on track', NOTIFICATION_TIP),
  drift_suspended: t('Agents suspended', NOTIFICATION_TIP),
  release_failed: t('Release failed', NOTIFICATION_TIP),
  factory_alert: t('Factory alert', NOTIFICATION_TIP),
};

const NOTIFICATION_REASON_TIP = 'Why you got it.';
const notificationReason: Readonly<Record<NotificationReason, Term>> = {
  slot_holder: t('You can decide', NOTIFICATION_REASON_TIP),
  escalated_backup: t('You are the backup', NOTIFICATION_REASON_TIP),
  project_admin: t('You run the project', NOTIFICATION_REASON_TIP),
  factory_admin: t('You run the factory', NOTIFICATION_REASON_TIP),
  // Not in glossary.md §17 yet (PROPOSED_TERMS).
  requester: t('You asked for it', NOTIFICATION_REASON_TIP),
};

// ---------------------------------------------------------------- 18 Settings

/**
 * Every setting key a screen names. The keys are the contracts' `*_KEY` and `*_KEYS` constants (a test
 * walks the exports and fails on a key missing here) plus the NEW keys glossary §18 names for settings
 * that are hard-coded today; the config registry (Settings squad) replaces this list with its own.
 */
export const CONFIG_KEY_TERMS = [
  'project.role_map',
  'project.two_person',
  'project.gating_profile',
  'project.kill_delegations',
  'project.release',
  'project.wip_limit',
  'project.default_envelope',
  's0.failure_model',
  's0.timeboxes',
  's0.calendar',
  's0.t0_attestation_required',
  'onboarding.instruction_template',
  'onboarding.reonboard_triggers',
  'onboarding.sandbox_image',
  'onboarding.light_tests',
  'factory.constitution',
  'factory.m1_policy',
  'factory.learn',
  'factory.floor',
  'sandbox.exec_allowed_repos',
  'sandbox.caps',
  'ops.maintenance.mm2',
  'pdp.bundle',
  'integrations.registry',
  'integrations.installs',
  'gateway.models',
  'gateway.routes',
  'codehost.merge_bypass',
  'audit.retention',
  'notifications.channels',
  // NEW in glossary §18 (hard-coded today; screen-map §5)
  'agents.config',
  'gates.policy',
  'session.policy',
  'gates.timers',
  'readiness.policy',
  'catalogue.lanes',
  'catalogue.back_edge_limits',
  'catalogue.rework_budget',
  'catalogue.envelope_extension',
  'catalogue.flow_limits',
  'catalogue.triggers',
  'catalogue.gating',
  'catalogue.eligibility',
  'catalogue.autonomy',
  'catalogue.criteria',
  'gateway.limits',
  'ops.health',
  'evals.gate',
  'codehost.polls',
  'work.request',
  'sandbox.probe',
  'sandbox.profiles',
  'planning.size_share',
  'access.roles',
] as const;
export type ConfigKeyTerm = (typeof CONFIG_KEY_TERMS)[number];

const configKey: Readonly<Record<ConfigKeyTerm, Term>> = {
  'project.role_map': t('Who decides what', 'Who holds each project role.', 'audit'),
  'project.two_person': t(
    'Two-person approvals',
    'Whether risky approvals need two different people.',
    'audit',
  ),
  'project.gating_profile': t(
    'Which approvals are on',
    'Which optional approvals this project has, per track, and how builds are scheduled.',
    'audit',
  ),
  'project.kill_delegations': t(
    'Who can stop agents',
    'People given the right to stop agents here.',
    'audit',
  ),
  'project.release': t(
    'Releases',
    'Off, or the GitHub environment to deploy to after release approval.',
    'audit',
  ),
  'project.wip_limit': t(
    'Work-in-progress limit',
    'The most parts of this project building at once.',
    'audit',
  ),
  'project.default_envelope': t(
    'Default budget',
    'The budget of an item with no plan, and the most one part may use.',
    'audit',
  ),
  's0.failure_model': t(
    'Onboarding retries and pauses',
    'Retries, send-backs, and when onboarding pauses for silence.',
    'audit',
  ),
  's0.timeboxes': t('Onboarding time limits', 'How long each onboarding step may take.', 'audit'),
  's0.calendar': t('Working days', 'Weekends, holidays and time zone for every timer.', 'audit'),
  's0.t0_attestation_required': t(
    'Low risk needs owner confirmation',
    'The owner must confirm "no production, no real data".',
    'audit',
  ),
  'onboarding.instruction_template': t(
    'Agent instructions template',
    'What agent instructions may and may not contain.',
    'audit',
  ),
  'onboarding.reonboard_triggers': t(
    'When to re-onboard',
    'How many knowledge errors in how many days suggest re-onboarding.',
    'audit',
  ),
  'onboarding.sandbox_image': t(
    'Test-run image',
    "The sandbox image used to run a repo's tests.",
    'audit',
  ),
  'onboarding.light_tests': t(
    'Coding image and isolation tests',
    'The coding image and the thresholds of its isolation tests.',
    'audit',
  ),
  'factory.constitution': t(
    'Factory rules',
    'The rules every design and change is checked against.',
    'audit',
  ),
  'factory.m1_policy': t(
    'Who approves factory settings',
    'Which role approves factory changes, and whether one or two people.',
    'audit',
  ),
  'factory.learn': t(
    'Learning from finished work',
    'When the factory proposes improvements.',
    'audit',
  ),
  'factory.floor': t(
    'Floor display',
    'When an item is drawn stuck and when an agent score is low.',
    'audit',
  ),
  'sandbox.exec_allowed_repos': t(
    'Repos agents may run code in',
    'Agents run code only in these repos.',
    'audit',
  ),
  'sandbox.caps': t(
    'Sandbox limits',
    'How many sandboxes and coding sandboxes run at once.',
    'audit',
  ),
  'ops.maintenance.mm2': t('Maintenance mode', 'Freeze timers and decisions everywhere.', 'audit'),
  'pdp.bundle': t(
    'Access policy',
    'The published permission rules (generated from roles).',
    'audit',
  ),
  'integrations.registry': t('Integrations', 'The outside services the factory uses.', 'audit'),
  'integrations.installs': t(
    'Integrations per project',
    'Which repos and models each project may use.',
    'audit',
  ),
  'gateway.models': t('Models and prices', 'The models and their limits and prices.', 'audit'),
  'gateway.routes': t(
    'Model per data class',
    'Which model handles each data sensitivity.',
    'audit',
  ),
  'codehost.merge_bypass': t(
    'Who may merge without the check',
    'GitHub users allowed to merge around the factory check.',
    'audit',
  ),
  'audit.retention': t('Data retention', 'How long each kind of data is kept.', 'audit'),
  'notifications.channels': t(
    'Notification channels',
    'Slack and email channels and who gets what.',
    'audit',
  ),
  'agents.config': t(
    'Agents on/off, models, turns, timeouts, budgets',
    'Per agent: on or off, model, max turns, time limit and budget.',
  ),
  'gates.policy': t(
    'Who decides each approval',
    'The role, two-person rule and "confirm it\'s you" for each approval.',
  ),
  'session.policy': t('Sign-in session limits', 'Inactivity sign-out and maximum session length.'),
  'gates.timers': t(
    'Approval timers',
    'When an approval is overdue, when it expires, how long "confirm it\'s you" lasts.',
  ),
  'readiness.policy': t(
    'Readiness rules',
    'Scorecard expiry, waiver length, fact confirmation share.',
  ),
  'catalogue.lanes': t('Tracks', 'What each track runs: its steps, approvals and default budget.'),
  'catalogue.back_edge_limits': t(
    'Retry limits',
    'How many times work may be sent back for each reason, and what happens then.',
  ),
  'catalogue.rework_budget': t(
    'Rework limit',
    'How often work may be sent back before a person takes over.',
  ),
  'catalogue.envelope_extension': t(
    'Budget extension',
    'How far and how often a budget may be extended.',
  ),
  'catalogue.flow_limits': t(
    'Hand back limits',
    'How often work may be handed back or an alternative tried.',
  ),
  'catalogue.triggers': t('Escalation triggers', 'What each escalation does and when it trips.'),
  'catalogue.gating': t('Default approvals', 'The approvals each track has by default.'),
  'catalogue.eligibility': t('Tracks per level', 'Which tracks each onboarding level allows.'),
  'catalogue.autonomy': t('Agent autonomy caps', 'How much agents may do at each level and tier.'),
  'catalogue.criteria': t('Readiness criteria', 'The criteria and floors a repo must meet.'),
  'gateway.limits': t('Model call ceiling', 'Most model calls one gateway process makes.'),
  'ops.health': t(
    'Health timers',
    'When health reads unknown, how often it is read, when it alerts.',
  ),
  'evals.gate': t('Evaluation gate', 'How a new agent version is compared with its baseline.'),
  'codehost.polls': t('GitHub poll intervals', 'How often the factory reads GitHub.'),
  'work.request': t('Request text limit', 'The longest request text accepted.'),
  'sandbox.probe': t('Test-run lease', 'How long the onboarding test run may hold its sandbox.'),
  'sandbox.profiles': t(
    'Limits per sandbox kind',
    'Lower the memory, CPU, time and output of each sandbox kind.',
  ),
  'planning.size_share': t(
    'Budget share per size',
    'The share of the coder budget each part size may spend.',
  ),
  'access.roles': t('Roles and permissions', 'The roles and what each may do.'),
};

/** The sections of Settings (screen-map §2.11) as the left list names them. */
const settingsSection: Readonly<Record<SettingsSection, Term>> = {
  general: t('General', 'Working days, who approves settings, sign-in, health and limits.'),
  tracks: t('Tracks', 'What each track runs, its limits and its budget.'),
  approvals: t('Approvals', 'Who decides each approval and its timers.'),
  onboarding: t('Onboarding', 'How a repo is onboarded and kept ready.'),
  factory_rules: t('Factory rules', 'The rules every design and change is checked against.'),
  sandboxes: t('Sandboxes', 'Sandbox limits, images and where agents may run code.'),
  retention: t('Retention', 'How long each kind of data is kept.'),
  agents: t('Agents', 'Agents on or off, their models, limits and the evaluation gate.'),
  integrations: t('Integrations', 'Outside services, models and notification channels.'),
  project_defaults: t('Project defaults', 'What every project has until it sets its own.'),
  access_policy: t('Access policy', 'The roles and the permission rules in force.'),
  other: t('Other settings', 'Settings with no section yet.'),
};

const SETTING_APPLIES_TIP = 'When a change to this setting takes effect.';
const settingsApplies: Readonly<Record<SettingApplies, Term>> = {
  now: t('Applies now', SETTING_APPLIES_TIP),
  new_items: t('New items only', SETTING_APPLIES_TIP),
  new_onboardings: t('New onboardings only', SETTING_APPLIES_TIP),
  next_start: t('At the next restart', SETTING_APPLIES_TIP),
};

const configLayer: Readonly<Record<ConfigLayerKind, Term>> = {
  factory: t('Factory-wide', 'Where a setting applies.'),
  project: t('This project', 'Where a setting applies.'),
};

const REVISION_TIP = 'Where a settings change stands.';
const configRevision: Readonly<Record<ConfigRevisionState, Term>> = {
  proposed: t('Waiting for approval', REVISION_TIP),
  current: t('In force', REVISION_TIP),
  // Not in glossary.md §18 yet (PROPOSED_TERMS).
  superseded: t('Replaced', REVISION_TIP),
  rolled_back: t('Rolled back', REVISION_TIP),
  rejected: t('Rejected', REVISION_TIP),
};

// ---------------------------------------------------------------- 19 Status words

export const STATUS_WORDS = [
  'unknown',
  'unreadable',
  'met',
  'not_met',
  'recorded',
  'not_evaluated',
  'na',
  'held',
  'parked',
  'blocked',
  'stale',
  'stale_index',
  'busy',
  'pending',
  'void',
  'refused',
  'error',
  'superseded',
  'expired',
  'sent_back',
  'not_requested',
] as const;
export type StatusWord = (typeof STATUS_WORDS)[number];

const status: Readonly<Record<StatusWord, Term>> = {
  unknown: t('Unknown', 'We could not tell; treated as not met.'),
  unreadable: t('Could not read', 'The factory could not read this; treated as not met.'),
  met: t('Met', 'Whether a requirement holds.'),
  not_met: t('Not met', 'Whether a requirement holds.'),
  recorded: t('Noted', 'Recorded; does not block at this level.'),
  not_evaluated: t('Not checked at this level', 'Not part of this level, or not relevant.'),
  na: t('Does not apply', 'Not part of this level, or not relevant.'),
  held: t('On hold', 'Paused; reason beside it.'),
  parked: t('Waiting for answers', 'Paused for missing answers.'),
  blocked: t('Blocked', 'Cannot go on until something is fixed.'),
  stale: t('Out of date', 'Older than allowed; refresh.'),
  stale_index: t('Search out of date', 'The repo index is behind; it rebuilds on the next scan.'),
  busy: t('Full', 'No free slot right now.'),
  pending: t('Waiting', 'Not decided or done yet.'),
  void: t('Did not count', 'A check result that is not a pass.'),
  refused: t('Refused', 'A check result that is not a pass.'),
  error: t('Failed to run', 'A check result that is not a pass.'),
  superseded: t('Replaced', 'A newer version took its place.'),
  expired: t('Expired', 'Ran out of time; never approves.'),
  sent_back: t('Changes requested', 'Sent back with requested changes.'),
  not_requested: t('Not asked for', 'This level was not requested.'),
};

// ---------------------------------------------------------------- 11, 16, 20 Concepts and core nouns

/** The factory's parts in plain words (§11, §16, §20): the words a screen uses for a concept. */
const concept = {
  factory: t('Factory', 'All projects and everything they share.'),
  project: t('Project', 'One onboarded repo and its settings, people and work.'),
  repo: t('Repo', 'A GitHub repository.'),
  work_item: t('Work item', 'One request and everything the factory does for it.'),
  item_key: t('Item number', "The item's short id, for example PAY-42."),
  floor: t('Floor', 'A live view of all work, by stage.'),
  fleet: t('All projects', 'The floor or list across every project.'),
  inbox: t('Inbox', 'Everything waiting on you.'),
  card: t('Decision card', 'One thing to decide, maybe several approvals together.'),
  closeout: t('Final record', 'What was done, checked and decided, kept for good.'),
  escape: t('Bug after merge', 'A problem found after the work closed.'),
  spot_check: t('Spot-check', 'A lightly reviewed merge picked for audit.'),
  catalogue: t(
    'Process version',
    'The version of the tracks and limits this item runs under.',
    'secondary',
  ),
  gate: t('Approval', 'A decision a person makes before the work moves on.'),
  lane: t('Track', 'The path this work follows: which steps run and which approvals it needs.'),
  level: t('Onboarding level', 'How much agents may do on this repo.'),
  unit: t('Part', 'One part of the plan, built on its own branch and PR.'),
  envelope: t('Budget', 'The most this work may spend on models, in money and tokens.'),
  coding_slot: t('Coding slot', 'The right to build one part now.'),
  push_broker: t(
    'Factory bot',
    'The only part of the factory that can push branches and open draft PRs.',
  ),
  oracle: t('Acceptance tests', 'Tests written from the spec that prove the change works.'),
  oracle_specs: t('Acceptance criteria', 'What the acceptance tests must prove.'),
  locked_tests: t('Locked tests', 'Tests agents may not change without approval.'),
  constitution: t(
    'Factory rules',
    'Rules every design and change must follow (for example, no unapproved network access).',
  ),
  evidence_pack: t('Evidence pack', 'The signed proof of every check for one exact commit.'),
  notary_signature: t(
    'Signed by the factory',
    "The factory's signature; anyone can check it offline.",
  ),
  gate_check: t(
    'Factory check',
    'The required GitHub check that passes only for signed, approved agent PRs.',
    'secondary',
  ),
  taint: t('Untrusted input', 'Text from outside; agents treat it as data, never instructions.'),
  intent_block: t('Agreed goal', 'The goal everyone agreed on, which later steps follow.'),
  artefact: t('Document', 'Something an agent wrote (spec, design, plan…).'),
  ledger: t('Decision log', 'The signed, append-only list of every decision.'),
  checkpoint: t('Log checkpoint', 'A signed snapshot that proves the log was not changed.'),
  record: t('History', 'Everything that happened, in order.'),
  prr: t(
    'Readiness scorecard',
    'What this repo is ready for, signed at onboarding and kept up to date.',
    'secondary',
  ),
  drift: t(
    'Changes since onboarding',
    'Something on GitHub changed since sign-off (protection, App, files).',
  ),
  gap: t('Gap', 'Something the repo is missing for the level asked.'),
  claims: t(
    'Repo facts',
    'Statements the agent makes about the repo; confirm, correct or mark unknown.',
  ),
  kill_switch: t('Emergency stop', 'Stops all agent work in a scope at once.'),
  kill_unreachable: t(
    'Agents stopped (cannot reach the stop switch)',
    'When the stop switch cannot be read, agents are treated as stopped.',
  ),
  sandbox: t('Sandbox', 'A locked-down container agents work in.'),
  gateway: t(
    'Model gateway',
    'The only service that holds model keys and talks to model providers.',
  ),
  notary: t('Signer', 'The service that signs evidence and decisions.'),
  witness: t('Log witness', 'The service that co-signs log checkpoints.'),
  spend: t('Spend', 'Money spent on models.'),
  integration: t('Integration', 'A connection to an outside service.'),
  secret_saved: t('Secret (saved)', 'A secret stored in the vault; never shown again.'),
  secret_field: t('Paste secret', 'Paste once; it is stored and never shown again.'),
  rotate: t('Replace secret', 'Paste a new secret; the old one stops working.'),
  test_connection: t('Test', 'Try the connection now with the saved secret.'),
  access_request: t('Access request', 'Ask for a role; an admin approves.'),
  role_assignment: t(
    'Role assignment',
    'A person or group given a role on a project, team or the factory.',
  ),
  // People, teams & roles (portal v2, People squad; PROPOSED_TERMS until glossary.md has them)
  person: t('Person', 'Someone who can sign in to the factory.'),
  team: t('Team', 'People who work together; a role given to a team reaches every member.'),
  role: t('Role', 'A named set of things a person may do, and where.'),
  role_scope_fleet: t('Whole factory', 'The role reaches every project.'),
  sign_in_sso: t('Company sign-in', 'Signs in through the company identity provider.'),
  sign_in_local: t('Local account', 'A break-glass account for factory admins.'),
  person_active: t('Active', 'Can sign in and act.'),
  person_suspended: t('Suspended', 'Cannot sign in or act until reactivated.'),
  deleted_person: t('Deleted person', 'Someone who was deleted; their decisions stay in the log.'),
  override: t(
    'Factory admin override',
    'The factory admin acted outside a normal rule; who, what and why are recorded.',
  ),
  override_reason: t('Reason for the override', 'Kept in the decision log with the act.'),
  deletion: t('Deletion', 'An object deleted for good; the log keeps only hashes.'),
  redacted: t('Hash only', 'The entry was deleted; only its hash stays so the log still verifies.'),
  delete: t('Delete', 'Remove the object and all its data for good; the log keeps hashes only.'),
  forbidden_403: t("You can't open this", 'Says why and who to ask.'),
  not_found_404: t('Not found', 'Shown the same whether it does not exist or you cannot see it.'),
} as const satisfies Readonly<Record<string, Term>>;

// ---------------------------------------------------------------- 11 Documents (portal v2 Work squad, proposed)

const DOC_TIP = 'A document an agent wrote for this work item.';
const document: Readonly<Record<ArtefactType, Term>> = {
  request: t('Request', 'The request as the factory keeps it, marked untrusted.'),
  intent_block: t('Agreed goal', 'The goal everyone agreed on, which later steps follow.'),
  context_brief: t('Context brief', 'What the agent learned about the code and the docs.'),
  decision_brief: t('Decision brief', 'The options the agent found and the one it suggests.'),
  spec_delta: t('Spec change', 'What will change in the spec.'),
  oracle_specs: t('Acceptance criteria', 'What the acceptance tests must prove.'),
  design: t('Design', DOC_TIP),
  plan: t('Task plan', 'The tasks of each part, in order.'),
  diff: t('Code change', 'The change to the code, file by file.'),
  evidence_pack: t('Evidence pack', 'The signed proof of every check for one exact commit.'),
  session_log: t('Session log', 'What the agent did in its sandbox, step by step.'),
  repo_snapshot: t('Repo snapshot', 'The repo as the agent read it.'),
  config_history: t('Settings history', 'Earlier versions of the settings.'),
  reverse_engineering: t('How it works now', 'What the agent worked out about the current code.'),
  impact: t('Impact', 'Who and what the change affects.'),
  initiative: t('Initiative outline', 'The goal and outline of a large initiative.'),
  affected_requirements: t('Affected requirements', 'The requirements the change touches.'),
  validation_report: t('Spec check report', 'Whether the spec change is complete and consistent.'),
  spec_review: t('Spec review', 'A second agent read the spec with fresh eyes.'),
  classification: t('Size and risk', 'How big and risky the agent judged the work.'),
  adr: t('Design decisions', 'The design decisions and why each was made.'),
  contracts: t('Interfaces', 'The interfaces and data shapes the change adds or changes.'),
  data_migration: t('Data and migration', 'How stored data changes and how it is moved.'),
  nfr_threat_ops: t('Risks and operations', 'Performance, security threats and how it is run.'),
  constitution_report: t('Factory rules check', 'Whether the design follows the factory rules.'),
  unit_split: t('Parts', 'How the work is split into parts.'),
  unit_sequence: t('Order of parts', 'The order the parts are built in.'),
  verification_binding: t('Checks per part', 'Which checks prove each part.'),
  budget_envelope: t('Budget', 'The most this work may spend on models, in money and tokens.'),
  capacity_input: t('Capacity', 'How much building time the plan needs.'),
  oracle_code: t('Acceptance tests', 'Tests written from the spec that prove the change works.'),
  patch: t('Patch', 'The exact change an approval is bound to.'),
  spike_report: t('Experiment report', 'What the experiment found.'),
};

/** The portal's screens as the navigation and breadcrumbs name them (screen-map.md). */
const screen = {
  home: t('Home', 'What needs you now, then what you are waiting for.'),
  inbox: t('Inbox', 'Every decision waiting on you, your team or the factory.'),
  items: t('Items', 'Find any work item.'),
  board: t('Board', 'Work items in columns by stage.'),
  floor: t('Floor', 'The live view of all work by stage.'),
  fleet: t('All projects', 'The floor or list across every project.'),
  projects: t('Projects', 'Every project you can see.'),
  onboard: t('Onboard a repo', 'Get a repo ready so agents can work on it safely.'),
  ask_for_work: t('Ask for work', 'Send a request to the factory.'),
  assistant: t('Ask the factory', 'Answers only from what you can see.'),
  operate: t(
    'Operate',
    'Run the factory: stop it, pause it, see capacity, sandboxes, health and spend.',
  ),
  emergency_stop: t('Emergency stop', 'Stops all agent work in a scope at once.'),
  controls: t('Pauses and notices', 'Pause, limit, halt or post a notice for a scope.'),
  scheduler: t('Queue and capacity', 'What is waiting to build and why.'),
  sandboxes: t('Sandboxes', 'Running sandboxes by kind and their limits.'),
  health: t('Health', 'Services and background jobs and their state.'),
  budgets: t('Budgets', 'Budgets and how much of each is spent.'),
  spend: t('Spend', 'Money spent on models, by project and item.'),
  agents: t('Agents', 'Every agent: on or off, its model, limits and quality.'),
  evals: t('Evaluations', 'Test sets that measure each agent.'),
  models: t('Models and prices', 'The models and their limits and prices.'),
  settings: t('Settings', 'Everything configurable for the factory.'),
  catalogue: t('Tracks and limits', 'Which steps and approvals each track has.'),
  integrations: t('Integrations', 'The outside services the factory uses.'),
  people_roles: t('People, teams & roles', 'Who is in the factory and what each person may do.'),
  people: t('People', 'Everyone who can sign in.'),
  teams: t('Teams', 'People who work together.'),
  roles: t('Roles', 'What each role may do.'),
  access_requests: t('Access requests', 'Requests for a role, and their answers.'),
  who_can: t('Who can do what', 'Who can decide each approval.'),
  audit_log: t('Decision log & audit', 'The signed record of every decision.'),
  decision_log: t('Decision log', 'The signed, append-only list of every decision.'),
  access_decisions: t('Access decisions', 'Sampled permission decisions, exports and holds.'),
  my_access: t('My access', 'What you can do and why.'),
  my_notifications: t('My notifications', 'What the factory told you.'),
  my_profile: t('My profile', 'Who you are in the factory: name, sign-in, teams and roles.'),
  design: t('Design system', 'Every component of the portal in both themes, for review.'),
} as const satisfies Readonly<Record<string, Term>>;

/** The groups of the left navigation (screen-map §1.2). */
const navGroup = {
  work: t('Work', 'Your work: what needs you, the items and the floor.'),
  projects: t('Projects', 'The onboarded repos and onboarding a new one.'),
  run: t('Run', 'Running the factory: stops, pauses, capacity and agents.'),
  govern: t('Govern', 'Settings, integrations, people and the decision log.'),
} as const satisfies Readonly<Record<string, Term>>;

// ---------------------------------------------------------------- the record

export const GLOSSARY = {
  stage,
  step,
  gate,
  gateFamily,
  toggleGroup,
  decision,
  decideWord,
  gateStatus,
  cardStatus,
  feasibility,
  inboxReason,
  lane,
  relane,
  level,
  tier,
  autonomy,
  reviewMode,
  card,
  claimVerdict,
  gapDisposition,
  gapStatus,
  posture,
  blocker,
  control,
  lightFloor,
  onboarding,
  readiness,
  pillar,
  driftEffect,
  servedFile,
  examGrade,
  seedStatus,
  phase,
  wait,
  room,
  floorStatus,
  floorMove,
  backEdge,
  handoff,
  trigger,
  e4Choice,
  hold,
  unitState,
  unitSize,
  verifyCheck,
  verdict,
  repairClass,
  role,
  roleSlot,
  principalKind,
  action,
  viewLevel,
  dataClass,
  agent,
  sessionState,
  evalCaseKind,
  killState,
  killScope,
  controlKind,
  controlState,
  bannerSeverity,
  sandboxClass,
  health,
  integrationKind,
  integrationAdapter,
  integrationStatus,
  notificationKind,
  notificationReason,
  configKey,
  settingsSection,
  settingsApplies,
  configLayer,
  configRevision,
  status,
  concept,
  document,
  screen,
  navGroup,
} as const;

export type Glossary = typeof GLOSSARY;
export type GlossaryFamily = keyof Glossary;
export type GlossaryValue<F extends GlossaryFamily> = keyof Glossary[F] & string;

/** Terms whose words glossary.md does not have yet: built from its words, waiting for the owner. */
export const PROPOSED_TERMS: ReadonlyArray<readonly [GlossaryFamily, string]> = [
  ['notificationKind', 'questions_waiting'],
  ['notificationKind', 'ready_waiting'],
  ['notificationKind', 'acceptance_waiting'],
  ['notificationKind', 'item_parked'],
  ['notificationKind', 'item_done'],
  ['notificationKind', 'item_ended'],
  ['notificationKind', 'control_halt'],
  ['notificationKind', 'breaker_tripped'],
  ['notificationKind', 'drift_suspended'],
  ['notificationKind', 'release_failed'],
  ['notificationKind', 'factory_alert'],
  ['notificationReason', 'requester'],
  ['configRevision', 'superseded'],
  ['configRevision', 'rolled_back'],
  ['configRevision', 'rejected'],
  ['screen', 'board'],
  ['screen', 'budgets'],
  ['screen', 'design'],
  ['action', 'project.delete'],
  ['action', 'repo.delete'],
  ['action', 'item.delete'],
  ['action', 'person.delete'],
  ['action', 'team.delete'],
  ['action', 'binding.delete'],
  ['configKey', 'catalogue.lanes'],
  ['configKey', 'catalogue.back_edge_limits'],
  ['configKey', 'catalogue.rework_budget'],
  ['configKey', 'catalogue.envelope_extension'],
  ['configKey', 'catalogue.flow_limits'],
  ['configKey', 'catalogue.triggers'],
  ['configKey', 'catalogue.gating'],
  ['configKey', 'catalogue.eligibility'],
  ['configKey', 'catalogue.autonomy'],
  ['configKey', 'catalogue.criteria'],
  ['configKey', 'gateway.limits'],
  ['configKey', 'ops.health'],
  ['configKey', 'evals.gate'],
  ['configKey', 'codehost.polls'],
  ['configKey', 'work.request'],
  ['configKey', 'sandbox.probe'],
  ['configKey', 'sandbox.profiles'],
  ['configKey', 'planning.size_share'],
  ['configKey', 'access.roles'],
  ['settingsSection', 'general'],
  ['settingsSection', 'tracks'],
  ['settingsSection', 'approvals'],
  ['settingsSection', 'onboarding'],
  ['settingsSection', 'factory_rules'],
  ['settingsSection', 'sandboxes'],
  ['settingsSection', 'retention'],
  ['settingsSection', 'agents'],
  ['settingsSection', 'integrations'],
  ['settingsSection', 'project_defaults'],
  ['settingsSection', 'access_policy'],
  ['settingsSection', 'other'],
  ['settingsApplies', 'now'],
  ['settingsApplies', 'new_items'],
  ['settingsApplies', 'new_onboardings'],
  ['settingsApplies', 'next_start'],
  ['document', 'request'],
  ['document', 'intent_block'],
  ['document', 'context_brief'],
  ['document', 'decision_brief'],
  ['document', 'spec_delta'],
  ['document', 'oracle_specs'],
  ['document', 'design'],
  ['document', 'plan'],
  ['document', 'diff'],
  ['document', 'evidence_pack'],
  ['document', 'session_log'],
  ['document', 'repo_snapshot'],
  ['document', 'config_history'],
  ['document', 'reverse_engineering'],
  ['document', 'impact'],
  ['document', 'initiative'],
  ['document', 'affected_requirements'],
  ['document', 'validation_report'],
  ['document', 'spec_review'],
  ['document', 'classification'],
  ['document', 'adr'],
  ['document', 'contracts'],
  ['document', 'data_migration'],
  ['document', 'nfr_threat_ops'],
  ['document', 'constitution_report'],
  ['document', 'unit_split'],
  ['document', 'unit_sequence'],
  ['document', 'verification_binding'],
  ['document', 'budget_envelope'],
  ['document', 'capacity_input'],
  ['document', 'oracle_code'],
  ['document', 'patch'],
  ['document', 'spike_report'],
  ['concept', 'person'],
  ['concept', 'team'],
  ['concept', 'role'],
  ['concept', 'role_scope_fleet'],
  ['concept', 'sign_in_sso'],
  ['concept', 'sign_in_local'],
  ['concept', 'person_active'],
  ['concept', 'person_suspended'],
  ['concept', 'deleted_person'],
  ['concept', 'override'],
  ['concept', 'override_reason'],
  ['concept', 'deletion'],
  ['concept', 'redacted'],
  ['screen', 'my_profile'],
];

/** The term of a value. Typed: a value the family does not have does not compile. */
export function term<F extends GlossaryFamily>(family: F, value: GlossaryValue<F>): Term {
  return (GLOSSARY[family] as Readonly<Record<string, Term>>)[value] as Term;
}

/** What the screen shows for a value. */
export function label<F extends GlossaryFamily>(family: F, value: GlossaryValue<F>): string {
  return term(family, value).label;
}

/** The tooltip of a value: one sentence. */
export function explain<F extends GlossaryFamily>(family: F, value: GlossaryValue<F>): string {
  return term(family, value).explain;
}

/**
 * The term of a value read off the wire (a string the compiler cannot check). `null` for a value the
 * family does not have: the caller shows "Unknown", never the raw code.
 */
export function lookupTerm(family: GlossaryFamily, value: string): Term | null {
  const fam = GLOSSARY[family] as Readonly<Record<string, Term>>;
  return Object.prototype.hasOwnProperty.call(fam, value) ? (fam[value] as Term) : null;
}

/** Whether the code may show on a screen for `audience` ('secondary': the named screens; 'audit': audit only). */
export function codeShows(t: Term, audience: 'screen' | 'audit'): boolean {
  if (t.code === 'secondary') return true;
  if (t.code === 'audit') return audience === 'audit';
  return false;
}
