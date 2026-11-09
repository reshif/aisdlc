import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '@aisdlc/kernel';
import { storeError, type EvalStoreError } from './errors.js';

// The store lives OUTSIDE the repo (DM §5.1, D36). Refused: a path that does not exist (fail closed,
// there is no store to fall back on), a path inside this repository (found from this file's own
// location, so a checkout without `.git` is covered too), and a path inside ANY git worktree (a
// `.git` directory or file in the path or one of its parents).

/** `packages/evals/src` (or `packages/evals/dist`) -> the repository root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const inside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export function resolveStorePath(
  path: string | undefined,
  repoRoot: string = REPO_ROOT,
): Result<string, EvalStoreError> {
  if (path === undefined || path.trim() === '') {
    return err(storeError('missing', 'AISDLC_EVAL_STORE is not set: there is no eval store'));
  }
  if (!existsSync(path)) return err(storeError('missing', 'the eval store path does not exist'));
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return err(storeError('missing', 'the eval store path cannot be resolved'));
  }
  const root = existsSync(repoRoot) ? realpathSync(repoRoot) : resolve(repoRoot);
  if (inside(real, root)) {
    return err(storeError('inside_repo', 'the eval store is inside the repository tree'));
  }
  for (let dir = real; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      return err(storeError('inside_repo', 'the eval store is inside a git worktree'));
    }
    if (dirname(dir) === dir) break;
  }
  return ok(real);
}
