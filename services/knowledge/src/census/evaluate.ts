import { LINT_RULES, TierValues } from '@aisdlc/contracts';
import type { CensusContext } from './context.js';
import { factEvidence, fail, pass, ref, unknown, type Evaluation } from './context.js';
import type { Blockers } from './blockers.js';

// What the Census can observe for each criterion (OB §3.3), independent of level: `pass`, `fail` or
// `unknown`. The class at the requested level then decides what that means (census/assemble.ts).
// A criterion with no entry here, or whose evidence the Census cannot read (the probe, a human, a
// check the detectors do not make), is UNKNOWN with a cause code: unknown counts as unmet.

type Evaluator = (c: CensusContext, b: Blockers) => Evaluation;

/** Criteria the Census cannot observe, and why. Keyed by criterion id; a missing id is `no_evaluator`. */
export const UNOBSERVED: Readonly<Record<string, string>> = {
  // Only a K-exec run measures these (B7); the probe is `pending` at Census.
  'RS-BT-2': 'probe_pending',
  'RS-BT-5': 'probe_pending',
  'RS-BT-6': 'probe_pending',
  'RS-BT-7': 'probe_pending',
  'RS-TH-1': 'probe_pending',
  'RS-TH-5': 'probe_pending',
  'RS-EN-2': 'probe_pending',
  'RS-KN-3': 'probe_pending',
  // A human affirms or attests them (cards 2 and 4); nothing in a bundle can.
  'RS-AI-4': 'needs_human_attestation',
  'RS-KN-4': 'needs_human_attestation',
  'RS-KN-5': 'needs_human_attestation',
  // No detector reads them yet (the detector set of M6.3 has no presence or CI-history check).
  'RS-AI-2': 'no_detector',
  'RS-BT-4': 'no_detector',
  'RS-BT-8': 'no_detector',
  'RS-ST-4': 'no_detector',
  'RS-ST-5': 'no_detector',
  'RS-TH-2': 'no_detector',
  'RS-TH-3': 'no_detector',
  'RS-TH-4': 'no_detector',
  'RS-TH-6': 'no_detector',
  'RS-CC-6': 'no_detector',
  'RS-CC-7': 'no_detector',
  'RS-KN-1': 'no_detector',
  'RS-KN-2': 'no_detector',
  'RS-KN-6': 'no_detector',
  'RS-KN-7': 'no_detector',
  'RS-OP-3': 'no_detector',
  'RS-PUB-1': 'no_detector',
  'RS-PUB-2': 'no_detector',
  'RS-PUB-4': 'no_detector',
  'RS-PUB-5': 'no_detector',
};

const incomplete = (what: string): Evaluation => unknown(`detector_incomplete:${what}`);

/** `test` and `check` (RS-BT-1) or a single task-contract name (RS-ST-1..3). */
function taskNames(...names: string[]): Evaluator {
  return (c) => {
    if (!c.ok('task_contract')) return incomplete('task_contract');
    const missing: string[] = [];
    const ev = [];
    for (const n of names) {
      const f = c.task(n);
      if (f?.state === 'found') ev.push(...factEvidence(f));
      else missing.push(`missing:${n}`);
    }
    return missing.length === 0 ? pass(ev) : fail(missing, ev);
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export const EVALUATORS: Readonly<Record<string, Evaluator>> = {
  // ---- identity: from the code host and the owner's card
  'RS-ID-1': (c) => {
    const inst = c.att.installation;
    const branch = c.d?.default_branch ?? null;
    const ev = [ref('codehost', 'codehost:installation'), ref('intake', 'intake:default_branch')];
    if (inst === undefined) return unknown('installation_unknown');
    if (branch === null) return unknown('default_branch_unknown', ev);
    if (inst.repository_selection !== 'selected') return fail(['installation_not_scoped'], ev);
    return pass(ev);
  },
  'RS-ID-2': (c) =>
    c.att.owner_confirmed === undefined
      ? unknown('owner_unconfirmed')
      : pass([ref('attestation', 'attestation:owner_confirmed')]),
  'RS-ID-3': (c) => {
    const t = c.att.tier;
    if (t === undefined) return unknown('tier_unsigned');
    const ev = [ref('attestation', 'attestation:tier')];
    const floor = c.d?.tier.floor ?? 'T0';
    const reasons: string[] = [];
    if (TierValues.indexOf(t.signed) < TierValues.indexOf(floor))
      reasons.push('signed_below_floor');
    if (!t.regulatory_attested) reasons.push('regulatory_unattested');
    if (!t.criticality_attested) reasons.push('criticality_unattested');
    if (t.signed === 'T0' && !t.t0_attested) reasons.push('t0_unattested');
    return reasons.length === 0 ? pass(ev) : fail(reasons, ev);
  },
  'RS-ID-4': (c) => {
    const r = c.att.repo;
    if (r === undefined) return unknown('repo_facts_unknown');
    return r.plan === null
      ? unknown('plan_unknown', [ref('codehost', 'codehost:repo')])
      : pass([ref('codehost', 'codehost:repo')]);
  },

  // ---- instructions and harness (inventory detector)
  'RS-AI-1': (c) => {
    if (!c.ok('inventory')) return incomplete('inventory');
    const f = c.inventory('agents_md');
    if (f === undefined || f.state === 'absent')
      return fail(['no_agents_md'], [ref('detector', 'absent:agents_md')]);
    const ev = factEvidence(f);
    if (f.detail['root_present'] !== true) return fail(['no_root_agents_md'], ev);
    const lines = num(f.detail['root_lines']);
    if (lines === null) return unknown('root_lines_unread', ev);
    const reasons: string[] = [];
    if (f.detail['root_over_limit'] === true) reasons.push('root_over_150_lines');
    if (f.detail['chain_over_limit'] === true) reasons.push('chain_over_32_kib');
    return reasons.length === 0 ? pass(ev) : fail(reasons, ev);
  },
  'RS-AI-3': (c) => {
    if (!c.ok('content_lint') || c.d === null) return incomplete('content_lint');
    const blocking = Object.entries(c.d.lint.by_rule)
      .filter(
        ([r, n]) =>
          n > 0 && (LINT_RULES as Record<string, { severity: string }>)[r]?.severity === 'blocking',
      )
      .map(([r]) => `lint:${r}`);
    const ev = c
      .facts('lint_finding')
      .filter((f) => f.severity === 'blocking')
      .flatMap(factEvidence);
    return blocking.length === 0 ? pass() : fail(blocking, ev);
  },
  'RS-AI-5': (c) => {
    if (!c.ok('inventory')) return incomplete('inventory');
    const claude = c.inventory('claude_md');
    const reasons: string[] = [];
    if (claude !== undefined && claude.state === 'data' && claude.detail['all_stubs'] !== true) {
      reasons.push('claude_md_not_a_stub');
    }
    if (reasons.length > 0) return fail(reasons, claude ? factEvidence(claude) : []);
    // The other harness files must be "absent or stubs"; the inventory does not tell stubs apart.
    const others = ['cursor', 'copilot_instructions', 'windsurf', 'gemini', 'aider', 'continue']
      .map((k) => c.inventory(k))
      .filter((f) => f !== undefined && f.state === 'data');
    if (others.length > 0) {
      return unknown(
        'other_harness_files_stub_unchecked',
        others.flatMap((f) => (f ? factEvidence(f) : [])),
      );
    }
    return pass();
  },
  'RS-AI-6': (c) => {
    if (!c.ok('inventory')) return incomplete('inventory');
    const f = c.inventory('agents_md');
    const nested = f === undefined ? 0 : (num(f.detail['nested_count']) ?? 0);
    if (nested === 0)
      return { observed: 'pass', reasons: [], evidence: [], na: 'NA-NO-NESTED-AGENTS' };
    const ev = f ? factEvidence(f) : [];
    if ((num(f?.detail['nested_over_limit']) ?? 0) > 0) return fail(['nested_over_60_lines'], ev);
    // "Only at subproject roots" is not something the inventory can check.
    return unknown('nested_location_unchecked', ev);
  },
  'RS-AI-7': (c) => {
    if (!c.ok('inventory')) return incomplete('inventory');
    // Recorded at Census: the inventory exists. At Light and Full the floor also needs the live
    // planted-instruction isolation test (LF4), which no bundle can show.
    return c.level === 'census'
      ? pass([ref('detector', 'detector:inventory')])
      : unknown('isolation_test_missing', [ref('detector', 'detector:inventory')]);
  },

  // ---- build, style, tests
  'RS-BT-1': taskNames('test', 'check'),
  'RS-ST-1': taskNames('format-check'),
  'RS-ST-2': taskNames('lint'),
  'RS-ST-3': taskNames('typecheck'),
  'RS-ST-6': (c) => {
    if (!c.ok('inventory')) return incomplete('inventory');
    const hooks = ['pre_commit_config', 'git_hooks']
      .map((k) => c.inventory(k))
      .filter((f) => f !== undefined && f.state === 'data');
    return hooks.length > 0
      ? pass(hooks.flatMap((f) => (f ? factEvidence(f) : [])))
      : fail(['no_pre_commit_hooks']);
  },
  'RS-BT-3': (c) => {
    if (!c.ok('lockfiles') || !c.ok('stack')) return incomplete('lockfiles');
    const locks = c.facts('lockfile');
    if (locks.length === 0) {
      return c.facts('stack').some((f) => f.category === 'manifest')
        ? unknown('manifest_without_lockfile_fact')
        : { observed: 'pass', reasons: [], evidence: [], na: 'NA-NO-MANIFEST' };
    }
    const ev = locks.flatMap(factEvidence);
    const reasons: string[] = [];
    if (locks.some((l) => l.state === 'absent')) reasons.push('lockfile_absent');
    if (locks.some((l) => l.state === 'present' && l.frozen_install === 'infeasible'))
      reasons.push('frozen_install_infeasible');
    if (reasons.length > 0) return fail(reasons, ev);
    if (locks.some((l) => l.frozen_install === 'unknown'))
      return unknown('frozen_install_unchecked', ev);
    return pass(ev);
  },

  // ---- change control
  'RS-CC-1': (c) => {
    if (!c.ok('codeowners')) return incomplete('codeowners');
    const f = c.facts('codeowners')[0];
    if (f === undefined) return incomplete('codeowners');
    const ev = factEvidence(f);
    if (f.state === 'absent')
      return fail(['no_codeowners'], [ref('detector', 'absent:codeowners')]);
    return f.errors.length === 0 ? pass(ev) : fail(['codeowners_parse_errors'], ev);
  },
  'RS-CC-2': (c) => {
    if (!c.ok('codeowners')) return incomplete('codeowners');
    const f = c.facts('codeowners')[0];
    if (f === undefined) return incomplete('codeowners');
    if (f.state === 'absent')
      return fail(['no_codeowners'], [ref('detector', 'absent:codeowners')]);
    return f.protected_set.covered
      ? pass(factEvidence(f))
      : fail(['protected_set_uncovered'], factEvidence(f));
  },
  'RS-CC-3': (c) => {
    const a = c.att;
    if (a.protect_main === false)
      return fail(['protect_main_not_effective'], [ref('codehost', 'codehost:protect_main')]);
    if (a.protect_main === undefined) return unknown('protect_main_unknown');
    return a.bypass_attested === true
      ? pass([ref('codehost', 'codehost:protect_main'), ref('attestation', 'attestation:bypass')])
      : unknown('bypass_unattested', [ref('codehost', 'codehost:protect_main')]);
  },
  'RS-CC-4': (c) => {
    const v = c.att.app_push_agent_only;
    return v === undefined
      ? unknown('app_push_scope_unknown')
      : v
        ? pass([ref('codehost', 'codehost:app_push_scope')])
        : fail(['app_can_push_beyond_agent'], [ref('codehost', 'codehost:app_push_scope')]);
  },
  'RS-CC-5': (c) =>
    c.visibility === 'public' || c.ownerType === 'user'
      ? { observed: 'pass', reasons: [], evidence: [], na: 'NA-PUBLIC-OR-USER-REPO' }
      : unknown('push_ruleset_unreadable'),

  // ---- operations, environment
  'RS-OP-1': (c) => {
    if (!c.ok('b6_apply_on_merge') || c.d === null) return incomplete('b6_apply_on_merge');
    // "Known" means decided either way: a repo that deploys on merge is known, not unmet.
    return pass(
      c.facts('apply_on_merge').flatMap(factEvidence),
      c.d.b6.detected ? ['apply_on_merge_detected'] : [],
    );
  },
  'RS-OP-2': (c) =>
    c.att.operations_attested === true
      ? pass([ref('attestation', 'attestation:operations')])
      : unknown('operations_unattested'),
  'RS-EN-1': (c) =>
    c.att.egress_declared === true
      ? pass([ref('attestation', 'attestation:egress')])
      : unknown('egress_undeclared'),
  'RS-EN-3': (c) => {
    const cov = c.r.scan_coverage;
    const reasons: string[] = [];
    if (cov.lfs_unscanned > 0) reasons.push('lfs_unscanned');
    if ((c.r.coverage_counts.file_over_cap ?? 0) > 0) reasons.push('files_over_cap');
    return reasons.length === 0
      ? pass([ref('intake', 'intake:head_tree')])
      : fail(reasons, [ref('intake', 'intake:head_tree')]);
  },

  // ---- security (the blockers decide)
  'RS-SEC': (_c, b) => {
    const get = (id: 'B1' | 'B2' | 'B5') => b.byId.get(id)?.status ?? 'unknown';
    const ev = [ref('scan', 'scan:finding_counts'), ref('scan', 'scan:coverage')];
    const reasons: string[] = [];
    if (get('B1') === 'blocked') reasons.push('B1');
    if (get('B2') === 'blocked') reasons.push('B2');
    if (get('B5') === 'blocked') reasons.push('B5');
    if (reasons.length > 0) return fail(reasons, ev);
    const open = (['B1', 'B2', 'B5'] as const).filter((id) => get(id) !== 'met');
    return open.length === 0 ? pass(ev) : unknown(`unknown:${open.join('+')}`, ev);
  },
};
