import {
  MAX_WAIVER_DAYS,
  PROJECT_CONFIG_KEYS,
  levelRank,
  type CensusRecord,
  type ControlsReport,
  type Gap,
  type PrincipalId,
  type ProjectSettingsWire,
  type RoleSlot,
  type Tier,
} from '@aisdlc/contracts';
import { hashCanonical, err, ok, type Result } from '@aisdlc/kernel';
import type { RemoteError } from '../clients.js';
import { DEFAULT_S0_SETTINGS, type S0Settings } from '../driver.js';
import { coreError, type CoreError } from '../errors.js';
import { getProjectState } from '../queries.js';
import { loadProjectSettings } from '../settings.js';
import { allowedDispositions, defaultDisposition, isPrivateOnly } from './gaps.js';
import { buildControlsReport } from './controls.js';
import type { CardDeps } from './model.js';
import { approvedPayload, type LoadedS0, type OnboardingCard } from './read.js';
import { proposeRoleMap, type RoleProposal } from './roles.js';

// What each card shows (OB §1A, §6.2) and the contexts a decision is validated against. The view of
// a card is a pure function of its context and carries no clock, so its hash is the evidence a
// person is bound to when they decide: if the context changes (a re-check, a new census), the hash
// changes and the decision on the old page is refused.

export const settingsOf = (deps: CardDeps): S0Settings =>
  (deps.settings ?? (() => DEFAULT_S0_SETTINGS))();

const TIER_RANK: Readonly<Record<Tier, number>> = { T0: 0, T1: 1, T2: 2 };
export const maxTier = (a: Tier, b: Tier | null | undefined): Tier =>
  b !== null && b !== undefined && TIER_RANK[b] > TIER_RANK[a] ? b : a;
export const tierBelow = (a: Tier, floor: Tier): boolean => TIER_RANK[a] < TIER_RANK[floor];

const remote = (e: RemoteError, what: string): CoreError =>
  coreError('unavailable', `${what}: ${e.message}`);

/** The evidence hash of a view: what a person is shown, bound into the nonce they decide with. */
export const evidenceHashOf = (view: object): string => hashCanonical(view);

// ---------------------------------------------------------------- who decides

export interface Deciders {
  readonly slot: RoleSlot;
  readonly holders: readonly PrincipalId[];
  /** One person holds the slot: they decide alone and the entry is stamped `sod_waiver`. */
  readonly single_operator: boolean;
  readonly sod_waiver: boolean;
  readonly tier: Tier | null;
  /** T2 allows no waiver: a sole holder cannot decide. */
  readonly t2: boolean;
  readonly can_decide: boolean;
  readonly error: string | null;
}

/** From the project's role map via the eligibility port (the real one reads identity's bindings). */
export async function decidersOf(
  deps: CardDeps,
  project: string,
  slot: RoleSlot,
): Promise<Deciders> {
  const e = deps.decisions.eligibility;
  const h = await e.holders(project as never, slot);
  const p = await e.policy(project as never);
  if (!h.ok || !p.ok) {
    return {
      slot,
      holders: [],
      single_operator: false,
      sod_waiver: false,
      tier: null,
      t2: false,
      can_decide: false,
      error: (!h.ok ? h.error.message : !p.ok ? p.error.message : '') || 'eligibility unavailable',
    };
  }
  const holders = [...new Set(h.value)].sort();
  const t2 = p.value.tier === 'T2' || p.value.two_person.locked_on;
  const single = holders.length === 1;
  return {
    slot,
    holders,
    single_operator: single,
    sod_waiver: single && !t2,
    tier: p.value.tier,
    t2,
    can_decide: holders.length > 0 && !(single && t2),
    error: null,
  };
}

// ---------------------------------------------------------------- card 1

export interface C1Ctx {
  readonly census: CensusRecord;
  readonly gaps: readonly Gap[];
  /** The raise-only floor: the detectors' floor and what the request attested. */
  readonly floor: Tier;
  readonly project_floor: Tier | null;
  readonly t0_required: boolean;
}

export async function c1Context(
  deps: CardDeps,
  loaded: LoadedS0,
): Promise<Result<C1Ctx, CoreError>> {
  const { s0 } = loaded;
  if (!s0.census) return err(coreError('conflict', 'the census is not ready'));
  const latest = await deps.knowledge.census(s0.repo);
  if (!latest.ok) return err(remote(latest.error, 'knowledge'));
  if (latest.value === null) return err(coreError('not_found', 'knowledge has no census'));
  if (latest.value.census_hash !== s0.census.census_hash) {
    return err(
      coreError('conflict', 'the census moved on since this card was raised; the card is stale'),
    );
  }
  const project = await getProjectState(deps.pool, s0.record.project_id);
  const attested = project?.attestations.tier_floor ?? null;
  const census = latest.value.census;
  return ok({
    census,
    gaps: census.gaps,
    floor: maxTier(census.risk_category.tier_floor, attested),
    project_floor: attested,
    t0_required: settingsOf(deps).t0AttestationRequired,
  });
}

export function c1View(c: C1Ctx, s0: LoadedS0['s0']): Record<string, unknown> {
  const census = c.census;
  const count = (f: (g: Gap) => boolean) => c.gaps.filter(f).length;
  return {
    card: 'C1',
    repo: s0.repo,
    requested_level: s0.record.requested_level,
    signable_level: s0.record.signable_level,
    census: {
      census_id: census.census_id,
      census_hash: census.census_hash,
      baseline_sha: census.baseline_sha,
      refs_covered: census.refs_covered,
    },
    tier: {
      floor: c.floor,
      detector_floor: census.risk_category.tier_floor,
      project_attested_floor: c.project_floor,
      floor_basis: census.risk_category.floor_basis,
      signals: census.risk_category.signals.map((s) => ({
        signal: s.signal,
        criterion: s.criterion,
        floor: s.floor,
        raised_by: s.raised_by,
        evidence: s.evidence,
      })),
      regulatory: census.risk_category.regulatory,
      criticality: census.risk_category.criticality,
      t0: census.risk_category.t0,
      blocks_m4_reasons: census.risk_category.blocks_m4_reasons,
      raise_only: true,
    },
    t0_attestation: {
      required: c.t0_required,
      text: 'no prod, no real data, no dependants',
    },
    posture: {
      state: census.posture.state,
      reasons: census.posture.reasons.map((r) =>
        r.kind === 'blocker'
          ? { kind: r.kind, blocker: r.blocker, status: r.status, codes: r.codes }
          : { kind: r.kind, code: r.code, count: r.count },
      ),
    },
    blockers: census.blockers.map((b) => ({
      id: b.id,
      status: b.status,
      reasons: b.reasons,
      notes: b.notes,
    })),
    // Counts only: never a value, a fingerprint or a path.
    security: census.security_summary.history_scan,
    gap_counts: {
      total: c.gaps.length,
      blocking: count((g) => g.severity === 'blocking'),
      tracked: count((g) => g.severity === 'tracked'),
      private_only: count(isPrivateOnly),
    },
    gaps: c.gaps.map((g) => ({
      gap_id: g.gap_id,
      criterion: g.criterion,
      severity: g.severity,
      blocks_level: g.blocks_level,
      visibility_class: g.visibility_class,
      default_disposition: defaultDisposition(g),
      allowed_dispositions: allowedDispositions(g),
    })),
    max_waiver_days: MAX_WAIVER_DAYS,
    owner_suggestions: [],
  };
}

// ---------------------------------------------------------------- card 4

export interface C4Ctx {
  readonly report: ControlsReport;
  readonly proposal: RoleProposal;
  /** The tier the person signed on card 1 (or the floor, if card 1 left none): decides the T2 floor. */
  readonly tier: Tier;
  readonly current: ProjectSettingsWire | null;
  readonly level_needs_operations: boolean;
  readonly deploys: boolean | null;
}

export async function c4Context(
  deps: CardDeps,
  loaded: LoadedS0,
  cards: readonly OnboardingCard[],
  requestedBy: PrincipalId,
  reduced: boolean,
): Promise<Result<C4Ctx, CoreError>> {
  const { s0 } = loaded;
  const [report, proposal] = await Promise.all([
    buildControlsReport(deps, s0.repo, { reduced }),
    proposeRoleMap(deps, s0.repo, requestedBy),
  ]);
  const project = await getProjectState(deps.pool, s0.record.project_id);
  const c1 = approvedPayload(cards, 'C1');
  const signed = c1?.payload.find((p) => p.kind === 'tier_decision');
  const tier: Tier =
    signed?.kind === 'tier_decision' ? signed.tier : (project?.attestations.tier_floor ?? 'T0');
  const cur = await loadProjectSettings(deps.pool, deps.registry, s0.record.project_id);
  return ok({
    report,
    proposal,
    tier: maxTier(tier, project?.attestations.tier_floor),
    current: cur.ok ? cur.value : null,
    level_needs_operations: levelRank(s0.record.signable_level) >= levelRank('light'),
    deploys: project?.project.deploys ?? null,
  });
}

export function c4View(c: C4Ctx): Record<string, unknown> {
  const r = c.report;
  return {
    card: 'C4',
    reduced: r.reduced,
    controls_report: r,
    // What the person does on GitHub; the factory fixes nothing, and the re-check reads it again.
    instructions: r.controls
      .filter((x) => x.blocking && x.status !== 'met' && x.instruction !== null)
      .map((x) => ({ control: x.id, status: x.status, text: x.instruction })),
    can_decide: r.blocking_open.length === 0,
    recheck: { action: 'recheck' },
    attestations: {
      required: [
        'bypass_has_no_factory_app',
        'app_scope_selected',
        'github_token_readonly',
        'actions_cannot_approve_prs',
        'fork_pr_approval_required',
        'secret_scanning',
        ...(c.level_needs_operations ? ['operations_md'] : []),
      ],
      secret_scanning_values: ['on', 'plan_unavailable'],
    },
    tier: c.tier,
    role_map: {
      proposed: c.proposal.role_map,
      basis: c.proposal.basis,
      current: c.current ? c.current.settings.role_map : null,
    },
    two_person: {
      locked_on: c.tier === 'T2',
      current: c.current ? c.current.settings.two_person : null,
      default: { enabled: true, default: 'on_if_2plus', locked_on: c.tier === 'T2' },
    },
    gating_profile: {
      current: c.current ? c.current.settings.gating_profile : null,
      t2_floor_applies: c.tier === 'T2',
      project_deploys: c.deploys,
    },
    kill_delegations: { current: c.current ? c.current.settings.kill_delegations : [] },
    settings_keys: PROJECT_CONFIG_KEYS,
  };
}

// ---------------------------------------------------------------- card 5

export interface C5Ctx {
  readonly package: { census_hash: string; gap_ledger_hash: string; controls_report_hash: string };
  readonly owners: readonly string[];
  readonly tier: Tier;
}

export function c5Context(
  loaded: LoadedS0,
  cards: readonly OnboardingCard[],
): Result<C5Ctx, CoreError> {
  const c1 = approvedPayload(cards, 'C1');
  const c4 = approvedPayload(cards, 'C4');
  if (!c1 || !c4) {
    return err(coreError('conflict', 'cards 1 and 4 are decided before the sign-off'));
  }
  const ledger = c1.payload.find((p) => p.kind === 'gap_ledger');
  const report = c4.payload.find((p) => p.kind === 'controls_report');
  const tier = c1.payload.find((p) => p.kind === 'tier_decision');
  const owners = c1.payload.find((p) => p.kind === 'owner_confirmation');
  if (
    ledger?.kind !== 'gap_ledger' ||
    report?.kind !== 'controls_report' ||
    tier?.kind !== 'tier_decision' ||
    owners?.kind !== 'owner_confirmation'
  ) {
    return err(coreError('conflict', 'the decided cards do not carry what the sign-off needs'));
  }
  const census = loaded.s0.census;
  if (!census || census.census_hash !== ledger.census_hash) {
    return err(coreError('conflict', 'the census moved on since card 1 was decided'));
  }
  return ok({
    package: {
      census_hash: ledger.census_hash,
      gap_ledger_hash: ledger.gap_ledger_hash,
      controls_report_hash: report.report_hash,
    },
    owners: owners.owners,
    tier: tier.tier,
  });
}

export function c5View(c: C5Ctx, s0: LoadedS0['s0']): Record<string, unknown> {
  return {
    card: 'C5',
    repo: s0.repo,
    requested_level: s0.record.requested_level,
    signable_level: s0.record.signable_level,
    owners: c.owners,
    tier: c.tier,
    m4_package: c.package,
    // M4 itself is the next decision (M7.5); this card is the sign-off of step 0.5.
    next: 'm4',
  };
}

// ---------------------------------------------------------------- the security card

export async function secrView(
  deps: CardDeps,
  s0: LoadedS0['s0'],
  card: OnboardingCard,
  siblings: readonly OnboardingCard[],
): Promise<Result<Record<string, unknown>, CoreError>> {
  const sum = await deps.knowledge.securitySummary(s0.repo);
  if (!sum.ok) return err(remote(sum.error, 'knowledge'));
  const same = siblings
    .filter((c) => c.kind === 'SECR' && c.occurrence === card.occurrence)
    .sort((a, b) => (a.card_id < b.card_id ? -1 : 1));
  return ok({
    card: 'SECR',
    repo: s0.repo,
    // Counts only: the value, the fingerprint and the path stay in the Security store.
    ordinal: same.findIndex((c) => c.card_id === card.card_id) + 1,
    of: same.length,
    counts: sum.value.finding_counts,
    states: ['rotated', 'false_positive', 'accepted_test_fixture'],
    guidance:
      'Rotate the credential first, then mark the finding rotated. A history rewrite is optional and never enough. Until every finding is decided, this onboarding can sign Census only.',
  });
}
