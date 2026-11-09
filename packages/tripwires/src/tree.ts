// A workspace tree as hashes (PLAN M13.4): what the factory keeps of a session's /work, and what the tripwires
// compare. Pure: contents are passed in, never read here.

export interface TreeEntry {
  readonly sha256: string;
  readonly size: number;
  readonly exec: boolean;
}
/** Repo-relative, `/`-separated path to entry. `.git`, `node_modules` and the factory's own session directory never appear. */
export type TreeManifest = Readonly<Record<string, TreeEntry>>;

export interface TreeDiff {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

/** Paths that are not the repository's content: tooling state and the factory's session directory. */
export const NOT_TREE = /(^|\/)(\.git|node_modules|\.aisdlc-session)(\/|$)/;
export const isTreePath = (p: string): boolean => !NOT_TREE.test(p);

export function diffManifests(base: TreeManifest, now: TreeManifest): TreeDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, e] of Object.entries(now)) {
    const b = base[p];
    if (b === undefined) added.push(p);
    else if (b.sha256 !== e.sha256 || b.exec !== e.exec) modified.push(p);
  }
  for (const p of Object.keys(base)) if (now[p] === undefined) deleted.push(p);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

/** Lines added and removed between two texts (a multiset difference: order-insensitive, cheap, deterministic). */
export function lineDelta(a: string, b: string): { added: number; removed: number } {
  const count = (t: string): Map<string, number> => {
    const m = new Map<string, number>();
    if (t === '') return m;
    for (const l of t.split('\n')) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  let added = 0;
  let removed = 0;
  for (const [l, n] of cb) added += Math.max(0, n - (ca.get(l) ?? 0));
  for (const [l, n] of ca) removed += Math.max(0, n - (cb.get(l) ?? 0));
  return { added, removed };
}
