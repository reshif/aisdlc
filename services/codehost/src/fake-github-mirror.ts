import { execFileSync } from 'node:child_process';
import type { GitObjects } from './fake-github-objects.js';
import { gitEnv } from './git-server-testing.js';

// The compose fake GitHub (fake-github.ts) answers the REST API from memory and git from a bare repository on disk. When
// the Git Data API creates or moves a branch (the Push Broker's write), this writes the commits the API made into the
// bare repository with the SAME object ids (the fake hashes objects as git does; each id is checked against the one git
// computes) and points the branch at the head, so a `git fetch` of the agent branch (S7 reads the Unit head as a bundle)
// sees exactly what the API holds. A mismatch throws: the fake never serves a git history that differs from its API.

export function mirrorRefIntoBareRepo(
  bare: string,
  objects: GitObjects,
  e: { readonly branch: string; readonly sha: string },
): void {
  if (
    !/^[0-9a-f]{40}$/.test(e.sha) ||
    !/^[A-Za-z0-9._/-]+$/.test(e.branch) ||
    e.branch.includes('..')
  ) {
    throw new Error('mirror: not a branch and a commit id');
  }
  const env = gitEnv();
  for (const o of objects.looseObjects(e.sha)) {
    const got = execFileSync(
      'git',
      ['--git-dir', bare, 'hash-object', '-w', '--literally', '-t', o.type, '--stdin'],
      { input: o.body, env, encoding: 'utf8' },
    ).trim();
    if (got !== o.sha)
      throw new Error(`mirror: git hashed a ${o.type} as ${got}, the API as ${o.sha}`);
  }
  execFileSync('git', ['--git-dir', bare, 'update-ref', `refs/heads/${e.branch}`, e.sha], { env });
}
