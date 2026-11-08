import { readFileSync } from 'node:fs';
import { RegisteredRepo } from '@aisdlc/contracts';
import { err, ok } from '@aisdlc/kernel';
import { RegisteredReposError, type RegisteredReposPort } from '@aisdlc/ports';
import { z } from 'zod';

/**
 * Stand-in for the Projects service until M7: a JSON file `[{project_id, repo}]`, read on every
 * call so an edit shows at once. A missing or invalid file is an error, and an error allows
 * nothing (fail closed).
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
