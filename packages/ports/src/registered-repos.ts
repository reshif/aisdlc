import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { RegisteredRepo, type RepoFullName } from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// RegisteredReposPort (PLAN M5.2, OB §6.5 P-MUST-3): the repos that have an S0 record or request,
// with the project each belongs to. The code-host allow-list is the installation's repos
// intersected with these. The real source is core's Projects context (M7.1): `DbRegisteredRepos` in
// `@aisdlc/core`, and `HttpRegisteredRepos` (core-clients.ts) for the codehost. The fake and a JSON
// file (`FileRegisteredRepos`) stay for tests and for a development setup without core.

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

/**
 * A JSON file `[{project_id, repo}]` for a development setup without core, read on every
 * call so an edit shows at once (the "registry reload path" of the poll loops and of the codehost's
 * allow-list). A missing or invalid file is an error, and an error allows nothing (fail closed).
 */
export class FileRegisteredRepos implements RegisteredReposPort {
  constructor(private readonly path: string) {}

  async list() {
    try {
      const rows = z.array(RegisteredRepo).parse(JSON.parse(readFileSync(this.path, 'utf8')));
      return ok(rows);
    } catch {
      return err(
        RegisteredReposError({
          code: 'unavailable' as const,
          message: 'the registered repos file is missing or invalid',
        }),
      );
    }
  }
}
