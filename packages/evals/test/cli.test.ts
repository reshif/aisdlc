import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli, type CliContext } from '../src/cli.js';
import { FakeAgentRunner } from '../src/runner-port.js';
import { MemoryEvalSink } from '../src/sink.js';
import {
  SPECS,
  badAnswer,
  cleanup,
  clock,
  custody,
  draftOf,
  goodAnswer,
  mkTmp,
  pinnedOf,
} from './helpers.js';

afterAll(cleanup);

async function harness() {
  const store = mkTmp();
  const work = mkTmp('aisdlc-evalwork-');
  const c = custody('cli');
  const out: string[] = [];
  const errs: string[] = [];
  const sink = new MemoryEvalSink();
  let answer: (r: { input: Record<string, unknown> }) => string = goodAnswer;
  const ctx: CliContext = {
    env: { AISDLC_EVAL_STORE: store },
    out: (t) => out.push(t),
    err: (t) => errs.push(t),
    custody: () => c,
    pinned: await pinnedOf(c),
    runner: () => new FakeAgentRunner((r) => answer(r)),
    sink: () => sink,
    clock: clock(),
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    errs.length = 0;
    const code = await runCli(argv, ctx);
    return { code, out: out.join(''), err: errs.join('') };
  };
  const file = (name: string, v: unknown) => {
    const p = join(work, name);
    writeFileSync(p, JSON.stringify(v));
    return p;
  };
  return { run, file, store, work, sink, setAnswer: (f: typeof answer) => (answer = f), ctx };
}

describe('aisdlc-evals', () => {
  it('init, add-case, sign, verify, run, baseline, sign, compare, gate: the whole life of a store', async () => {
    const h = await harness();
    expect((await h.run('init', '--store-id', 'cli-store')).code).toBe(0);
    for (const s of SPECS) {
      const r = await h.run('add-case', h.file(`${s.id}.json`, draftOf(s)));
      expect(r.code, r.err).toBe(0);
    }
    // the manifest is stale: the store does not open until it is signed
    expect((await h.run('verify')).code).toBe(1);
    expect((await h.run('sign')).code).toBe(0);
    const v = await h.run('verify');
    expect(v.code).toBe(0);
    expect(JSON.parse(v.out)).toMatchObject({ ok: true, store_id: 'cli-store' });

    // run, recorded as history; no baseline yet, so the gate says no
    const runFile = join(h.work, 'run1.json');
    const r1 = await h.run('run', '--suite', 'triage', '--k', '2', '--out', runFile, '--record');
    expect(r1.code, r1.err).toBe(0);
    expect(h.sink.runs).toHaveLength(1);
    expect(JSON.parse(readFileSync(runFile, 'utf8')).eval_run_id).toBe(h.sink.runs[0]?.eval_run_id);
    const g0 = await h.run('gate', '--run', runFile);
    expect(g0.code).toBe(1);
    expect(JSON.parse(g0.out).reasons).toEqual(['no_baseline']);

    // set the baseline, sign (a baseline is a signed part of the store), and gate again
    expect((await h.run('baseline', '--run', runFile)).code).toBe(0);
    expect((await h.run('verify')).code).toBe(1);
    expect((await h.run('sign')).code).toBe(0);
    const g1 = await h.run('gate', '--run', runFile);
    expect(g1.code, g1.out).toBe(0);
    expect(JSON.parse(g1.out)).toMatchObject({ passed: true });
    expect(JSON.parse((await h.run('compare', '--run', runFile)).out)).toMatchObject({
      verdict: 'no_change',
      level: 0.9,
    });

    // a regression fails the gate with a non-zero exit
    h.setAnswer(() => badAnswer());
    const badFile = join(h.work, 'run2.json');
    expect((await h.run('run', '--suite', 'triage', '--k', '2', '--out', badFile)).code).toBe(0);
    const g2 = await h.run('gate', '--run', badFile);
    expect(g2.code).toBe(1);
    expect(JSON.parse(g2.out).reasons).toContain('significant_regression');
    expect(JSON.parse((await h.run('compare', '--run', badFile)).out).verdict).toBe('regression');
  });

  it('refuses a store inside the repo, a missing store, and a tampered store (exit 1)', async () => {
    const h = await harness();
    const inRepo = { ...h.ctx, env: { AISDLC_EVAL_STORE: join(import.meta.dirname, '..') } };
    const errs: string[] = [];
    const code = await runCli(['verify'], { ...inRepo, err: (t) => errs.push(t) });
    expect(code).toBe(1);
    expect(errs.join('')).toContain('inside_repo');
    const none = await runCli(['verify'], { ...h.ctx, env: {}, err: (t) => errs.push(t) });
    expect(none).toBe(1);

    await h.run('init', '--store-id', 's');
    await h.run('add-case', h.file('a.json', draftOf(SPECS[0]!)));
    await h.run('sign');
    const p = join(h.store, 'tasks', 't-exact.json');
    writeFileSync(p, readFileSync(p, 'utf8').replace('request of', 'changed'));
    const r = await h.run('verify');
    expect(r.code).toBe(1);
    expect(r.err).toContain('tampered');
    const run = await h.run('run', '--suite', 'triage');
    expect(run.code).toBe(1);
  });

  it('holdouts run only with --include-holdout', async () => {
    const h = await harness();
    await h.run('init', '--store-id', 's');
    await h.run('add-case', h.file('a.json', draftOf(SPECS[0]!)));
    await h.run(
      'add-case',
      h.file(
        'h.json',
        draftOf(SPECS[1]!, {
          case_id: 'h-1',
          kind: 'holdout',
          input: { id: 't-subset', request: 'held' },
        }),
      ),
    );
    await h.run('sign');
    const a = JSON.parse((await h.run('run', '--suite', 'triage', '--k', '1')).out);
    expect(a.cases.map((c: { case_id: string }) => c.case_id)).toEqual(['t-exact']);
    const b = JSON.parse(
      (await h.run('run', '--suite', 'triage', '--k', '1', '--include-holdout')).out,
    );
    expect(b.cases.map((c: { case_id: string }) => c.case_id).sort()).toEqual(['h-1', 't-exact']);
  });

  it('usage and configuration errors exit 2', async () => {
    const h = await harness();
    expect((await h.run('nope')).code).toBe(2);
    expect((await h.run('init')).code).toBe(2);
    expect((await h.run('run')).code).toBe(2);
    expect((await h.run('run', '--suite', 'x', '--k', '0')).code).toBe(2);
    expect((await h.run('gate')).code).toBe(2);
    mkdirSync(join(h.work, 'x'));
  });
});
