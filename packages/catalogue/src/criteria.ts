import type {
  Criterion,
  CriterionClass,
  CriterionEscalation,
  CriterionPillar,
  FloorDef,
  FloorId,
} from '@aisdlc/contracts';
import type { CriteriaCatalogue } from './schema.js';

// CRITERIA_V2 (OB §3.3, every row) and the safety floors CF1-CF4, LF1-LF8, FF1-FF2 (OB §3.2).
// Class letters: F FLOOR, S SCORED, R RECORDED, A ADVISORY, - not applicable ("—").

type C = 'F' | 'S' | 'R' | 'A' | '-';
const CLASS: Record<Exclude<C, '-'>, CriterionClass> = {
  F: 'FLOOR',
  S: 'SCORED',
  R: 'RECORDED',
  A: 'ADVISORY',
};
const cls = (c: C): CriterionClass | null => (c === '-' ? null : CLASS[c]);

const TEAM: CriterionEscalation = { when: 'team', class: 'FLOOR' };
const TEAM_PUBLIC: CriterionEscalation = { when: 'team_and_public', class: 'FLOOR' };

type Opts = {
  floors?: FloorId[];
  escalations?: CriterionEscalation[];
  note?: string;
};

const row = (
  id: string,
  pillar: CriterionPillar,
  title: string,
  census: C,
  light: C,
  full: C,
  opts: Opts = {},
): Criterion => ({
  id,
  pillar,
  title,
  class_by_level: { census: cls(census), light: cls(light), full: cls(full) },
  floors: opts.floors ?? [],
  escalations: opts.escalations ?? [],
  note: opts.note ?? null,
});

export const CRITERIA_LIST: readonly Criterion[] = [
  row(
    'RS-ID-1',
    'ID',
    'App installation scoped to the repo; repo reachable; default branch known',
    'F',
    'F',
    'F',
    { floors: ['CF1'] },
  ),
  row('RS-ID-2', 'ID', 'Owner confirmed', 'F', 'F', 'F', { floors: ['CF2'] }),
  row('RS-ID-3', 'ID', 'Tier signed, raise-only', 'F', 'F', 'F', { floors: ['CF3'] }),
  row('RS-ID-4', 'ID', 'Visibility, owner type and plan recorded', 'F', 'F', 'F', {
    floors: ['CF4'],
  }),

  row(
    'RS-AI-1',
    'AI',
    'Root AGENTS.md ≤150 lines; the whole chain ≤32 KiB (Codex cut-off)',
    'R',
    'S',
    'S',
  ),
  row('RS-AI-2', 'AI', 'Template sections present', '-', 'S', 'S'),
  row('RS-AI-3', 'AI', 'Content lint clean (L-rules)', 'R', 'F', 'F', { floors: ['LF5'] }),
  row('RS-AI-4', 'AI', 'Text affirmed by a human', '-', 'F', 'F', { floors: ['LF5'] }),
  row(
    'RS-AI-5',
    'AI',
    'One source: CLAUDE.md = @AGENTS.md stub, other harness files absent or stubs',
    'R',
    'S',
    'S',
  ),
  row('RS-AI-6', 'AI', 'Nested AGENTS.md only at subproject roots, ≤60 lines', 'R', 'S', 'S', {
    note: 'if present; an unaffirmed nested file stays data',
  }),
  row(
    'RS-AI-7',
    'AI',
    'Harness and auto-run config inventoried, protected, never loaded; isolation test',
    'R',
    'F',
    'F',
    { floors: ['LF4'] },
  ),

  row('RS-BT-1', 'BT', 'Task-contract targets discoverable; test and check exist', 'R', 'F', 'F', {
    floors: ['LF3'],
  }),
  row('RS-BT-2', 'BT', 'setup and test pass headless in K-exec from clean', 'R', 'F', 'F', {
    floors: ['LF3'],
  }),
  row('RS-BT-3', 'BT', 'Lockfile per manifest; frozen install', 'R', 'S', 'S'),
  row('RS-BT-4', 'BT', 'Toolchain pinned', 'R', 'S', 'S'),
  row('RS-BT-5', 'BT', 'Environment builds within the ≤10 min rehydration budget', 'R', 'S', 'S'),
  row(
    'RS-BT-6',
    'BT',
    'Test wall time recorded; if test > 15 min, a test-fast ≤5 min exists',
    'R',
    'S',
    'S',
  ),
  row(
    'RS-BT-7',
    'BT',
    'Default test is hermetic; external-service tests marked and excluded',
    'R',
    'F',
    'F',
    { floors: ['LF3'] },
  ),
  row('RS-BT-8', 'BT', 'CI runs check; required check = what the sandbox ran', 'R', 'S', 'S'),

  row('RS-ST-1', 'ST', 'Formatter', 'R', 'S', 'S'),
  row('RS-ST-2', 'ST', 'Linter (diff-scoped against a baseline)', 'R', 'S', 'S'),
  row('RS-ST-3', 'ST', 'Type checker', 'R', 'S', 'S'),
  row(
    'RS-ST-4',
    'ST',
    'AGENTS.md conventions = non-standard practices only, tagged (enforced:) or (advisory)',
    '-',
    'S',
    'S',
  ),
  row('RS-ST-5', 'ST', 'Generated and vendored paths declared', 'R', 'S', 'S'),
  row('RS-ST-6', 'ST', 'pre-commit hooks', 'A', 'A', 'A'),

  row('RS-TH-1', 'TH', 'Tests exist and the gating set passes', 'R', 'F', 'F', { floors: ['LF3'] }),
  row('RS-TH-2', 'TH', 'Flake baseline (CI history or later item runs)', 'R', 'R', 'R'),
  row(
    'RS-TH-3',
    'TH',
    'Quarantine manifest with issue, owner and expiry; tests never deleted',
    '-',
    'S',
    'S',
  ),
  row('RS-TH-4', 'TH', 'Skip/xfail inventory', 'R', 'R', 'R'),
  row('RS-TH-5', 'TH', 'Coverage report producible', '-', 'S', 'S'),
  row('RS-TH-6', 'TH', 'Mutation testing', '-', '-', 'A'),

  row('RS-CC-1', 'CC', 'CODEOWNERS parses with zero errors; owners resolve', 'R', 'S', 'S', {
    escalations: [TEAM],
    note: 'RECORDED until SP-FID-2 proves the API is readable',
  }),
  row('RS-CC-2', 'CC', 'CODEOWNERS covers the protected set', 'R', 'S', 'S', {
    escalations: [TEAM],
  }),
  row(
    'RS-CC-3',
    'CC',
    'Default-branch rules (as LF2); the bypass clause is H-attested',
    'R',
    'F',
    'F',
    { floors: ['LF2'] },
  ),
  row('RS-CC-4', 'CC', 'App may only create or update agent/**', 'R', 'F', 'F', {
    floors: ['LF2'],
  }),
  row('RS-CC-5', 'CC', 'Push ruleset on protected paths', 'R', 'S', 'S', {
    note: 'N/A on public or user-owned repos',
  }),
  row('RS-CC-6', 'CC', 'Merge method recorded', 'R', 'R', 'R'),
  row('RS-CC-7', 'CC', 'Signed commits', 'A', 'A', 'A'),

  row('RS-KN-1', 'KN', 'README purpose and how to run', 'R', 'S', 'S'),
  row(
    'RS-KN-2',
    'KN',
    '.factory/knowledge/ pack in git, front-matter valid, kn-check clean',
    '-',
    'S',
    'S',
    {
      note: 'git copy; see DEC-12',
    },
  ),
  row('RS-KN-3', 'KN', 'build-and-run.md generated from the probe', '-', 'S', 'S'),
  row('RS-KN-4', 'KN', '≥90% of ≤50 claims affirmed or unknown; unknowns register', '-', 'F', 'F', {
    floors: ['LF6'],
  }),
  row('RS-KN-5', 'KN', 'Business intent (card answers) and sensitive-path list', '-', 'F', 'F', {
    floors: ['LF6'],
  }),
  row('RS-KN-6', 'KN', 'Decision records seeded', '-', 'A', 'S'),
  row('RS-KN-7', 'KN', 'Full codekb, system map, seeds', '-', '-', 'F', { floors: ['FF1'] }),

  row('RS-OP-1', 'OP', 'Apply-on-merge known', 'R', 'F', 'F', { floors: ['LF7'] }),
  row('RS-OP-2', 'OP', 'operations.md attested (L5 also: staging separation)', '-', 'F', 'F', {
    floors: ['LF7', 'FF2'],
  }),
  row('RS-OP-3', 'OP', 'Runbook pointers', '-', 'A', 'S'),

  row('RS-EN-1', 'EN', 'Egress needs declared', '-', 'F', 'F', { floors: ['LF8'] }),
  row('RS-EN-2', 'EN', '.env.example placeholders only; test needs no real secret', 'R', 'F', 'F', {
    floors: ['LF3'],
  }),
  row('RS-EN-3', 'EN', 'Repo size, LFS, binaries', 'R', 'R', 'R'),

  row('RS-PUB-1', 'PUB', 'LICENSE', 'R', 'S', 'S', { escalations: [TEAM_PUBLIC] }),
  row('RS-PUB-2', 'PUB', 'SECURITY.md with private reporting (human-authored)', 'R', 'S', 'S', {
    escalations: [TEAM_PUBLIC],
  }),
  row('RS-PUB-4', 'PUB', 'CONTRIBUTING, PR template', 'A', 'A', 'A'),
  row('RS-PUB-5', 'PUB', 'Dependabot or Renovate config', 'R', 'S', 'S'),

  row('RS-SEC', 'SEC', 'Security assessment exists; no open BLOCKING finding', 'R', 'F', 'F', {
    floors: ['LF1'],
    note: 'written RS-SEC-* in the §3.3 table and RS-SEC in LF1; one criterion',
  }),
];

const floor = (
  id: FloorId,
  level: FloorDef['level'],
  title: string,
  criteria: string[],
  method: string | null,
  why: string | null = null,
): FloorDef => ({ id, level, title, criteria, method, why });

export const FLOORS: readonly FloorDef[] = [
  floor(
    'CF1',
    'census',
    'App installation scoped to the repo; repo reachable; default branch known',
    ['RS-ID-1'],
    'D',
  ),
  floor('CF2', 'census', 'Owner confirmed (SOLO: the user)', ['RS-ID-2'], 'H'),
  floor(
    'CF3',
    'census',
    'Tier signed, raise-only (positive attestation for T0, if DEC-4)',
    ['RS-ID-3'],
    'D→A→H',
  ),
  floor('CF4', 'census', 'Visibility, owner type and plan recorded', ['RS-ID-4'], 'D'),
  floor(
    'LF1',
    'light',
    'No open BLOCKING security finding (B1, B2, B5). The scan is complete, or its gap is accepted',
    ['RS-SEC'],
    'D+H',
    'Agent code must not run where secrets or dangerous workflows are open',
  ),
  floor(
    'LF2',
    'light',
    'protect-main effective on the default branch: PR required, ≥1 approval, last-push approval, required gate-check pinned to the App, no force push or deletion; the App can push only to agent/** and holds no forbidden permission; the bypass list is attested',
    ['RS-CC-3', 'RS-CC-4'],
    'D (rules read) + H',
    'Makes D11 (the factory never merges) structural',
  ),
  floor(
    'LF3',
    'light',
    'Probe: setup and test from a clean checkout, hermetic (mirror-only egress, no secrets, no prod endpoints), one run. Test count > 0 and the gating set passes',
    ['RS-BT-1', 'RS-BT-2', 'RS-BT-7', 'RS-TH-1', 'RS-EN-2'],
    'D',
    "Without it the agent can't check its work, and every change looks broken",
  ),
  floor(
    'LF4',
    'light',
    'Repo harness and auto-run config inventoried, and the live planted-instruction isolation test passed for the worker image in use',
    ['RS-AI-7'],
    'D',
    'FIX 15: these files execute code or grant tools',
  ),
  floor(
    'LF5',
    'light',
    'Instruction text affirmed (card and D37 step-up, lint-clean, record artefact)',
    ['RS-AI-3', 'RS-AI-4'],
    'D+H',
    'The only repo text that can reach agents as guidance',
  ),
  floor(
    'LF6',
    'light',
    'Shallow codekb produced; ≥90% of ≤50 high-impact claims affirmed or unknown; intent attestation (card answers); practices interview attested',
    ['RS-KN-4', 'RS-KN-5'],
    'A+H',
    'Guards against a confident-but-wrong baseline (R-OPK-4)',
  ),
  floor(
    'LF7',
    'light',
    'operations.md attested and apply-on-merge known ("never deploys" is fine)',
    ['RS-OP-1', 'RS-OP-2'],
    'A+H',
    'Decides whether a merge is a deploy',
  ),
  floor(
    'LF8',
    'light',
    'Egress needs declared (a mirror allow-list request)',
    ['RS-EN-1'],
    'A+D',
    'Undeclared needs turn every probe red',
  ),
  floor(
    'FF1',
    'full',
    'DED Full exit: full codekb, system-map edges, specs/ seeds (observed until affirmed intended)',
    ['RS-KN-7'],
    null,
  ),
  floor('FF2', 'full', 'For L5 only: staging_separation: yes attested', ['RS-OP-2'], null),
];

export const CRITERIA: CriteriaCatalogue = {
  set: 'CRITERIA_V2',
  criteria: [...CRITERIA_LIST],
  floors: [...FLOORS],
};
