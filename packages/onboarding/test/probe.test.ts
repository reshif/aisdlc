import type { Fact, ProbeResult } from '@aisdlc/contracts';
import { FakeSandbox, type FakeSandboxOutcome, type SandboxRun } from '@aisdlc/ports';
import { makeCanary } from '@aisdlc/secrets-rules';
import { describe, expect, it } from 'vitest';
import {
  argvOf,
  countJunit,
  countSummary,
  evaluateLightFloors,
  lf3Of,
  logTail,
  notRunResult,
  planProbe,
  probeCommand,
  probeIdOf,
  resultOfRun,
  type LightFloorInputs,
  type ProbeBase,
} from '../src/index.js';
import { nodeFacts } from './light-fixtures.js';

// M16: the probe's pure half. What runs (the census's task contract), how the image is asked, and what a session's
// output is worth (its own word: parsed strictly; a void, quarantined or disagreeing run counts for nothing).

const HEAD = { census_hash: 'c'.repeat(64), baseline_sha: 'd'.repeat(40) };
const BASE: ProbeBase = {
  probe_id: probeIdOf('01930000-0000-7000-8000-000000000001', HEAD.census_hash, 1),
  s0_id: '01930000-0000-7000-8000-000000000001',
  repo: 'acme/app',
  ...HEAD,
  image: `sha256:${'1'.repeat(64)}`,
  recorded_at: '2026-11-12T10:00:00.000Z',
};

async function sessionOf(o: FakeSandboxOutcome): Promise<SandboxRun> {
  const r = await new FakeSandbox(() => o).run({
    session_id: 'probe-session-1',
    class: 'K-exec',
    command: ['aisdlc-probe', '0', 'npm', 'test'],
    repo: [{ path: 'package.json', content: '{}' }],
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const report = (setup: number | null, test: number | null) =>
  JSON.stringify({
    schema: 'aisdlc-probe/1',
    setup: setup === null ? null : { exit_code: setup, duration_ms: 10 },
    test: test === null ? null : { exit_code: test, duration_ms: 20 },
  });

const JUNIT = (tests: number, failures = 0, skipped = 0) =>
  `<?xml version="1.0"?><testsuites name="pytest tests" tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}"><testsuite name="pytest" tests="${tests}"/></testsuites>`;

describe('what the probe runs', () => {
  it('setup and test from the task-contract facts, as plain argv; the lockfiles declare the mirror needs', () => {
    const p = planProbe(nodeFacts());
    expect(p.setup).toEqual(['npm', 'ci']);
    expect(p.test).toEqual(['npm', 'test']);
    expect(p.egress).toEqual({
      declared: [{ ecosystem: 'npm', manifest: 'package.json', lockfile: 'package-lock.json' }],
      unserved: [],
    });
    expect(probeCommand(p)).toEqual(['aisdlc-probe', '2', 'npm', 'ci', 'npm', 'test']);
  });
  it('no test command: nothing to run; a missing setup is allowed', () => {
    const p = planProbe(nodeFacts({ commands: false }));
    expect([p.setup, p.test]).toEqual([null, null]);
    expect(() => probeCommand(p)).toThrow();
    const testOnly = planProbe(
      nodeFacts().filter((f) => !(f.kind === 'task_command' && f.name === 'setup')),
    );
    expect(probeCommand(testOnly)).toEqual(['aisdlc-probe', '0', 'npm', 'test']);
  });
  it('an invocation that is not plain argv is refused, never handed to a shell', () => {
    expect(argvOf('make test')).toEqual(['make', 'test']);
    for (const bad of ['npm test; curl x', 'make $(evil)', 'a | b', 'x `y`', '']) {
      expect(argvOf(bad), bad).toBeNull();
    }
    const facts: Fact[] = nodeFacts().map((f) =>
      f.kind === 'task_command' && f.name === 'test' ? { ...f, invocation: 'npm test && rm' } : f,
    );
    const p = planProbe(facts);
    expect(p.test).toBeNull();
    expect(p.refused).toEqual(['test: the invocation is not plain argv']);
  });
  it('an ecosystem the mirror does not serve is an LF8 gap', () => {
    const facts: Fact[] = [
      ...nodeFacts(),
      {
        kind: 'lockfile',
        detector: 'lockfiles',
        evidence: [],
        manifest: 'go.mod',
        ecosystem: 'go',
        state: 'present',
        lockfile: 'go.sum',
        inherited: false,
        frozen_install: 'feasible',
        reason: 'lockfile present',
      },
    ];
    expect(planProbe(facts).egress.unserved).toEqual(['go']);
  });
  it('the probe id is stable per record, census and attempt', () => {
    expect(BASE.probe_id).toMatch(/^probe-[0-9a-f]{32}$/);
    expect(probeIdOf(BASE.s0_id, HEAD.census_hash, 2)).not.toBe(BASE.probe_id);
  });
});

describe('counting the tests', () => {
  it('a JUnit report: the root totals, else the suites summed', () => {
    expect(countJunit(JUNIT(5, 1, 1))).toEqual({
      total: 5,
      passed: 3,
      failed: 1,
      skipped: 1,
      source: 'junit',
    });
    expect(
      countJunit('<testsuite tests="2" failures="0"/><testsuite tests="3" errors="1"/>'),
    ).toMatchObject({ total: 5, failed: 1 });
    expect(countJunit('<html/>')).toBeNull();
  });
  it('a runner summary: pytest, jest, vitest, node --test, mocha', () => {
    expect(countSummary('...\n========= 3 passed, 1 skipped in 0.12s =========\n')).toMatchObject({
      total: 4,
      passed: 3,
      skipped: 1,
    });
    expect(countSummary('=== no tests ran in 0.01s ===')).toMatchObject({ total: 0 });
    expect(countSummary('Tests:       1 failed, 3 passed, 4 total')).toMatchObject({
      total: 4,
      failed: 1,
    });
    expect(countSummary('      Tests  2 passed (2)')).toMatchObject({ total: 2, passed: 2 });
    expect(countSummary('# tests 4\n# pass 4\n# fail 0\n')).toMatchObject({ total: 4, passed: 4 });
    expect(countSummary('  3 passing (12ms)\n  1 failing\n')).toMatchObject({
      total: 4,
      failed: 1,
    });
    expect(countSummary('all good!')).toBeNull();
  });
});

describe('what a session says', () => {
  const plan = planProbe(nodeFacts());
  const ok = (extra: Record<string, string> = {}) =>
    sessionOf({
      exit_code: 0,
      out: {
        'aisdlc-probe/result.json': report(0, 0),
        'aisdlc-probe/test.log': 'ok\n',
        'aisdlc-probe/junit.xml': JUNIT(4),
        ...extra,
      },
    });

  it('passed: setup and test exited 0 and tests were counted', async () => {
    const r = resultOfRun(BASE, plan, await ok());
    expect(r.outcome).toBe('passed');
    expect(r.tests).toMatchObject({ total: 4, source: 'junit' });
    expect(r.session).toMatchObject({ status: 'exited', peers: ['mirror'], quarantined: false });
    expect(r.setup).toMatchObject({ argv: ['npm', 'ci'], exit_code: 0 });
    expect(r.test.log_tail).toBe('ok\n');
    expect(lf3Of(r, HEAD).state).toBe('met');
  });
  it('failed setup, failed test, no tests, uncounted tests', async () => {
    const setupFail = await sessionOf({
      exit_code: 1,
      out: { 'aisdlc-probe/result.json': report(1, null) },
    });
    expect(resultOfRun(BASE, plan, setupFail).outcome).toBe('failed');
    const testFail = await sessionOf({
      exit_code: 1,
      out: { 'aisdlc-probe/result.json': report(0, 2), 'aisdlc-probe/junit.xml': JUNIT(3, 1) },
    });
    expect(resultOfRun(BASE, plan, testFail).outcome).toBe('failed');
    const none = resultOfRun(BASE, plan, await ok({ 'aisdlc-probe/junit.xml': JUNIT(0) }));
    expect([none.outcome, lf3Of(none, HEAD).state]).toEqual(['no_tests', 'unmet']);
    const uncounted = await sessionOf({
      exit_code: 0,
      out: { 'aisdlc-probe/result.json': report(0, 0), 'aisdlc-probe/test.log': 'fine' },
    });
    const u = resultOfRun(BASE, plan, uncounted);
    expect([u.outcome, lf3Of(u, HEAD).state]).toEqual(['tests_uncounted', 'unknown']);
  });
  it('a report that lies about failures it counted is a failure', async () => {
    const r = resultOfRun(BASE, plan, await ok({ 'aisdlc-probe/junit.xml': JUNIT(3, 2) }));
    expect(r.outcome).toBe('failed');
  });
  it('void: no report, a report the exit code contradicts, a run that did not end, a canary', async () => {
    const noReport = await sessionOf({ exit_code: 0, out: {} });
    expect(resultOfRun(BASE, plan, noReport).outcome).toBe('void');
    const lie = await sessionOf({
      exit_code: 1,
      out: { 'aisdlc-probe/result.json': report(0, 0) },
    });
    expect(resultOfRun(BASE, plan, lie).outcome).toBe('void');
    const garbage = await sessionOf({ exit_code: 0, out: { 'aisdlc-probe/result.json': '{' } });
    expect(resultOfRun(BASE, plan, garbage).outcome).toBe('void');
    const timedOut = await sessionOf({ status: 'timed_out' });
    expect(resultOfRun(BASE, plan, timedOut).outcome).toBe('void');
    const canary = await sessionOf({
      exit_code: 0,
      stdout: makeCanary('probe'),
      out: { 'aisdlc-probe/result.json': report(0, 0), 'aisdlc-probe/junit.xml': JUNIT(4) },
    });
    const c = resultOfRun(BASE, plan, canary);
    expect([c.outcome, c.out_scan.canary, lf3Of(c, HEAD).state]).toEqual(['void', true, 'unknown']);
  });
  it('a log tail with a secret is dropped, never kept; control characters are removed', () => {
    expect(logTail('ok\u0007\n')).toBe('ok\n');
    expect(logTail(`key: ${makeCanary('probe')}\n`)).toBeNull();
    expect(logTail('   ')).toBeNull();
    expect(logTail('x'.repeat(5000))?.length).toBe(2000);
  });
});

describe('LF3: card 2 exits only on a passed probe of its own census head', () => {
  const passed = (over: Partial<ProbeResult> = {}): ProbeResult => ({
    ...notRunResult(BASE, planProbe(nodeFacts()), 'passed', 'x'),
    detail: null,
    tests: { total: 3, passed: 3, failed: 0, skipped: 0, source: 'junit' },
    ...over,
  });
  it('no probe, another head, nothing ran: unknown; failed, no tests, no command: unmet', () => {
    expect(lf3Of(null, HEAD)).toEqual({ state: 'unknown', reasons: ['probe_not_run'] });
    expect(lf3Of(passed({ baseline_sha: 'e'.repeat(40) }), HEAD).reasons).toEqual([
      'probe_of_another_head',
    ]);
    for (const [o, s] of [
      ['not_allowed', 'unknown'],
      ['b1_blocked', 'unknown'],
      ['no_image', 'unknown'],
      ['unavailable', 'unknown'],
      ['void', 'unknown'],
      ['failed', 'unmet'],
      ['no_tests', 'unmet'],
      ['no_test_command', 'unmet'],
    ] as const) {
      expect(lf3Of(notRunResult(BASE, null, o, 'x'), HEAD).state, o).toBe(s);
    }
    expect(lf3Of(passed(), HEAD).state).toBe('met');
    expect(
      lf3Of(passed({ out_scan: { clean: false, canary: false, rule_ids: ['x'] } }), HEAD).state,
    ).toBe('unmet');
  });
});

describe('the Light floors', () => {
  const all: LightFloorInputs = {
    blocking_findings: 0,
    scan_complete: true,
    controls_blocking_open: 0,
    controls_attested: true,
    head: HEAD,
    probe: {
      ...notRunResult(BASE, planProbe(nodeFacts()), 'passed', 'x'),
      detail: null,
      tests: { total: 3, passed: 3, failed: 0, skipped: 0, source: 'junit' },
    },
    harness_inventoried: true,
    isolation_test_passed: true,
    instructions_affirmed: true,
    claims_share: 0.95,
    intent_attested: true,
    practices_attested: true,
    operations_attested: true,
    apply_on_merge_known: true,
  };
  it('every floor met: Light can be signed', () => {
    const r = evaluateLightFloors(all);
    expect(r.met).toBe(true);
    expect(r.floors.map((f) => f.floor)).toEqual([
      'LF1',
      'LF2',
      'LF3',
      'LF4',
      'LF5',
      'LF6',
      'LF7',
      'LF8',
    ]);
  });
  it('fails closed: each unknown input is an unknown floor, never a met one', () => {
    const nulls: Array<[keyof LightFloorInputs, string]> = [
      ['blocking_findings', 'LF1'],
      ['controls_attested', 'LF2'],
      ['probe', 'LF3'],
      ['isolation_test_passed', 'LF4'],
      ['instructions_affirmed', 'LF5'],
      ['claims_share', 'LF6'],
      ['operations_attested', 'LF7'],
    ];
    for (const [k, floor] of nulls) {
      const r = evaluateLightFloors({ ...all, [k]: null });
      expect(r.met, k).toBe(false);
      expect(r.floors.find((f) => f.floor === floor)?.state, k).toBe('unknown');
    }
    expect(
      evaluateLightFloors({ ...all, probe: null }).floors.find((f) => f.floor === 'LF8')?.state,
    ).toBe('unknown');
  });
  it('unmet with the reason', () => {
    const r = evaluateLightFloors({
      ...all,
      blocking_findings: 1,
      controls_blocking_open: 2,
      claims_share: 0.5,
      probe: { ...all.probe!, egress: { declared: [], unserved: ['go'] } },
    });
    const by = Object.fromEntries(r.floors.map((f) => [f.floor, f]));
    expect(by['LF1']).toEqual({ floor: 'LF1', state: 'unmet', reasons: ['blocking_finding_open'] });
    expect(by['LF2']?.reasons).toEqual(['protect_main_not_effective']);
    expect(by['LF6']?.reasons).toEqual(['claims_below_floor']);
    expect(by['LF8']?.reasons).toEqual(['mirror_does_not_serve:go']);
  });
});
