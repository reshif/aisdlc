import {
  BranchRules,
  CODEHOST_FORBIDDEN_VERBS,
  CodeownersFile,
  Collaborator,
  FileAtSha,
  InstallationInfo,
  InstallationRepo,
  type CodeHostNotOk,
  type CodeHostRead,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  CODEHOST_PORT_METHODS,
  forbiddenVerbMethods,
  gitBlobSha,
  holds,
  type CodeHostPort,
} from './codehost.js';
import { emptySeed, type CodeHostSeed, type LoggedRequest } from './fake-github.js';

// The CodeHostPort contract suite (PLAN M5.1). `codeHostContract` runs against any implementation
// that can be SEEDED: the fake, and the REST adapter over the in-repo fake GitHub HTTP server.
// `codeHostLiveContract` runs the seed-independent, read-only part against the real App when the
// caller has credentials (it never writes and never assumes a repo's rules).

export interface CodeHostHarness {
  port: CodeHostPort;
  /** The requests made so far, as `{method, path}`. */
  requests(): readonly LoggedRequest[];
  /** Makes every read answer `unknown` (`'unknown'`) or `unreadable` (`'unreadable'`), or clears it. */
  breakAll(as: CodeHostNotOk | null): void;
  stop?: () => Promise<void>;
}

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);

const raw = {
  pr: (over: Record<string, unknown> = {}, id = 1) => ({
    type: 'pull_request',
    ruleset_source_type: 'Repository',
    ruleset_source: 'acme/app',
    ruleset_id: id,
    parameters: {
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: true,
      required_review_thread_resolution: false,
      ...over,
    },
  }),
  checks: (
    checks: Array<{ context: string; integration_id?: number }>,
    strict = false,
    id = 1,
  ) => ({
    type: 'required_status_checks',
    ruleset_source_type: 'Repository',
    ruleset_source: 'acme/app',
    ruleset_id: id,
    parameters: { strict_required_status_checks_policy: strict, required_status_checks: checks },
  }),
  simple: (type: string, id = 1) => ({
    type,
    ruleset_source_type: 'Repository',
    ruleset_source: 'acme/app',
    ruleset_id: id,
  }),
};
export { raw as rawRules };

/** The seed the suite uses: two repos, one with files, rules, collaborators and CODEOWNERS errors. */
export function contractSeed(): CodeHostSeed {
  return emptySeed({
    installation: {
      installation_id: 4242,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'read', metadata: 'read', statuses: 'write' },
      suspended: false,
    },
    repos: [
      { full_name: 'acme/app', default_branch: 'main', private: true, archived: false },
      { full_name: 'acme/lib', default_branch: 'trunk', private: false, archived: false },
    ],
    heads: [
      { repo: 'acme/app', branch: 'main', sha: SHA_A },
      { repo: 'acme/lib', branch: 'trunk', sha: SHA_B },
    ],
    files: [
      { repo: 'acme/app', sha: SHA_A, path: 'README.md', content: '# App\nhello é\n' },
      { repo: 'acme/app', sha: SHA_A, path: 'docs/guide/start.md', content: 'start' },
      { repo: 'acme/app', sha: SHA_A, path: 'CODEOWNERS', content: '* @root-owner\n' },
      { repo: 'acme/app', sha: SHA_A, path: '.github/CODEOWNERS', content: '* @github-owner\n' },
      { repo: 'acme/lib', sha: SHA_B, path: 'docs/CODEOWNERS', content: '* @docs-owner\n' },
    ],
    rules: [
      {
        repo: 'acme/app',
        branch: 'main',
        rules: [
          raw.pr({}, 1),
          raw.pr({ required_approving_review_count: 2, require_code_owner_review: true }, 2),
          raw.checks([{ context: 'gate-check', integration_id: 99 }, { context: 'lint' }], true, 1),
          raw.checks([{ context: 'gate-check', integration_id: 99 }], false, 2),
          raw.simple('non_fast_forward'),
          raw.simple('deletion', 2),
          raw.simple('required_signatures'),
          raw.simple('required_linear_history'),
          raw.simple('creation'),
        ],
      },
    ],
    codeowners_errors: [
      {
        repo: 'acme/app',
        ref: 'main',
        errors: [
          {
            line: 3,
            column: 5,
            kind: 'Invalid owner',
            message: 'Unknown owner on line 3',
            path: '.github/CODEOWNERS',
          },
        ],
      },
    ],
    collaborators: [
      {
        repo: 'acme/app',
        collaborators: [
          { login: 'alice', permission: 'admin' },
          { login: 'bob', permission: 'write' },
        ],
      },
    ],
  });
}

const okValue = <T>(r: CodeHostRead<T>): T => {
  if (r.state !== 'ok') throw new Error(`expected ok, got ${r.state}/${r.reason}: ${r.message}`);
  return r.value;
};

const notOk = (r: CodeHostRead<unknown>): CodeHostNotOk => {
  if (r.state === 'ok') throw new Error('expected a read that is not ok');
  return r;
};

/** Behaviour every seedable `CodeHostPort` must have. `make` builds a fresh host from a seed. */
export function codeHostContract(
  name: string,
  make: (seed: CodeHostSeed) => Promise<CodeHostHarness>,
  /**
   * `bundle: false` for an implementation whose bundle needs a real git server (the REST adapter
   * has its own suite in services/codehost); then the bundle is only asserted to be refused.
   */
  opts: { bundle?: boolean } = {},
): void {
  const bundleSupported = opts.bundle ?? true;
  describe(`CodeHostPort contract: ${name}`, () => {
    const withHost = async (
      fn: (h: CodeHostHarness) => Promise<void>,
      seed: CodeHostSeed = contractSeed(),
    ): Promise<void> => {
      const h = await make(seed);
      try {
        await fn(h);
      } finally {
        await h.stop?.();
      }
    };

    it('lists the installation repos and describes the installation', () =>
      withHost(async ({ port }) => {
        const repos = okValue(await port.list_repos());
        expect(repos.map((r) => InstallationRepo.parse(r).full_name).sort()).toEqual([
          'acme/app',
          'acme/lib',
        ]);
        expect(repos.find((r) => r.full_name === 'acme/lib')).toMatchObject({
          default_branch: 'trunk',
          private: false,
        });
        const inst = InstallationInfo.parse(okValue(await port.installation()));
        expect(inst).toMatchObject({
          installation_id: 4242,
          repository_selection: 'selected',
          suspended: false,
        });
        expect(inst.permissions).toEqual({ contents: 'read', metadata: 'read', statuses: 'write' });
      }));

    it('reads a file at a sha with its git blob id; a file that is not there is ok(null)', () =>
      withHost(async ({ port }) => {
        const f = FileAtSha.parse(
          okValue(await port.read_at_sha({ repo: 'acme/app', sha: SHA_A, path: 'README.md' })),
        );
        expect(f.content).toBe('# App\nhello é\n');
        expect(f.blob_sha).toBe(gitBlobSha('# App\nhello é\n'));
        expect(f.size).toBe(Buffer.byteLength('# App\nhello é\n'));
        const nested = okValue(
          await port.read_at_sha({ repo: 'acme/app', sha: SHA_A, path: 'docs/guide/start.md' }),
        );
        expect(nested?.content).toBe('start');
        expect(
          okValue(await port.read_at_sha({ repo: 'acme/app', sha: SHA_A, path: 'nope.md' })),
        ).toBeNull();
        expect(
          okValue(await port.read_at_sha({ repo: 'acme/app', sha: SHA_B, path: 'README.md' })),
        ).toBeNull();
      }));

    it('refuses a path that is not repo-relative, and a repo outside the installation', () =>
      withHost(async ({ port }) => {
        for (const path of ['../etc/passwd', '/etc/passwd', 'a/../b', 'a//b', '', 'a\\b']) {
          const r = await port.read_at_sha({ repo: 'acme/app', sha: SHA_A, path });
          expect(r.state).toBe('unreadable');
        }
        const other = await port.read_at_sha({ repo: 'evil/other', sha: SHA_A, path: 'README.md' });
        expect(notOk(other).state).toBe('unreadable');
        expect(
          (await port.rules_for_branch({ repo: 'evil/other', branch: 'main' })).state,
        ).not.toBe('ok');
        expect((await port.collaborators({ repo: 'evil/other' })).state).not.toBe('ok');
        expect((await port.codeowners({ repo: 'evil/other', sha: SHA_A })).state).not.toBe('ok');
      }));

    it('resolves a branch head', () =>
      withHost(async ({ port }) => {
        expect(okValue(await port.branch_head({ repo: 'acme/lib', branch: 'trunk' }))).toBe(SHA_B);
        expect((await port.branch_head({ repo: 'acme/lib', branch: 'nope' })).state).toBe(
          'unreadable',
        );
      }));

    it('merges the rules of every ruleset on a branch, strictest value first', () =>
      withHost(async ({ port }) => {
        const r = BranchRules.parse(
          okValue(await port.rules_for_branch({ repo: 'acme/app', branch: 'main' })),
        );
        expect(r).toEqual({
          branch: 'main',
          pull_request: {
            required_approving_review_count: 2,
            require_code_owner_review: true,
            require_last_push_approval: true,
            dismiss_stale_reviews_on_push: false,
            required_review_thread_resolution: false,
          },
          required_checks: [
            { context: 'gate-check', integration_id: 99 },
            { context: 'lint', integration_id: null },
          ],
          strict_status_checks: true,
          blocks_force_push: true,
          blocks_deletion: true,
          requires_linear_history: true,
          requires_signatures: true,
          other_rule_types: ['creation'],
        });
      }));

    it('a branch with no rules has no rules (ok, empty), not "unknown"', () =>
      withHost(async ({ port }) => {
        const r = okValue(await port.rules_for_branch({ repo: 'acme/lib', branch: 'trunk' }));
        expect(r).toMatchObject({
          pull_request: null,
          required_checks: [],
          blocks_force_push: false,
          blocks_deletion: false,
        });
      }));

    it('finds CODEOWNERS in GitHub order (.github, root, docs) and reports none as ok(null)', () =>
      withHost(async ({ port }) => {
        const a = CodeownersFile.parse(
          okValue(await port.codeowners({ repo: 'acme/app', sha: SHA_A })),
        );
        expect(a).toMatchObject({ path: '.github/CODEOWNERS', content: '* @github-owner\n' });
        expect(a.blob_sha).toBe(gitBlobSha('* @github-owner\n'));
        const b = okValue(await port.codeowners({ repo: 'acme/lib', sha: SHA_B }));
        expect(b?.path).toBe('docs/CODEOWNERS');
        expect(okValue(await port.codeowners({ repo: 'acme/lib', sha: SHA_A }))).toBeNull();
      }));

    it('reports the CODEOWNERS errors GitHub shows, and collaborators with their role', () =>
      withHost(async ({ port }) => {
        const e = okValue(await port.codeowners_errors({ repo: 'acme/app', ref: 'main' }));
        expect(e).toHaveLength(1);
        expect(e[0]).toMatchObject({ line: 3, kind: 'Invalid owner' });
        expect(okValue(await port.codeowners_errors({ repo: 'acme/lib', ref: 'trunk' }))).toEqual(
          [],
        );
        const c = okValue(await port.collaborators({ repo: 'acme/app' })).map((x) =>
          Collaborator.parse(x),
        );
        expect(c).toEqual([
          { login: 'alice', permission: 'admin' },
          { login: 'bob', permission: 'write' },
        ]);
      }));

    it('unknown and unreadable are never ok, and `holds` is never true for them', () =>
      withHost(async (h) => {
        for (const as of [
          { state: 'unknown', reason: 'network', message: 'down' },
          { state: 'unreadable', reason: 'forbidden', message: 'no' },
        ] as const) {
          h.breakAll(as);
          const reads = [
            await h.port.list_repos(),
            await h.port.installation(),
            await h.port.read_at_sha({ repo: 'acme/app', sha: SHA_A, path: 'README.md' }),
            await h.port.branch_head({ repo: 'acme/app', branch: 'main' }),
            await h.port.rules_for_branch({ repo: 'acme/app', branch: 'main' }),
            await h.port.codeowners({ repo: 'acme/app', sha: SHA_A }),
            await h.port.codeowners_errors({ repo: 'acme/app', ref: 'main' }),
            await h.port.collaborators({ repo: 'acme/app' }),
            ...(bundleSupported ? [await h.port.bundle({ repo: 'acme/app', refs: 'all' })] : []),
          ];
          for (const r of reads) {
            expect(r.state).toBe(as.state);
            expect(holds(r as CodeHostRead<unknown>, () => true)).toBe(false);
            expect(holds(r as CodeHostRead<unknown>, () => false)).toBe(false);
          }
        }
        h.breakAll(null);
        expect((await h.port.list_repos()).state).toBe('ok');
      }));

    it.runIf(bundleSupported)(
      'bundle: a stream plus a manifest whose head is the default branch head, recorded refs, head_moved on a stale base',
      () =>
        withHost(async ({ port, requests }) => {
          const r = await port.bundle({ repo: 'acme/app', base_sha: SHA_A, refs: 'all' });
          if (r.state !== 'ok') throw new Error(`bundle: ${r.state}/${r.reason}`);
          const chunks: Buffer[] = [];
          for await (const c of r.value.stream) chunks.push(c as Buffer);
          const bytes = Buffer.concat(chunks);
          expect(r.value.manifest).toMatchObject({
            repo: 'acme/app',
            head_sha: SHA_A,
            refs_covered: 'all',
          });
          expect(r.value.manifest.bytes).toBe(bytes.length);
          expect(r.value.manifest.ref_count).toBeGreaterThanOrEqual(1);
          const only = await port.bundle({ repo: 'acme/app', refs: 'default_only' });
          expect(only.state === 'ok' && only.value.manifest.refs_covered).toBe('default_only');
          if (only.state === 'ok') only.value.dispose();
          expect(
            notOk(await port.bundle({ repo: 'acme/app', base_sha: SHA_B, refs: 'all' })),
          ).toMatchObject({
            state: 'unreadable',
            reason: 'head_moved',
          });
          expect(notOk(await port.bundle({ repo: 'nobody/none', refs: 'all' })).state).not.toBe(
            'ok',
          );
          expect(requests().every((q) => q.method === 'GET')).toBe(true);
        }),
    );

    it('apply_patch and pr_status are interface only: unreadable/not_implemented', () =>
      withHost(async ({ port, requests }) => {
        const before = requests().length;
        const reads = [
          await port.apply_patch({
            repo: 'acme/app',
            branch: 'agent/x/y',
            base_sha: SHA_A,
            patch: '',
            message: 'm',
          }),
          await port.pr_status({ repo: 'acme/app', number: 1 }),
        ];
        for (const r of reads)
          expect(notOk(r)).toMatchObject({ state: 'unreadable', reason: 'not_implemented' });
        expect(requests().length).toBe(before);
      }));

    it('has no method that can express a forbidden verb, and only ever GETs', () =>
      withHost(async ({ port, requests }) => {
        const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(port)).filter(
          (n) =>
            n !== 'constructor' &&
            typeof (port as unknown as Record<string, unknown>)[n] === 'function',
        );
        // Public methods are exactly the port's (implementations may have private helpers; none may be a verb).
        for (const m of CODEHOST_PORT_METHODS) expect(proto).toContain(m);
        expect(forbiddenVerbMethods(proto)).toEqual([]);
        expect(forbiddenVerbMethods([...CODEHOST_PORT_METHODS])).toEqual([]);
        expect(CODEHOST_FORBIDDEN_VERBS).toEqual([
          'merge',
          'enqueue',
          'approve',
          'auto_merge',
          'force',
          'delete',
          'dismiss',
          'admin',
        ]);
        // A full read pass.
        await port.list_repos();
        await port.installation();
        await port.read_at_sha({ repo: 'acme/app', sha: SHA_A, path: 'README.md' });
        await port.rules_for_branch({ repo: 'acme/app', branch: 'main' });
        await port.codeowners({ repo: 'acme/app', sha: SHA_A });
        await port.codeowners_errors({ repo: 'acme/app', ref: 'main' });
        await port.collaborators({ repo: 'acme/app' });
        expect(requests().length).toBeGreaterThan(0);
        expect(requests().every((r) => r.method === 'GET')).toBe(true);
        expect(requests().some((r) => /\/rulesets(\/|$|\?)/.test(r.path))).toBe(false);
      }));
  });
}

/**
 * The read-only checks that hold for any real installation. They assert shapes and fail-closed
 * behaviour, never a particular repo's settings. `repo` must be reachable by the installation.
 */
export function codeHostLiveContract(
  name: string,
  make: () => Promise<{
    port: CodeHostPort;
    repo: string;
    requests(): readonly LoggedRequest[];
    stop?: () => Promise<void>;
  }>,
  opts: { skip?: boolean } = {},
): void {
  describe.skipIf(opts.skip === true)(`CodeHostPort live contract: ${name}`, () => {
    it('reads installation, repos, head, rules and collaborators with the right shapes; GET only', async () => {
      const { port, repo, requests, stop } = await make();
      try {
        const inst = InstallationInfo.parse(okValue(await port.installation()));
        expect(inst.installation_id).toBeGreaterThan(0);
        const repos = okValue(await port.list_repos()).map((r) => InstallationRepo.parse(r));
        const mine = repos.find((r) => r.full_name.toLowerCase() === repo.toLowerCase());
        expect(mine).toBeDefined();
        const branch = mine?.default_branch ?? 'main';
        const head = okValue(await port.branch_head({ repo, branch }));
        expect(head).toMatch(/^[0-9a-f]{40}$/);
        // Rules, CODEOWNERS and collaborators may legitimately be unreadable for this App; when
        // they are readable they parse, and when they are not they are never "ok".
        const rules = await port.rules_for_branch({ repo, branch });
        if (rules.state === 'ok') BranchRules.parse(rules.value);
        const co = await port.codeowners({ repo, sha: head });
        if (co.state === 'ok' && co.value) CodeownersFile.parse(co.value);
        const collab = await port.collaborators({ repo });
        if (collab.state === 'ok') collab.value.forEach((c) => Collaborator.parse(c));
        expect(requests().every((r) => r.method === 'GET')).toBe(true);
        expect(requests().some((r) => /\/rulesets(\/|$|\?)/.test(r.path))).toBe(false);
      } finally {
        await stop?.();
      }
    });
  });
}
