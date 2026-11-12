import { protectedPushPath, type VerifyFinding } from '@aisdlc/contracts';
import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import { rulesVersion, scanText } from '@aisdlc/secrets-rules';
import {
  DEFAULT_PROTECTED_GLOBS,
  addedDependencies,
  isLockfile,
  isManifest,
  matchesAny,
} from '@aisdlc/tripwires';
import type { CheckContext } from './context.js';
import { finding, verdictOf, type ResultParts } from './finding.js';
import { changedPaths, diffTrees, textOf, type Tree } from './tree.js';

// 7.4 Secrets and dependencies (FL S7 "7.4 Secrets and dependencies, D"; X2 "Protected-path change"). New findings
// only: what the head has that the BASE commit (the merged head the plan was made against) did not.
//
//   secrets       the ONE shared ruleset (`scanText`) over every file the head added or changed; a finding is new when
//                 its fingerprint (rule id + the value's hash, never the value) is nowhere in the base tree, so a file
//                 that only moved is not new and an old secret is not this Unit's. Critical: it fails the check
//   dependencies  the manifests' new entries (the tripwires' `addedDependencies`): approved by an X3 at 6.4 they are
//                 recorded, otherwise high (a dependency nobody approved)
//   protected     a changed path in the factory's protected set (instruction files, CODEOWNERS, CI, the factory's
//                 own knowledge, harness files): X2 is raised with the result bound to it, unless the head is the
//                 Push Broker's own write under an X2 approved for exactly that patch, or X2 was approved here
//
// The scans are in-process (data only: no repo code runs), like knowledge's census scan.

/** The value is hashed with its rule, so a fingerprint never reveals the value and never collides across rules. */
const secretPrint = (rule: string, value: string): string =>
  sha256Hex(canonicalJson(['secret', rule, sha256Hex(value)] as never));

interface SecretHit {
  readonly rule_id: string;
  readonly line: number;
  readonly print: string;
}

const scanFile = (t: Tree, path: string): SecretHit[] => {
  const text = textOf(t.get(path));
  if (text === null) return [];
  return scanText(text).map((m) => ({
    rule_id: m.rule_id,
    line: m.line,
    print: secretPrint(m.rule_id, m.value),
  }));
};

/** Secrets the head brings that the base tree does not have anywhere (pure). */
export function newSecretFindings(base: Tree, head: Tree): VerifyFinding[] {
  const d = diffTrees(base, head);
  const hits: Array<SecretHit & { path: string }> = [];
  for (const p of [...d.added, ...d.modified].sort()) {
    for (const h of scanFile(head, p)) hits.push({ ...h, path: p });
  }
  if (hits.length === 0) return [];
  const known = new Set<string>();
  for (const p of base.keys()) for (const h of scanFile(base, p)) known.add(h.print);
  return hits
    .filter((h) => !known.has(h.print))
    .map((h) =>
      finding('secret_new', 'critical', {
        rule_id: h.rule_id,
        path: h.path,
        line: h.line,
        message: `a new secret (${h.rule_id}) at ${h.path}:${h.line}`,
        key: h.print,
      }),
    );
}

/** Dependencies the head's manifests gained against the base (pure). */
export function dependencyFindings(base: Tree, head: Tree, x3Approved: boolean): VerifyFinding[] {
  const d = diffTrees(base, head);
  const out: VerifyFinding[] = [];
  for (const p of [...d.added, ...d.modified].filter(isManifest).sort()) {
    const after = textOf(head.get(p));
    if (after === null) continue;
    for (const dep of addedDependencies(p, textOf(base.get(p)), after)) {
      out.push(
        x3Approved
          ? finding('dependency_new', 'info', {
              rule_id: 'X3',
              path: p,
              message: `${p} adds ${dep} (approved by X3)`,
              key: dep,
            })
          : finding('dependency_unapproved', 'high', {
              path: p,
              message: `${p} adds ${dep} and no X3 approved a new dependency`,
              key: dep,
            }),
      );
    }
  }
  // a lockfile that moves with no manifest change is recorded: the reviewer of the pack sees it
  for (const p of changedPaths(d).filter(isLockfile)) {
    out.push(
      finding('dependency_new', 'info', {
        rule_id: 'lockfile',
        path: p,
        message: `the lockfile ${p} changed`,
      }),
    );
  }
  return out;
}

/** The protected-set rule a path falls under, or null. */
export const protectedRuleOf = (path: string): string | null =>
  protectedPushPath(path) ??
  (matchesAny(path, DEFAULT_PROTECTED_GLOBS) ? (path.split('/')[0] ?? path) : null);

/** The protected paths the head changed (pure). */
export function protectedFindings(base: Tree, head: Tree, covered: boolean): VerifyFinding[] {
  return changedPaths(diffTrees(base, head)).flatMap((p) => {
    const rule = protectedRuleOf(p);
    if (rule === null) return [];
    return [
      finding('protected_path', covered ? 'info' : 'high', {
        rule_id: rule.slice(0, 64),
        path: p,
        message: covered
          ? `the protected path ${p} changed, under an approved X2`
          : `the protected path ${p} changed: X2 decides it`,
      }),
    ];
  });
}

export async function checkSecretsDependencies(c: CheckContext): Promise<ResultParts> {
  const { req, base, head } = c;
  const covered = req.x2_covered || req.approved_gates.includes('X2');
  const prot = protectedFindings(base, head, covered);
  const findings = [
    ...newSecretFindings(base, head),
    ...dependencyFindings(base, head, req.x3_approved),
    ...prot,
  ];
  const kits = [
    {
      kit: 'secrets-scan',
      class: null,
      session_id: null,
      status: 'answered' as const,
      exit_code: null,
      detail: null,
    },
  ];
  const x2 = !covered && prot.length > 0;
  return {
    findings,
    kits,
    raised: x2 ? { kind: 'gate', gate: 'X2', reason_code: 'protected_path' } : null,
    verdict: verdictOf(findings, kits, x2 ? ['protected_path'] : []),
    rules_version: rulesVersion(),
  };
}
