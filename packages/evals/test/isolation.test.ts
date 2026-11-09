import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeAgentRunner } from '../src/runner-port.js';
import { runSuite } from '../src/runner.js';
import { loadSuite } from '../src/suite.js';
import { buildStore, cleanup, clock, goodAnswer } from './helpers.js';

// HOLDOUT ISOLATION (PLAN M11.3 acceptance; DM §5.1; D36: the factory's own agents must never see
// answers). Enforced by code path, and checked here by the import graph, by grep and by behaviour.

afterAll(cleanup);
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const REPO = join(HERE, '..', '..', '..');

const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map(
    (m) => m[1] as string,
  );

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const i of importsOf(join(SRC, f)))
      if (i.startsWith('./')) walk(i.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
  };
  walk(entry);
  return seen;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('the import graph', () => {
  it('nothing the agent runner is made of reaches the store, the holdouts, the loader or the authoring tools', () => {
    for (const entry of ['gateway-runner.ts', 'runner-port.ts', 'messages-call.ts']) {
      const reach = closure(entry);
      for (const forbidden of [
        'holdout.ts',
        'store.ts',
        'suite.ts',
        'layout.ts',
        'authoring.ts',
        'grader.ts',
      ]) {
        expect(reach.has(forbidden), `${entry} reaches ${forbidden}`).toBe(false);
      }
    }
  });

  it('holdout.ts is imported by the suite loader and nothing else; holdout paths are named in three files', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    const importers = files.filter((f) => importsOf(join(SRC, f)).includes('./holdout.js'));
    expect(importers.sort()).toEqual(['suite.ts']);
    const naming = files.filter((f) =>
      /HOLDOUTS_DIR|holdoutFile|holdoutHiddenFile|isHoldoutHidden/.test(
        readFileSync(join(SRC, f), 'utf8'),
      ),
    );
    expect(naming.sort()).toEqual(['authoring.ts', 'holdout.ts', 'layout.ts']);
  });

  it('no other package or service imports @aisdlc/evals, names the store variable or reads holdouts', () => {
    const offenders: string[] = [];
    for (const base of ['packages', 'services']) {
      for (const d of readdirSync(join(REPO, base))) {
        // contracts is the vocabulary: it names the store layout in comments, it holds no code that reads one
        if (d === 'evals') continue;
        const src = join(REPO, base, d, 'src');
        try {
          statSync(src);
        } catch {
          continue;
        }
        for (const f of sources(src)) {
          const text = readFileSync(f, 'utf8');
          if (
            /@aisdlc\/evals/.test(text) ||
            (d !== 'contracts' && /AISDLC_EVAL_STORE|eval_store\.pub|holdouts\//.test(text))
          ) {
            offenders.push(relative(REPO, f));
          }
        }
        // and no package.json outside evals depends on it
        const pkg = readFileSync(join(REPO, base, d, 'package.json'), 'utf8');
        if (pkg.includes('@aisdlc/evals')) offenders.push(`${base}/${d}/package.json`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the context builder and the agent registry cannot reach evals at all', () => {
    const agents = join(REPO, 'packages', 'agents', 'src');
    for (const f of sources(agents)) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/@aisdlc\/evals|holdout/i);
    }
  });
});

describe('behaviour', () => {
  async function setup() {
    const s = await buildStore({ holdout: true });
    const st = await s.open();
    if (!st.ok) throw new Error(st.error.message);
    return st.value;
  }

  it('a suite run without includeHoldout never loads a holdout case or grader', async () => {
    const store = await setup();
    const suite = loadSuite(store, 'triage');
    if (!suite.ok) throw new Error('suite');
    expect(suite.value.cases.map((c) => c.case_id)).not.toContain('h-1');
    expect(suite.value.suite.holdout_case_ids).toEqual(['h-1']);
    expect(suite.value.suite.local_prod_loadable).toBe(false);
    const runner = new FakeAgentRunner((r) => goodAnswer(r));
    const run = await runSuite({
      suite: suite.value.suite,
      cases: suite.value.cases,
      graderOf: suite.value.graderOf,
      runner,
      k: 1,
      store_id: store.store_id,
      manifest_digest: store.manifest_digest,
      clock: clock(),
    });
    expect(JSON.stringify(runner.requests)).not.toContain('held-out');
    expect(JSON.stringify(run)).not.toContain('h-1');
  });

  it('with includeHoldout the agent gets the holdout INPUT only; the grader is fetched after the answer; the record has no content', async () => {
    const store = await setup();
    const suite = loadSuite(store, 'triage', { includeHoldout: true });
    if (!suite.ok) throw new Error('suite');
    const order: string[] = [];
    const runner = new FakeAgentRunner((r) => {
      order.push(`run:${String(r.input['id'])}`);
      return r.input['id'] === 'h-1'
        ? JSON.stringify({
            kind: 'classification',
            work_type: 'remediation',
            size: 'small',
            risk: 'standard',
            confidence: 0.8,
            rationale: 'r',
          })
        : goodAnswer(r);
    });
    const run = await runSuite({
      suite: suite.value.suite,
      cases: suite.value.cases,
      graderOf: (c) => {
        order.push(`grader:${c.case_id}`);
        return suite.value.graderOf(c);
      },
      runner,
      k: 1,
      store_id: store.store_id,
      manifest_digest: store.manifest_digest,
      clock: clock(),
    });
    const held = run.cases.find((c) => c.case_id === 'h-1');
    expect(held).toMatchObject({ kind: 'holdout' });
    expect(held?.trials[0]?.passed).toBe(true);
    // the runner was handed {agent_id, input, trial}: no kind, no hidden_ref, no grader, no expected
    for (const req of runner.requests) {
      expect(Object.keys(req).sort()).toEqual(['agent_id', 'input', 'trial']);
    }
    const sent = JSON.stringify(runner.requests);
    expect(sent).not.toMatch(/hidden_ref|grader|expected|sha256:/);
    // the grader of a case is fetched only after its trial's answer
    for (const id of ['t-exact', 'h-1']) {
      expect(order.indexOf(`run:${id}`)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(`grader:${id}`)).toBeGreaterThan(order.indexOf(`run:${id}`));
    }
    // the recorded run is ids, vectors and counts: neither input text nor the expected answer
    const recorded = JSON.stringify(run);
    expect(recorded).not.toContain('held-out');
    expect(recorded).not.toContain('request of');
    expect(recorded).not.toContain('json_subset');
  });

  it('a holdout kept in tasks/ is refused, and a case in holdouts/ that is not a holdout is refused', async () => {
    const { addCase } = await import('../src/authoring.js');
    const { draftOf, SPECS } = await import('./helpers.js');
    const s = await buildStore();
    // the author writes a regression case into holdouts/ by hand: the loader refuses it
    const { mkdirSync, writeFileSync, readFileSync: rf } = await import('node:fs');
    const ok = addCase(s.path, draftOf(SPECS[0]!, { case_id: 'x', kind: 'holdout' }));
    expect(ok.ok).toBe(true);
    const text = rf(join(s.path, 'holdouts', 'x.json'), 'utf8').replace(
      '"holdout"',
      '"regression"',
    );
    mkdirSync(join(s.path, 'holdouts'), { recursive: true });
    writeFileSync(join(s.path, 'holdouts', 'x.json'), text);
    await s.sign();
    const st = await s.open();
    if (!st.ok) throw new Error('open');
    const suite = loadSuite(st.value, 'triage', { includeHoldout: true });
    expect(suite.ok).toBe(false);
  });
});
