import { RegisteredRepo, type RepoFullName } from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// RegisteredReposPort (PLAN M5.2, OB §6.5 P-MUST-3): the repos that have an S0 record or request,
// with the project each belongs to. The code-host allow-list is the installation's repos
// intersected with these. The real source is Projects (M7); until then the fake is the only one.

export type RegisteredReposErrorCode = 'unavailable';

export const RegisteredReposError = taggedError('RegisteredReposError');
export type RegisteredReposError = TaggedError<
  'RegisteredReposError',
  { code: RegisteredReposErrorCode; message: string }
>;

export interface RegisteredReposPort {
  /** Every registered repo. An error is a refusal: an unknown registry allows nothing. */
  list(): Promise<Result<RegisteredRepo[], RegisteredReposError>>;
}

/** Deterministic in-memory `RegisteredReposPort`. */
export class FakeRegisteredRepos implements RegisteredReposPort {
  private rows: RegisteredRepo[] = [];
  private down = false;

  set(rows: ReadonlyArray<{ project_id: string; repo: RepoFullName }>): this {
    this.rows = rows.map((r) => RegisteredRepo.parse(r));
    return this;
  }

  add(project_id: string, repo: RepoFullName): this {
    this.rows.push(RegisteredRepo.parse({ project_id, repo }));
    return this;
  }

  /** Makes every call fail, to test fail-closed behaviour. */
  breakIt(down = true): this {
    this.down = down;
    return this;
  }

  async list() {
    if (this.down) {
      return err(
        RegisteredReposError({
          code: 'unavailable' as const,
          message: 'registered repos unavailable',
        }),
      );
    }
    return ok(structuredClone(this.rows));
  }
}
