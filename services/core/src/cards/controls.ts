import {
  CONTROLS_SCHEMA_ID,
  ControlsReport,
  PROTECTED_PATH_PROBES,
  controlsReportHash,
  type BranchRules,
  type CodeHostNotOk,
  type CodeHostRead,
  type Control,
  type ControlId,
  type InstallationInfo,
} from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import { parseCodeowners, ruleFor } from '@aisdlc/codeowners';
import { b4Checks, mapRead, readUnreadable, repoKey } from '@aisdlc/ports';
import type { CardDeps } from './model.js';

// The controls report of card 4 (OB §6.2 row 0.4): deterministic from the code host's reads, unknown
// is never met, and the factory never fixes anything it finds. There is no clock in it: the same
// reads give the same bytes and the same `report_hash`.

/** The required check protect-main pins to the App (OB §3.3 LF2). */
export const GATE_CHECK = 'gate-check';

interface Verdict {
  readonly status: 'met' | 'not_met' | 'unknown';
  readonly reasons: string[];
}

/** LF2: PR required, at least one approval, last-push approval, `gate-check` pinned, no force push or deletion. */
export function protectMain(rules: CodeHostRead<BranchRules>): Verdict {
  if (rules.state !== 'ok')
    return { status: 'unknown', reasons: [`rules_${rules.state}:${rules.reason}`] };
  const r = rules.value;
  const reasons: string[] = [];
  if (r.pull_request === null) reasons.push('no_pull_request_rule');
  else {
    if (r.pull_request.required_approving_review_count < 1) reasons.push('no_required_approval');
    if (!r.pull_request.require_last_push_approval) reasons.push('no_last_push_approval');
  }
  if (!r.required_checks.some((c) => c.context === GATE_CHECK && c.integration_id !== null)) {
    reasons.push('gate_check_not_pinned');
  }
  if (!r.blocks_force_push) reasons.push('force_push_allowed');
  if (!r.blocks_deletion) reasons.push('deletion_allowed');
  return { status: reasons.length === 0 ? 'met' : 'not_met', reasons };
}

const INSTRUCTIONS: Readonly<Record<string, string>> = {
  B4a: 'Remove the `administration`, `workflows` and `statuses` permissions from the factory App on GitHub (Settings, Applications). The factory never changes its own permissions.',
  B4b: 'Pin every required status check of the default branch to the factory App (set its integration in the ruleset on GitHub), or remove the `statuses` permission from the App.',
  protect_main:
    'Apply the protect-main ruleset on the default branch on GitHub: pull request required, one approval, last-push approval, `gate-check` pinned to the App, no force push, no deletion. The factory never changes rulesets.',
  app_scope:
    'Install the factory App on selected repositories only ("Only select repositories"), not on all of them, on GitHub.',
  unreadable:
    'The code host could not be read. Check that the App is installed on this repository and press re-check.',
};

/** Reads the code host and judges. `reduced`: the 0.4 of a Census onboarding (protect-main is only recorded). */
export async function buildControlsReport(
  deps: Pick<CardDeps, 'source'>,
  repo: string,
  o: { reduced: boolean },
): Promise<ControlsReport> {
  const { source } = deps;
  const repos = await source.list_repos();
  const info =
    repos.state === 'ok'
      ? repos.value.find((r) => repoKey(r.full_name) === repoKey(repo))
      : undefined;
  const branch = info?.default_branch ?? null;
  const missing: CodeHostNotOk =
    repos.state !== 'ok'
      ? repos
      : readUnreadable('not_found', `${repo} is not reached by the installation`);

  const full = repo as Parameters<typeof source.branch_head>[0]['repo'];
  const [installation, head, rules] = await Promise.all([
    source.installation(),
    branch ? source.branch_head({ repo: full, branch }) : Promise.resolve(missing),
    branch ? source.rules_for_branch({ repo: full, branch }) : Promise.resolve(missing),
  ]);
  const b4 = b4Checks({
    installation,
    required_checks: mapRead(rules, (r) => r.required_checks),
  });

  // CODEOWNERS and the instruction files, read at the head the rules were judged for.
  let owners: CodeHostRead<{ path: string; blob_sha: string; text: string } | null> = missing;
  let githubErrors: CodeHostRead<number> = missing;
  let agents: CodeHostRead<unknown> = missing;
  let claude: CodeHostRead<unknown> = missing;
  if (head.state === 'ok') {
    const sha = head.value;
    const [file, errs, a, c] = await Promise.all([
      source.codeowners({ repo: full, sha }),
      source.codeowners_errors({ repo: full, ref: sha }),
      source.read_at_sha({ repo: full, sha, path: 'AGENTS.md' }),
      source.read_at_sha({ repo: full, sha, path: 'CLAUDE.md' }),
    ]);
    owners = mapRead(file, (f) =>
      f ? { path: f.path, blob_sha: f.blob_sha, text: f.content } : null,
    );
    githubErrors = mapRead(errs, (e) => e.length);
    agents = a;
    claude = c;
  }
  const parsed = owners.state === 'ok' && owners.value ? parseCodeowners(owners.value.text) : null;
  const uncovered =
    owners.state !== 'ok'
      ? null
      : parsed === null
        ? [...PROTECTED_PATH_PROBES]
        : PROTECTED_PATH_PROBES.filter((p) => {
            const rule = ruleFor(parsed, p);
            return rule === null || rule.owners.length === 0;
          });
  const presence = (r: CodeHostRead<unknown>): 'present' | 'absent' | 'unknown' =>
    r.state !== 'ok' ? 'unknown' : r.value === null ? 'absent' : 'present';

  // ---- the controls
  const controls: Control[] = [];
  const add = (c: Control) => controls.push(c);
  const fromB4 = (id: 'B4a' | 'B4b', f: typeof b4.b4a): Control => ({
    id,
    status: f.status === 'clear' ? 'met' : f.status === 'blocked' ? 'not_met' : 'unknown',
    blocking: true,
    reasons: f.reasons,
    instruction:
      f.status === 'clear'
        ? null
        : f.status === 'unknown'
          ? (INSTRUCTIONS['unreadable'] ?? null)
          : (INSTRUCTIONS[id] ?? null),
  });
  add(fromB4('B4a', b4.b4a));
  add(fromB4('B4b', b4.b4b));
  add({
    id: 'B4c',
    status: b4.b4c.status === 'clear' ? 'met' : b4.b4c.status === 'amber' ? 'recorded' : 'unknown',
    blocking: false,
    reasons: b4.b4c.reasons,
    instruction: null,
  });
  const pm = protectMain(rules);
  add({
    id: 'protect_main',
    status: pm.status === 'met' ? 'met' : o.reduced ? 'recorded' : pm.status,
    blocking: !o.reduced,
    reasons: pm.reasons,
    instruction:
      pm.status === 'met'
        ? null
        : pm.status === 'unknown'
          ? (INSTRUCTIONS['unreadable'] ?? null)
          : (INSTRUCTIONS['protect_main'] ?? null),
  });
  const selection = installation.state === 'ok' ? installation.value.repository_selection : null;
  add({
    id: 'app_scope',
    status: selection === 'selected' ? 'met' : selection === 'all' ? 'not_met' : 'unknown',
    blocking: true,
    reasons:
      selection === null
        ? ['installation_unreadable']
        : selection === 'all'
          ? ['all_repositories']
          : [],
    instruction:
      selection === 'selected'
        ? null
        : selection === 'all'
          ? (INSTRUCTIONS['app_scope'] ?? null)
          : (INSTRUCTIONS['unreadable'] ?? null),
  });
  const coReasons: string[] = [];
  if (owners.state === 'ok' && owners.value === null) coReasons.push('no_codeowners_file');
  if ((parsed?.errors.length ?? 0) > 0) coReasons.push('codeowners_parse_errors');
  if (githubErrors.state === 'ok' && githubErrors.value > 0)
    coReasons.push('codeowners_github_errors');
  if (uncovered !== null && uncovered.length > 0 && owners.state === 'ok' && owners.value !== null)
    coReasons.push('protected_paths_uncovered');
  add({
    id: 'codeowners',
    status: owners.state !== 'ok' ? 'unknown' : coReasons.length === 0 ? 'met' : 'recorded',
    blocking: false,
    reasons: coReasons,
    instruction: null,
  });
  add({
    id: 'instructions',
    status: 'recorded',
    blocking: false,
    reasons: [`agents_md:${presence(agents)}`, `claude_md:${presence(claude)}`],
    instruction: null,
  });

  const rulesJson = rules.state === 'ok' ? rules.value : null;
  const inst: InstallationInfo | null = installation.state === 'ok' ? installation.value : null;
  const body = {
    schema: CONTROLS_SCHEMA_ID,
    repo: repo as ControlsReport['repo'],
    branch,
    head_sha: head.state === 'ok' ? head.value : null,
    reduced: o.reduced,
    effective_rules: {
      read: rules.state,
      rules: rulesJson,
      rules_hash: rulesJson ? hashCanonical(rulesJson) : null,
    },
    app_installation: {
      read: installation.state,
      installation_id: inst?.installation_id ?? null,
      repository_selection: inst?.repository_selection ?? null,
      permissions: inst?.permissions ?? null,
    },
    b4,
    codeowners: {
      read: owners.state,
      path: owners.state === 'ok' && owners.value ? owners.value.path : null,
      blob_sha: owners.state === 'ok' && owners.value ? owners.value.blob_sha : null,
      parse_errors: owners.state === 'ok' ? (parsed?.errors.length ?? 0) : null,
      github_errors: githubErrors.state === 'ok' ? githubErrors.value : ('unknown' as const),
      protected_uncovered: uncovered,
    },
    sensitive_paths: [...PROTECTED_PATH_PROBES],
    sensitive_paths_hash: hashCanonical([...PROTECTED_PATH_PROBES]),
    instructions: { agents_md: presence(agents), claude_md: presence(claude) },
    controls,
    blocking_open: controls
      .filter((c) => c.blocking && c.status !== 'met')
      .map((c) => c.id as ControlId),
  };
  return ControlsReport.parse({ ...body, report_hash: controlsReportHash(body) });
}
