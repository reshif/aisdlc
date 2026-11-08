import {
  GitSha,
  InstallationInfo,
  InstallationRepo,
  RepoFullName,
  type BranchRules,
  type CodeHostNotOk,
  type CodeHostRead,
  type CodeownersError,
  type CodeownersFile,
  type Collaborator,
  type FileAtSha,
  type GithubPermissions,
} from '@aisdlc/contracts';
import { systemClock, type Clock } from '@aisdlc/kernel';
import {
  badRepoPath,
  effectiveBranchRules,
  findCodeowners,
  gitBlobSha,
  readOk,
  readUnknown,
  readUnreadable,
  repoKey,
  type AppliedPatch,
  type ApplyPatchRequest,
  type BranchRequest,
  type BundleRequest,
  type BundleResult,
  type CodeHostPort,
  type CodeownersErrorsRequest,
  type CodeownersRequest,
  type PrStatus,
  type PrStatusRequest,
  type ReadAtShaRequest,
  type RepoRequest,
} from '@aisdlc/ports';
import { z } from 'zod';
import type { GitHubTransport } from './transport.js';

// The GitHub REST adapter of `CodeHostPort` (PLAN M5.2). Reads only; each method names one row of
// the allow-list (`allow-list.ts`) and the transport refuses anything else before the network.
// GitHub answers 404 for a repo it hides and for a file that is not there, so the adapter checks
// that a repo is one of the installation's before it reads a file from it (cached briefly).

const Repo = z.looseObject({
  full_name: z.string(),
  default_branch: z.string().min(1),
  private: z.boolean(),
  archived: z.boolean().optional(),
});

const Installation = z.looseObject({
  id: z.number().int().min(0),
  account: z
    .looseObject({ login: z.string().min(1).optional(), slug: z.string().min(1).optional() })
    .nullable(),
  repository_selection: z.enum(['all', 'selected']),
  permissions: z.record(z.string(), z.enum(['read', 'write', 'admin'])),
  suspended_at: z.string().nullable().optional(),
});

const ContentFile = z.looseObject({
  type: z.literal('file'),
  path: z.string().min(1),
  size: z.number().int().min(0),
  sha: z.string(),
  encoding: z.string(),
  content: z.string(),
});

const RefObject = z.looseObject({
  object: z.looseObject({ sha: z.string(), type: z.string() }),
});

const CodeownersErrors = z.looseObject({
  errors: z.array(
    z.looseObject({
      line: z.number().int().min(1),
      column: z.number().int().min(0),
      kind: z.string(),
      message: z.string(),
      path: z.string().min(1),
    }),
  ),
});

const CollaboratorItem = z.looseObject({
  login: z.string().min(1),
  role_name: z.string().min(1).optional(),
  permissions: z
    .looseObject({
      admin: z.boolean().optional(),
      maintain: z.boolean().optional(),
      push: z.boolean().optional(),
      triage: z.boolean().optional(),
      pull: z.boolean().optional(),
    })
    .optional(),
});

const fromPermissions = (p: z.infer<typeof CollaboratorItem>['permissions']): string | null => {
  if (!p) return null;
  if (p.admin) return 'admin';
  if (p.maintain) return 'maintain';
  if (p.push) return 'write';
  if (p.triage) return 'triage';
  if (p.pull) return 'read';
  return null;
};

const enc = (s: string): string => encodeURIComponent(s);
const encPath = (p: string): string => p.split('/').map(enc).join('/');

/** A branch name safe to put in a path: no traversal, no control characters, no leading dash. */
const badBranch = (b: string): string | null =>
  b === '' ||
  b.length > 255 ||
  b.startsWith('-') ||
  b.startsWith('/') ||
  b.endsWith('/') ||
  b.split('/').some((s) => s === '' || s === '.' || s === '..') ||
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  /[\u0000-\u001f\u007f\\]/.test(b)
    ? 'branch name is not acceptable'
    : null;

const notImplemented = (what: string): CodeHostNotOk =>
  readUnreadable('not_implemented', `${what} is not implemented yet`);

export interface GitHubRestOptions {
  readonly transport: GitHubTransport;
  readonly installationId: number;
  readonly clock?: Clock;
  /** How long the installation's repo list is trusted for file reads. Default one minute. */
  readonly repoCacheMs?: number;
}

export class GitHubRestCodeHost implements CodeHostPort {
  private readonly clock: Clock;
  private reachable: { at: number; keys: Set<string> } | null = null;

  constructor(private readonly o: GitHubRestOptions) {
    this.clock = o.clock ?? systemClock;
  }

  private parseRepo(repo: string): CodeHostNotOk | { owner: string; name: string } {
    const p = RepoFullName.safeParse(repo);
    if (!p.success || repo.split('/').some((s) => s === '.' || s === '..')) {
      return readUnreadable('refused', 'repo must be owner/name');
    }
    const [owner, name] = repo.split('/') as [string, string];
    return { owner, name };
  }

  async list_repos(): Promise<CodeHostRead<InstallationRepo[]>> {
    const r = await this.o.transport.getAll('/installation/repositories', (json) => {
      const l = z.looseObject({ repositories: z.array(z.unknown()) }).safeParse(json);
      return l.success ? l.data.repositories : null;
    });
    if (!r.ok) return r.error;
    const out: InstallationRepo[] = [];
    for (const item of r.value) {
      const p = Repo.safeParse(item);
      if (!p.success) return readUnknown('malformed', 'a repository has an unexpected shape');
      const repo = InstallationRepo.safeParse({
        full_name: p.data.full_name,
        default_branch: p.data.default_branch,
        private: p.data.private,
        archived: p.data.archived ?? false,
      });
      if (!repo.success) return readUnknown('malformed', 'a repository has an unexpected shape');
      out.push(repo.data);
    }
    this.reachable = {
      at: this.clock.now().getTime(),
      keys: new Set(out.map((x) => repoKey(x.full_name))),
    };
    return readOk(out);
  }

  /** Is `repo` one of the installation's? A failed list is the failure, never "yes". */
  async repoReachable(repo: string): Promise<CodeHostRead<boolean>> {
    const ttl = this.o.repoCacheMs ?? 60_000;
    const c = this.reachable;
    if (c && this.clock.now().getTime() - c.at < ttl) return readOk(c.keys.has(repoKey(repo)));
    const l = await this.list_repos();
    if (l.state !== 'ok') return l;
    return readOk(l.value.some((x) => repoKey(x.full_name) === repoKey(repo)));
  }

  async installation(): Promise<CodeHostRead<InstallationInfo>> {
    const id = this.o.installationId;
    const r = await this.o.transport.get(`/app/installations/${id}`);
    if (!r.ok) return r.error;
    const p = Installation.safeParse(r.value.json);
    if (!p.success || p.data.id !== id) {
      return readUnknown('malformed', 'the installation has an unexpected shape');
    }
    const login = p.data.account?.login ?? p.data.account?.slug;
    const info = InstallationInfo.safeParse({
      installation_id: p.data.id,
      account_login: login,
      repository_selection: p.data.repository_selection,
      permissions: p.data.permissions satisfies GithubPermissions,
      suspended: p.data.suspended_at != null,
    });
    return info.success
      ? readOk(info.data)
      : readUnknown('malformed', 'the installation has an unexpected shape');
  }

  async read_at_sha(req: ReadAtShaRequest): Promise<CodeHostRead<FileAtSha | null>> {
    const repo = this.parseRepo(req.repo);
    if ('state' in repo) return repo;
    const bad = badRepoPath(req.path);
    if (bad) return readUnreadable('refused', bad);
    if (!GitSha.safeParse(req.sha).success) return readUnreadable('refused', 'sha must be 40 hex');
    const reach = await this.repoReachable(req.repo);
    if (reach.state !== 'ok') return reach;
    if (!reach.value) {
      return readUnreadable(
        'not_found',
        `repository ${req.repo} is not reachable by this installation`,
      );
    }
    const r = await this.o.transport.get(
      `/repos/${repo.owner}/${repo.name}/contents/${encPath(req.path)}?ref=${req.sha}`,
    );
    if (!r.ok) {
      // The repo is the installation's, so a 404 here is a file that is not there.
      return r.error.reason === 'not_found' && r.error.state === 'unreadable'
        ? readOk(null)
        : r.error;
    }
    if (Array.isArray(r.value.json))
      return readUnreadable('not_a_file', `${req.path} is a directory`);
    const f = ContentFile.safeParse(r.value.json);
    if (!f.success) {
      const t = z.looseObject({ type: z.string() }).safeParse(r.value.json);
      return t.success && t.data.type !== 'file'
        ? readUnreadable('not_a_file', `${req.path} is a ${t.data.type}, not a file`)
        : readUnknown('malformed', 'the file has an unexpected shape');
    }
    if (f.data.encoding !== 'base64' || (f.data.content === '' && f.data.size > 0)) {
      return readUnreadable(
        'too_large',
        `${req.path} is too large to read through the contents API`,
      );
    }
    const bytes = Buffer.from(f.data.content, 'base64');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return readUnreadable('not_a_file', `${req.path} is not UTF-8 text`);
    }
    const blob = gitBlobSha(content);
    // The blob id GitHub gives must be the id of the bytes it sent.
    if (bytes.length !== f.data.size || blob !== f.data.sha) {
      return readUnknown('malformed', `${req.path}: the content does not match its blob id`);
    }
    return readOk({ path: req.path, sha: req.sha, blob_sha: blob, size: bytes.length, content });
  }

  async branch_head(req: BranchRequest): Promise<CodeHostRead<GitSha>> {
    const repo = this.parseRepo(req.repo);
    if ('state' in repo) return repo;
    const bad = badBranch(req.branch);
    if (bad) return readUnreadable('refused', bad);
    const r = await this.o.transport.get(
      `/repos/${repo.owner}/${repo.name}/git/ref/heads/${encPath(req.branch)}`,
    );
    if (!r.ok) return r.error;
    const p = RefObject.safeParse(r.value.json);
    if (
      !p.success ||
      p.data.object.type !== 'commit' ||
      !GitSha.safeParse(p.data.object.sha).success
    ) {
      return readUnknown('malformed', 'the branch ref has an unexpected shape');
    }
    return readOk(p.data.object.sha);
  }

  async rules_for_branch(req: BranchRequest): Promise<CodeHostRead<BranchRules>> {
    const repo = this.parseRepo(req.repo);
    if ('state' in repo) return repo;
    const bad = badBranch(req.branch);
    if (bad) return readUnreadable('refused', bad);
    const r = await this.o.transport.getAll(
      `/repos/${repo.owner}/${repo.name}/rules/branches/${enc(req.branch)}`,
      (json) => (Array.isArray(json) ? json : null),
    );
    if (!r.ok) return r.error;
    return effectiveBranchRules(req.branch, r.value);
  }

  async codeowners(req: CodeownersRequest): Promise<CodeHostRead<CodeownersFile | null>> {
    return findCodeowners((path) => this.read_at_sha({ repo: req.repo, sha: req.sha, path }));
  }

  async codeowners_errors(req: CodeownersErrorsRequest): Promise<CodeHostRead<CodeownersError[]>> {
    const repo = this.parseRepo(req.repo);
    if ('state' in repo) return repo;
    if (req.ref !== undefined && badBranch(req.ref)) {
      return readUnreadable('refused', 'ref is not acceptable');
    }
    const q = req.ref === undefined ? '' : `?ref=${enc(req.ref)}`;
    const r = await this.o.transport.get(`/repos/${repo.owner}/${repo.name}/codeowners/errors${q}`);
    if (!r.ok) return r.error;
    const p = CodeownersErrors.safeParse(r.value.json);
    if (!p.success)
      return readUnknown('malformed', 'the CODEOWNERS errors have an unexpected shape');
    return readOk(
      p.data.errors.map((e) => ({
        line: e.line,
        column: e.column,
        kind: e.kind,
        message: e.message,
        path: e.path,
      })),
    );
  }

  async collaborators(req: RepoRequest): Promise<CodeHostRead<Collaborator[]>> {
    const repo = this.parseRepo(req.repo);
    if ('state' in repo) return repo;
    const r = await this.o.transport.getAll(
      `/repos/${repo.owner}/${repo.name}/collaborators`,
      (json) => (Array.isArray(json) ? json : null),
      'affiliation=all',
    );
    if (!r.ok) return r.error;
    const out: Collaborator[] = [];
    for (const item of r.value) {
      const p = CollaboratorItem.safeParse(item);
      const permission = p.success
        ? (p.data.role_name ?? fromPermissions(p.data.permissions))
        : null;
      if (!p.success || permission === null) {
        return readUnknown('malformed', 'a collaborator has an unexpected shape');
      }
      out.push({ login: p.data.login, permission });
    }
    return readOk(out);
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
