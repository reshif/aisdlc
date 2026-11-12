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
  type GateCheckAuthor,
  type GitSha,
  type GithubPermissions,
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
  badCheckRunWrite,
  type CheckRunRead,
  type CheckRunWrite,
  type GateCheckHostPort,
  type GateCheckPull,
  type PullCommit,
} from './gate-check-host.js';
import {
  FakeTrackerView,
  type FakeIssue,
  type FakeIssueHost,
  type FakeTrackerIdentity,
} from './fake-issue-tracker.js';
import type { IssueTrackerPort } from './issue-tracker.js';
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
  /** M14.5: who opened it (the Push Broker's bot for `apply_patch`, a person for `openPull`). */
  readonly author: GateCheckAuthor;
  readonly base_ref: string;
  /** The commits ahead of the base, oldest first. */
  commits: PullCommit[];
  merged_by: string | null;
  merge_commit_sha: string | null;
  merged_at: string | null;
}

/** An App's credential on the fake host: its id and what its installation token carries. */
export interface FakeAppIdentity {
  readonly app_id: number;
  readonly permissions: GithubPermissions;
}

interface StoredCheckRun extends CheckRunRead {
  readonly external_id: string;
  readonly title: string;
  readonly summary: string;
}

/** The login GitHub gives the Push Broker's App on the fake host (an App's PRs are authored by `<slug>[bot]`). */
export const FAKE_PUSH_BROKER_LOGIN = 'aisdlc-push[bot]';
/** The Push Broker's App id on the fake host. */
export const FAKE_PUSH_APP_ID = 1001;

export interface FakeGitHubOptions {
  /** The Unit's owner (lease and X2). Default: none, so a push is refused (fail closed). */
  readonly guards?: PushGuardsPort;
  /** The bot login of the Push Broker's App (the author of every PR `apply_patch` opens). */
  readonly brokerLogin?: string;
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
  private checkRunsByRepo = new Map<string, StoredCheckRun[]>();
  private nextCheckRunId = 1;
  private readonly brokerLogin: string;
  private brokenChecks: CodeHostNotOk | null = null;
  private issuesByRepo = new Map<string, FakeIssue[]>();
  private nextCommentId = 1;
  /** The Push Broker's App as a credential on this host (its token carries the installation's grant). */
  get pushApp(): FakeAppIdentity {
    return { app_id: FAKE_PUSH_APP_ID, permissions: { ...this.seed.installation.permissions } };
  }

  constructor(seed?: CodeHostSeed, opts: FakeGitHubOptions = {}) {
    this.guards = opts.guards ?? NO_PUSH_GUARDS;
    this.brokerLogin = opts.brokerLogin ?? FAKE_PUSH_BROKER_LOGIN;
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
    this.checkRunsByRepo = new Map();
    this.issuesByRepo = new Map();
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
    this.brokenChecks = null;
    return this;
  }

  /** Makes every call of every App view (`asApp`) answer `as` until `unbreak`. */
  breakChecksApi(as: CodeHostNotOk): this {
    this.brokenChecks = as;
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
      pr.commits.push({ sha, message });
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
        author: { login: this.brokerLogin, type: 'Bot' },
        base_ref: repo.default_branch,
        commits: [{ sha, message }],
        merged_by: null,
        merge_commit_sha: null,
        merged_at: null,
      };
      list.push(pr);
    }
    this.pushed.push({ commit, pr: { ...pr, commits: [...pr.commits] }, repo: req.repo });
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

  // ---------------------------------------------------------------- M14.5: people's PRs, merges, check runs

  /** A person opens a pull request (not through the Push Broker): its branch points at `head_sha`. */
  openPull(
    repo: string,
    o: {
      readonly head_ref: string;
      readonly head_sha: string;
      readonly author: string;
      readonly title?: string;
      readonly body?: string;
      readonly commits?: readonly PullCommit[];
      readonly draft?: boolean;
    },
  ): number {
    const r = this.seed.repos.find((x) => repoKey(x.full_name) === repoKey(repo));
    if (!r) throw new Error(`no repo ${repo}`);
    const list = this.prs.get(repoKey(repo)) ?? [];
    this.prs.set(repoKey(repo), list);
    this.moveBranch(repo, o.head_ref, o.head_sha);
    const number = this.nextNumberOf(repo);
    list.push({
      number,
      head_ref: o.head_ref,
      head_sha: o.head_sha,
      title: o.title ?? 'A change',
      body: o.body ?? '',
      state: 'open',
      merged: false,
      draft: o.draft ?? false,
      author: { login: o.author, type: 'User' },
      base_ref: r.default_branch,
      commits: [...(o.commits ?? [{ sha: o.head_sha, message: 'a change' }])],
      merged_by: null,
      merge_commit_sha: null,
      merged_at: null,
    });
    return number;
  }

  /** Somebody pushed to a PR's branch: its head moves (the old check run stays on the old head). */
  pushToPull(repo: string, number: number, sha: string, message = 'another change'): this {
    const pr = this.prOf(repo, number);
    if (!pr) throw new Error(`no pull request ${number}`);
    pr.head_sha = sha;
    pr.commits.push({ sha, message });
    return this.moveBranch(repo, pr.head_ref, sha);
  }

  /** A person merges a PR on the host (the factory never does: this is the test’s hand, not a port method; the name avoids the verb the forbidden-verb check looks for). */
  landPull(repo: string, number: number, by: string, at = '2026-11-12T12:00:00Z'): this {
    const pr = this.prOf(repo, number);
    if (!pr) throw new Error(`no pull request ${number}`);
    pr.state = 'closed';
    pr.merged = true;
    pr.merged_by = by;
    pr.merged_at = at;
    pr.merge_commit_sha = createHash('sha1').update(`merge\0${pr.head_sha}\0${by}`).digest('hex');
    return this;
  }

  closePull(repo: string, number: number): this {
    const pr = this.prOf(repo, number);
    if (pr) pr.state = 'closed';
    return this;
  }

  /** Every check run written in a repo, in order (tests). */
  checkRunsOf(repo: string): readonly StoredCheckRun[] {
    return [...(this.checkRunsByRepo.get(repoKey(repo)) ?? [])];
  }

  /**
   * The host as one App's credential sees it (M14.5): gate-check's App reads PRs and writes check runs only if its
   * token carries `checks: write`; the Push Broker's (`pushApp`) does not, so its view refuses the write. The view has
   * no push method at all.
   */
  asApp(app: FakeAppIdentity): GateCheckHostPort {
    return new FakeAppView(this, app);
  }

  // ---------------------------------------------------------------- M16: issues and the tracker

  /** The next issue or pull request number of a repo: GitHub numbers both in one sequence. */
  private nextNumberOf(repo: string): number {
    const prs = this.prs.get(repoKey(repo)) ?? [];
    const issues = this.issuesByRepo.get(repoKey(repo)) ?? [];
    return Math.max(0, ...prs.map((p) => p.number), ...issues.map((i) => i.number)) + 1;
  }

  /** A person files an issue (the test's hand). */
  openIssue(
    repo: string,
    o: { title: string; body?: string; labels?: readonly string[]; author: string },
  ): number {
    if (!this.repoKnown(repo)) throw new Error(`no repo ${repo}`);
    const list = this.issuesByRepo.get(repoKey(repo)) ?? [];
    this.issuesByRepo.set(repoKey(repo), list);
    const number = this.nextNumberOf(repo);
    list.push({
      number,
      state: 'open',
      title: o.title,
      body: o.body ?? '',
      labels: [...(o.labels ?? [])],
      author: { login: o.author, type: 'User' },
      closed_by: null,
      gone: false,
      comments: [],
    });
    return number;
  }

  private issueOf(repo: string, number: number): FakeIssue {
    const i = this.issuesByRepo.get(repoKey(repo))?.find((x) => x.number === number);
    if (!i) throw new Error(`no issue ${number}`);
    return i;
  }

  /** A person closes an issue on the host. */
  closeIssueAs(repo: string, number: number, by: string): this {
    const i = this.issueOf(repo, number);
    i.state = 'closed';
    i.closed_by = by;
    return this;
  }

  /** A person reopens an issue. */
  reopenIssueAs(repo: string, number: number): this {
    const i = this.issueOf(repo, number);
    i.state = 'open';
    i.closed_by = null;
    return this;
  }

  /** A person edits an issue's title or labels (the twin ignores both). */
  editIssueAs(repo: string, number: number, o: { title?: string; labels?: string[] }): this {
    const i = this.issueOf(repo, number);
    if (o.title !== undefined) i.title = o.title;
    if (o.labels !== undefined) i.labels = [...o.labels];
    return this;
  }

  /** An issue is deleted or transferred away: it reads as not found from now on. */
  removeIssue(repo: string, number: number): this {
    this.issueOf(repo, number).gone = true;
    return this;
  }

  /** Every issue of a repo with its comments, as a person would see them (tests). */
  issuesOf(repo: string): readonly FakeIssue[] {
    return (this.issuesByRepo.get(repoKey(repo)) ?? []).map((i) => ({
      ...i,
      labels: [...i.labels],
      comments: [...i.comments],
    }));
  }

  /** The host as the issue tracker's credential sees it (M16): issues only, its own to write to. */
  asTracker(id: FakeTrackerIdentity): IssueTrackerPort {
    return new FakeTrackerView(() => this._issues(), id);
  }

  /** @internal the tracker view's access to the host's state. */
  _issues(): FakeIssueHost {
    return {
      issues: this.issuesByRepo,
      repoKnown: (repo) => this.repoKnown(repo),
      log: (method, path) => this.requests.push({ method, path }),
      broken: () => this.brokenChecks,
      nextNumber: (repo) => this.nextNumberOf(repo),
      nextCommentId: () => this.nextCommentId++,
    };
  }

  /** @internal the App views' access to the host's state. */
  _apps(): {
    readonly prs: Map<string, FakePr[]>;
    readonly checkRuns: Map<string, StoredCheckRun[]>;
    readonly repoKnown: (repo: string) => boolean;
    readonly headOf: (repo: string, branch: string) => string | null;
    readonly log: (method: 'GET' | 'POST', path: string) => void;
    readonly broken: () => CodeHostNotOk | null;
    readonly nextId: () => number;
  } {
    return {
      prs: this.prs,
      checkRuns: this.checkRunsByRepo,
      repoKnown: (repo) => this.repoKnown(repo),
      headOf: (repo, branch) =>
        this.seed.heads.find((h) => repoKey(h.repo) === repoKey(repo) && h.branch === branch)
          ?.sha ?? null,
      log: (method, path) => this.requests.push({ method, path }),
      broken: () => this.brokenChecks,
      nextId: () => this.nextCheckRunId++,
    };
  }
}

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** One App's view of a `FakeGitHub` (see `asApp`). */
class FakeAppView implements GateCheckHostPort {
  readonly app_id: number;

  constructor(
    private readonly host: FakeGitHub,
    private readonly app: FakeAppIdentity,
  ) {
    this.app_id = app.app_id;
  }

  private can(perm: string, level: 'read' | 'write'): boolean {
    return (LEVEL[this.app.permissions[perm] ?? ''] ?? 0) >= (LEVEL[level] ?? 99);
  }

  private start(
    method: 'GET' | 'POST',
    path: string,
    repo: string,
    perm: string,
    level: 'read' | 'write',
  ): CodeHostNotOk | null {
    const h = this.host._apps();
    h.log(method, path);
    const b = h.broken();
    if (b) return b;
    if (!h.repoKnown(repo))
      return readUnreadable(
        'not_found',
        `repository ${repo} is not reachable by this installation`,
      );
    if (!this.can(perm, level)) {
      return readUnreadable(
        'forbidden',
        `${method} ${path}: 403 (the token has no ${perm}:${level})`,
      );
    }
    return null;
  }

  private pullOf(p: FakePr): GateCheckPull {
    return {
      number: p.number,
      state: p.state,
      draft: p.draft,
      merged: p.merged,
      head_sha: p.head_sha,
      head_ref: p.head_ref,
      base_ref: p.base_ref,
      author: { ...p.author },
      title: p.title,
      body: p.body,
      merged_by: p.merged_by,
      merge_commit_sha: p.merge_commit_sha,
      merged_at: p.merged_at,
    };
  }

  async list_pulls(req: {
    repo: string;
    state: 'open' | 'closed';
  }): Promise<CodeHostRead<GateCheckPull[]>> {
    const no = this.start('GET', `/repos/${req.repo}/pulls`, req.repo, 'pull_requests', 'read');
    if (no) return no;
    const list = this.host._apps().prs.get(repoKey(req.repo)) ?? [];
    return readOk(list.filter((p) => p.state === req.state).map((p) => this.pullOf(p)));
  }

  async pull_commits(req: { repo: string; number: number }): Promise<CodeHostRead<PullCommit[]>> {
    const no = this.start(
      'GET',
      `/repos/${req.repo}/pulls/${req.number}/commits`,
      req.repo,
      'pull_requests',
      'read',
    );
    if (no) return no;
    const pr = this.host
      ._apps()
      .prs.get(repoKey(req.repo))
      ?.find((p) => p.number === req.number);
    if (!pr) return readUnreadable('not_found', `no pull request ${req.number}`);
    return readOk(pr.commits.map((c) => ({ ...c })));
  }

  async branch_head(req: { repo: string; branch: string }): Promise<CodeHostRead<string>> {
    const no = this.start(
      'GET',
      `/repos/${req.repo}/branches/${encodeURIComponent(req.branch)}`,
      req.repo,
      'metadata',
      'read',
    );
    if (no) return no;
    const h = this.host._apps().headOf(req.repo, req.branch);
    return h ? readOk(h) : readUnreadable('not_found', `no branch ${req.branch}`);
  }

  async check_runs(req: {
    repo: string;
    sha: string;
    name: string;
  }): Promise<CodeHostRead<CheckRunRead[]>> {
    const no = this.start(
      'GET',
      `/repos/${req.repo}/commits/${req.sha}/check-runs`,
      req.repo,
      'checks',
      'read',
    );
    if (no) return no;
    const runs = this.host._apps().checkRuns.get(repoKey(req.repo)) ?? [];
    return readOk(
      runs
        .filter((r) => r.head_sha === req.sha && r.name === req.name)
        .map((r) => ({
          id: r.id,
          name: r.name,
          head_sha: r.head_sha,
          status: r.status,
          conclusion: r.conclusion,
          app_id: r.app_id,
        })),
    );
  }

  async write_check_run(req: CheckRunWrite): Promise<CodeHostRead<{ id: number; app_id: number }>> {
    const bad = badCheckRunWrite(req);
    if (bad) return readUnreadable('refused', bad);
    const no = this.start('POST', `/repos/${req.repo}/check-runs`, req.repo, 'checks', 'write');
    if (no) return no;
    const h = this.host._apps();
    const list = h.checkRuns.get(repoKey(req.repo)) ?? [];
    h.checkRuns.set(repoKey(req.repo), list);
    const id = h.nextId();
    list.push({
      id,
      name: req.name,
      head_sha: req.head_sha,
      status: req.status,
      conclusion: req.conclusion,
      app_id: this.app.app_id,
      external_id: req.external_id,
      title: req.title,
      summary: req.summary,
    });
    return readOk({ id, app_id: this.app.app_id });
  }
}
