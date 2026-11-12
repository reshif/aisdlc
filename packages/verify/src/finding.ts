import {
  QUARANTINE_FINDINGS,
  VERIFY_CHECK_OF_STEP,
  VERIFY_RESULT_SCHEMA,
  VerifyCheckResult,
  verifyResultHash,
  type CheckVerdict,
  type FindingKind,
  type FindingSeverity,
  type MutationScore,
  type StageOutcome,
  type VerifyFinding,
  type VerifyKitRun,
  type VerifyRaise,
  type VerifyRunRequest,
  type VerifyStep,
} from '@aisdlc/contracts';
import { canonicalJson, sha256Hex } from '@aisdlc/kernel';

// Findings, verdicts and results (PLAN M14.3): one place that says what fails a check, so every check, the service and
// core's 7.6 agree. Fail closed: a kit that gave no verdict makes the check `unknown`, and `unknown` is unmet.

/** One line, bounded, no newline (a finding ends up in a card; a newline there could start a heading). */
export const line = (s: string, max = 480): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

export function finding(
  kind: FindingKind,
  severity: FindingSeverity,
  o: {
    message: string;
    rule_id?: string | null;
    path?: string | null;
    line?: number | null;
    /** What makes the finding the same finding across runs (default: kind, rule, path, line). */
    key?: string;
  },
): VerifyFinding {
  const rule_id = o.rule_id ?? null;
  const path = o.path ?? null;
  const at = o.line ?? null;
  return {
    kind,
    severity,
    rule_id,
    path,
    line: at,
    message: line(o.message) || kind,
    fingerprint: sha256Hex(
      canonicalJson([kind, rule_id, path, o.key ?? (at === null ? null : String(at))] as never),
    ),
  };
}

/** Severities that fail a check. `medium` and below are recorded for the reviewer of the pack, and do not fail. */
export const FAILING: readonly FindingSeverity[] = ['high', 'critical'];
export const isFailing = (f: VerifyFinding): boolean =>
  FAILING.includes(f.severity) || QUARANTINE_FINDINGS.includes(f.kind);

/** A kit that answered nothing usable. */
export const unanswered = (k: VerifyKitRun): boolean => k.status !== 'answered';

/**
 * The verdict over what a check found. `failed` when a failing finding is there (other than the subject of the gate
 * the check raised: a person decides that one), else `unknown` when a kit gave no answer or a `kit_error` was found,
 * else `passed`. Nothing here can turn an unanswered kit into a pass.
 */
export function verdictOf(
  findings: readonly VerifyFinding[],
  kits: readonly VerifyKitRun[],
  gateSubject: readonly FindingKind[] = [],
): CheckVerdict {
  if (findings.some((f) => isFailing(f) && !gateSubject.includes(f.kind))) return 'failed';
  if (kits.some(unanswered) || findings.some((f) => f.kind === 'kit_error')) return 'unknown';
  return 'passed';
}

const order = (a: VerifyFinding, b: VerifyFinding): number => {
  const ka = `${a.kind}\0${a.path ?? ''}\0${String(a.line ?? 0).padStart(9, '0')}\0${a.fingerprint}`;
  const kb = `${b.kind}\0${b.path ?? ''}\0${String(b.line ?? 0).padStart(9, '0')}\0${b.fingerprint}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/** The inputs a result depends on, without the key, the command key or the attempt: what `inputs_sha256` hashes. */
export function inputsHash(req: VerifyRunRequest): string {
  const { review, command_key, attempt, ...rest } = req;
  void command_key;
  void attempt;
  return sha256Hex(
    canonicalJson({
      ...rest,
      review: review
        ? {
            agent_id: review.agent.agent_id,
            prompt_sha256: review.agent.prompt_sha256,
            artefacts: review.artefacts.map((a) => ({ type: a.type, sha256: a.sha256 })),
          }
        : null,
    } as never),
  );
}

export interface ResultParts {
  readonly findings: readonly VerifyFinding[];
  readonly kits: readonly VerifyKitRun[];
  readonly raised: VerifyRaise | null;
  readonly verdict: CheckVerdict;
  readonly mutation?: MutationScore | null;
  readonly rules_version?: string | null;
}

/** The result of one check: deterministic (findings sorted and de-duplicated, no clock), validated by the contract. */
export function resultOf(req: VerifyRunRequest, p: ResultParts): VerifyCheckResult {
  const seen = new Set<string>();
  const findings = [...p.findings].sort(order).filter((f) => {
    if (seen.has(f.fingerprint)) return false;
    seen.add(f.fingerprint);
    return true;
  });
  return VerifyCheckResult.parse({
    schema: VERIFY_RESULT_SCHEMA,
    item_id: req.item_id,
    unit_key: req.unit_key,
    step: req.step,
    check: VERIFY_CHECK_OF_STEP[req.step],
    repo: req.repo,
    lane: req.lane,
    base_sha: req.base_sha,
    head_sha: req.head_sha,
    inputs_sha256: inputsHash(req),
    verdict: p.verdict,
    findings: findings.slice(0, 500),
    kits: p.kits.slice(0, 64),
    raised: p.raised,
    mutation: p.mutation ?? null,
    rules_version: p.rules_version ?? null,
  });
}

/**
 * The stage outcome of a result, for the work engine: ET10 is the quarantine (Q1, the result is its evidence), a
 * raised gate is `gate_needed` with the result bound into the gate by hash, anything else completes the step with the
 * result's hash as its output (7.6 reads every result back by that hash and refuses an unmet one).
 */
export function outcomeOf(result: VerifyCheckResult): StageOutcome {
  const h = verifyResultHash(result);
  const r = result.raised;
  if (r?.kind === 'trigger')
    return { outcome: 'trigger', trigger: r.trigger, reason_code: r.reason_code, output_hash: h };
  if (r?.kind === 'gate')
    return { outcome: 'gate_needed', gate: r.gate, reason_code: r.reason_code, output_hash: h };
  return { outcome: 'completed', output_hash: h };
}

/** A gate a check can raise (X2 at 7.4, E2 at 7.5, E6 at 7.2). */
export type RaisedGate = Extract<VerifyRaise, { kind: 'gate' }>['gate'];

/** The latest result of each step (results in record order). */
export function latestByStep(
  results: readonly VerifyCheckResult[],
): Partial<Record<VerifyStep, VerifyCheckResult>> {
  const out: Partial<Record<VerifyStep, VerifyCheckResult>> = {};
  for (const r of results) out[r.step] = r;
  return out;
}

/** One step's result is met: passed, and the gate it raised (if any) approved. A trigger is never met. */
export function stepMet(
  r: VerifyCheckResult | undefined,
  approved: (gate: RaisedGate, step: VerifyStep) => boolean,
): boolean {
  return (
    r !== undefined &&
    r.verdict === 'passed' &&
    (r.raised === null || (r.raised.kind === 'gate' && approved(r.raised.gate, r.step)))
  );
}

/**
 * Whether S7's checks are met for one head (7.6 signs a passing Evidence Pack only when none is unmet: `decide76`): the latest result of
 * EVERY step 7.1 to 7.5 passed, and a gate a check raised was approved. A missing step, an `unknown`, a `failed` or
 * a pending or denied gate is unmet. Returns the steps that are not met (empty: met).
 */
export function unmetSteps(
  results: readonly VerifyCheckResult[],
  approved: (gate: RaisedGate, step: VerifyStep) => boolean,
): VerifyStep[] {
  const out: VerifyStep[] = [];
  const latest = latestByStep(results);
  for (const step of Object.keys(VERIFY_CHECK_OF_STEP) as VerifyStep[]) {
    if (!stepMet(latest[step], approved)) out.push(step);
  }
  return out;
}
