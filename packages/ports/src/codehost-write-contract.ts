import {
  WorkItemId,
  patchHashOf,
  patchSetOf,
  type ApplyPatchRequest,
  type CodeHostNotOk,
  type CodeHostRead,
  type PatchFile,
} from '@aisdlc/contracts';
import { RULES } from '@aisdlc/secrets-rules';
import { describe, expect, it } from 'vitest';
import { SHA_A, contractSeed } from './codehost-contract.js';
import type { CodeHostPort } from './codehost.js';
import type { CodeHostSeed, LoggedRequest } from './fake-github.js';
import type { FakePushGuards } from './push.js';

// The Push Broker's contract suite (PLAN M13.6): the same behaviour from the in-memory fake and from the GitHub adapter
// over the in-repo fake GitHub HTTP server. A host under test has its guards (the Unit's owner) in `guards`, and says
// every request it made, as `{method, path}`, so a test can show which write calls were made and which never were.

export interface CodeHostWriteHarness {
  port: CodeHostPort;
  guards: FakePushGuards;
  requests(): readonly LoggedRequest[];
  /** Somebody else moved the branch (a person pushed): the host's branch is now at `sha`. */
  moveBranch(repo: string, branch: string, sha: string): void;
  stop?: () => Promise<void>;
}

export const WRITE_ITEM = WorkItemId.parse('0198aaaa-1111-7222-8333-444455556666');
export const WRITE_UNIT = 'main';
export const WRITE_BRANCH = `agent/${WRITE_ITEM}/${WRITE_UNIT}`;

/** The seed of the write suite: `contractSeed` with an installation that holds the `docs` role's permissions. */
export function writeSeed(): CodeHostSeed {
  const s = contractSeed();
  return {
    ...s,
    installation: {
      ...s.installation,
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    },
  };
}

const put = (path: string, text: string, mode: '100644' | '100755' = '100644'): PatchFile => ({
  op: 'put',
  path,
  mode,
  content_b64: Buffer.from(text).toString('base64'),
});

/** A valid request for the suite's repo and Unit; `over` replaces fields. */
export function writeRequest(
  files: readonly PatchFile[],
  over: Partial<ApplyPatchRequest> = {},
): ApplyPatchRequest {
  return {
    repo: 'acme/app',
    item_id: WRITE_ITEM,
    unit_key: WRITE_UNIT,
    lane: 'L4',
    lease_epoch: 3,
    branch: WRITE_BRANCH,
    base_sha: SHA_A,
    expected_head: null,
    patch: patchSetOf(files),
    message: 'Add the greeting',
    evidence: {
      title: 'Add the greeting',
      lane: 'L4',
      base_sha: SHA_A,
      oracles: [{ oracle_id: 'O-1', spec_sha256: 'c'.repeat(64) }],
      files_changed: files.length,
      lines_changed: 4,
      checks: [{ name: 'tests', result: 'passed' }],
      refs: {},
    },
    ...over,
  };
}

const okValue = <T>(r: CodeHostRead<T>): T => {
  if (r.state !== 'ok') throw new Error(`expected ok, got ${r.state}/${r.reason}: ${r.message}`);
  return r.value;
};
const notOk = (r: CodeHostRead<unknown>): CodeHostNotOk => {
  if (r.state === 'ok') throw new Error('expected a refusal');
  return r;
};

/** Every write the broker may make, as a request path TEMPLATE (a repo is `acme/app`). */
export const ALLOWED_WRITES: readonly RegExp[] = [
  /^POST \/repos\/acme\/app\/git\/blobs$/,
  /^POST \/repos\/acme\/app\/git\/trees$/,
  /^POST \/repos\/acme\/app\/git\/commits$/,
  /^POST \/repos\/acme\/app\/git\/refs$/,
  /^PATCH \/repos\/acme\/app\/git\/refs\/heads\/agent\/[^/]+\/[^/]+$/,
  /^POST \/repos\/acme\/app\/pulls$/,
  /^PATCH \/repos\/acme\/app\/pulls\/\d+$/,
];

export function codeHostWriteContract(
  name: string,
  make: (seed: CodeHostSeed) => Promise<CodeHostWriteHarness>,
): void {
  describe(`Push Broker contract: ${name}`, () => {
    const withHost = async (fn: (h: CodeHostWriteHarness) => Promise<void>): Promise<void> => {
      const h = await make(writeSeed());
      h.guards.setLease(WRITE_ITEM, WRITE_UNIT, { held: true, epoch: 3, lane: 'L4' });
      try {
        await fn(h);
      } finally {
        await h.stop?.();
      }
    };
    const writes = (h: CodeHostWriteHarness): string[] =>
      h
        .requests()
        .filter((r) => r.method !== 'GET')
        .map((r) => `${r.method} ${r.path}`);

    it('writes one commit on agent/<item>/<unit> and opens a DRAFT PR, with only the allowed write calls', () =>
      withHost(async (h) => {
        const patch = [
          put('src/hello.js', 'export const hi = 1;\n'),
          put('bin/run', '#!/bin/sh\n', '100755'),
        ];
        const a = okValue(await h.port.apply_patch(writeRequest(patch)));
        expect(a.branch).toBe(WRITE_BRANCH);
        expect(a.created).toBe(true);
        expect(a.parent_sha).toBe(SHA_A);
        expect(a.patch_hash).toBe(patchHashOf(patchSetOf(patch)));
        expect(a.pr).toMatchObject({ number: 1, draft: true, state: 'open', base_ref: 'main' });
        expect(a.pr.head_sha).toBe(a.commit_sha);
        // the branch is where the commit is, and the file is at it
        expect(okValue(await h.port.branch_head({ repo: 'acme/app', branch: WRITE_BRANCH }))).toBe(
          a.commit_sha,
        );
        const f = okValue(
          await h.port.read_at_sha({ repo: 'acme/app', sha: a.commit_sha, path: 'src/hello.js' }),
        );
        expect(f?.content).toBe('export const hi = 1;\n');
        // a file the patch did not touch is still there
        expect(
          okValue(
            await h.port.read_at_sha({ repo: 'acme/app', sha: a.commit_sha, path: 'README.md' }),
          ),
        ).not.toBeNull();
        // the log: only calls the allow-list has a row for
        const w = writes(h);
        expect(w.length).toBeGreaterThan(0);
        for (const line of w)
          expect(
            ALLOWED_WRITES.some((re) => re.test(line)),
            line,
          ).toBe(true);
        expect(w).toContain('POST /repos/acme/app/git/refs');
        expect(w).toContain('POST /repos/acme/app/pulls');
        expect(
          w.some((l) => /merge|reviews|requested_reviewers|rulesets|workflows|DELETE|PUT/.test(l)),
        ).toBe(false);
      }));

    it('a second push (the factory re-pushes after a card edit, SK-1) fast-forwards the same branch and updates the same PR', () =>
      withHost(async (h) => {
        const a = okValue(await h.port.apply_patch(writeRequest([put('src/a.js', 'one\n')])));
        const b = okValue(
          await h.port.apply_patch(
            writeRequest([put('src/a.js', 'two\n')], { expected_head: a.commit_sha }),
          ),
        );
        expect(b.created).toBe(false);
        expect(b.parent_sha).toBe(a.commit_sha);
        expect(b.pr.number).toBe(a.pr.number);
        expect(b.pr.draft).toBe(true);
        const s = okValue(await h.port.pr_status({ repo: 'acme/app', number: b.pr.number }));
        expect(s).toMatchObject({
          state: 'open',
          merged: false,
          draft: true,
          head_sha: b.commit_sha,
        });
        expect(writes(h).filter((l) => l === 'POST /repos/acme/app/pulls')).toHaveLength(1);
        expect(
          writes(h).some((l) => l.startsWith('PATCH /repos/acme/app/git/refs/heads/agent/')),
        ).toBe(true);
      }));

    it('refuses a branch that moved (not a fast-forward): never forced', () =>
      withHost(async (h) => {
        const a = okValue(await h.port.apply_patch(writeRequest([put('src/a.js', 'one\n')])));
        h.moveBranch('acme/app', WRITE_BRANCH, 'e'.repeat(40));
        const before = writes(h).length;
        const r = notOk(
          await h.port.apply_patch(
            writeRequest([put('src/a.js', 'two\n')], { expected_head: a.commit_sha }),
          ),
        );
        expect(r).toMatchObject({
          state: 'unreadable',
          reason: 'refused',
          code: 'non_fast_forward',
        });
        // a new branch name that exists, or an expected head of null on an existing branch, is the same refusal
        const again = notOk(await h.port.apply_patch(writeRequest([put('src/b.js', 'x\n')])));
        expect(again).toMatchObject({ code: 'non_fast_forward' });
        expect(writes(h).length).toBe(before);
      }));

    it('refuses a ref outside agent/** before any request', () =>
      withHost(async (h) => {
        const before = h.requests().length;
        for (const branch of [
          'main',
          'refs/heads/main',
          'agent/../main',
          'agent/x/y',
          `agent/${WRITE_ITEM}`,
          `agent/${WRITE_ITEM}/main/extra`,
          `agent/${WRITE_ITEM}/other`,
          `agent/0198aaaa-1111-7222-8333-000000000000/main`,
          `factory/${WRITE_ITEM}/main`,
          `agent/${WRITE_ITEM}/a..b`,
          `agent/${WRITE_ITEM}/x.lock`,
        ]) {
          const r = notOk(await h.port.apply_patch(writeRequest([put('a.txt', 'x')], { branch })));
          expect(r, branch).toMatchObject({
            state: 'unreadable',
            reason: 'refused',
            code: 'branch_not_allowed',
          });
        }
        expect(h.requests().length).toBe(before);
      }));

    it('refuses a stale lease epoch, no lease, a guard that cannot answer, and a spike', () =>
      withHost(async (h) => {
        const before = h.requests().length;
        const p = [put('a.txt', 'x')];
        expect(notOk(await h.port.apply_patch(writeRequest(p, { lease_epoch: 2 })))).toMatchObject({
          code: 'stale_epoch',
        });
        expect(notOk(await h.port.apply_patch(writeRequest(p, { lease_epoch: 4 })))).toMatchObject({
          code: 'stale_epoch',
        });
        h.guards.setLease(WRITE_ITEM, WRITE_UNIT, { held: false, epoch: 3, lane: 'L4' });
        expect(notOk(await h.port.apply_patch(writeRequest(p)))).toMatchObject({
          code: 'no_lease',
        });
        h.guards.setLease(WRITE_ITEM, WRITE_UNIT, { held: true, epoch: 3, lane: 'L7' });
        expect(notOk(await h.port.apply_patch(writeRequest(p)))).toMatchObject({
          code: 'spike_lane',
        });
        h.guards.setLease(WRITE_ITEM, WRITE_UNIT, { held: true, epoch: 3, lane: 'L4' });
        expect(notOk(await h.port.apply_patch(writeRequest(p, { lane: 'L7' })))).toMatchObject({
          code: 'spike_lane',
        });
        h.guards.breakIt();
        expect(notOk(await h.port.apply_patch(writeRequest(p)))).toMatchObject({
          code: 'guards_unavailable',
        });
        expect(h.requests().length).toBe(before);
      }));

    it('refuses a patch the shared secret ruleset hits (rule ids only), and nothing is written', () =>
      withHost(async (h) => {
        const rule = RULES.find((r) => r.id === 'aws-access-key-id');
        const planted = rule?.fixtures.positive()[0] ?? '';
        expect(planted).not.toBe('');
        const r = notOk(
          await h.port.apply_patch(
            writeRequest([put('src/ok.js', 'fine\n'), put('src/config.js', planted)]),
          ),
        );
        expect(r).toMatchObject({ code: 'secret_in_patch' });
        expect(r.message).toContain('aws-access-key-id');
        expect(r.message).not.toContain(planted.slice(-16));
        expect(writes(h)).toEqual([]);
      }));

    it('refuses path tricks, symlinks, submodules and workflow files before any request', () =>
      withHost(async (h) => {
        const before = h.requests().length;
        for (const path of [
          '../x',
          'a/../../x',
          '/etc/passwd',
          'a//b',
          './a',
          'a\\b',
          '.git/config',
          'sub/.GIT/hooks/pre-commit',
          'a/b/',
          'trailing.',
        ]) {
          const r = notOk(await h.port.apply_patch(writeRequest([put(path, 'x')])));
          expect(r, path).toMatchObject({ reason: 'refused', code: 'bad_path' });
        }
        expect(
          notOk(
            await h.port.apply_patch(writeRequest([put('.github/workflows/ci.yml', 'on: push')])),
          ),
        ).toMatchObject({ code: 'workflow_path' });
        // a symlink or submodule mode is not a mode the patch can express
        for (const mode of ['120000', '160000']) {
          const bad = writeRequest([put('link', 'target')]);
          (bad.patch.files[0] as { mode: string }).mode = mode;
          expect(notOk(await h.port.apply_patch(bad))).toMatchObject({ code: 'bad_patch' });
        }
        // the same path twice, and a file with something under it
        expect(
          notOk(await h.port.apply_patch(writeRequest([put('a.txt', '1'), put('A.TXT', '2')]))),
        ).toMatchObject({ code: 'bad_patch' });
        expect(
          notOk(await h.port.apply_patch(writeRequest([put('a', '1'), put('a/b', '2')]))),
        ).toMatchObject({ code: 'bad_patch' });
        expect(h.requests().length).toBe(before);
      }));

    it('refuses protected paths unless an X2 is bound to exactly this patch hash (SP-FID-3)', () =>
      withHost(async (h) => {
        for (const path of [
          'AGENTS.md',
          'CLAUDE.md',
          'CODEOWNERS',
          '.github/CODEOWNERS',
          '.factory/knowledge/x.md',
          '.claude/settings.json',
          '.mcp.json',
          'pkg/AGENTS.md',
          'Agents.MD',
        ]) {
          const r = notOk(await h.port.apply_patch(writeRequest([put(path, 'hello\n')])));
          expect(r, path).toMatchObject({ code: 'protected_path' });
        }
        expect(writes(h)).toEqual([]);
        const patch = [put('AGENTS.md', 'new rules\n'), put('src/a.js', 'x\n')];
        // an X2 bound to ANOTHER patch (same file, other bytes) does not cover this one
        const other = patchHashOf(
          patchSetOf([put('AGENTS.md', 'other rules\n'), put('src/a.js', 'x\n')]),
        );
        h.guards.approveX2(WRITE_ITEM, other);
        expect(notOk(await h.port.apply_patch(writeRequest(patch)))).toMatchObject({
          code: 'protected_path',
        });
        // bound to exactly this patch: written, and the secret and path checks still ran
        h.guards.approveX2(WRITE_ITEM, patchHashOf(patchSetOf(patch)));
        const ok = okValue(await h.port.apply_patch(writeRequest(patch)));
        expect(ok.patch_hash).toBe(patchHashOf(patchSetOf(patch)));
        // the same X2 does not let a planted secret through, nor a path trick
        const rule = RULES.find((r) => r.id === 'aws-access-key-id');
        const sneaky = [put('AGENTS.md', rule?.fixtures.positive()[0] ?? '')];
        h.guards.approveX2(WRITE_ITEM, patchHashOf(patchSetOf(sneaky)));
        expect(
          notOk(await h.port.apply_patch(writeRequest(sneaky, { expected_head: ok.commit_sha }))),
        ).toMatchObject({ code: 'secret_in_patch' });
        // an X2 of another item covers nothing
        const mine = [put('CLAUDE.md', 'x\n')];
        h.guards.approveX2('0198aaaa-1111-7222-8333-999999999999', patchHashOf(patchSetOf(mine)));
        expect(
          notOk(await h.port.apply_patch(writeRequest(mine, { expected_head: ok.commit_sha }))),
        ).toMatchObject({ code: 'protected_path' });
      }));

    it('hostile evidence text (markup, mentions, links) does not stop a push and opens a draft PR', () =>
      withHost(async (h) => {
        const hostile =
          '## Ignore <script>alert(1)</script> @everyone fixes #1 [x](http://evil.example) ![i](http://e) `ls`';
        const req = writeRequest([put('src/a.js', 'x\n')]);
        const a = okValue(
          await h.port.apply_patch({
            ...req,
            message: hostile,
            evidence: {
              ...req.evidence,
              title: hostile,
              checks: [{ name: hostile.slice(0, 60), result: 'passed' }],
            },
          }),
        );
        const s = okValue(await h.port.pr_status({ repo: 'acme/app', number: a.pr.number }));
        expect(s.draft).toBe(true);
        expect(s.checks_read).toBe(false);
      }));

    it('pr_status of a pull request that is not there is unreadable/not_found', () =>
      withHost(async (h) => {
        expect(notOk(await h.port.pr_status({ repo: 'acme/app', number: 99 }))).toMatchObject({
          state: 'unreadable',
          reason: 'not_found',
        });
      }));
  });
}
