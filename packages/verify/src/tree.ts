import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import type { RepoFile } from '@aisdlc/ports';
import {
  diffManifests,
  isTestPath,
  isTreePath,
  type TreeDiff,
  type TreeManifest,
} from '@aisdlc/tripwires';
import { createHash } from 'node:crypto';

// A repository tree as S7 reads it (PLAN M14.3): the files at a commit, by path, with their bytes and hash. Pure: the
// bytes come from the code host (the base and the Unit head), nothing here reads a disk or runs anything.

export interface TreeFile {
  readonly bytes: Buffer;
  readonly exec: boolean;
  readonly sha256: string;
}
export type Tree = ReadonlyMap<string, TreeFile>;

export const sha256Of = (b: Buffer | string): string =>
  createHash('sha256').update(b).digest('hex');

/** The tree of a list of files (`.git`, `node_modules` and the session directory never count). */
export function treeOf(files: readonly RepoFile[]): Tree {
  const m = new Map<string, TreeFile>();
  for (const f of files) {
    if (!isTreePath(f.path)) continue;
    const bytes = Buffer.from(f.content);
    m.set(f.path, { bytes, exec: f.executable === true, sha256: sha256Of(bytes) });
  }
  return new Map([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The files of a tree, as a sandbox's repo copy takes them. */
export const filesOf = (t: Tree): RepoFile[] =>
  [...t.entries()].map(([path, f]) => ({
    path,
    content: f.bytes,
    ...(f.exec ? { executable: true } : {}),
  }));

export function manifestOf(t: Tree): TreeManifest {
  const out: Record<string, { sha256: string; size: number; exec: boolean }> = {};
  for (const [p, f] of t) out[p] = { sha256: f.sha256, size: f.bytes.length, exec: f.exec };
  return out;
}

/** The content address of a tree: the sha256 of its canonical manifest. */
export const treeHash = (t: Tree): string => sha256Hex(canonicalJson(manifestOf(t) as never));

export const diffTrees = (base: Tree, head: Tree): TreeDiff =>
  diffManifests(manifestOf(base), manifestOf(head));

/** Every path the head changed against the base (added, modified, deleted), sorted. */
export const changedPaths = (d: TreeDiff): string[] =>
  [...d.added, ...d.modified, ...d.deleted].sort();

const MAX_TEXT = 1024 * 1024;

/** A file's text, or `null` for an absent, binary or oversized file (only text is scanned or mutated). */
export function textOf(f: TreeFile | undefined): string | null {
  if (f === undefined || f.bytes.length > MAX_TEXT || f.bytes.includes(0)) return null;
  return f.bytes.toString('utf8');
}

const SOURCE = /\.(c?js|mjs|jsx|ts|tsx|mts|cts|py|go|rb|rs|java|kt|php|cs)$/;

/** Implementation code (not a test, not a manifest): what the stub probe reverts and the mutation kit mutates. */
export const isSourcePath = (p: string): boolean =>
  SOURCE.test(p) && !isTestPath(p) && isTreePath(p);

/** A copy of `t` with `path` set to `text` (or removed with `null`). */
export function withFile(t: Tree, path: string, text: string | null): Tree {
  const m = new Map(t);
  if (text === null) m.delete(path);
  else {
    const bytes = Buffer.from(text);
    m.set(path, { bytes, exec: t.get(path)?.exec ?? false, sha256: sha256Of(bytes) });
  }
  return m;
}
