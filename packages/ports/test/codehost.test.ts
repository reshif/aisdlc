import { CODEHOST_FORBIDDEN_VERBS, type CodeHostNotOk } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  CODEHOST_PORT_METHODS,
  FakeGitHub,
  FakeRegisteredRepos,
  badRepoPath,
  effectiveBranchRules,
  forbiddenVerbMethods,
  gitBlobSha,
  holds,
  mapRead,
  readOk,
  readUnknown,
  readUnreadable,
} from '../src/index.js';
import { codeHostContract, contractSeed, rawRules, SHA_A } from '../src/testing.js';

codeHostContract('FakeGitHub', async (seed) => {
  const fake = new FakeGitHub(seed);
  return {
    port: fake,
    requests: () => fake.requests,
    breakAll: (as: CodeHostNotOk | null) => (as === null ? fake.unbreak() : fake.breakAll(as)),
  };
});

describe('CodeHostPort', () => {
  it('names no method after a forbidden verb', () => {
    expect(forbiddenVerbMethods([...CODEHOST_PORT_METHODS])).toEqual([]);
    expect(
      forbiddenVerbMethods(['merge_pr', 'auto_merge', 'FORCE_push', 'x_admin', 'enqueue']),
    ).toEqual(['merge_pr', 'auto_merge', 'FORCE_push', 'x_admin', 'enqueue']);
    expect(CODEHOST_FORBIDDEN_VERBS).toHaveLength(8);
  });

  it('holds is only true for an ok read that satisfies the predicate', () => {
    expect(holds(readOk(3), (n) => n === 3)).toBe(true);
    expect(holds(readOk(3), (n) => n === 4)).toBe(false);
    expect(holds(readUnknown('network', 'x'), () => true)).toBe(false);
    expect(holds(readUnreadable('forbidden', 'x'), () => true)).toBe(false);
    expect(mapRead(readOk(2), (n) => n * 2)).toEqual(readOk(4));
    expect(mapRead(readUnknown('timeout', 't'), (n: number) => n)).toMatchObject({
      state: 'unknown',
    });
  });

  it('computes a git blob id like git hash-object', () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('accepts only repo-relative paths', () => {
    expect(badRepoPath('a/b.md')).toBeNull();
    for (const p of ['', '/a', 'a/', 'a/./b', '../a', 'a\\b', 'a\0b']) {
      expect(badRepoPath(p)).not.toBeNull();
    }
  });
});

describe('effectiveBranchRules', () => {
  it('is malformed (unknown), never "no rules", when a known rule has bad parameters', () => {
    const bad = effectiveBranchRules('main', [{ type: 'pull_request', parameters: { x: 1 } }]);
    expect(bad).toMatchObject({ state: 'unknown', reason: 'malformed' });
    expect(
      effectiveBranchRules('main', [{ type: 'required_status_checks', parameters: {} }]).state,
    ).toBe('unknown');
    expect(effectiveBranchRules('main', { not: 'a list' }).state).toBe('unknown');
    expect(effectiveBranchRules('main', [{ nope: 1 }]).state).toBe('unknown');
  });

  it('keeps an unpinned check unpinned even when another ruleset pins the same context', () => {
    const r = effectiveBranchRules('main', [
      rawRules.checks([{ context: 'ci', integration_id: 7 }], false, 1),
      rawRules.checks([{ context: 'ci' }], false, 2),
    ]);
    expect(r.state === 'ok' && r.value.required_checks).toEqual([
      { context: 'ci', integration_id: null },
      { context: 'ci', integration_id: 7 },
    ]);
  });
});

describe('FakeGitHub', () => {
  it('logs the request each call stands for (a bundle: git ref discovery), and apply_patch/pr_status log nothing', async () => {
    const f = new FakeGitHub(contractSeed());
    await f.list_repos();
    await f.rules_for_branch({ repo: 'acme/app', branch: 'feature/x' });
    await f.read_at_sha({ repo: 'acme/app', sha: SHA_A, path: 'docs/a b.md' });
    const b = await f.bundle({ repo: 'acme/app', base_sha: SHA_A, refs: 'all' });
    if (b.state === 'ok') b.value.dispose();
    await f.apply_patch({
      repo: 'acme/app',
      branch: 'agent/x/y',
      base_sha: SHA_A,
      patch: '',
      message: 'm',
    });
    await f.pr_status({ repo: 'acme/app', number: 1 });
    expect(f.requests).toEqual([
      { method: 'GET', path: '/installation/repositories' },
      { method: 'GET', path: '/repos/acme/app/rules/branches/feature%2Fx' },
      { method: 'GET', path: '/repos/acme/app/contents/docs/a%20b.md' },
      { method: 'GET', path: '/acme/app.git/info/refs?service=git-upload-pack' },
    ]);
  });

  it('refuses an invalid seed, and compares repo names without case', async () => {
    expect(() => new FakeGitHub({ ...contractSeed(), extra: 1 } as never)).toThrow();
    const f = new FakeGitHub(contractSeed());
    const r = await f.collaborators({ repo: 'ACME/App' });
    expect(r.state).toBe('ok');
  });
});

describe('FakeRegisteredRepos', () => {
  it('lists what was set, and a broken registry is an error, not an empty list', async () => {
    const r = new FakeRegisteredRepos().set([{ project_id: 'p1', repo: 'acme/app' }]);
    const a = await r.list();
    expect(a.ok && a.value).toEqual([{ project_id: 'p1', repo: 'acme/app' }]);
    r.breakIt();
    const b = await r.list();
    expect(!b.ok && b.error.code).toBe('unavailable');
    expect(() => r.add('Bad Project', 'acme/app')).toThrow();
  });
});
