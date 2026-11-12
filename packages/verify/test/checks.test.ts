import { LANES } from '@aisdlc/catalogue';
import {
  DEFAULT_CONSTITUTION,
  LaneValues,
  VerifyCheckResult,
  verifyResultHash,
  type VerifyCheckResult as Result,
} from '@aisdlc/contracts';
import { RULES } from '@aisdlc/secrets-rules';
import { describe, expect, it } from 'vitest';
import { outcomeOf, unmetSteps } from '../src/index.js';
import { FIXED, check, headOf, request, world } from './fixtures.js';

// One test (at least) per check of S7 (PLAN M14.3 exit: "one test per check"), pass and fail, over the runner with a
// scripted sandbox, the fake code host, the fake reviewer and the fake holdout store.

const kinds = (r: Result) => r.findings.map((f) => f.kind);
const planted = (): string => {
  const v = RULES.find((r) => r.id === 'aws-access-key-id')?.fixtures.positive()[0];
  if (!v) throw new Error('no fixture');
  return v;
};

describe('7.1 deterministic checks', () => {
  it('passes when every command of the contract is green on the head', async () => {
    const w = world();
    const r = await check(w, '7.1');
    expect(r.verdict).toBe('passed');
    expect(r.check).toBe('deterministic');
    // test and check are the same argv here (`node --test`), so `npm test` and `npm run check` each ran once, in O
    expect(w.specs.map((s) => s.command.join(' '))).toEqual(['npm test', 'npm run check']);
    expect(w.specs.every((s) => s.class === 'O' && s.gateway_key === undefined)).toBe(true);
    expect(outcomeOf(r)).toEqual({ outcome: 'completed', output_hash: verifyResultHash(r) });
  });

  it('fails when a command is red, naming the command', async () => {
    const w = world();
    w.head = headOf(w.base, {}); // the head without the fix: the oracle-less `npm test` passes...
    w.script = (_s, cmd) =>
      cmd === 'npm run check' ? { exit_code: 1, stdout: 'not ok 1 - lint\n' } : undefined;
    const r = await check(w, '7.1');
    expect(r.verdict).toBe('failed');
    expect(r.findings).toEqual([
      expect.objectContaining({ kind: 'command_failed', rule_id: 'check', severity: 'high' }),
    ]);
  });

  it('is unknown (never a pass) when a session gives no verdict, and failed with no test command', async () => {
    const w = world();
    w.script = (_s, cmd) => (cmd === 'npm test' ? { status: 'timed_out' } : undefined);
    const r = await check(w, '7.1');
    expect(r.verdict).toBe('unknown');
    expect(kinds(r)).toContain('command_void');

    const n = world();
    n.files.set('acme/synth', 'a'.repeat(40), headOf(n.base, { 'package.json': '{"name":"x"}' }));
    n.head = headOf(n.base, { 'package.json': '{"name":"x"}' });
    const none = await check(n, '7.1');
    expect(none.verdict).toBe('failed');
    expect(kinds(none)).toEqual(['no_test_command']);
  });
});

describe('7.2 test integrity: locks, stub probe, mutation, holdout', () => {
  it('passes: the lock holds, the oracle is red on the stub, the mutant is killed', async () => {
    const w = world();
    const r = await check(w, '7.2');
    expect(r.verdict, JSON.stringify(r.findings)).toBe('passed');
    expect(r.raised).toBeNull();
    expect(r.mutation).toMatchObject({ total: 1, killed: 1, survived: 0, unknown: 0 });
    expect(kinds(r)).toEqual(['holdout_none']);
    // the stub run had the base's (buggy) implementation and the head's oracle
    const stub = w.specs[0];
    expect(stub?.command.join(' ')).toBe(`npm test -- ${w.oraclePath}`);
    expect(
      Buffer.from(stub?.repo.find((f) => f.path === 'src/calc.js')?.content ?? '').toString(),
    ).not.toContain('a + b');
  });

  it('Q1: the stub probe passes (the oracle is green with the implementation taken out) -> ET10', async () => {
    const w = world();
    w.script = (_s, cmd) => (cmd.startsWith('npm test -- ') ? { exit_code: 0 } : undefined);
    const r = await check(w, '7.2');
    expect(r.raised).toEqual({
      kind: 'trigger',
      trigger: 'ET10',
      reason_code: 'stub_probe_passed',
    });
    expect(r.verdict).toBe('failed');
    expect(kinds(r)).toEqual(['stub_probe_passed']);
    expect(outcomeOf(r)).toEqual({
      outcome: 'trigger',
      trigger: 'ET10',
      reason_code: 'stub_probe_passed',
      output_hash: verifyResultHash(r),
    });
  });

  it('Q1: a locked test edited after its lock -> ET10, and no kit runs', async () => {
    const w = world();
    w.head = headOf(w.head, { [w.oraclePath]: `${w.oracleCode}// relaxed\n` });
    const r = await check(w, '7.2');
    expect(r.raised).toMatchObject({ trigger: 'ET10', reason_code: 'locked_test_edit' });
    expect(kinds(r)).toEqual(['locked_test_edit']);
    expect(w.specs).toHaveLength(0);
  });

  it('Q1: a new test that cannot fail -> ET10', async () => {
    const w = world();
    w.head = headOf(w.head, {
      'test/extra.test.js':
        "const test = require('node:test');\nconst assert = require('node:assert');\ntest('ok', () => { assert.ok(true); });\n",
    });
    const r = await check(w, '7.2');
    expect(r.raised).toMatchObject({ trigger: 'ET10', reason_code: 'stub_test' });
  });

  it('fails when the tests kill too few mutants (no oracle locked, every test green)', async () => {
    const w = world();
    w.script = () => ({ exit_code: 0 });
    const r = await check(w, '7.2', { locks: {}, oracles: [] });
    expect(r.verdict).toBe('failed');
    expect(r.mutation).toMatchObject({ total: 1, killed: 0, survived: 1 });
    expect(kinds(r)).toEqual(
      expect.arrayContaining(['mutation_score_low', 'mutation_survived', 'stub_probe_skipped']),
    );
  });

  it('fails when a holdout test fails on the head; the holdout path is never recorded', async () => {
    const w = world();
    w.holdouts.set(request(w, '7.2').item_id, {
      set_id: 'hs-1',
      files: [{ path: 'holdout/secret-case.test.js', content: 'hidden' }],
    });
    w.head = headOf(w.head, { 'src/calc.js': FIXED.replace('a + b', 'a+b') }); // "fixed" in a way the holdout catches
    w.script = (_s, cmd) =>
      cmd === 'npm test -- holdout/secret-case.test.js'
        ? { exit_code: 1 }
        : cmd.startsWith('npm test -- ')
          ? { exit_code: 1 }
          : { exit_code: 0 };
    const r = await check(w, '7.2');
    expect(kinds(r)).toContain('holdout_failed');
    expect(r.verdict).toBe('failed');
    expect(JSON.stringify(r)).not.toContain('secret-case');
  });

  it('is unknown when the holdout store cannot be read', async () => {
    const w = world();
    w.holdouts.breakIt();
    const r = await check(w, '7.2');
    expect(r.verdict).toBe('unknown');
  });
});

describe('7.3 spec conformance (D+A)', () => {
  it('passes: the approved oracle is bound, green on the head, and A5 finds nothing', async () => {
    const w = world();
    const r = await check(w, '7.3');
    expect(r.verdict, JSON.stringify(r.findings)).toBe('passed');
    expect(w.reviewer.calls).toHaveLength(1);
    const call = w.reviewer.calls[0];
    expect(call?.check).toBe('spec_conformance');
    // the change and the spec reach the reviewer as fenced data, never the key in the text
    expect(call?.user).toContain('src/calc.js');
    expect(call?.user).not.toContain('aisk_');
    expect(JSON.stringify(r)).not.toContain('aisk_');
  });

  it('fails on an approved oracle the head does not carry, and on an oracle red on the head', async () => {
    const w = world();
    const r = await check(w, '7.3', {
      oracles: [
        ...request(w, '7.3').oracles,
        { oracle_id: 'O2', requirement_id: 'REQ-2', spec_sha256: 'c'.repeat(64) },
      ],
    });
    expect(r.verdict).toBe('failed');
    expect(kinds(r)).toContain('oracle_missing');

    const red = world();
    red.head = headOf(red.head, { 'src/calc.js': 'exports.add = (a, b) => a - b;\n' });
    const r2 = await check(red, '7.3');
    expect(kinds(r2)).toContain('oracle_failing');
  });

  it('fails on a high A5 finding; is unknown with no reviewer, an invalid answer, or an unlocked prompt', async () => {
    const w = world();
    w.reviewer.scripted(() => ({
      verdict: 'findings',
      findings: [
        {
          severity: 'high',
          location: { path: 'src/calc.js', line: 1 },
          message: 'mul is not in the spec',
        },
      ],
    }));
    const r = await check(w, '7.3');
    expect(r.verdict).toBe('failed');
    expect(kinds(r)).toEqual(['conformance_review']);

    const none = await check(world(), '7.3', { review: null });
    expect(none.verdict).toBe('unknown');

    const bad = world();
    bad.reviewer.scripted(() => 'I think it is fine.');
    expect((await check(bad, '7.3')).verdict).toBe('unknown');

    const unlocked = world();
    const rv = request(unlocked, '7.3').review;
    const tampered = await check(unlocked, '7.3', {
      review: rv ? { ...rv, agent: { ...rv.agent, prompt_sha256: 'd'.repeat(64) } } : null,
    });
    expect(tampered.verdict).toBe('unknown');
    expect(unlocked.reviewer.calls).toHaveLength(0);
  });

  it('an unreachable gateway is transient: no result, the step is asked again', async () => {
    const w = world();
    w.reviewer.scripted(() => ({ kind: 'unreachable', code: 'unreachable' }));
    w.files.set('acme/synth', 'b'.repeat(40), w.head);
    const r = await w.runner.run(request(w, '7.3'));
    expect(r.ok).toBe(false);
  });
});

describe('7.4 secrets and dependencies, new findings only; X2 on protected paths', () => {
  it('passes on a clean head, with the ruleset version recorded', async () => {
    const r = await check(world(), '7.4');
    expect(r.verdict).toBe('passed');
    expect(r.raised).toBeNull();
    expect(r.rules_version).toMatch(/^secrets-rules\//);
  });

  it('fails on a NEW secret, names only the rule; a secret the base already had (even moved) is not new', async () => {
    const w = world();
    const secret = planted();
    w.head = headOf(w.head, { 'src/config.js': `module.exports = '${secret}';\n` });
    const r = await check(w, '7.4');
    expect(r.verdict).toBe('failed');
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: 'secret_new',
        rule_id: 'aws-access-key-id',
        path: 'src/config.js',
        line: 1,
      }),
    ]);
    expect(JSON.stringify(r)).not.toContain(secret);

    // the same value in the base (another file): moved or old, not this Unit's
    const old = world();
    const base = headOf(old.base, { 'old/keys.js': `x = '${secret}'\n` });
    old.files.set('acme/synth', 'a'.repeat(40), base);
    old.head = headOf(base, {
      'src/calc.js': FIXED,
      [old.oraclePath]: old.oracleCode,
      'src/config.js': `module.exports = '${secret}';\n`,
    });
    const r2 = await check(old, '7.4');
    expect(kinds(r2)).not.toContain('secret_new');
  });

  it('a new dependency nobody approved fails; with X3 approved it is recorded', async () => {
    const w = world();
    const pkg = JSON.parse(
      Buffer.from(w.base.find((f) => f.path === 'package.json')?.content ?? '').toString(),
    ) as Record<string, unknown>;
    w.head = headOf(w.head, {
      'package.json': JSON.stringify({ ...pkg, dependencies: { leftpad: '1.0.0' } }),
    });
    const r = await check(w, '7.4');
    expect(r.verdict).toBe('failed');
    expect(kinds(r)).toContain('dependency_unapproved');
    const ok = await check(w, '7.4', { x3_approved: true });
    expect(ok.verdict).toBe('passed');
    expect(kinds(ok)).toContain('dependency_new');
  });

  it('X2: raised on a protected-path change, with the result bound; not otherwise, not when covered', async () => {
    const w = world();
    w.head = headOf(w.head, { 'AGENTS.md': 'Agents: be careful.\n' });
    const r = await check(w, '7.4');
    expect(r.raised).toEqual({ kind: 'gate', gate: 'X2', reason_code: 'protected_path' });
    expect(r.verdict).toBe('passed'); // the protected path is X2's to decide, nothing else failed
    expect(outcomeOf(r)).toEqual({
      outcome: 'gate_needed',
      gate: 'X2',
      reason_code: 'protected_path',
      output_hash: verifyResultHash(r),
    });
    for (const p of [
      '.github/CODEOWNERS',
      'CODEOWNERS',
      '.claude/settings.json',
      '.factory/knowledge/x.md',
      '.github/workflows/ci.yml',
    ]) {
      const x = world();
      x.head = headOf(x.head, { [p]: 'changed\n' });
      expect((await check(x, '7.4')).raised?.kind, p).toBe('gate');
    }
    // not touched: no X2
    expect((await check(world(), '7.4')).raised).toBeNull();
    // the Push Broker wrote this head under an X2 bound to its patch, or X2 was approved here: no second X2
    expect((await check(w, '7.4', { x2_covered: true })).raised).toBeNull();
    expect((await check(w, '7.4', { approved_gates: ['X2'] })).raised).toBeNull();
  });
});

describe('7.5 constitution check (D+A), every lane', () => {
  it('passes on code that adds no egress and no migration', async () => {
    const r = await check(world(), '7.5');
    expect(r.verdict).toBe('passed');
    expect(r.raised).toBeNull();
  });

  it('E2: new egress the design did not approve; an approved host passes', async () => {
    const w = world();
    w.head = headOf(w.head, {
      'src/net.js': "exports.ping = () => fetch('https://api.vendor-x.io/v1/ping');\n",
    });
    const r = await check(w, '7.5');
    expect(r.raised).toEqual({ kind: 'gate', gate: 'E2', reason_code: 'constitution_violation' });
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: 'constitution_violation',
        rule_id: 'C-EGRESS',
        path: 'src/net.js',
      }),
    ]);
    expect((await check(w, '7.5', { approved_hosts: ['api.vendor-x.io'] })).raised).toBeNull();
  });

  it('E2: a migration neither reversible nor flagged; a down file or the flag passes', async () => {
    const w = world();
    w.head = headOf(w.head, { 'db/migrations/0002_drop.sql': 'DROP TABLE users;\n' });
    expect((await check(w, '7.5')).raised?.kind).toBe('gate');
    const down = world();
    down.head = headOf(down.head, {
      'db/migrations/0002_add.sql': 'ALTER TABLE t ADD c int;\n',
      'db/migrations/0002_add.down.sql': 'ALTER TABLE t DROP c;\n',
    });
    expect((await check(down, '7.5')).raised).toBeNull();
    const flagged = world();
    flagged.head = headOf(flagged.head, {
      'db/migrations/0002_drop.sql': '-- aisdlc: irreversible\nDROP TABLE users;\n',
    });
    expect((await check(flagged, '7.5')).raised).toBeNull();
  });

  it('E2 on a high A5 constitution finding; unknown with no reviewer', async () => {
    const w = world();
    w.reviewer.scripted((q) =>
      q.check === 'constitution'
        ? {
            verdict: 'findings',
            findings: [
              {
                severity: 'high',
                rule_id: 'C-EGRESS',
                location: { path: 'src/calc.js' },
                message: 'opens a socket',
              },
            ],
          }
        : undefined,
    );
    expect((await check(w, '7.5')).raised?.kind).toBe('gate');
    expect((await check(world(), '7.5', { review: null })).verdict).toBe('unknown');
  });

  it('runs in EVERY lane of the catalogue, with the same verdict: the rules never read the lane', async () => {
    for (const lane of LaneValues) {
      // the catalogue makes 7.5 mandatory in every lane that has an S7 (L7, the spike, never reaches S7: its S7 is
      // skipped and its exemption is written down)
      const def = LANES[lane];
      const s7 = def.stages.find((x) => x.stage === 'S7');
      if (s7?.mode === 'skipped') expect(def.profile.mandatory_exemption, lane).not.toBeNull();
      else {
        expect(def.profile.mandatory_steps, lane).toContain('7.5');
        expect(s7?.steps, lane).toContain('7.5');
      }
      const w = world();
      w.head = headOf(w.head, { 'src/net.js': "fetch('https://api.vendor-x.io/');\n" });
      const r = await check(w, '7.5', { lane });
      expect(r.lane).toBe(lane);
      expect(r.check).toBe('constitution');
      expect(r.raised?.kind, lane).toBe('gate');
    }
    expect(DEFAULT_CONSTITUTION.rules.length).toBeGreaterThan(0);
  });
});

describe('fail closed: an error is never a pass', () => {
  it('a refused session (no grant at the controller, DEC-18) is unknown, not passed', async () => {
    const w = world();
    w.script = () => {
      throw new Error('never runs');
    };
    const refusing = {
      run: async () => ({
        ok: false as const,
        error: { _tag: 'SandboxError' as const, code: 'refused' as const, message: 'no grant' },
      }),
    };
    const { VerifyRunner } = await import('../src/index.js');
    const { readPrompt } = await import('@aisdlc/agents/files');
    const runner = new VerifyRunner({
      sandbox: refusing as never,
      files: w.files,
      holdouts: w.holdouts,
      reviewer: w.reviewer,
      prompt: readPrompt,
    });
    w.files.set('acme/synth', 'b'.repeat(40), w.head);
    for (const step of ['7.1', '7.2', '7.3'] as const) {
      const r = await runner.run(request(w, step));
      expect(r.ok && r.value.verdict, step).toBe('unknown');
    }
  });

  it('a busy or unreachable sandbox and an unreachable code host are transient; a missing head is unknown', async () => {
    const w = world();
    w.sandbox.breakIt();
    w.files.set('acme/synth', 'b'.repeat(40), w.head);
    expect((await w.runner.run(request(w, '7.1'))).ok).toBe(false);
    const down = world();
    down.files.breakIt();
    expect((await down.runner.run(request(down, '7.1'))).ok).toBe(false);
    const missing = world();
    const r = await missing.runner.run(request(missing, '7.4'));
    expect(r.ok && r.value.verdict).toBe('unknown');
    expect(r.ok && r.value.findings.map((f) => f.kind)).toEqual(['kit_error']);
  });

  it('a canary in a session’s output voids the kit', async () => {
    const { makeCanary } = await import('@aisdlc/secrets-rules');
    const w = world();
    w.script = () => ({ exit_code: 0, stdout: makeCanary('aisdlc-test') });
    const r = await check(w, '7.1');
    expect(r.verdict).toBe('unknown');
  });

  it('the 7.6 guard: every step must have passed, a raised gate approved; unknown, missing or pending is unmet', async () => {
    const w = world();
    const results: Result[] = [];
    for (const step of ['7.1', '7.2', '7.3', '7.4', '7.5'] as const)
      results.push(await check(w, step));
    const none = () => false;
    expect(unmetSteps(results, none)).toEqual([]);
    expect(unmetSteps(results.slice(1), none)).toEqual(['7.1']);
    const unknown = VerifyCheckResult.parse({ ...results[0], verdict: 'unknown' });
    expect(unmetSteps([unknown, ...results.slice(1)], none)).toEqual(['7.1']);
    const x2 = VerifyCheckResult.parse({
      ...results[3],
      raised: { kind: 'gate', gate: 'X2', reason_code: 'protected_path' },
    });
    const withX2 = [...results.slice(0, 3), x2, results[4] as Result];
    expect(unmetSteps(withX2, none)).toEqual(['7.4']);
    expect(unmetSteps(withX2, (g, s) => g === 'X2' && s === '7.4')).toEqual([]);
  });

  it('results are content-addressed: the same inputs give the same hash, a new attempt too', async () => {
    const a = await check(world(), '7.4');
    const b = await check(world(), '7.4', { attempt: 2, command_key: 'other' });
    expect(verifyResultHash(a)).toBe(verifyResultHash(b));
  });
});
