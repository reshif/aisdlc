import { ok, err } from '@aisdlc/kernel';
import { RegisteredReposError, type RegisteredReposPort } from '@aisdlc/ports';
import type pg from 'pg';
import { registeredRepos } from './queries.js';

/**
 * The real `RegisteredReposPort` (PLAN M7.1, OB §6.5 P-MUST-3): the repos that have an S0 record or
 * request, read from core's read model after catching it up. The codehost's allow-list is the
 * installation's repos intersected with these. A database that cannot be read is an error, and an
 * error allows nothing (fail closed). The fakes stay for tests.
 */
export class DbRegisteredRepos implements RegisteredReposPort {
  constructor(private readonly pool: pg.Pool) {}

  async list() {
    try {
      return ok(await registeredRepos(this.pool));
    } catch {
      return err(
        RegisteredReposError({
          code: 'unavailable' as const,
          message: 'core could not read its repos',
        }),
      );
    }
  }
}
