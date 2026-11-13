import type {
  BranchRules,
  BundleRequest,
  CodeHostRead,
  CodeownersError,
  CodeownersFile,
  Collaborator,
  FileAtSha,
  GitSha,
  InstallationInfo,
  InstallationRepo,
  ProjectId,
  RedraftPrRequest,
  RedraftedPr,
  RegisteredRepo,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  readOk,
  readUnknown,
  readUnreadable,
  repoKey,
  type AppliedPatch,
  type ApplyPatchRequest,
  type BranchRequest,
  type BundleResult,
  type CodeHostPort,
  type CodeownersErrorsRequest,
  type CodeownersRequest,
  type PrStatus,
  type PrStatusRequest,
  type ReadAtShaRequest,
  type RegisteredReposPort,
  type RepoRequest,
} from '@aisdlc/ports';

/**
 * The repo allow-list (PLAN M5.2, OB §6.5 P-MUST-3): a repo may be touched only if the
 * installation reaches it AND it has an S0 record or request. This wraps a `CodeHostPort` so the
 * check is made before the inner call; a repo that is not registered never causes a request for
 * that repo. Where the registry cannot be read, nothing is allowed (fail closed).
 *
 * `list_repos` returns the intersection. The installation half is the inner port's: it returns
 * only repos the installation reaches, and a file read of another repo is not_found.
 */
export class AllowListedCodeHost implements CodeHostPort {
  constructor(
    private readonly inner: CodeHostPort,
    private readonly registered: RegisteredReposPort,
  ) {}

  private async registry(): Promise<Result<RegisteredRepo[], ReturnType<typeof readUnknown>>> {
    const r = await this.registered.list();
    return r.ok
      ? ok(r.value)
      : err(readUnknown('registry_unavailable', 'the registry of S0 repos could not be read'));
  }

  /** The project a repo is registered to, `null` if it is not registered; an error if the registry is down. */
  async projectOf(repo: string): Promise<CodeHostRead<ProjectId | null>> {
    const r = await this.registry();
    if (!r.ok) return r.error;
    const row = r.value.find((x) => repoKey(x.repo) === repoKey(repo));
    return readOk(row ? row.project_id : null);
  }

  private async gate(
    repo: string,
  ): Promise<ReturnType<typeof readUnreadable> | ReturnType<typeof readUnknown> | null> {
    const p = await this.projectOf(repo);
    if (p.state !== 'ok') return p;
    return p.value === null
      ? readUnreadable('repo_not_allowed', `repository ${repo} has no S0 record`)
      : null;
  }

  async list_repos(): Promise<CodeHostRead<InstallationRepo[]>> {
    // The registry first: if it cannot be read nothing is allowed, and no request is made.
    const reg = await this.registry();
    if (!reg.ok) return reg.error;
    const installed = await this.inner.list_repos();
    if (installed.state !== 'ok') return installed;
    const allowed = new Set(reg.value.map((x) => repoKey(x.repo)));
    return readOk(installed.value.filter((r) => allowed.has(repoKey(r.full_name))));
  }

  installation(): Promise<CodeHostRead<InstallationInfo>> {
    return this.inner.installation();
  }

  async read_at_sha(req: ReadAtShaRequest): Promise<CodeHostRead<FileAtSha | null>> {
    return (await this.gate(req.repo)) ?? this.inner.read_at_sha(req);
  }

  async branch_head(req: BranchRequest): Promise<CodeHostRead<GitSha>> {
    return (await this.gate(req.repo)) ?? this.inner.branch_head(req);
  }

  async rules_for_branch(req: BranchRequest): Promise<CodeHostRead<BranchRules>> {
    return (await this.gate(req.repo)) ?? this.inner.rules_for_branch(req);
  }

  async codeowners(req: CodeownersRequest): Promise<CodeHostRead<CodeownersFile | null>> {
    return (await this.gate(req.repo)) ?? this.inner.codeowners(req);
  }

  async codeowners_errors(req: CodeownersErrorsRequest): Promise<CodeHostRead<CodeownersError[]>> {
    return (await this.gate(req.repo)) ?? this.inner.codeowners_errors(req);
  }

  async collaborators(req: RepoRequest): Promise<CodeHostRead<Collaborator[]>> {
    return (await this.gate(req.repo)) ?? this.inner.collaborators(req);
  }

  async bundle(req: BundleRequest): Promise<CodeHostRead<BundleResult>> {
    return (await this.gate(req.repo)) ?? this.inner.bundle(req);
  }

  async apply_patch(req: ApplyPatchRequest): Promise<CodeHostRead<AppliedPatch>> {
    return (await this.gate(req.repo)) ?? this.inner.apply_patch(req);
  }

  async pr_status(req: PrStatusRequest): Promise<CodeHostRead<PrStatus>> {
    return (await this.gate(req.repo)) ?? this.inner.pr_status(req);
  }

  async redraft_pr(req: RedraftPrRequest): Promise<CodeHostRead<RedraftedPr>> {
    return (await this.gate(req.repo)) ?? this.inner.redraft_pr(req);
  }
}
