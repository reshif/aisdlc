import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GATE_CHECK_NAME } from '@aisdlc/contracts';
import { emptySeed, type CodeHostSeed } from '@aisdlc/ports';
import { git, gitEnv } from './git-server-testing.js';

// The seeded repository of the compose stack's fake GitHub (see `fake-github.ts`): its files, the
// bare git repository built from them, and what the fake REST host says about it.

/** The files of the seeded repository: ordinary, secret-free, and enough for a Census. */
export const TESTBED_FILES: Readonly<Record<string, string>> = {
  'README.md':
    '# asf-factory-testbed\n\nA throwaway repository for exercising the factory. No production, no real data.\n',
  'AGENTS.md':
    '# AGENTS.md\n\nRun `npm test` before every commit. Keep changes small.\n\n## Commands\n\n```\nnpm test\n```\n',
  'CLAUDE.md': '@AGENTS.md\n',
  '.github/CODEOWNERS': '* @reshif\n',
  'package.json':
    '{\n  "name": "asf-factory-testbed",\n  "version": "0.0.0",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
  'src/index.js': 'export const greet = (name) => `hello ${name}`;\n',
  'test/index.test.js':
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/index.js';\n\ntest('greet', () => assert.equal(greet('x'), 'hello x'));\n",
  'docs/overview.md': '# Overview\n\nThe testbed has one function and one test.\n',
  '.gitignore': 'node_modules/\n',
};

/** Builds `<root>/<repo>.git` (bare, default branch `main`, one commit with `TESTBED_FILES`); returns the head. */
export function buildTestbed(root: string, repo: string): string {
  const bare = join(root, `${repo}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare], {
    env: gitEnv(),
  });
  const work = mkdtempSync(join(tmpdir(), 'aisdlc-testbed-'));
  try {
    git(work, 'init', '--quiet', '--initial-branch=main');
    for (const [path, content] of Object.entries(TESTBED_FILES)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'testbed');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '--quiet', '--mirror', bare);
    return head;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * What the fake REST host knows about the seeded repository at `head`. With `gateCheckAppId` (the compose fake, which
 * knows gate-check's App), protect-main also requires `aisdlc/gate` pinned to that App, as the readiness controls ask.
 */
export function testbedSeed(o: {
  repo: string;
  head: string;
  installationId: number;
  gateCheckAppId?: number;
}): CodeHostSeed {
  const [owner] = o.repo.split('/') as [string];
  const rule = (type: string, parameters?: Record<string, unknown>) => ({
    type,
    ruleset_source_type: 'Repository',
    ruleset_source: o.repo,
    ruleset_id: 1,
    ...(parameters ? { parameters } : {}),
  });
  return emptySeed({
    installation: {
      installation_id: o.installationId,
      account_login: owner,
      repository_selection: 'selected',
      // Read-only: contents and metadata. The factory never asks for more (OB §5.5).
      permissions: { contents: 'read', metadata: 'read' },
      suspended: false,
    },
    repos: [{ full_name: o.repo, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo: o.repo, branch: 'main', sha: o.head }],
    files: Object.entries(TESTBED_FILES).map(([path, content]) => ({
      repo: o.repo,
      sha: o.head,
      path,
      content,
    })),
    rules: [
      {
        repo: o.repo,
        branch: 'main',
        rules: [
          rule('pull_request', {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: true,
            require_last_push_approval: true,
            required_review_thread_resolution: false,
          }),
          rule('non_fast_forward'),
          rule('deletion'),
          ...(o.gateCheckAppId === undefined
            ? []
            : [
                rule('required_status_checks', {
                  strict_required_status_checks_policy: false,
                  required_status_checks: [
                    { context: GATE_CHECK_NAME, integration_id: o.gateCheckAppId },
                  ],
                }),
              ]),
        ],
      },
    ],
    collaborators: [{ repo: o.repo, collaborators: [{ login: owner, permission: 'admin' }] }],
  });
}
