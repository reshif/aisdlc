import { bindOracles, testOneArgv } from '@aisdlc/build';
import type {
  MutationScore,
  VerifyFinding,
  VerifyKitRun,
  VerifyOracle,
  VerifyRaise,
} from '@aisdlc/contracts';
import { isTestPath, stubReason } from '@aisdlc/tripwires';
import type { CheckContext } from './context.js';
import { finding, verdictOf, type ResultParts } from './finding.js';
import { runKit } from './kits.js';
import {
  changedPaths,
  diffTrees,
  isSourcePath,
  sha256Of,
  textOf,
  treeHash,
  withFile,
  type Tree,
} from './tree.js';

// 7.2 Test integrity and oracle quality (FL S7 "7.2 Test integrity + oracle quality, mutation · holdout · D"; Q1 "locked-
// test edit · stub passes"). In this order, and misbehaviour stops it at once (ET10, Q1: no kit runs after it):
//
//   locks        every locked oracle is in the head with exactly the hash it was locked with (ET10 otherwise)
//   stub tests   a test file the head added or changed that cannot fail (the tripwires' static probe; ET10)
//   stub probe   the oracles run over the STUB tree: the base with only the head's test files on it. They were red on
//                the base at 6.3; green now means the tests pass without the implementation, so the test side was
//                bent to pass (ET10 "stub passes"). Skipped when the head changed nothing but tests.
//   mutation     mutants of the lines the head added to its implementation files, each run against the repo's tests;
//                the tests must kill at least `min_mutation_score` of them
//   holdout      the hidden tests of the Unit (a narrow port: the factory's holdout store, never the eval store), each
//                must pass on the head
//
// A kit with no verdict anywhere makes the check `unknown`.

/** Locked oracles the head changed or dropped (pure). */
export function lockFindings(head: Tree, locks: Readonly<Record<string, string>>): VerifyFinding[] {
  const out: VerifyFinding[] = [];
  for (const [path, sha] of Object.entries(locks).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const now = head.get(path);
    if (now?.sha256 !== sha) {
      out.push(
        finding('locked_test_edit', 'critical', {
          path,
          message: now
            ? `the locked test ${path} changed after it was locked`
            : `the locked test ${path} is gone from the head`,
          key: `${sha}:${now?.sha256 ?? 'deleted'}`,
        }),
      );
    }
  }
  return out;
}

/**
 * B12 "locked test must change" (PLAN M14.4): a locked oracle that is intact (its lock hash holds, so nobody bent it)
 * but carries an oracle id whose APPROVED spec hash is no longer the one its marker names. The approved spec moved after
 * the lock (a B10 re-spec, a G2 portion again): the locked test cannot be right any more, and only a person may change a
 * locked test (E6, then G3o). Pure; L0's reproduction tests carry no spec hash and are never stale.
 */
export function staleLockFindings(
  head: Tree,
  locks: Readonly<Record<string, string>>,
  oracles: readonly VerifyOracle[],
  repro: boolean,
): VerifyFinding[] {
  if (repro) return [];
  const approved = new Map(oracles.map((o) => [o.oracle_id, o.spec_sha256]));
  const files: Array<{ path: string; content: string }> = [];
  for (const path of Object.keys(locks).sort()) {
    const f = head.get(path);
    const t = textOf(f);
    if (f === undefined || f.sha256 !== locks[path] || t === null) continue;
    files.push({ path, content: t });
  }
  const out: VerifyFinding[] = [];
  for (const b of bindOracles(files)) {
    if (b.oracle_id === null || b.declared_spec_sha256 === null) continue;
    const want = approved.get(b.oracle_id);
    if (want === undefined || want === b.declared_spec_sha256) continue;
    out.push(
      finding('locked_test_stale', 'high', {
        rule_id: b.oracle_id.slice(0, 64),
        path: b.path,
        message: `the locked oracle ${b.path} (${b.oracle_id}) was locked against a spec the approved one replaced`,
        key: `${b.declared_spec_sha256}:${want}`,
      }),
    );
  }
  return out;
}

/** Test files the head added or changed that cannot fail, where the base's did not already (pure). */
export function staticStubFindings(base: Tree, head: Tree): VerifyFinding[] {
  const d = diffTrees(base, head);
  const out: VerifyFinding[] = [];
  for (const p of [...d.added, ...d.modified]) {
    const after = textOf(head.get(p));
    if (after === null) continue;
    const why = stubReason(p, after);
    if (why === null) continue;
    const before = textOf(base.get(p));
    if (before !== null && stubReason(p, before) !== null) continue;
    out.push(finding('stub_test', 'critical', { path: p, message: why }));
  }
  return out;
}

/**
 * The stub tree: the base, with the head's test files on it (added and changed ones, deletions too) and the locked
 * oracles as the head has them. Every implementation change is gone. `null` when that is the head itself.
 */
export function stubTreeOf(base: Tree, head: Tree, locked: readonly string[]): Tree | null {
  let t: Tree = base;
  const d = diffTrees(base, head);
  for (const p of changedPaths(d)) {
    if (!isTestPath(p) && !locked.includes(p)) continue;
    const f = head.get(p);
    const m = new Map(t);
    if (f === undefined) m.delete(p);
    else m.set(p, f);
    t = m;
  }
  return treeHash(t) === treeHash(head) ? null : t;
}

export interface Mutant {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly operator: string;
  readonly text: string;
}

const OPERATORS: ReadonlyArray<{ id: string; re: RegExp; to: string }> = [
  { id: 'strict-eq', re: /===/, to: '!==' },
  { id: 'strict-neq', re: /!==/, to: '===' },
  { id: 'plus', re: / \+ /, to: ' - ' },
  { id: 'minus', re: / - /, to: ' + ' },
  { id: 'times', re: / \* /, to: ' / ' },
  { id: 'lte', re: / <= /, to: ' > ' },
  { id: 'gte', re: / >= /, to: ' < ' },
  { id: 'lt', re: / < /, to: ' >= ' },
  { id: 'gt', re: / > /, to: ' <= ' },
  { id: 'and', re: /&&/, to: '||' },
  { id: 'or', re: /\|\|/, to: '&&' },
  { id: 'true', re: /\btrue\b/, to: 'false' },
  { id: 'false', re: /\bfalse\b/, to: 'true' },
];

/**
 * Mutants of the lines the head ADDED to its implementation files (a line the base file did not have), one per
 * operator and line, at most `max`, spread evenly over the candidates. Deterministic: same trees, same mutants.
 */
export function mutantsOf(base: Tree, head: Tree, max: number): Mutant[] {
  const d = diffTrees(base, head);
  const all: Mutant[] = [];
  for (const p of [...d.added, ...d.modified].filter(isSourcePath).sort()) {
    const after = textOf(head.get(p));
    if (after === null) continue;
    const had = new Set((textOf(base.get(p)) ?? '').split('\n'));
    const lines = after.split('\n');
    lines.forEach((l, i) => {
      if (had.has(l) || /^\s*(\/\/|#|\*|\/\*)/.test(l)) return;
      for (const op of OPERATORS) {
        if (!op.re.test(l)) continue;
        const mutated = [...lines];
        mutated[i] = l.replace(op.re, op.to);
        all.push({
          id: `${p}:${i + 1}:${op.id}`,
          path: p,
          line: i + 1,
          operator: op.id,
          text: mutated.join('\n'),
        });
      }
    });
  }
  if (all.length <= max) return all;
  return Array.from({ length: max }, (_, k) => all[Math.floor((k * all.length) / max)] as Mutant);
}

/** The mutation score and its findings (pure). */
export function judgeMutation(
  runs: ReadonlyArray<{ mutant: Mutant; answered: boolean; killed: boolean }>,
  min_score: number,
): { score: MutationScore; findings: VerifyFinding[] } {
  const killed = runs.filter((r) => r.answered && r.killed).length;
  const survived = runs.filter((r) => r.answered && !r.killed).length;
  const unknown = runs.filter((r) => !r.answered).length;
  const score: MutationScore = { total: runs.length, killed, survived, unknown, min_score };
  const findings: VerifyFinding[] = [];
  if (runs.length === 0) {
    findings.push(
      finding('mutation_none', 'info', {
        message: 'the head added no implementation line a mutant could be made of',
      }),
    );
    return { score, findings };
  }
  for (const r of runs.filter((x) => x.answered && !x.killed)) {
    findings.push(
      finding('mutation_survived', 'low', {
        rule_id: r.mutant.operator,
        path: r.mutant.path,
        line: r.mutant.line,
        message: `a mutant (${r.mutant.operator}) of ${r.mutant.path}:${r.mutant.line} survived the tests`,
      }),
    );
  }
  const answered = killed + survived;
  if (unknown === 0 && answered > 0 && killed / answered < min_score) {
    findings.push(
      finding('mutation_score_low', 'high', {
        message: `the tests killed ${killed} of ${answered} mutants, below ${min_score}`,
      }),
    );
  }
  return { score, findings };
}

const et10 = (reason_code: string): VerifyRaise => ({
  kind: 'trigger',
  trigger: 'ET10',
  reason_code,
});

export async function checkIntegrity(c: CheckContext): Promise<ResultParts> {
  const { req, base, head } = c;
  const kits: VerifyKitRun[] = [];
  const findings: VerifyFinding[] = [];

  // misbehaviour first: the tree alone shows it, and nothing runs once it is seen
  const tamper = [...lockFindings(head, req.locks), ...staticStubFindings(base, head)];
  if (tamper.length > 0) {
    const reason = tamper.some((f) => f.kind === 'locked_test_edit')
      ? 'locked_test_edit'
      : 'stub_test';
    return { findings: tamper, kits, raised: et10(reason), verdict: 'failed' };
  }

  // B12: a locked test the approved spec has moved away from must change, and only a person may change it (E6)
  const stale = staleLockFindings(head, req.locks, req.oracles, req.repro);
  if (stale.length > 0) {
    return {
      findings: stale,
      kits,
      raised: { kind: 'gate', gate: 'E6', reason_code: 'locked_test_must_change' },
      verdict: 'failed',
    };
  }

  const test = c.contract.test;
  if (!test || test.length === 0) {
    findings.push(
      finding('no_test_command', 'high', {
        message: 'the repo has no test command: oracle quality cannot be measured',
      }),
    );
    return { findings, kits, raised: null, verdict: 'failed' };
  }

  // the stub probe
  const locked = Object.keys(req.locks).sort();
  const stub = locked.length > 0 ? stubTreeOf(base, head, locked) : null;
  if (locked.length === 0 || stub === null) {
    findings.push(
      finding('stub_probe_skipped', 'info', {
        message:
          locked.length === 0
            ? 'no locked oracle to probe'
            : 'the head changed only tests: the stub is the head',
      }),
    );
  } else {
    const passed: string[] = [];
    for (const p of locked) {
      const a = await runKit(c.kit, `stub-${p}`, stub, testOneArgv(test, p));
      kits.push(a.kit);
      if (a.answered && a.green) passed.push(p);
    }
    if (passed.length > 0) {
      for (const p of passed) {
        findings.push(
          finding('stub_probe_passed', 'critical', {
            path: p,
            message: `the oracle ${p} passes with the implementation taken out: the tests were bent to pass`,
          }),
        );
      }
      return {
        findings,
        kits,
        raised: et10('stub_probe_passed'),
        verdict: 'failed',
      };
    }
  }

  // mutation
  const mutants = mutantsOf(base, head, c.policy.max_mutants);
  const runs: Array<{ mutant: Mutant; answered: boolean; killed: boolean }> = [];
  for (const m of mutants) {
    const a = await runKit(c.kit, `mut-${m.id}`, withFile(head, m.path, m.text), test);
    kits.push(a.kit);
    runs.push({ mutant: m, answered: a.answered, killed: a.answered && !a.green });
  }
  const mut = judgeMutation(runs, c.policy.min_mutation_score);
  findings.push(...mut.findings);

  // holdout
  const h = await c.holdouts.holdouts({
    item_id: req.item_id,
    repo: req.repo,
    unit_key: req.unit_key,
    base_sha: req.base_sha,
  });
  if (!h.ok) {
    kits.push({
      kit: 'holdout-set',
      class: null,
      session_id: null,
      status: 'error',
      exit_code: null,
      detail: h.error.message.slice(0, 200),
    });
  } else if (h.value === null || h.value.files.length === 0) {
    findings.push(
      finding('holdout_none', 'info', { message: 'no holdout set is bound to this Unit' }),
    );
  } else {
    let withHoldouts: Tree = head;
    for (const f of h.value.files) {
      withHoldouts = withFile(withHoldouts, f.path, Buffer.from(f.content).toString('utf8'));
    }
    for (const f of [...h.value.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const a = await runKit(
        c.kit,
        `holdout-${sha256Of(f.path).slice(0, 12)}`,
        withHoldouts,
        testOneArgv(test, f.path),
      );
      kits.push(a.kit);
      if (a.answered && !a.green) {
        findings.push(
          finding('holdout_failed', 'high', {
            rule_id: h.value.set_id.slice(0, 64),
            // the holdout's own path is hidden from the coder: the finding names its hash, never the path
            message: `a holdout test of set ${h.value.set_id.slice(0, 32)} fails on the head`,
            key: sha256Of(f.path),
          }),
        );
      }
    }
  }
  return {
    findings,
    kits,
    raised: null,
    verdict: verdictOf(findings, kits),
    mutation: mut.score,
  };
}
