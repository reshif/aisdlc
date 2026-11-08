import {
  CodeownersError,
  Collaborator,
  InstallationInfo,
  InstallationRepo,
  type BranchRules,
  type CodeHostNotOk,
  type CodeHostRead,
  type CodeownersFile,
  type FileAtSha,
  type GitSha,
} from '@aisdlc/contracts';
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
  type BundleRequest,
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
  readonly method: 'GET';
  readonly path: string;
}

type PortMethod = (typeof CODEHOST_PORT_METHODS)[number];

const notImplemented = (what: string): CodeHostNotOk =>
  readUnreadable('not_implemented', `${what} is not implemented yet`);

export class FakeGitHub implements CodeHostPort {
  readonly requests: LoggedRequest[] = [];
  private seed: CodeHostSeed = emptySeed();
  private readonly broken = new Map<PortMethod, CodeHostNotOk>();

  constructor(seed?: CodeHostSeed) {
    if (seed) this.load(seed);
  }

  /** Replaces everything the fake knows (the request log is kept). */
  load(seed: CodeHostSeed): this {
    this.seed = structuredClone(CodeHostSeed.parse(seed));
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
    ] as const) {
      this.broken.set(m, as);
    }
    return this;
  }

  unbreak(): this {
    this.broken.clear();
    return this;
  }

  private gate(method: PortMethod, method_: 'GET', path: string): CodeHostNotOk | null {
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

  async bundle(_req: BundleRequest): Promise<CodeHostRead<BundleResult>> {
    return notImplemented('bundle (M5.3)');
  }

  async apply_patch(_req: ApplyPatchRequest): Promise<CodeHostRead<AppliedPatch>> {
    return notImplemented('apply_patch (M13)');
  }

  async pr_status(_req: PrStatusRequest): Promise<CodeHostRead<PrStatus>> {
    return notImplemented('pr_status (M14)');
  }
}
