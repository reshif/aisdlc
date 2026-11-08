import {
  type ControlsReport,
  type Gap,
  type Level,
  type PrincipalId,
  type Tier,
} from '@aisdlc/contracts';
import { buildControlsReport, buildPrr, type PrrBuildError, type PrrInputs } from '../src/index.js';
import { cardHost, censusFixture } from './cards-fixtures.js';

// Inputs of the PRR builder for the tests: the golden clean census, a controls report read from a
// fake code host with protect-main in force (or not), card 1 and card 4 decisions as a person would
// give them.

export const REPO = 'acme/prr-unit';
export const NOW = new Date('2026-11-09T10:00:00.000Z');
export const alice = 'alice' as PrincipalId;

export let good: ControlsReport;
export let unprotected: ControlsReport;
/** Reads the two controls reports; call once, in a `beforeAll`. */
export async function loadReports(): Promise<void> {
  good = await buildControlsReport({ source: cardHost(REPO) }, REPO, { reduced: true });
  unprotected = await buildControlsReport({ source: cardHost(REPO, { rules: 'none' }) }, REPO, {
    reduced: true,
  });
}

export const GATING_ON = {
  gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
  schedule: 'auto',
  tier_floor_applied: true,
} as const;

export function inputs(
  o: {
    tier?: Tier;
    level?: Level;
    requested?: Level;
    census?: Parameters<typeof censusFixture>[1];
    report?: ControlsReport;
    gating?: PrrInputs['c4']['gating_profile'];
    gaps?: (g: Gap[]) => Gap[];
    over?: Partial<PrrInputs>;
  } = {},
): PrrInputs {
  const tier = o.tier ?? 'T0';
  const census = censusFixture(REPO, o.census).census;
  const gaps = o.gaps ? o.gaps(census.gaps) : census.gaps;
  const c = { ...census, gaps } as typeof census;
  const t2 = tier === 'T2';
  return {
    project_id: 'prr-unit',
    now: NOW,
    version: 1,
    supersedes: null,
    census: c,
    s0: {
      requested_level: o.requested ?? o.level ?? 'census',
      signable_level: o.level ?? 'census',
      step_0_2: (o.level ?? 'census') === 'census' ? 'skip' : 'done',
      step_0_3: (o.level ?? 'census') === 'full' ? 'done' : 'skip',
      catalogue_ref: census.pins.catalogue,
    },
    attested_floor: null,
    deploys: false,
    c1: {
      owners: [alice],
      tier,
      floor: tier,
      t0_attested: tier === 'T0',
      regulatory_attested: true,
      criticality_attested: true,
      gap_rows: gaps.map((g) => ({
        kind: 'gap_disposition' as const,
        gap_id: g.gap_id,
        criterion: g.criterion,
        disposition: 'track_only' as const,
      })),
      decided_by: alice,
      decided_at: new Date('2026-11-09T09:00:00.000Z'),
    },
    c4: {
      report: o.report ?? good,
      attestation: {
        bypass_has_no_factory_app: true,
        app_scope_selected: true,
        github_token_readonly: true,
        actions_cannot_approve_prs: true,
        fork_pr_approval_required: true,
        secret_scanning: 'on',
      },
      role_map: Object.fromEntries(
        ['admin', 'requesters', 'intent', 'design', 'g4', 'g5', 'x', 'sec', 'm4', 'kill'].map(
          (k) => [
            k,
            k === 'g4'
              ? { kind: 'codeowners' }
              : { kind: 'principals', principals: t2 ? [alice, 'bob'] : [alice] },
          ],
        ),
      ) as never,
      two_person: { enabled: true, default: 'on_if_2plus', locked_on: t2 },
      gating_profile: o.gating ?? GATING_ON,
      kill_delegations: [],
      read_at: '2026-11-09T09:30:00.000Z',
      collaborators_read: 'ok',
      decided_by: alice,
      decided_at: new Date('2026-11-09T09:30:00.000Z'),
    },
    security: census.security_summary,
    signer: {
      principal: alice,
      role: 'TL',
      mode: 'solo',
      sod_waiver: !t2,
    },
    ...o.over,
  } as PrrInputs;
}

export const built = (i: PrrInputs) => {
  const r = buildPrr(i);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
export const refused = (i: PrrInputs): PrrBuildError => {
  const r = buildPrr(i);
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
};
