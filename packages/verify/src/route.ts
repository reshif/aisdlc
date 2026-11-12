import {
  S7_HANDOFF_TRIGGER,
  VERIFY_CHECK_OF_STEP,
  repairClassOf,
  verifyResultHash,
  type EvidenceStep,
  type RepairClass,
  type S7Disposition,
  type S7HandoffTrigger,
  type StageOutcome,
  type VerifyCheckResult,
  type VerifyStep,
} from '@aisdlc/contracts';
import { isFailing, latestByStep, outcomeOf, stepMet, type RaisedGate } from './finding.js';

// Where a failed S7 check sends the item (PLAN M14.4; FL S7: B9 to B12 and D2). Pure and deterministic: the decision is
// a function of the results for ONE head, the gates the item approved and how many rounds each edge has left under the
// item's pinned catalogue (core reads those through `@aisdlc/work`'s limits; this module has no number of its own).
//
//   7.2  a locked test the approved spec moved away from (`locked_test_change`): E6 (B12; the engine counts it and chains
//        G3o). No round left: D2 (ET3).
//   7.3  a failing finding classed `spec_ambiguous`: rework B10 (G2's portion again). No round left: D2 (ET3).
//   7.6  every step met: sign the passing pack. Otherwise, by precedence: a step with no verdict (`unknown`) is D2 (ET4);
//        a hard-fail or quarantine finding is D2 (ET5); a raised gate not approved is D2 (ET6); `approach_wrong` is
//        B11 (G3 again); `repairable` is B9 (6.4 again, counted against `et3_rounds`). An edge with no round left is
//        D2 (ET3). A step that has no result for the head at all is not decided here (`incomplete`): nothing to sign.
//
// A D2 never comes from a pass: every path that is not "every step met" ends in a pack marked not passing.

/** Whether an edge may loop once more under the item's catalogue limit (the item's rework budget is the engine's). */
export type EdgeRoom = (edge: 'B9' | 'B10' | 'B11' | 'B12') => boolean;

/** The loop B9 rounds count against (ET3 "repeat fail": the only S7 limit the flow gives a number). */
export const B9_LOOP = 'et3_rounds';

export type StepDecision =
  | { readonly kind: 'outcome'; readonly outcome: StageOutcome }
  | {
      readonly kind: 'handoff';
      readonly trigger: S7HandoffTrigger;
      readonly reason_code: string;
    };

const failingClasses = (r: VerifyCheckResult): RepairClass[] =>
  r.findings.filter(isFailing).map((f) => repairClassOf(f, r.step));

/** The outcome of one step 7.1 to 7.5 from its result (core calls it instead of `outcomeOf` from M14.4). */
export function decideStep(result: VerifyCheckResult, room: EdgeRoom): StepDecision {
  const r = result.raised;
  if (r?.kind === 'gate' && r.gate === 'E6') {
    return room('B12')
      ? { kind: 'outcome', outcome: outcomeOf(result) }
      : { kind: 'handoff', trigger: S7_HANDOFF_TRIGGER.limit, reason_code: 'b12_limit' };
  }
  if (
    r === null &&
    result.step === '7.3' &&
    result.verdict === 'failed' &&
    failingClasses(result).includes('spec_ambiguous')
  ) {
    return room('B10')
      ? {
          kind: 'outcome',
          outcome: { outcome: 'rework', edge: 'B10', reason_code: 'spec_ambiguous' },
        }
      : { kind: 'handoff', trigger: S7_HANDOFF_TRIGGER.limit, reason_code: 'b10_limit' };
  }
  return { kind: 'outcome', outcome: outcomeOf(result) };
}

export type Decision76 =
  | { readonly kind: 'incomplete'; readonly missing: readonly VerifyStep[] }
  | { readonly kind: 'decided'; readonly disposition: S7Disposition };

const STEPS = Object.keys(VERIFY_CHECK_OF_STEP) as VerifyStep[];

/** 7.6 over the results of one head (record order; the caller passes only results for that head). */
export function decide76(
  results: readonly VerifyCheckResult[],
  approved: (gate: RaisedGate, step: VerifyStep) => boolean,
  room: EdgeRoom,
): Decision76 {
  const latest = latestByStep(results);
  const missing = STEPS.filter((s) => latest[s] === undefined);
  if (missing.length > 0) return { kind: 'incomplete', missing };
  const unmet = STEPS.map((s) => latest[s] as VerifyCheckResult).filter(
    (r) => !stepMet(r, approved),
  );
  if (unmet.length === 0) return { kind: 'decided', disposition: { kind: 'passed' } };

  const handoff = (trigger: S7HandoffTrigger, reason_code: string): Decision76 => ({
    kind: 'decided',
    disposition: { kind: 'handoff', trigger, step: '7.6', reason_code },
  });
  const unknown = unmet.find((r) => r.verdict === 'unknown');
  if (unknown) return handoff(S7_HANDOFF_TRIGGER.unknown, `unknown_${unknown.step}`);
  const classes = unmet.flatMap((r) => failingClasses(r).map((c) => ({ c, step: r.step })));
  const hard = classes.find(
    (x) =>
      x.c === 'hard_fail' ||
      x.c === 'quarantine' ||
      x.c === 'spec_ambiguous' ||
      x.c === 'locked_test_change',
  );
  if (hard) return handoff(S7_HANDOFF_TRIGGER.hard_fail, `${hard.c}_${hard.step}`);
  // a raised gate the item did not approve, or a trigger that reached 7.6: a person decides
  const gate = unmet.find((r) => r.raised !== null);
  if (gate) return handoff(S7_HANDOFF_TRIGGER.gate, `unapproved_${gate.step}`);
  // a failed result with no failing finding to repair: nothing tells the coder what to fix
  const unexplained = unmet.find((r) => failingClasses(r).length === 0);
  if (unexplained) return handoff(S7_HANDOFF_TRIGGER.hard_fail, `unexplained_${unexplained.step}`);

  const wrong = classes.find((x) => x.c === 'approach_wrong');
  if (wrong) {
    return room('B11')
      ? {
          kind: 'decided',
          disposition: {
            kind: 'rework',
            edge: 'B11',
            loop: null,
            reason_code: `approach_wrong_${wrong.step}`,
          },
        }
      : handoff(S7_HANDOFF_TRIGGER.limit, 'b11_limit');
  }
  const first = classes[0];
  return room('B9')
    ? {
        kind: 'decided',
        disposition: {
          kind: 'rework',
          edge: 'B9',
          loop: B9_LOOP,
          reason_code: `repairable_${first?.step ?? '7.6'}`,
        },
      }
    : handoff(S7_HANDOFF_TRIGGER.limit, 'b9_limit');
}

/** The pack's view of each step: the result by hash, its verdict, whether it is met, its failing findings classed. */
export function evidenceSteps(
  results: readonly VerifyCheckResult[],
  approved: (gate: RaisedGate, step: VerifyStep) => boolean,
): EvidenceStep[] {
  const latest = latestByStep(results);
  return STEPS.map((step): EvidenceStep => {
    const r = latest[step];
    if (r === undefined) {
      return {
        step,
        check: VERIFY_CHECK_OF_STEP[step],
        result_sha256: null,
        verdict: null,
        inputs_sha256: null,
        raised: null,
        gate_approved: null,
        met: false,
        mutation: null,
        rules_version: null,
        findings: { total: 0, failing: 0, items: [] },
      };
    }
    const failing = r.findings.filter(isFailing);
    return {
      step,
      check: r.check,
      result_sha256: verifyResultHash(r),
      verdict: r.verdict,
      inputs_sha256: r.inputs_sha256,
      raised: r.raised,
      gate_approved: r.raised?.kind === 'gate' ? approved(r.raised.gate, step) : null,
      met: stepMet(r, approved),
      mutation: r.mutation,
      rules_version: r.rules_version,
      findings: {
        total: r.findings.length,
        failing: failing.length,
        items: failing.slice(0, 100).map((f) => ({
          kind: f.kind,
          severity: f.severity,
          repair_class: repairClassOf(f, step),
          rule_id: f.rule_id,
          path: f.path,
          line: f.line,
          fingerprint: f.fingerprint,
        })),
      },
    };
  });
}

/** The stage outcome a 7.6 disposition asks for (a handoff's outcome carries the D2 record's hash: `outputHash`). */
export function outcomeOf76(
  d: S7Disposition,
  packSha256: string,
  outputHash: string | null,
): StageOutcome {
  switch (d.kind) {
    case 'passed':
      return { outcome: 'completed', output_hash: packSha256 };
    case 'rework':
      return {
        outcome: 'rework',
        edge: d.edge,
        ...(d.loop !== null ? { loop: d.loop } : {}),
        reason_code: d.reason_code,
      };
    case 'handoff':
      return {
        outcome: 'trigger',
        trigger: d.trigger,
        reason_code: d.reason_code,
        output_hash: outputHash ?? packSha256,
      };
  }
}
