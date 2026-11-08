import {
  PrincipalId,
  SetCodeownerMembersResult,
  type ProjectId,
  type SetCodeownerMembersRequest,
} from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import { callJson } from '@aisdlc/service-kit';
import { z } from 'zod';

// The codehost's view of identity (PLAN M5.2): resolve a GitHub login to a principal through
// IdentityLink (`github_login`), and set the members of a project's g4 group. Both go over
// identity's HTTP API with the codehost's own service token (scopes `read` and `codeowners`);
// identity stays the only writer.

export type IdentityLinksErrorCode = 'unavailable' | 'refused' | 'invalid';

export const IdentityLinksError = taggedError('IdentityLinksError');
export type IdentityLinksError = TaggedError<
  'IdentityLinksError',
  { code: IdentityLinksErrorCode; message: string }
>;
const fail = (code: IdentityLinksErrorCode, message: string): IdentityLinksError =>
  IdentityLinksError({ code, message });

export interface IdentityLinksPort {
  /** The principal linked to a `github_login`, or `null`. An error is a refusal, never "unlinked". */
  resolveGithubLogin(login: string): Promise<Result<PrincipalId | null, IdentityLinksError>>;
  /** Makes the project's g4 group hold exactly `principals`. */
  setCodeownerMembers(
    project: ProjectId,
    req: SetCodeownerMembersRequest,
  ): Promise<Result<SetCodeownerMembersResult, IdentityLinksError>>;
}

export class HttpIdentityLinks implements IdentityLinksPort {
  constructor(private readonly o: { baseUrl: string; token: string; fetchImpl?: typeof fetch }) {}

  private call(method: 'GET' | 'POST', path: string, body?: unknown) {
    return callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
  }

  async resolveGithubLogin(login: string) {
    const r = await this.call(
      'GET',
      `/v1/resolve?kind=github_login&value=${encodeURIComponent(login)}`,
    );
    if (!r.reached) return err(fail('unavailable', 'identity did not answer'));
    if (r.status === 404) return ok(null);
    if (r.status === 200) {
      const p = z.looseObject({ principal_id: PrincipalId }).safeParse(r.json);
      return p.success
        ? ok(p.data.principal_id)
        : err(fail('invalid', 'identity answered with an unexpected shape'));
    }
    return err(
      fail(
        r.status === 503 || r.status >= 500 ? 'unavailable' : 'refused',
        `identity: ${r.status}`,
      ),
    );
  }

  async setCodeownerMembers(project: ProjectId, req: SetCodeownerMembersRequest) {
    const r = await this.call(
      'POST',
      `/v1/projects/${encodeURIComponent(project)}/codeowners/members`,
      req,
    );
    if (!r.reached) return err(fail('unavailable', 'identity did not answer'));
    if (r.status === 200) {
      const p = SetCodeownerMembersResult.safeParse(r.json);
      return p.success
        ? ok(p.data)
        : err(fail('invalid', 'identity answered with an unexpected shape'));
    }
    const code = z
      .looseObject({ error: z.looseObject({ code: z.string().optional() }) })
      .safeParse(r.json);
    const detail = code.success ? ` ${code.data.error.code ?? ''}` : '';
    return err(
      fail(r.status >= 500 ? 'unavailable' : 'refused', `identity: ${r.status}${detail}`.trim()),
    );
  }
}

/** A deterministic in-memory `IdentityLinksPort` for unit tests that do not need identity itself. */
export class FakeIdentityLinks implements IdentityLinksPort {
  readonly links = new Map<string, PrincipalId>();
  readonly sets: Array<{ project: ProjectId; req: SetCodeownerMembersRequest }> = [];
  down = false;

  async resolveGithubLogin(login: string) {
    if (this.down) return err(fail('unavailable', 'identity is down'));
    return ok(this.links.get(login.toLowerCase()) ?? null);
  }

  async setCodeownerMembers(project: ProjectId, req: SetCodeownerMembersRequest) {
    if (this.down) return err(fail('unavailable', 'identity is down'));
    this.sets.push({ project, req });
    return ok({
      project_id: project,
      group_id: `rm.${project}.g4`,
      members: [...req.principals],
      added: [...req.principals],
      removed: [],
    });
  }
}
