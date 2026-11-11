import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RepoFile } from '@aisdlc/ports';

// The scratch root: where a session's read-only repo copy is written (the one bind mount a sandbox gets).
// `local` is the path this process writes to; `host` is the same directory as the Docker daemon sees it (they
// are equal when the worker bind-mounts the host directory at the same path, the way compose does it).

export interface ScratchRoot {
  readonly local: string;
  readonly host: string;
}

export interface Materialised {
  readonly dir: string;
  readonly hostRepoDir: string;
  readonly files: number;
  readonly bytes: number;
}

/**
 * Writes the repo copy to `<scratch>/<session>/repo`: a fresh directory (an existing one is an error: never
 * reuse a name), plain files only, world-readable so the sandbox user can read them, never writable by anyone
 * but this process. Where the class runs no repo code (`exec: false`) no file carries an execute bit.
 */
export function materialiseRepo(
  scratch: ScratchRoot,
  session: string,
  files: readonly RepoFile[],
  exec: boolean,
): Materialised {
  const dir = join(scratch.local, session);
  if (existsSync(dir)) throw new Error(`scratch ${session} already exists`);
  mkdirSync(scratch.local, { recursive: true });
  let bytes = 0;
  mkdirSync(dir, { mode: 0o755 });
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo, { mode: 0o755 });
    chmodSync(dir, 0o755);
    chmodSync(repo, 0o755);
    for (const f of files) {
      const full = join(repo, f.path);
      mkdirSync(dirname(full), { recursive: true, mode: 0o755 });
      const data = Buffer.from(typeof f.content === 'string' ? Buffer.from(f.content) : f.content);
      // 'wx': fails if anything (a file, a symlink) is already there
      writeFileSync(full, data, { flag: 'wx', mode: exec && f.executable ? 0o755 : 0o644 });
      chmodSync(full, exec && f.executable ? 0o755 : 0o644);
      bytes += data.length;
    }
    // every path we made is plain: verify there is no symlink in the tree we wrote
    for (const f of files) {
      let p = repo;
      for (const part of f.path.split('/')) {
        p = join(p, part);
        if (lstatSync(p).isSymbolicLink())
          throw new Error('scratch: a symlink appeared in the repo copy');
      }
    }
  } catch (e) {
    // a half-written copy is never left behind
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { dir, hostRepoDir: `${scratch.host}/${session}/repo`, files: files.length, bytes };
}

export function removeScratch(scratch: ScratchRoot, session: string): void {
  rmSync(join(scratch.local, session), { recursive: true, force: true });
}

export const scratchExists = (scratch: ScratchRoot, session: string): boolean =>
  existsSync(join(scratch.local, session));
