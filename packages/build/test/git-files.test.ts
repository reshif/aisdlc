import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitBundleFiles } from '../src/index.js';

// A REAL git repo built by the test (never a real repository), bundled with `git bundle`, read back as files.

const dir = mkdtempSync(join(tmpdir(), 'aisdlc-gitfiles-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } },
  ).trim();

describe('the repo at the base commit, from a git bundle', () => {
  it('regular files, executable bits, no symlink, no hooks of the repo, the commit asked for (not the head)', async () => {
    const w = join(dir, 'w');
    mkdirSync(join(w, 'src'), { recursive: true });
    git(w, 'init', '-q', '-b', 'main');
    writeFileSync(join(w, 'src/a.js'), 'exports.a = 1;\n');
    writeFileSync(join(w, 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(w, 'run.sh'), 0o755);
    symlinkSync('/etc/passwd', join(w, 'link'));
    writeFileSync(join(w, 'bin.dat'), Buffer.from([0, 1, 2, 255, 254]));
    git(w, 'add', '-A');
    git(w, 'commit', '-q', '-m', 'one');
    const first = git(w, 'rev-parse', 'HEAD');
    writeFileSync(join(w, 'src/a.js'), 'exports.a = 2;\n');
    git(w, 'commit', '-q', '-am', 'two');
    git(w, 'bundle', 'create', join(dir, 'repo.bundle'), '--all');
    const g = new GitBundleFiles({ bundle: async () => ({ state: 'x' }) });
    const r = await g.read(dir, first);
    expect(r.ok ? 'ok' : JSON.stringify(r.error)).toBe('ok');
    if (!r.ok) return;
    const byPath = Object.fromEntries(r.value.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['bin.dat', 'run.sh', 'src/a.js']);
    expect(Buffer.from(byPath['src/a.js']?.content ?? '').toString()).toBe('exports.a = 1;\n');
    expect(byPath['run.sh']?.executable).toBe(true);
    expect(byPath['src/a.js']?.executable).toBeUndefined();
    expect([...Buffer.from(byPath['bin.dat']?.content ?? '')]).toEqual([0, 1, 2, 255, 254]);
  });
  it('an unknown commit and a bad sha are errors', async () => {
    const g = new GitBundleFiles({ bundle: async () => ({ state: 'unknown' }) });
    const r = await g.read(dir, 'f'.repeat(40));
    expect(r.ok === false && r.error.code).toBe('not_found');
    expect((await g.files('acme/x', 'nope')).ok).toBe(false);
    expect((await g.files('acme/x', 'f'.repeat(40))).ok).toBe(false);
  });
  it('a commit off the default branch (a Unit head on agent/*) comes from the bundle of every branch', async () => {
    const w = join(dir, 'w2');
    mkdirSync(w, { recursive: true });
    git(w, 'init', '-q', '-b', 'main');
    writeFileSync(join(w, 'a.js'), 'base\n');
    git(w, 'add', '-A');
    git(w, 'commit', '-q', '-m', 'base');
    const base = git(w, 'rev-parse', 'HEAD');
    git(w, 'checkout', '-q', '-b', 'agent/item/main');
    writeFileSync(join(w, 'a.js'), 'head\n');
    git(w, 'commit', '-q', '-am', 'head');
    const head = git(w, 'rev-parse', 'HEAD');
    git(w, 'checkout', '-q', 'main');
    const all = join(dir, 'all.bundle');
    const main = join(dir, 'main.bundle');
    git(w, 'bundle', 'create', all, '--all');
    git(w, 'bundle', 'create', main, 'main');
    const asked: string[] = [];
    // the host's answers: the default branch only when its head is the commit asked for (else `head_moved`)
    const g = new GitBundleFiles({
      bundle: async (req) => {
        asked.push(`${req.refs}:${req.base_sha ?? '-'}`);
        if (req.refs === 'default_only' && req.base_sha !== base) return { state: 'unreadable' };
        const path = req.refs === 'all' ? all : main;
        return {
          state: 'ok',
          value: {
            manifest: {} as never,
            stream: createReadStream(path),
            dispose: () => undefined,
          },
        };
      },
    });
    const atBase = await g.files('acme/x', base);
    expect(atBase.ok && atBase.value.map((f) => Buffer.from(f.content).toString())).toEqual([
      'base\n',
    ]);
    expect(asked).toEqual([`default_only:${base}`]);
    const atHead = await g.files('acme/x', head);
    expect(atHead.ok && atHead.value.map((f) => Buffer.from(f.content).toString())).toEqual([
      'head\n',
    ]);
    expect(asked.slice(1)).toEqual([`default_only:${head}`, 'all:-']);
  });
});
