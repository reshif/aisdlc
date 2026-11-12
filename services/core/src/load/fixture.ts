import {
  CensusRecord,
  censusHash,
  type ControlsReport,
  type Gap,
  type PrincipalId,
  type PrrGatingProfile,
} from '@aisdlc/contracts';
import { FakeGitHub, emptySeed } from '@aisdlc/ports';
import { buildControlsReport } from '../cards/controls.js';
import { buildPrr, type PrrInputs } from '../prr.js';
import golden from './census-golden.json' with { type: 'json' };

// The load test's projects (PLAN M19, `aisdlc-load`; FACTORY_ENV=local only). Each has an ACTIVE Project Readiness
// Record written straight into its PRR stream: the census is the knowledge service's golden census `a` retargeted at
// the load repo and re-sealed (the copy here is checked against the golden file by a test), the controls report is
// read from a deterministic fake code host with protect-main in force, and cards 1 and 4 are decided as a person
// would. This is what the work lifecycle tests do (`test/work-fixtures.ts`); the onboarding that makes a PRR in
// production (S0, cards 1 to 5, M4) is not what the load test measures. Everything after the PRR runs for real:
// the project's settings go through their M1 gate, identity binds the role map, the work engine runs every item.

const SHA = 'c'.repeat(40);

/** The golden census `a`, retargeted at `repo` and re-sealed. */
export function loadCensus(repo: string): CensusRecord {
  const text = JSON.stringify(golden)
    .replaceAll('acme.app', repo.toLowerCase().replace('/', '.'))
    .replaceAll('acme/app', repo);
  const body = JSON.parse(text) as Record<string, unknown> & { gaps: Gap[] };
  return CensusRecord.parse({ ...body, census_hash: censusHash(body) });
}

/** A fake code host where `repo` has protect-main in force (a PR rule, the gate check pinned, no force push). */
function host(repo: string): FakeGitHub {
  const rule = (type: string, parameters?: Record<string, unknown>) => ({
    type,
    ruleset_source_type: 'Repository',
    ruleset_source: repo,
    ruleset_id: 1,
    ...(parameters ? { parameters } : {}),
  });
  return new FakeGitHub(
    emptySeed({
      installation: {
        installation_id: 4242,
        account_login: repo.split('/')[0] as string,
        repository_selection: 'selected',
        permissions: { contents: 'read', metadata: 'read' },
        suspended: false,
      },
      repos: [
        {
          full_name: repo,
          default_branch: 'main',
          private: true,
          archived: false,
          owner_type: 'org',
        },
      ],
      heads: [{ repo, branch: 'main', sha: SHA }],
      files: [{ repo, sha: SHA, path: 'AGENTS.md', content: '# agents\n' }],
      rules: [
        {
          repo,
          branch: 'main',
          rules: [
            rule('pull_request', {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: false,
              require_code_owner_review: false,
              require_last_push_approval: true,
              required_review_thread_resolution: false,
            }),
            rule('required_status_checks', {
              strict_required_status_checks_policy: false,
              required_status_checks: [{ context: 'gate-check', integration_id: 99 }],
            }),
            rule('non_fast_forward'),
            rule('deletion'),
          ] as never,
        },
      ],
    }),
  );
}

export async function loadControls(repo: string): Promise<ControlsReport> {
  return buildControlsReport({ source: host(repo) }, repo, { reduced: false });
}

/** The PRR inputs of a load project: level `full`, tier T1, `admin` deciding cards 1 and 4, the gating profile given. */
export function loadPrrInputs(o: {
  project: string;
  repo: string;
  now: Date;
  admin: PrincipalId;
  gating: PrrGatingProfile;
  report: ControlsReport;
}): PrrInputs {
  const census = loadCensus(o.repo);
  const { project_deploys, ...profile } = o.gating;
  return {
    project_id: o.project,
    now: o.now,
    version: 1,
    supersedes: null,
    census,
    s0: {
      requested_level: 'full',
      signable_level: 'full',
      step_0_2: 'done',
      step_0_3: 'done',
      catalogue_ref: census.pins.catalogue,
    },
    attested_floor: null,
    deploys: project_deploys,
    c1: {
      owners: [o.admin],
      tier: 'T1',
      floor: 'T1',
      t0_attested: false,
      regulatory_attested: true,
      criticality_attested: true,
      gap_rows: census.gaps.map((g) => ({
        kind: 'gap_disposition' as const,
        gap_id: g.gap_id,
        criterion: g.criterion,
        disposition: 'track_only' as const,
      })),
      decided_by: o.admin,
      decided_at: o.now,
    },
    c4: {
      report: o.report,
      attestation: {
        bypass_has_no_factory_app: true,
        app_scope_selected: true,
        github_token_readonly: true,
        actions_cannot_approve_prs: true,
        fork_pr_approval_required: true,
        secret_scanning: 'on',
        plan: 'free',
      },
      role_map: Object.fromEntries(
        ['admin', 'requesters', 'intent', 'design', 'g4', 'g5', 'x', 'sec', 'm4', 'kill'].map(
          (k) => [k, { kind: 'principals', principals: [o.admin] }],
        ),
      ) as never,
      two_person: { enabled: false, default: 'on_if_2plus', locked_on: false },
      gating_profile: { ...profile, project_deploys } as never,
      kill_delegations: [],
      read_at: o.now.toISOString(),
      collaborators_read: 'ok',
      decided_by: o.admin,
      decided_at: o.now,
    },
    security: census.security_summary,
    signer: { principal: o.admin, role: 'EM', mode: 'solo', sod_waiver: true },
  } as PrrInputs;
}

export function loadPrr(i: PrrInputs) {
  const r = buildPrr(i);
  if (!r.ok) throw new Error(`the load PRR: ${r.error.code}: ${r.error.message}`);
  return r.value;
}
