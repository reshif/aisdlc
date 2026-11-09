import { createHash } from 'node:crypto';
import type { CodeHostSeed } from '@aisdlc/ports';
import { repoKey } from '@aisdlc/ports';

// The git objects of the in-repo fake GitHub server (PLAN M13.6): blobs, trees, commits, with REAL git hashing (a blob is
// sha1 of `blob <n>\0<bytes>`, a tree of its sorted entries, a commit of its text), so a sha the fake hands out is the sha a
// real `git hash-object` would give, and the Git Data API answers have GitHub's shapes. Commits that the seed names by
// an arbitrary sha stand for a tree of the seed's files at that sha (they have no parents and are not re-hashed).

const sha1 = (...parts: Array<string | Buffer>): string => {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

export const blobSha = (bytes: Buffer): string => sha1(`blob ${bytes.length}\0`, bytes);

export interface TreeFile {
  readonly mode: '100644' | '100755';
  readonly blob: string;
}
/** A tree as the flat map of its files (path -> mode and blob), which is what the Git Data API's `base_tree` and `tree` merge. */
export type FlatTree = ReadonlyMap<string, TreeFile>;

interface Dir {
  files: Map<string, TreeFile>;
  dirs: Map<string, Dir>;
}

function nest(flat: FlatTree): Dir {
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, f] of flat) {
    const segs = path.split('/');
    let d = root;
    for (const s of segs.slice(0, -1)) {
      let n = d.dirs.get(s);
      if (!n) {
        n = { files: new Map(), dirs: new Map() };
        d.dirs.set(s, n);
      }
      d = n;
    }
    d.files.set(segs[segs.length - 1] as string, f);
  }
  return root;
}

function hashDir(d: Dir): string {
  const entries: Array<{ key: string; bytes: Buffer }> = [];
  for (const [name, f] of d.files) {
    entries.push({
      key: name,
      bytes: Buffer.concat([Buffer.from(`${f.mode} ${name}\0`), Buffer.from(f.blob, 'hex')]),
    });
  }
  for (const [name, sub] of d.dirs) {
    entries.push({
      // git sorts a directory as if its name ended in "/"
      key: `${name}/`,
      bytes: Buffer.concat([Buffer.from(`40000 ${name}\0`), Buffer.from(hashDir(sub), 'hex')]),
    });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const body = Buffer.concat(entries.map((e) => e.bytes));
  return sha1(`tree ${body.length}\0`, body);
}

export const treeSha = (flat: FlatTree): string => hashDir(nest(flat));

export interface CommitObject {
  readonly sha: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: { name: string; email: string; date: string };
  readonly committer: { name: string; email: string; date: string };
}

export class GitObjects {
  private readonly blobs = new Map<string, Buffer>();
  private readonly trees = new Map<string, FlatTree>();
  private readonly commits = new Map<string, CommitObject>();
  private readonly made = new Set<string>();

  constructor(private seed: CodeHostSeed) {}

  load(seed: CodeHostSeed): void {
    this.seed = seed;
    this.blobs.clear();
    this.trees.clear();
    this.commits.clear();
    this.made.clear();
  }

  addBlob(bytes: Buffer): string {
    const sha = blobSha(bytes);
    this.blobs.set(sha, bytes);
    return sha;
  }
  blob(sha: string): Buffer | undefined {
    return this.blobs.get(sha);
  }

  /** The seed's files at `sha` as a flat tree, or `undefined` when the seed has none at that sha. */
  private seeded(repo: string, sha: string): FlatTree | undefined {
    const files = this.seed.files.filter((f) => repoKey(f.repo) === repoKey(repo) && f.sha === sha);
    const isHead = this.seed.heads.some((h) => repoKey(h.repo) === repoKey(repo) && h.sha === sha);
    if (files.length === 0 && !isHead) return undefined;
    const m = new Map<string, TreeFile>();
    for (const f of files)
      m.set(f.path, { mode: '100644', blob: this.addBlob(Buffer.from(f.content)) });
    return m;
  }

  /** A commit by sha: one created through the API, or a seeded sha standing for the seed's tree. */
  commit(repo: string, sha: string): CommitObject | undefined {
    const made = this.commits.get(sha);
    if (made) return made;
    const flat = this.seeded(repo, sha);
    if (!flat) return undefined;
    const tree = treeSha(flat);
    this.trees.set(tree, flat);
    const who = { name: 'seed', email: 'seed@example.invalid', date: '2026-01-01T00:00:00Z' };
    const c: CommitObject = {
      sha,
      tree,
      parents: [],
      message: 'seed',
      author: who,
      committer: who,
    };
    this.commits.set(sha, c);
    return c;
  }

  /** Was this commit created through the API (as opposed to named by the seed)? */
  created(sha: string): boolean {
    return this.made.has(sha);
  }

  tree(sha: string): FlatTree | undefined {
    return this.trees.get(sha);
  }

  /** `base_tree` plus entries (an entry with `sha: null` deletes the path): GitHub's tree creation. */
  createTree(
    base: string | undefined,
    entries: ReadonlyArray<{ path: string; mode: string; sha: string | null }>,
  ): { sha: string } | { error: string } {
    const flat = new Map<string, TreeFile>(base === undefined ? [] : (this.trees.get(base) ?? []));
    if (base !== undefined && !this.trees.has(base)) return { error: 'base_tree does not exist' };
    for (const e of entries) {
      if (e.sha === null) {
        flat.delete(e.path);
        continue;
      }
      if (!this.blobs.has(e.sha)) return { error: `tree entry ${e.path}: blob does not exist` };
      if (e.mode !== '100644' && e.mode !== '100755') return { error: 'unsupported mode' };
      flat.set(e.path, { mode: e.mode, blob: e.sha });
    }
    const sha = treeSha(flat);
    this.trees.set(sha, flat);
    return { sha };
  }

  createCommit(
    repo: string,
    c: {
      tree: string;
      parents: readonly string[];
      message: string;
      author: { name: string; email: string; date: string };
      committer: { name: string; email: string; date: string };
    },
  ): { sha: string } | { error: string } {
    if (!this.trees.has(c.tree)) return { error: 'tree does not exist' };
    for (const p of c.parents) if (!this.commit(repo, p)) return { error: 'parent does not exist' };
    const ts = (d: string): string => `${Math.floor(new Date(d).getTime() / 1000)} +0000`;
    const text =
      `tree ${c.tree}\n` +
      c.parents.map((p) => `parent ${p}\n`).join('') +
      `author ${c.author.name} <${c.author.email}> ${ts(c.author.date)}\n` +
      `committer ${c.committer.name} <${c.committer.email}> ${ts(c.committer.date)}\n\n${c.message}`;
    const sha = sha1(`commit ${Buffer.byteLength(text)}\0`, text);
    this.commits.set(sha, { sha, ...c });
    this.made.add(sha);
    return { sha };
  }

  /** Is `ancestor` reachable from `from` by parents (a commit is its own ancestor)? */
  isAncestor(repo: string, ancestor: string, from: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const s = stack.pop() as string;
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      const c = this.commit(repo, s);
      if (c) stack.push(...c.parents);
    }
    return false;
  }

  /** The content of `path` in the commit's tree (for the contents API), as bytes. */
  fileAt(repo: string, sha: string, path: string): Buffer | null | undefined {
    const c = this.commit(repo, sha);
    if (!c) return undefined;
    const f = this.trees.get(c.tree)?.get(path);
    return f ? (this.blobs.get(f.blob) ?? null) : null;
  }

  pathsAt(repo: string, sha: string): string[] | undefined {
    const c = this.commit(repo, sha);
    return c ? [...(this.trees.get(c.tree)?.keys() ?? [])] : undefined;
  }
}
