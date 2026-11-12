import {
  MIRROR_ECOSYSTEMS,
  PROBE_LOG_TAIL_CHARS,
  ProbeArgv,
  ProbeResult,
  type Fact,
  type ProbeOutcome,
  type ProbeStep,
  type ProbeTestCount,
} from '@aisdlc/contracts';
import { hashCanonical, sha256Hex } from '@aisdlc/kernel';
import type { SandboxRun } from '@aisdlc/ports';
import { scanText } from '@aisdlc/secrets-rules';
import { z } from 'zod';

// The onboarding probe's pure half (PLAN M16; OB §3.2 LF3, LF8; §5.6): what to run, how to ask the image to run it,
// and what a session's output says. No I/O. Everything a session reports is the word of the code that ran
// (untrusted): it is parsed strictly, capped, and secret-scanned before any of it is kept.

/** The probe's step runner in the onboarding image (`platform/sandbox/onboarding/aisdlc-probe`). */
export const PROBE_RUNNER = 'aisdlc-probe';
/** Where the runner leaves its report, logs and the JUnit report, under `/out`. */
export const PROBE_OUT_DIR = 'aisdlc-probe';

export interface ProbePlan {
  readonly setup: ProbeArgv | null;
  readonly test: ProbeArgv | null;
  /** Why a declared command could not be used (one line each). */
  readonly refused: readonly string[];
  readonly egress: ProbeResult['egress'];
}

/** An invocation as argv: split on spaces, plain tokens only (no shell is ever involved). */
export function argvOf(invocation: string): ProbeArgv | null {
  const p = ProbeArgv.safeParse(invocation.trim().split(/\s+/));
  return p.success ? p.data : null;
}

/**
 * What the probe runs, from the census's detector facts at the census head: the `setup` and `test` task-contract
 * commands (RS-BT-1), and the mirror needs its lockfile facts declare (LF8, RS-EN-1).
 */
export function planProbe(facts: readonly Fact[]): ProbePlan {
  const refused: string[] = [];
  const cmd = (name: 'setup' | 'test'): ProbeArgv | null => {
    const f = facts.find((x) => x.kind === 'task_command' && x.name === name);
    if (f?.kind !== 'task_command' || f.state !== 'found' || f.invocation === null) return null;
    const argv = argvOf(f.invocation);
    if (argv === null) refused.push(`${name}: the invocation is not plain argv`);
    return argv;
  };
  const setup = cmd('setup');
  const test = cmd('test');
  const declared = facts
    .flatMap((f) =>
      f.kind === 'lockfile'
        ? [{ ecosystem: f.ecosystem, manifest: f.manifest, lockfile: f.lockfile }]
        : [],
    )
    .sort((a, b) => (a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : 0))
    .slice(0, 200);
  const served = MIRROR_ECOSYSTEMS as readonly string[];
  const unserved = [
    ...new Set(declared.filter((d) => !served.includes(d.ecosystem)).map((d) => d.ecosystem)),
  ].sort();
  return { setup, test, refused, egress: { declared, unserved } };
}

/** The session's command: the runner, how many words the setup has, then setup and test. */
export function probeCommand(plan: ProbePlan): string[] {
  if (plan.test === null) throw new RangeError('a probe needs a test command');
  return [PROBE_RUNNER, String(plan.setup?.length ?? 0), ...(plan.setup ?? []), ...plan.test];
}

/** The probe's id for an S0 record at a census, the n-th attempt: also its grant id and its session id. */
export const probeIdOf = (s0Id: string, censusHash: string, attempt: number): string =>
  `probe-${sha256Hex(`${s0Id}|${censusHash}|${attempt}`).slice(0, 32)}`;

// ---------------------------------------------------------------- reading a session

const RunnerStep = z.strictObject({
  exit_code: z.number().int().min(-255).max(255),
  duration_ms: z.number().int().min(0),
});
const RunnerReport = z.strictObject({
  schema: z.literal('aisdlc-probe/1'),
  setup: RunnerStep.nullable(),
  test: RunnerStep.nullable(),
});

const MAX_REPORT = 64 * 1024;
const MAX_JUNIT = 4 * 1024 * 1024;

const text = (b: Uint8Array): string => Buffer.from(b).toString('utf8');

/** The end of a log, without control characters, or `null` when empty or when the secret ruleset hits it. */
export function logTail(log: string | null): string | null {
  if (log === null) return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  const clean = log.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const tail = clean.slice(-PROBE_LOG_TAIL_CHARS);
  if (tail.trim() === '') return null;
  return scanText(clean).length > 0 ? null : tail;
}

const attr = (tag: string, name: string): number | null => {
  const m = new RegExp(`\\b${name}="(\\d{1,9})"`).exec(tag);
  return m ? Number(m[1]) : null;
};

/** Counts from a JUnit XML report: the `<testsuites>` root's totals, else the sum of its `<testsuite>` elements. */
export function countJunit(xml: string): ProbeTestCount | null {
  if (xml.length > MAX_JUNIT) return null;
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0];
  const suites = root && attr(root, 'tests') !== null ? [root] : xml.match(/<testsuite\b[^>]*>/g);
  if (!suites || suites.length === 0) return null;
  let total = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of suites) {
    const t = attr(s, 'tests');
    if (t === null) return null;
    total += t;
    failed += (attr(s, 'failures') ?? 0) + (attr(s, 'errors') ?? 0);
    skipped += attr(s, 'skipped') ?? 0;
  }
  return {
    total,
    failed,
    skipped,
    passed: Math.max(0, total - failed - skipped),
    source: 'junit',
  };
}

const num = (s: string, re: RegExp): number | null => {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
};

/** Counts from a known runner's summary line in the log (pytest, vitest, jest, node --test, mocha). */
export function countSummary(log: string): ProbeTestCount | null {
  const lines = log.split(/\r?\n/).reverse();
  const from = (passed: number | null, failed: number | null, skipped: number | null) => {
    const total = (passed ?? 0) + (failed ?? 0) + (skipped ?? 0);
    return { total, passed: passed ?? 0, failed: failed ?? 0, skipped: skipped ?? 0 };
  };
  for (const l of lines) {
    // pytest: "==== 3 passed, 1 skipped in 0.12s ====" or "no tests ran in 0.01s"
    if (/^=+ .* in [\d.]+s(?: \([^)]*\))? =+$/.test(l.trim())) {
      if (/no tests ran/.test(l)) return { ...from(0, 0, 0), source: 'summary' };
      const failed = (num(l, /(\d+) failed/) ?? 0) + (num(l, /(\d+) errors?/) ?? 0);
      return {
        ...from(num(l, /(\d+) passed/), failed, num(l, /(\d+) skipped/)),
        source: 'summary',
      };
    }
    // jest: "Tests:       1 failed, 3 passed, 4 total"
    const jest = /^Tests:\s+(.*?)(\d+) total/.exec(l.trim());
    if (jest) {
      const failed = num(l, /(\d+) failed/) ?? 0;
      const skipped = num(l, /(\d+) skipped/) ?? 0;
      const total = Number(jest[2]);
      return {
        total,
        passed: num(l, /(\d+) passed/) ?? Math.max(0, total - failed - skipped),
        failed,
        skipped,
        source: 'summary',
      };
    }
    // vitest: "      Tests  1 failed | 3 passed (4)"
    const vt = /^Tests\s+(.*)\((\d+)\)$/.exec(l.trim());
    if (vt) {
      const failed = num(l, /(\d+) failed/) ?? 0;
      const skipped = num(l, /(\d+) skipped/) ?? 0;
      const total = Number(vt[2]);
      return {
        total,
        passed: num(l, /(\d+) passed/) ?? Math.max(0, total - failed - skipped),
        failed,
        skipped,
        source: 'summary',
      };
    }
  }
  // node --test: "# tests 4" / "ℹ tests 4", with "# pass" and "# fail"
  const nt = /^(?:#|ℹ) tests (\d+)$/m.exec(log);
  if (nt) {
    const total = Number(nt[1]);
    const failed = num(log, /^(?:#|ℹ) fail (\d+)$/m) ?? 0;
    const skipped = num(log, /^(?:#|ℹ) skipped (\d+)$/m) ?? 0;
    return {
      total,
      passed: num(log, /^(?:#|ℹ) pass (\d+)$/m) ?? Math.max(0, total - failed - skipped),
      failed,
      skipped,
      source: 'summary',
    };
  }
  // mocha: "  3 passing (12ms)", "  1 failing"
  const mp = num(log, /^\s+(\d+) passing\b/m);
  if (mp !== null) {
    return {
      ...from(mp, num(log, /^\s+(\d+) failing\b/m), num(log, /^\s+(\d+) pending\b/m)),
      source: 'summary',
    };
  }
  return null;
}

const NO_COUNT: ProbeTestCount = {
  total: null,
  passed: null,
  failed: null,
  skipped: null,
  source: null,
};

export interface ProbeBase {
  readonly probe_id: string;
  readonly s0_id: string;
  readonly repo: string;
  readonly census_hash: string;
  readonly baseline_sha: string;
  readonly image: string | null;
  readonly recorded_at: string;
}

const step = (argv: ProbeArgv | null): ProbeStep => ({
  argv,
  exit_code: null,
  duration_ms: null,
  log_sha256: null,
  log_tail: null,
});

/** A probe that did not run (or whose run counts for nothing): the reason, the plan, and no session. */
export function notRunResult(
  base: ProbeBase,
  plan: ProbePlan | null,
  outcome: ProbeOutcome,
  detail: string,
): ProbeResult {
  return ProbeResult.parse({
    ...base,
    outcome,
    detail: detail.slice(0, 300),
    session: null,
    setup: step(plan?.setup ?? null),
    test: step(plan?.test ?? null),
    tests: NO_COUNT,
    out_scan: { clean: true, canary: false, rule_ids: [] },
    egress: plan?.egress ?? { declared: [], unserved: [] },
  });
}

/** The result of a session that ran: the runner's report, the logs, the test count, the outcome. */
export function resultOfRun(base: ProbeBase, plan: ProbePlan, run: SandboxRun): ProbeResult {
  const file = (name: string) =>
    run.out.find(
      (f) => f.path === `${PROBE_OUT_DIR}/${name}` || f.path === `./${PROBE_OUT_DIR}/${name}`,
    );
  const session = {
    status: run.status,
    exit_code: run.exit_code,
    duration_ms: run.duration_ms,
    peers: [...run.peers],
    quarantined: run.quarantined,
  };
  const out_scan = {
    clean: run.out_scan.clean,
    canary: run.out_scan.canary,
    rule_ids: [...new Set(run.out_scan.findings.map((f) => f.rule_id))].sort(),
  };
  const common = { ...base, session, out_scan, egress: plan.egress };
  const report = (() => {
    const f = file('result.json');
    if (!f || f.size > MAX_REPORT) return null;
    try {
      const p = RunnerReport.safeParse(JSON.parse(text(f.content)));
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  })();
  const stepOf = (name: 'setup' | 'test', argv: ProbeArgv | null): ProbeStep => {
    const r = report?.[name] ?? null;
    const log = file(`${name}.log`);
    return {
      argv,
      exit_code: r?.exit_code ?? null,
      duration_ms: r?.duration_ms ?? null,
      log_sha256: log ? log.sha256 : null,
      log_tail: log ? logTail(text(log.content)) : null,
    };
  };
  const setup = stepOf('setup', plan.setup);
  const test = stepOf('test', plan.test);
  const done = (outcome: ProbeOutcome, detail: string | null, tests = NO_COUNT) =>
    ProbeResult.parse({ ...common, outcome, detail, setup, test, tests });

  if (run.quarantined || run.out_scan.canary) {
    return done('void', 'a factory canary came out of the session: its output is withheld');
  }
  if (run.status !== 'exited')
    return done('void', `the session did not run to its end: ${run.status}`);
  if (report === null) return done('void', 'the probe runner left no readable report');
  if ((plan.setup === null) !== (report.setup === null)) {
    return done('void', 'the report does not match the setup that was asked for');
  }
  const ok =
    (report.setup === null || report.setup.exit_code === 0) && report.test?.exit_code === 0;
  if ((run.exit_code === 0) !== ok) {
    return done('void', 'the report and the session exit code disagree');
  }
  if (report.setup !== null && report.setup.exit_code !== 0) {
    return done('failed', `setup exited ${report.setup.exit_code}`);
  }
  if (report.test === null) return done('void', 'the test did not run');
  const junit = file('junit.xml');
  const counted =
    (junit ? countJunit(text(junit.content)) : null) ??
    (() => {
      const log = file('test.log');
      return log ? countSummary(text(log.content)) : null;
    })();
  const tests = counted ?? NO_COUNT;
  if (report.test.exit_code !== 0)
    return done('failed', `test exited ${report.test.exit_code}`, tests);
  if (counted === null || counted.total === null) {
    return done('tests_uncounted', 'the test exited 0 but no test count could be read', tests);
  }
  if (counted.total === 0) return done('no_tests', 'the test exited 0 and ran no test', tests);
  if ((counted.failed ?? 0) > 0) {
    return done(
      'failed',
      `the test exited 0 but its report counts ${counted.failed} failures`,
      tests,
    );
  }
  return done('passed', null, tests);
}

/** `hashCanonical` of a result: what a card 2 approval binds. */
export const probeResultHash = (r: ProbeResult): string => hashCanonical(r);
