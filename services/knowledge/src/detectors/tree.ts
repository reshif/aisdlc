import type { GitSha } from '@aisdlc/contracts';
import type { Git } from '../git.js';
import { CatFile, ScanFailure } from '../git.js';
import type { HeadEntry, Mirror } from '../intake.js';
import type { ReadOutcome, TreeFile, TreeReader } from './types.js';

// The tree reader over the hardened mirror (PLAN M6.3): paths and blob ids come from `git ls-tree`
// of the head commit; contents come from one persistent `git cat-file --batch`, sized first with
// `--batch-check` so an over-limit blob is never read. Nothing is checked out. A symlink is read as
// what git stores (its target path) and never followed.

const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_MAX_ENTRY = 256 * 1024;

export class GitTreeReader implements TreeReader {
  readonly files: readonly TreeFile[];
  private readonly byPath = new Map<string, TreeFile>();
  private readonly cache = new Map<string, Buffer>();
  private cached = 0;
  private cats: { check: CatFile; read: CatFile } | null = null;

  constructor(
    git: Git,
    mirror: Mirror,
    headTree: readonly HeadEntry[],
    readonly maxFileBytes: number,
    readonly defaultBranch: string | null,
  ) {
    const files: TreeFile[] = [];
    for (const e of headTree) {
      if (e.type !== 'blob' || e.mode === '160000') continue;
      files.push({ path: e.path, blob: e.sha as GitSha, mode: e.mode, size: e.size ?? 0 });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.files = files;
    for (const f of files) this.byPath.set(f.path, f);
    this.git = git;
    this.gitDir = mirror.dir;
  }

  private readonly git: Git;
  private readonly gitDir: string;

  /** The object readers start on the first read (a job already past its deadline spawns nothing). */
  private catFiles(): { check: CatFile; read: CatFile } {
    this.cats ??= {
      check: new CatFile(this.git, this.gitDir, 'batch-check'),
      read: new CatFile(this.git, this.gitDir, 'batch'),
    };
    return this.cats;
  }

  get(path: string): TreeFile | undefined {
    return this.byPath.get(path);
  }

  under(prefix: string): TreeFile[] {
    return this.files.filter((f) => f.path.startsWith(prefix));
  }

  async readText(path: string, maxBytes = this.maxFileBytes): Promise<ReadOutcome> {
    const file = this.byPath.get(path);
    if (file === undefined) return { state: 'absent' };
    const limit = Math.min(maxBytes, this.maxFileBytes);
    if (file.size > limit) return { state: 'too_large', file, limit };
    try {
      let buf = this.cache.get(file.blob);
      if (buf === undefined) {
        const { check, read } = this.catFiles();
        // The size in the tree listing is checked against git's own answer before the content is read.
        const info = await check.request(file.blob);
        if (info.missing) return { state: 'unreadable', file };
        if (info.type !== 'blob') return { state: 'unreadable', file };
        if (info.size > limit) return { state: 'too_large', file, limit };
        const got = await read.request(file.blob);
        if (got.missing || got.content === null) return { state: 'unreadable', file };
        buf = got.content;
        if (buf.length <= CACHE_MAX_ENTRY && this.cached + buf.length <= CACHE_MAX_BYTES) {
          this.cache.set(file.blob, buf);
          this.cached += buf.length;
        }
      }
      const text = buf.toString('utf8');
      return file.mode === '120000'
        ? { state: 'symlink', file, target: text }
        : { state: 'ok', file, text };
    } catch (e) {
      // An object git cannot read is `unreadable` (recorded); the job deadline and a dead git are
      // not, and propagate so the detector set is marked failed.
      if (e instanceof ScanFailure && e.code === 'unreadable_object')
        return { state: 'unreadable', file };
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.cats) await Promise.all([this.cats.check.close(), this.cats.read.close()]);
  }
}

/** The default branch of the mirror: the branch the head commit is the tip of (`main` or `master` first). */
export function defaultBranchOf(mirror: Mirror): string | null {
  const heads = mirror.refs.filter(
    (r) => r.name.startsWith('refs/heads/') && r.sha === mirror.base_sha,
  );
  const names = heads.map((r) => r.name.slice('refs/heads/'.length)).sort();
  return names.find((n) => n === 'main') ?? names.find((n) => n === 'master') ?? names[0] ?? null;
}
