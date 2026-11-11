import {
  CodeownersError,
  Collaborator,
  InstallationInfo,
  InstallationRepo,
  type BranchRules,
  type BundleRequest,
  type CodeHostNotOk,
  type CodeHostRead,
  type CodeownersFile,
  type FileAtSha,
  type GitSha,
} from '@aisdlc/contracts';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  badRepoPath,
  effectiveBranchRules,
  findCodeowners,
  gitBlobSha,
  readOk,
  readUnreadable,
  repoKey,
  type AppliedPatch,
  type ApplyPatchRequest,
  type BranchRequest,
  type BundleResult,
  type CODEHOST_PORT_METHODS,
  type CodeHostPort,
  type CodeownersErrorsRequest,
  type CodeownersRequest,
  type PrStatus,
  type PrStatusRequest,
  type ReadAtShaRequest,
  type RepoRequest,
} from './codehost.js';
import {
  NO_PUSH_GUARDS,
  commitMessage,
  preflightPush,
  refusal,
  renderPr,
  type PushGuardsPort,
} from './push.js';

// FakeGitHub (PLAN M5.1): a deterministic in-memory `CodeHostPort` with a request log. It is
// seeded with a `CodeHostSeed` (the same document the in-repo fake GitHub HTTP server of
// `services/codehost` takes, so one contract suite runs against both). The log has the REST
// request each call stands for, `{method, path}`, so a test can show a Census run made GETs only.

/** What a fake host knows. Rules are the raw rule objects GitHub returns for a branch. */
export const CodeHostSeed = z.strictObject({
  installation: InstallationInfo,
  repos: z.array(InstallationRepo),
  heads: z.array(
    z.strictObject({ repo: z.string(), branch: z.string().min(1), sha: z.string().length(40) }),
  ),
  files: z.array(
    z.strictObject({
      repo: z.string(),
      sha: z.string().length(40),
      path: z.string().min(1),
      content: z.string(),
    }),
  ),
  rules: z.array(
    z.strictObject({ repo: z.string(), branch: z.string().min(1), rules: z.array(z.unknown()) }),
  ),
  codeowners_errors: z.array(
    z.strictObject({ repo: z.string(), ref: z.string().min(1), errors: z.array(CodeownersError) }),
  ),
  collaborators: z.array(
    z.strictObject({ repo: z.string(), collaborators: z.array(Collaborator) }),
  ),
});
export type CodeHostSeed = z.infer<typeof CodeHostSeed>;

export const emptySeed = (over: Partial<CodeHostSeed> = {}): CodeHostSeed => ({
  installation: {
    installation_id: 1,
    account_login: 'acme',
    repository_selection: 'selected',
    permissions: { contents: 'read', metadata: 'read' },
    suspended: false,
  },
  repos: [],
  heads: [],
  files: [],
  rules: [],
  codeowners_errors: [],
  collaborators: [],
  ...over,
});

export interface LoggedRequest {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
}

interface FakeCommit {
  readonly sha: string;
  readonly parent: string | null;
  readonly tree: string;
  readonly message: string;
  /** The whole tree after the commit: path -> bytes (base64) and mode. */
  readonly files: ReadonlyMap<string, { readonly b64: string; readonly mode: string }>;
}

interface FakePr {
  readonly number: number;
  readonly head_ref: string;
  head_sha: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
}

export interface FakeGitHubOptions {
  /** The Unit's owner (lease and X2). Default: none, so a push is refused (fail closed). */
  readonly guards?: PushGuardsPort;
}

type PortMethod = (typeof CODEHOST_PORT_METHODS)[number];

export class FakeGitHub implements CodeHostPort {
  readonly requests: LoggedRequest[] = [];
  private seed: CodeHostSeed = emptySeed();
  private readonly broken = new Map<PortMethod, CodeHostNotOk>();
  private readonly guards: PushGuardsPort;
  private commits = new Map<string, FakeCommit>();
  private prs = new Map<string, FakePr[]>();
  /** What the last accepted `apply_patch` wrote: for tests that look at the commit and the PR body. */
  readonly pushed: Array<{ commit: FakeCommit; pr: FakePr; repo: string }> = [];

  constructor(seed?: CodeHostSeed, opts: FakeGitHubOptions = {}) {
    this.guards = opts.guards ?? NO_PUSH_GUARDS;
    if (seed) this.load(seed);
  }

  /** The PR the fake holds (the body is what a person would read), for tests. */
  prOf(repo: string, number: number): FakePr | undefined {
    return this.prs.get(repoKey(repo))?.find((p) => p.number === number);
  }

  /** Somebody else wrote to the branch (a person pushed, against the rules): the next push is not a fast-forward. */
  moveBranch(repo: string, branch: string, sha: string): this {
    const h = this.seed.heads.find((x) => repoKey(x.repo) === repoKey(repo) && x.branch === branch);
    if (h) h.sha = sha;
    else this.seed.heads.push({ repo, branch, sha });
    return this;
  }

  /** Replaces everything the fake knows (the request log is kept). */
  load(seed: CodeHostSeed): this {
    this.seed = structuredClone(CodeHostSeed.parse(seed));
    this.commits = new Map();
    this.prs = new Map();
    return this;
  }

  /** Makes a method answer `unknown` or `unreadable`; `reset` of it with `unbreak`. */
  breakMethod(method: PortMethod, as: CodeHostNotOk): this {
    this.broken.set(method, as);
    return this;
  }

  breakAll(as: CodeHostNotOk): this {
    for (const m of [
      'list_repos',
      'installation',
      'read_at_sha',
      'branch_head',
      'rules_for_branch',
      'codeowners',
      'codeowners_errors',
      'collaborators',
      'bundle',
    ] as const) {
      this.broken.set(m, as);
    }
    return this;
  }

  unbreak(): this {
    this.broken.clear();
    return this;
  }

  private gate(
    method: PortMethod,
    method_: 'GET' | 'POST' | 'PATCH',
    path: string,
  ): CodeHostNotOk | null {
    this.requests.push({ method: method_, path });
    return this.broken.get(method) ?? null;
  }

  private repoKnown(repo: string): boolean {
    return this.seed.repos.some((r) => repoKey(r.full_name) === repoKey(repo));
  }

  private missingRepo(repo: string): CodeHostNotOk {
    return readUnreadable('not_found', `repository ${repo} is not reachable by this installation`);
  }

  async list_repos(): Promise<CodeHostRead<InstallationRepo[]>> {
    const b = this.gate('list_repos', 'GET', '/installation/repositories');
    if (b) return b;
    return readOk(structuredClone(this.seed.repos));
  }

  async installation(): Promise<CodeHostRead<InstallationInfo>> {
    const b = this.gate(
      'installation',
      'GET',
      `/app/installations/${this.seed.installation.installation_id}`,
    );
    if (b) return b;
    return readOk(structuredClone(this.seed.installation));
  }

  async read_at_sha(req: ReadAtShaRequest): Promise<CodeHostRead<FileAtSha | null>> {
    const bad = badRepoPath(req.path);
    if (bad) return readUnreadable('refused', bad);
    const b = this.gate(
      'read_at_sha',
      'GET',
      `/repos/${req.repo}/contents/${req.path.split('/').map(encodeURIComponent).join('/')}`,
    );
    if (b) return b;
    if (!this.repoKnown(req.repo)) return this.missingRepo(req.repo);
    const pushed = this.commits.get(req.sha)?.files.get(req.path);
    if (pushed) {
      const content = Buffer.from(pushed.b64, 'base64').toString('utf8');
      return readOk({
        path: req.path,
        sha: req.sha,
        blob_sha: gitBlobSha(content),
        size: Buffer.byteLength(content),
        content,
      });
    }
    if (this.commits.has(req.sha)) return readOk(null);
    const f = this.seed.files.find(
      (x) => repoKey(x.repo) === repoKey(req.repo) && x.sha === req.sha && x.path === req.path,
    );
    if (!f) return readOk(null);
    return readOk({
      path: f.path,
      sha: req.sha,
      blob_sha: gitBlobSha(f.content),
      size: Buffer.byteLength(f.content),
      content: f.content,
    });
  }

  async branch_head(req: BranchRequest): Promise<CodeHostRead<GitSha>> {
    const b = this.gate(
      'branch_head',
      'GET',
      `/repos/${req.repo}/commits/${encodeURIComponent(req.branch)}`,
    );
    if (b) return b;
    if (!this.repoKnown(req.repo)) return this.missingRepo(req.repo);
    const h = this.seed.heads.find(
      (x) => repoKey(x.repo) === repoKey(req.repo) && x.branch === req.branch,
    );
    return h ? readOk(h.sha) : readUnreadable('not_found', `no branch ${req.branch}`);
  }

  async rules_for_branch(req: BranchRequest): Promise<CodeHostRead<BranchRules>> {
    const b = this.gate(
      'rules_for_branch',
      'GET',
      `/repos/${req.repo}/rules/branches/${encodeURIComponent(req.branch)}`,
    );
    if (b) return b;
    if (!this.repoKnown(req.repo)) return this.missingRepo(req.repo);
    const raw = this.seed.rules
      .filter((x) => repoKey(x.repo) === repoKey(req.repo) && x.branch === req.branch)
      .flatMap((x) => x.rules);
    return effectiveBranchRules(req.branch, raw);
  }

  async codeowners(req: CodeownersRequest): Promise<CodeHostRead<CodeownersFile | null>> {
    return findCodeowners((path) => this.read_at_sha({ repo: req.repo, sha: req.sha, path }));
  }

  async codeowners_errors(req: CodeownersErrorsRequest): Promise<CodeHostRead<CodeownersError[]>> {
    const b = this.gate('codeowners_errors', 'GET', `/repos/${req.repo}/codeowners/errors`);
    if (b) return b;
    if (!this.repoKnown(req.repo)) return this.missingRepo(req.repo);
    const e = this.seed.codeowners_errors.find(
      (x) => repoKey(x.repo) === repoKey(req.repo) && (req.ref === undefined || x.ref === req.ref),
    );
    return readOk(structuredClone(e?.errors ?? []));
  }

  async collaborators(req: RepoRequest): Promise<CodeHostRead<Collaborator[]>> {
    const b = this.gate('collaborators', 'GET', `/repos/${req.repo}/collaborators`);
    if (b) return b;
    if (!this.repoKnown(req.repo)) return this.missingRepo(req.repo);
    const c = this.seed.collaborators.find((x) => repoKey(x.repo) === repoKey(req.repo));
    return readOk(structuredClone(c?.collaborators ?? []));
  }

  /**
   * A deterministic stand-in bundle: text that names the repo, the refs and the head, never a real
   * git bundle (the real bytes are the codehost's). Its manifest follows the same rules as the real
   * one: `head_sha` is the default branch's head, `default_only` covers one ref, and a `base_sha`
   * that is not the head is `head_moved`.
   */
  async bundle(req: BundleRequest): Promise<CodeHostRead<BundleResult>> {
    const b = this.gate('bundle', 'GET', `/${req.repo}.git/info/refs?service=git-upload-pack`);
    if (b) return b;
    const repo = this.seed.repos.find((r) => repoKey(r.full_name) === repoKey(req.repo));
    if (!repo) return this.missingRepo(req.repo);
    const heads = this.seed.heads.filter((x) => repoKey(x.repo) === repoKey(req.repo));
    const head = heads.find((x) => x.branch === repo.default_branch);
    if (!head) return readUnreadable('not_found', `no branch ${repo.default_branch}`);
    if (req.base_sha !== undefined && req.base_sha !== head.sha) {
      return readUnreadable('head_moved', `the default branch is no longer at ${req.base_sha}`);
    }
    const covered = req.refs === 'all' ? heads : [head];
    const text = [
      '# FakeGitHub bundle (not a git bundle)',
      `repo ${repo.full_name}`,
      `head ${head.sha}`,
      ...covered.map((x) => `${x.sha} refs/heads/${x.branch}`),
      '',
    ].join('\n');
    const bytes = Buffer.from(text);
    const stream = Readable.from([bytes]);
    return readOk({
      manifest: {
        repo: repo.full_name,
        head_sha: head.sha,
        refs_covered: req.refs,
        ref_count: covered.length,
        commit_count: covered.length,
        bytes: bytes.length,
        duration_ms: 0,
      },
      stream,
      dispose: () => void stream.destroy(),
    });
  }

  /** The files of a commit: a pushed one, or the seed's files at that sha. */
  private filesAt(repo: string, sha: string): FakeCommit['files'] {
    const c = this.commits.get(sha);
    if (c) return c.files;
    const m = new Map<string, { b64: string; mode: string }>();
    for (const f of this.seed.files) {
      if (repoKey(f.repo) === repoKey(repo) && f.sha === sha) {
        m.set(f.path, { b64: Buffer.from(f.content).toString('base64'), mode: '100644' });
      }
    }
    return m;
  }

  async apply_patch(req: ApplyPatchRequest): Promise<CodeHostRead<AppliedPatch>> {
    // everything the broker checks before the network, once (`preflightPush`)
    const pf = await preflightPush(req, this.guards);
    if (!pf.ok) return pf.error;
    const { patch_hash, protected_rules } = pf.value;
    const b = this.broken.get('apply_patch');
    if (b) return b;
    const repo = this.seed.repos.find((r) => repoKey(r.full_name) === repoKey(req.repo));
    if (!repo) return this.missingRepo(req.repo);
    const known =
      this.commits.has(req.base_sha) ||
      this.seed.heads.some((h) => repoKey(h.repo) === repoKey(req.repo) && h.sha === req.base_sha);
    if (!known) return refusal('base_unknown', 'the base commit is not one the host holds');
    const head = this.seed.heads.find(
      (h) => repoKey(h.repo) === repoKey(req.repo) && h.branch === req.branch,
    );
    if ((head?.sha ?? null) !== req.expected_head) {
      return refusal('non_fast_forward', 'the branch is not where the writer last left it');
    }
    const parent = head?.sha ?? req.base_sha;
    const files = new Map(this.filesAt(req.repo, req.base_sha));
    for (const f of req.patch.files) {
      this.requests.push({ method: 'POST', path: `/repos/${req.repo}/git/blobs` });
      if (f.op === 'put') files.set(f.path, { b64: f.content_b64, mode: f.mode });
      else files.delete(f.path);
    }
    const tree = createHash('sha1')
      .update(
        JSON.stringify(
          [...files].sort(([a], [c]) => (a < c ? -1 : 1)).map(([p, v]) => [p, v.mode, v.b64]),
        ),
      )
      .digest('hex');
    this.requests.push({ method: 'POST', path: `/repos/${req.repo}/git/trees` });
    const message = commitMessage(req.message, {
      item_id: req.item_id,
      unit_key: req.unit_key,
      lease_epoch: req.lease_epoch,
      patch_hash,
      protected_rules,
    });
    const sha = createHash('sha1').update(`commit\0${tree}\0${parent}\0${message}`).digest('hex');
    this.requests.push({ method: 'POST', path: `/repos/${req.repo}/git/commits` });
    const commit: FakeCommit = { sha, parent, tree, message, files };
    this.commits.set(sha, commit);
    if (head) {
      this.requests.push({
        method: 'PATCH',
        path: `/repos/${req.repo}/git/refs/heads/${req.branch.split('/').map(encodeURIComponent).join('/')}`,
      });
      head.sha = sha;
    } else {
      this.requests.push({ method: 'POST', path: `/repos/${req.repo}/git/refs` });
      this.seed.heads.push({ repo: req.repo, branch: req.branch, sha });
    }
    const list = this.prs.get(repoKey(req.repo)) ?? [];
    this.prs.set(repoKey(req.repo), list);
    const text = renderPr(req.evidence, {
      item_id: req.item_id,
      unit_key: req.unit_key,
      lease_epoch: req.lease_epoch,
      patch_hash,
      protected_rules,
    });
    let pr = list.find((p) => p.head_ref === req.branch && p.state === 'open');
    if (pr) {
      this.requests.push({ method: 'PATCH', path: `/repos/${req.repo}/pulls/${pr.number}` });
      pr.head_sha = sha;
      pr.title = text.title;
      pr.body = text.body;
    } else {
      this.requests.push({ method: 'POST', path: `/repos/${req.repo}/pulls` });
      pr = {
        number: list.length + 1,
        head_ref: req.branch,
        head_sha: sha,
        title: text.title,
        body: text.body,
        state: 'open',
        merged: false,
        draft: true,
      };
      list.push(pr);
    }
    this.pushed.push({ commit, pr: { ...pr }, repo: req.repo });
    return readOk({
      branch: req.branch,
      commit_sha: sha,
      parent_sha: parent,
      tree_sha: tree,
      created: head === undefined,
      patch_hash,
      pr: {
        number: pr.number,
        draft: pr.draft,
        state: pr.state,
        head_sha: sha,
        head_ref: req.branch,
        base_ref: repo.default_branch,
        html_url: `https://github.example/${req.repo}/pull/${pr.number}`,
      },
    });
  }

  async pr_status(req: PrStatusRequest): Promise<CodeHostRead<PrStatus>> {
    const b = this.gate('pr_status', 'GET', `/repos/${req.repo}/pulls/${req.number}`);
    if (b) return b;
    if (!this.repoKnown(req.repo)) return this.missingRepo(req.repo);
    const pr = this.prs.get(repoKey(req.repo))?.find((p) => p.number === req.number);
    if (!pr) return readUnreadable('not_found', `no pull request ${req.number}`);
    return readOk({
      number: pr.number,
      state: pr.state,
      merged: pr.merged,
      head_sha: pr.head_sha,
      draft: pr.draft,
      checks_read: false,
      checks: [],
    });
  }
}
