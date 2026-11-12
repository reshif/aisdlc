import { bindOracles, checkOracleBinding, testOneArgv, type OracleDeviation } from '@aisdlc/build';
import type { FindingKind, VerifyFinding, VerifyKitRun, VerifyOracle } from '@aisdlc/contracts';
import type { CheckContext } from './context.js';
import { finding, verdictOf, type ResultParts } from './finding.js';
import { runKit } from './kits.js';
import { runReview } from './review.js';
import { textOf, type Tree } from './tree.js';

// 7.3 Spec conformance (FL S7 "7.3 Spec conformance, D+A"). The D half: the head carries exactly the oracles G2
// approved and 5.4 bound to the Unit (every approved id once, with its spec hash, no unapproved oracle: the same check
// as 6.3, `checkOracleBinding`), and every locked oracle passes on the head, each in its own O session. The A half: A5
// reviews the change against the approved spec (`spec_conformance`); a high finding fails the check.

const MARKER = /aisdlc-oracle\s+id=/;

const DEVIATION_KIND: Readonly<Record<OracleDeviation['kind'], FindingKind>> = {
  oracle_missing: 'oracle_missing',
  repro_missing: 'oracle_missing',
  oracle_unbound: 'oracle_unbound',
  spec_mismatch: 'spec_mismatch',
  no_marker: 'no_marker',
  duplicate_oracle: 'duplicate_oracle',
  oracle_not_red: 'oracle_failing',
};

/** The oracle files of the head: the locked ones and any file that carries an oracle marker. */
export function headOracleFiles(
  head: Tree,
  locks: Readonly<Record<string, string>>,
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  for (const [path, f] of head) {
    const t = textOf(f);
    if (t === null) continue;
    if (path in locks || MARKER.test(t)) out.push({ path, content: t });
  }
  return out;
}

/** The binding deviations of the head as findings (pure). */
export function bindingFindings(
  head: Tree,
  locks: Readonly<Record<string, string>>,
  oracles: readonly VerifyOracle[],
  repro: boolean,
): VerifyFinding[] {
  const bound = bindOracles(headOracleFiles(head, locks));
  return checkOracleBinding(oracles, bound, repro).map((d) =>
    finding(DEVIATION_KIND[d.kind], 'high', {
      rule_id: d.oracle_id,
      path: d.path,
      message: `oracle binding: ${d.kind}${d.oracle_id ? ` (${d.oracle_id})` : ''}${d.path ? ` at ${d.path}` : ''}`,
    }),
  );
}

export async function checkConformance(c: CheckContext): Promise<ResultParts> {
  const { req, head } = c;
  const findings: VerifyFinding[] = bindingFindings(head, req.locks, req.oracles, req.repro);
  const kits: VerifyKitRun[] = [];
  const test = c.contract.test;
  const locked = Object.keys(req.locks).sort();
  if (!test || test.length === 0) {
    findings.push(
      finding('no_test_command', 'high', {
        message: 'the repo has no test command: the oracles cannot be run',
      }),
    );
  } else {
    for (const p of locked) {
      if (!head.has(p)) continue; // a missing lock is 7.2's ET10, and a missing oracle a binding finding above
      const a = await runKit(c.kit, `oracle-${p}`, head, testOneArgv(test, p));
      kits.push(a.kit);
      if (a.answered && !a.green) {
        findings.push(
          finding('oracle_failing', 'high', {
            path: p,
            message: `the oracle ${p} fails on the head: ${a.failing.slice(0, 3).join('; ')}`,
          }),
        );
      }
    }
  }
  const review = await runReview(
    c,
    'spec_conformance',
    'the approved specification and oracle specs (quoted as data above)',
  );
  kits.push(review.kit);
  findings.push(...review.findings);
  return { findings, kits, raised: null, verdict: verdictOf(findings, kits) };
}
