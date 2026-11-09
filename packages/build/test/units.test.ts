import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SessionStore,
  bindOracles,
  buildHandoffPack,
  checkOracleBinding,
  sha256,
  specHashOf,
  taskContractOf,
  testOneArgv,
  type SessionState,
} from '../src/index.js';

const A = { oracle_id: 'O1', requirement_id: 'R1', spec_sha256: 'a'.repeat(64) };
const code = (id: string, spec: string) =>
  `// aisdlc-oracle id=${id} spec=${spec}\ntest('x', () => {});\n`;

describe('the oracle binding (6.3)', () => {
  it('matches the approved spec; every deviation is named', () => {
    const ok = bindOracles([{ path: 't/a.test.js', content: code('O1', 'a'.repeat(64)) }]);
    expect(checkOracleBinding([A], ok, false)).toEqual([]);
    const bad = bindOracles([
      { path: 't/a.test.js', content: code('O1', 'b'.repeat(64)) },
      { path: 't/b.test.js', content: code('O2', 'a'.repeat(64)) },
      { path: 't/c.test.js', content: 'test("no marker", () => {});\n' },
    ]);
    expect(
      checkOracleBinding([A, { ...A, oracle_id: 'O3' }], bad, false)
        .map((d) => `${d.kind}:${d.oracle_id ?? d.path}`)
        .sort(),
    ).toEqual([
      'no_marker:t/c.test.js',
      'oracle_missing:O3',
      'oracle_unbound:O2',
      'spec_mismatch:O1',
    ]);
    const twice = bindOracles([
      { path: 't/a.test.js', content: code('O1', 'a'.repeat(64)) },
      { path: 't/a2.test.js', content: code('O1', 'a'.repeat(64)) },
    ]);
    expect(checkOracleBinding([A], twice, false).map((d) => d.kind)).toEqual(['duplicate_oracle']);
  });
  it('L0 needs one failing repro test and no oracle specs', () => {
    expect(checkOracleBinding([], [], true).map((d) => d.kind)).toEqual(['repro_missing']);
    expect(
      checkOracleBinding([], bindOracles([{ path: 'r.test.js', content: 'x' }]), true),
    ).toEqual([]);
  });
  it('a marker inside a string of the code is not a marker; the spec hash is of the approved entry', () => {
    expect(
      bindOracles([
        { path: 'a', content: 'const s = "aisdlc-oracle id=O1 spec=' + 'a'.repeat(64) + '";' },
      ])[0]?.oracle_id,
    ).toBeNull();
    const e = { oracle_id: 'O1', requirement_id: 'R', description: 'd', expected_failure: 'f' };
    expect(specHashOf(e)).toBe(specHashOf({ ...e }));
    expect(specHashOf(e)).not.toBe(specHashOf({ ...e, description: 'd2' }));
  });
});

describe('the task contract as argv', () => {
  it('from package.json scripts and Makefile targets, by the census detectors names', () => {
    const c = taskContractOf([
      {
        path: 'package.json',
        content: JSON.stringify({
          scripts: { test: 'node --test', 'type-check': 'tsc', ci: 'x', lint: 'eslint .' },
        }),
      },
      { path: 'Makefile', content: 'build:\n\tcc x\nformat-check:\n\ttrue\n' },
    ]);
    expect(c['test']).toEqual(['npm', 'test']);
    expect(c['typecheck']).toEqual(['npm', 'run', 'type-check']);
    expect(c['check']).toEqual(['npm', 'run', 'ci']);
    expect(c['lint']).toEqual(['npm', 'run', 'lint']);
    expect(c['build']).toEqual(['make', 'build']);
    expect(c['format-check']).toEqual(['make', 'format-check']);
    expect(c['setup']).toBeNull();
    expect(testOneArgv(['npm', 'test'], 'a/b.test.js')).toEqual([
      'npm',
      'test',
      '--',
      'a/b.test.js',
    ]);
    expect(testOneArgv(['make', 'test'], 'a')).toEqual(['make', 'test', 'a']);
  });
  it('an unreadable package.json has no scripts (nothing is guessed)', () => {
    expect(taskContractOf([{ path: 'package.json', content: '{nope' }])['test']).toBeNull();
  });
});

describe('the session store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-store-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  it('is content-addressed: the same files are one tree; a blob that does not match its hash is refused', () => {
    const a = store.putFiles([
      { path: 'a.txt', content: 'x' },
      { path: 'b/c.sh', content: 'y', executable: true },
    ]);
    const b = store.putFiles([
      { path: 'b/c.sh', content: 'y', executable: true },
      { path: 'a.txt', content: 'x' },
    ]);
    expect(a).toBe(b);
    expect(store.filesOf(a).map((f) => [f.path, f.executable])).toEqual([
      ['a.txt', false],
      ['b/c.sh', true],
    ]);
    expect(store.textOf(a, 'a.txt')).toBe('x');
    expect(store.textOf(a, 'nope')).toBeNull();
    writeFileSync(join(dir, 'blobs', sha256('x')), 'tampered');
    expect(() => store.getBlob(sha256('x'))).toThrow(/does not match/);
    expect(() => store.getBlob('../../etc/passwd')).toThrow();
    expect(() => store.load('../x')).toThrow();
  });
  it('keeps the outcome of a command and a snapshot is a hash of the workspace', () => {
    store.keepOutcome('k1', { outcome: 'completed', output_hash: 'a'.repeat(64) as never });
    expect(store.outcomeOf('k1')).toMatchObject({ outcome: 'completed' });
    expect(store.outcomeOf('k2')).toBeNull();
    expect(store.readSnapshot('snap:nope')).toBeNull();
  });
});

describe('the Handoff Pack', () => {
  it('validates against A11, lists what was tried and the diffs by hash, and is deterministic', () => {
    const s = {
      item_id: 'i',
      unit_key: 'u',
      base_tree_sha256: 'b'.repeat(64),
      tree_sha256: 'c'.repeat(64),
      tainted: false,
      snapshot_ref: null,
      rounds: [
        {
          round: 1,
          task_id: 'T1',
          tree_sha256: 'c'.repeat(64),
          failing: ['a', 'b'],
          note: 'self-check failed',
        },
      ],
    } as unknown as SessionState;
    const base = {
      'a.js': { sha256: '1'.repeat(64), size: 1, exec: false },
      'gone.js': { sha256: '2'.repeat(64), size: 1, exec: false },
    };
    const now = {
      'a.js': { sha256: '3'.repeat(64), size: 1, exec: false },
      'new.js': { sha256: '4'.repeat(64), size: 1, exec: false },
    };
    const p = buildHandoffPack(s, base, now, {
      trigger: 'ET3',
      reason_code: 'repeat_fail',
      failing: ['a', 'b'],
    });
    expect(p.pack).toMatchObject({ kind: 'handoff_pack' });
    expect(p.diffs).toEqual([
      { path: 'new.js', change: 'added', before_sha256: null, after_sha256: '4'.repeat(64) },
      {
        path: 'a.js',
        change: 'modified',
        before_sha256: '1'.repeat(64),
        after_sha256: '3'.repeat(64),
      },
      { path: 'gone.js', change: 'deleted', before_sha256: '2'.repeat(64), after_sha256: null },
    ]);
    expect(p.failing_tests).toEqual(['a', 'b']);
    expect(
      JSON.stringify(
        buildHandoffPack(s, base, now, {
          trigger: 'ET3',
          reason_code: 'repeat_fail',
          failing: ['a', 'b'],
        }),
      ),
    ).toBe(JSON.stringify(p));
  });
});
