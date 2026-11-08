import {
  BranchRules,
  CodeHostNotOk,
  Collaborator,
  CodeownersError,
  CodeownersFile,
  FileAtSha,
  GitSha,
  InstallationInfo,
  InstallationRepo,
  type CodeHostRead,
} from '@aisdlc/contracts';
import {
  readOk,
  readUnknown,
  type BranchRequest,
  type CodeHostPort,
  type CodeownersErrorsRequest,
  type CodeownersRequest,
  type ReadAtShaRequest,
  type RepoRequest,
} from './codehost.js';
import { z } from 'zod';

// The read half of `CodeHostPort` over the codehost's HTTP API (PLAN M5.2 routes). core-worker (and
// core's S0 driver) never
// holds a code-host credential: it asks the codehost, with its own service token (scopes `census`
// for repos and heads, `posture` for the installation and the rules). A 2xx is a `CodeHostRead`
// with state `ok`; any other answer carries the read that was not ok. Anything else (network,
// garbled body, an `ok` that is not the shape asked for) is `unknown`: it is never read as a value.

export interface HttpCodeHostOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const enc = encodeURIComponent;

/**
 * What the polls, the S0 driver and the onboarding cards read: the read half of `CodeHostPort`
 * (everything but the bundle and the two write-shaped interfaces).
 */
export type CodeHostReads = Pick<
  CodeHostPort,
  | 'list_repos'
  | 'installation'
  | 'branch_head'
  | 'rules_for_branch'
  | 'read_at_sha'
  | 'codeowners'
  | 'codeowners_errors'
  | 'collaborators'
>;

export class HttpCodeHostReads implements CodeHostReads {
  constructor(private readonly o: HttpCodeHostOptions) {}

  private async get<S extends z.ZodType>(
    path: string,
    value: S,
  ): Promise<CodeHostRead<z.infer<S>>> {
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(new URL(path, this.o.baseUrl), {
        headers: { authorization: `Bearer ${this.o.token}` },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
      });
    } catch {
      return readUnknown('network', `codehost did not answer ${path.split('?')[0]}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return readUnknown('malformed', `codehost answered ${res.status} without JSON`);
    }
    if (res.status >= 200 && res.status < 300) {
      const ok = z.looseObject({ state: z.literal('ok'), value }).safeParse(json);
      return ok.success
        ? readOk(ok.data.value as z.infer<S>)
        : readUnknown('malformed', 'codehost answered with an unexpected shape');
    }
    const notOk = CodeHostNotOk.safeParse(json);
    if (notOk.success) return notOk.data;
    // 401/403 from the service itself (token or scope) and anything else with no read in it.
    return res.status === 401 || res.status === 403
      ? { state: 'unreadable', reason: 'forbidden', message: `codehost refused with ${res.status}` }
      : readUnknown('server_error', `codehost answered ${res.status}`);
  }

  list_repos() {
    return this.get('/v1/repos', z.array(InstallationRepo));
  }

  installation() {
    return this.get('/v1/installation', InstallationInfo);
  }

  branch_head(req: BranchRequest) {
    return this.get(`/v1/repos/${req.repo}/head?branch=${enc(req.branch)}`, GitSha);
  }

  rules_for_branch(req: BranchRequest) {
    return this.get(`/v1/repos/${req.repo}/rules?branch=${enc(req.branch)}`, BranchRules);
  }

  /** `census` scope. A 200 `ok` with a `null` value is "the repo has no such file there". */
  read_at_sha(req: ReadAtShaRequest) {
    return this.get(
      `/v1/repos/${req.repo}/file?sha=${enc(req.sha)}&path=${enc(req.path)}`,
      FileAtSha.nullable(),
    );
  }

  /** `census` scope. */
  codeowners(req: CodeownersRequest) {
    return this.get(
      `/v1/repos/${req.repo}/codeowners?sha=${enc(req.sha)}`,
      CodeownersFile.nullable(),
    );
  }

  /** `posture` scope. */
  codeowners_errors(req: CodeownersErrorsRequest) {
    const ref = req.ref === undefined ? '' : `?ref=${enc(req.ref)}`;
    return this.get(`/v1/repos/${req.repo}/codeowners/errors${ref}`, z.array(CodeownersError));
  }

  /** `posture` scope. */
  collaborators(req: RepoRequest) {
    return this.get(`/v1/repos/${req.repo}/collaborators`, z.array(Collaborator));
  }
}
