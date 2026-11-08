import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noise } from '@aisdlc/codehost/testing';
import { gitEnv } from '../src/testing.js';
import {
  FileBundleSource,
  FixtureRepo,
  scratchDir,
  startKnowledgeStack,
  type KnowledgeStack,
} from '../src/testing.js';

// M6.1: bundle intake into a hardened bare mirror, with real git and real bundles.

const scratch = scratchDir();
afterAll(() => scratch.dispose());

const LFS =
  'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'ab'.repeat(32) + '\nsize 12345\n';

/** main with a binary file, a big file, an LFS pointer, a submodule entry, two branches and two tags. */
function buildFixture(name: string): FixtureRepo {
  const r = new FixtureRepo(scratch.dir, name);
  r.write('README.md', '# app\n').write('src/a.ts', 'export const a = 1;\n');
  r.commit('first');
  r.write('bin/blob.dat', noise('binary', 4096));
  r.write('big/huge.bin', noise('big', 300_000));
  r.write('assets/model.bin', LFS);
  r.addSubmodule('vendor/lib');
  r.commit('second: binary, oversize, lfs, submodule');
  r.tag('v1');
  r.checkout('dev', true).write('dev.txt', 'dev\n');
  r.commit('on dev');
  r.checkout('feature/x', true).write('x.txt', 'x\n');
  r.commit('on feature');
  r.checkout('main');
  r.write('src/b.ts', 'export const b = 2;\n');
  r.commit('third');
  r.git('tag', '-a', '-m', 'release', 'v2');
  return r;
}

let repo: FixtureRepo;
let stack: KnowledgeStack;
let source: FileBundleSource;
let good: ReturnType<FixtureRepo['bundle']>;

beforeAll(async () => {
  repo = buildFixture('fixture');
  good = repo.bundle(join(scratch.dir, 'good.bundle'));
  source = new FileBundleSource(good.file, good.manifest);
  stack = await startKnowledgeStack({ source, maxFileBytes: 100_000 });
}, 60_000);
afterAll(async () => stack?.stop());

const workspaces = (): string[] => (existsSync(stack.workRoot) ? readdirSync(stack.workRoot) : []);

function pgrepFor(dir: string): string {
  const r = spawnSync('pgrep', ['-f', dir], { encoding: 'utf8' });
  return r.stdout.trim();
}

describe('a good bundle', () => {
  it('becomes a done job with the refs of the bundle, a hash of the outputs and no workspace left', async () => {
    const job = await stack.runJob();
    expect(job.state).toBe('done');
    expect(job.error).toBeNull();
    const r = job.result;
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.base_sha).toBe(repo.head());
    expect(r.manifest).toEqual(good.manifest);
    expect(r.bundle_bytes).toBe(good.manifest.bytes);
    expect(r.refs.map((x) => x.name)).toEqual([
      'refs/heads/dev',
      'refs/heads/feature/x',
      'refs/heads/main',
      'refs/tags/v1',
      'refs/tags/v2',
    ]);
    expect(r.scan_coverage).toMatchObject({
      refs_covered: 'all',
      ref_count: 5,
      truncated: false,
      cap_reached: false,
      lfs_unscanned: 1,
      submodules_listed: 1,
    });
    expect(r.head_tree.files).toBe(6);
    expect(job.result_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The outputs are content-hashed: the stored hash is the hash of the stored result.
    const { hashCanonical } = await import('@aisdlc/kernel');
    expect(hashCanonical(r)).toBe(job.result_sha256);
    expect(workspaces()).toEqual([]);
    expect(stack.runner.workRoot).toBe(stack.workRoot);
  });

  it('lists everything it did not scan as coverage items with a kind, a place and a reason', async () => {
    const job = await stack.runJob();
    const items = job.result?.coverage_items ?? [];
    const by = (kind: string) => items.filter((i) => i.kind === kind);
    expect(by('lfs_pointer')).toMatchObject([
      { path: 'assets/model.bin', reason: expect.stringContaining('LFS') },
    ]);
    expect(by('submodule')).toMatchObject([
      { path: 'vendor/lib', reason: expect.stringContaining('submodule') },
    ]);
    expect(by('file_over_cap')).toMatchObject([
      { path: 'big/huge.bin', reason: expect.stringContaining('per-file cap') },
    ]);
    expect(by('file_over_cap')[0]?.object).toMatch(/^[0-9a-f]{40}$/);
    for (const i of items) expect(i.reason.length).toBeGreaterThan(0);
    expect(job.result?.coverage_counts).toEqual({ file_over_cap: 1, lfs_pointer: 1, submodule: 1 });
    // The binary file was read and scanned (it is not a coverage item).
    expect(items.some((i) => i.path === 'bin/blob.dat')).toBe(false);
  });

  it('runs no process that outlives the job', async () => {
    await stack.runJob();
    expect(stack.runner['running']).toBe(0);
    expect(pgrepFor(stack.workRoot)).toBe('');
    expect(workspaces()).toEqual([]);
  });

  it('records job events on kjob:<id>: queued, started, done', async () => {
    const job = await stack.runJob();
    const ev = await stack.db.pool.query<{ type: string }>(
      'SELECT type FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [`kjob:${job.job_id}`],
    );
    expect(ev.rows.map((e) => e.type)).toEqual(['kjob.queued', 'kjob.started', 'kjob.done']);
  });

  it('covers default_only bundles, and says so in the coverage', async () => {
    const d = repo.bundle(join(scratch.dir, 'default.bundle'), 'default_only');
    source.set(d.file, d.manifest);
    try {
      const job = await stack.runJob('default_only');
      expect(job.state).toBe('done');
      expect(job.result?.scan_coverage).toMatchObject({
        refs_covered: 'default_only',
        ref_count: 1,
      });
      expect(job.result?.refs.map((r) => r.name)).toEqual(['refs/heads/main']);
    } finally {
      source.set(good.file, good.manifest);
    }
  });
});

describe('a bundle that is refused', () => {
  const refused = async (file: string, manifest: typeof good.manifest, re: RegExp) => {
    source.set(file, manifest);
    try {
      const job = await stack.runJob();
      expect(job.state).toBe('error');
      expect(job.result).toBeNull();
      expect(job.error).toMatch(re);
      expect(workspaces()).toEqual([]);
      // No scan, no findings: a refused bundle is never "clean".
      const f = await stack.db.pool.query('SELECT 1 FROM security_findings.finding');
      expect(f.rowCount).toBe(0);
    } finally {
      source.set(good.file, good.manifest);
    }
  };

  it('a corrupt bundle (bytes cut off) fails git bundle verify or the fetch', async () => {
    const f = join(scratch.dir, 'corrupt.bundle');
    execFileSync('cp', [good.file, f]);
    truncateSync(f, Math.floor(good.manifest.bytes / 2));
    await refused(
      f,
      { ...good.manifest, bytes: Math.floor(good.manifest.bytes / 2) },
      /bundle_invalid|malformed_object/,
    );
  });

  it('garbage that is not a bundle at all is refused', async () => {
    const f = join(scratch.dir, 'garbage.bundle');
    writeFileSync(f, noise('garbage', 2048));
    await refused(f, { ...good.manifest, bytes: 2048 }, /bundle_invalid/);
  });

  it('a head that is not the base sha the codehost reported is refused', async () => {
    await refused(good.file, { ...good.manifest, head_sha: 'f'.repeat(40) }, /head_mismatch/);
  });

  it('a manifest that disagrees with the bundle (refs, bytes) is refused', async () => {
    await refused(
      good.file,
      { ...good.manifest, ref_count: good.manifest.ref_count + 1 },
      /manifest_mismatch/,
    );
    await refused(
      good.file,
      { ...good.manifest, bytes: good.manifest.bytes + 1 },
      /manifest_mismatch/,
    );
    await refused(
      good.file,
      { ...good.manifest, commit_count: good.manifest.commit_count + 1 },
      /manifest_mismatch/,
    );
    await refused(
      good.file,
      { ...good.manifest, refs_covered: 'default_only', ref_count: 1 },
      /manifest_mismatch/,
    );
  });

  it('a bundle over the size cap is refused while it streams, even if the manifest understates it', async () => {
    const big = new FixtureRepo(scratch.dir, 'bigrepo');
    big.write('pad.bin', noise('pad', 400_000));
    big.commit('big');
    const b = big.bundle(join(scratch.dir, 'big.bundle'));
    const small = await startKnowledgeStack({
      source: new FileBundleSource(b.file, { ...b.manifest, bytes: 1000 }),
      bundleCapBytes: 100_000,
    });
    try {
      const job = await small.runJob();
      expect(job.state).toBe('error');
      expect(job.error).toMatch(/too_large/);
      expect(readdirSync(small.workRoot)).toEqual([]);
      // And an honest manifest is refused before a byte is read.
      small.source.set(b.file, b.manifest);
      const again = await small.runJob();
      expect(again.error).toMatch(/too_large.*manifest says/);
    } finally {
      await small.stop();
    }
  });

  it('a malformed object (a tree with unsorted entries) is refused by fsck, not partly accepted', async () => {
    const m = new FixtureRepo(scratch.dir, 'malformed');
    m.write('a.txt', 'a\n');
    m.commit('ok');
    const env = gitEnv();
    const blob = execFileSync('git', ['hash-object', '-w', 'a.txt'], {
      cwd: m.dir,
      env,
      encoding: 'utf8',
    }).trim();
    // A tree whose entries are not sorted (b before a): fsck rejects it as `treeNotSorted`.
    const raw = Buffer.concat([
      Buffer.from('100644 b.txt\0'),
      Buffer.from(blob, 'hex'),
      Buffer.from('100644 a.txt\0'),
      Buffer.from(blob, 'hex'),
    ]);
    const treeFile = join(scratch.dir, 'bad-tree');
    writeFileSync(treeFile, raw);
    const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--literally', treeFile], {
      cwd: m.dir,
      env,
      encoding: 'utf8',
    }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'bad'], {
      cwd: m.dir,
      env,
      encoding: 'utf8',
    }).trim();
    m.git('update-ref', 'refs/heads/main', commit);
    const b = m.bundle(join(scratch.dir, 'malformed.bundle'));
    await refused(b.file, b.manifest, /malformed_object|bundle_invalid/);
  });
});

describe('repo content is data, never instructions', () => {
  it('a repo with hostile attributes, hooks, submodule urls and a build script is only read', async () => {
    const marker = join(scratch.dir, 'EXECUTED');
    const h = new FixtureRepo(scratch.dir, 'hostile');
    h.write('.gitattributes', '* filter=evil\n*.md diff=evil\n');
    h.write(
      '.gitmodules',
      `[submodule "x"]\n\tpath = vendor/x\n\turl = ext::sh -c "touch ${marker}"\n`,
    );
    h.addSubmodule('vendor/x');
    h.write('.githooks/post-checkout', `#!/bin/sh\ntouch ${marker}\n`);
    h.write('.git-hooks.sh', `touch ${marker}\n`);
    h.write(
      'package.json',
      JSON.stringify({ scripts: { postinstall: `touch ${marker}`, test: `touch ${marker}` } }),
    );
    h.write('Makefile', `all:\n\ttouch ${marker}\n`);
    h.write('README.md', '# hi\n');
    h.commit('hostile');
    const b = h.bundle(join(scratch.dir, 'hostile.bundle'));
    source.set(b.file, b.manifest);
    try {
      const job = await stack.runJob();
      expect(job.state).toBe('done');
      expect(existsSync(marker)).toBe(false);
      expect(job.result?.coverage_counts).toMatchObject({ submodule: 1 });
    } finally {
      source.set(good.file, good.manifest);
    }
  });

  it('every git call is hardened: own HOME, no config, hooks off, protocols off except for the one bundle read, only read verbs', async () => {
    const log = join(scratch.dir, 'git-calls.log');
    writeFileSync(log, '');
    const wrapper = join(scratch.dir, 'git-wrapper.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nout=$({ printf 'ARGS %s\\n' "$*"; env | grep -E '^(HOME|GIT_|PATH=)' | sort; printf 'END\\n'; })\nprintf '%s\\n' "$out" >> ${log}\nexec git "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const s = await startKnowledgeStack({
      source: new FileBundleSource(good.file, good.manifest),
      gitBin: wrapper,
    });
    try {
      const job = await s.runJob();
      expect(job.state).toBe('done');
      const calls = readFileSync(log, 'utf8')
        .split(/^END$/m)
        .filter((c) => c.trim() !== '');
      expect(calls.length).toBeGreaterThan(8);
      const verbs = new Set<string>();
      for (const c of calls) {
        const args = /^ARGS (.*)$/m.exec(c)?.[1] ?? '';
        const verb = args.replace(/^--git-dir=\S+ /, '').split(' ')[0] as string;
        verbs.add(verb);
        expect(c).toMatch(/^HOME=.*\/job-[^/]+\/home$/m);
        expect(c).toMatch(/^GIT_CONFIG_NOSYSTEM=1$/m);
        expect(c).toMatch(/^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
        expect(c).toMatch(/^GIT_TERMINAL_PROMPT=0$/m);
        const cfg = Object.fromEntries(
          [...c.matchAll(/^GIT_CONFIG_KEY_(\d+)=(.*)$/gm)].map((m) => [
            m[2],
            new RegExp(`^GIT_CONFIG_VALUE_${m[1]}=(.*)$`, 'm').exec(c)?.[1],
          ]),
        );
        expect(cfg['core.hooksPath']).toBe('/dev/null');
        expect(cfg['protocol.allow']).toBe('never');
        expect(cfg['transfer.fsckObjects']).toBe('true');
        expect(cfg['filter.lfs.smudge']).toBe('');
        expect(cfg['filter.lfs.required']).toBe('false');
        expect(cfg['submodule.recurse']).toBe('false');
        // The file transport is allowed for the bundle fetch and nothing else.
        expect(cfg['protocol.file.allow'] === 'always').toBe(verb === 'fetch');
      }
      // Reads only: never a checkout, clone, merge, worktree, submodule or filter run.
      expect([...verbs].sort()).toEqual(
        [
          'bundle',
          'cat-file',
          'fetch',
          'for-each-ref',
          'fsck',
          'init',
          'log',
          'ls-tree',
          'rev-list',
          'rev-parse',
        ].sort(),
      );
    } finally {
      await s.stop();
    }
  });
});

describe('time cap', () => {
  const slowOn = (verb: string, seconds: number): string => {
    const w = join(scratch.dir, `slow-${verb}.sh`);
    writeFileSync(
      w,
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "${verb}" ]; then sleep ${seconds}; fi; done\nexec git "$@"\n`,
    );
    chmodSync(w, 0o755);
    return w;
  };

  it('an intake that overruns the job time cap is an error, its processes are killed, nothing is left', async () => {
    const s = await startKnowledgeStack({
      source: new FileBundleSource(good.file, good.manifest),
      gitBin: slowOn('fetch', 20),
      jobTimeoutMs: 1500,
    });
    try {
      const t = performance.now();
      const job = await s.runJob();
      expect(performance.now() - t).toBeLessThan(15_000);
      expect(job.state).toBe('error');
      expect(job.error).toMatch(/timeout/);
      expect(readdirSync(s.workRoot)).toEqual([]);
      expect(pgrepFor(s.workRoot)).toBe('');
    } finally {
      await s.stop();
    }
  }, 30_000);
});

describe('recovery', () => {
  it('a job a previous process left running is marked error, and stray workspaces are removed', async () => {
    const stray = join(stack.workRoot, 'job-stray-1');
    mkdirSync(join(stray, 'home'), { recursive: true });
    const { enqueueJob, markRunning, getJob } = await import('../src/store.js');
    const q = await enqueueJob({ pool: stack.db.pool }, { repo: 'acme/app' });
    if (!q.ok) throw new Error('enqueue');
    await markRunning({ pool: stack.db.pool }, q.value.job_id);
    const q2 = await enqueueJob({ pool: stack.db.pool }, { repo: 'acme/app' });
    if (!q2.ok) throw new Error('enqueue');
    expect(await stack.runner.recover()).toBe(2);
    expect((await getJob(stack.db.pool, q.value.job_id))?.error).toBe('interrupted by a restart');
    expect((await getJob(stack.db.pool, q2.value.job_id))?.state).toBe('error');
    expect(existsSync(stray)).toBe(false);
  });
});
