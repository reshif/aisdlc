import { patternRegex } from '@aisdlc/codeowners';
import { PROTECTED_PATH_PROBES } from '@aisdlc/contracts';
import { SECRET_PATH } from './commands.js';
import { diffManifests, isTreePath, lineDelta, type TreeManifest } from './tree.js';
import type { Tripwire } from './types.js';

// What a session may not touch and how much it may change (PLAN M13.4), as plain data: the same policy is applied
// live in the sandbox (the runner's hooks) and again by the factory over the tree that comes back, so a runner that
// was tampered with is still caught where the factory looks.

export interface TripwirePolicy {
  /** CODEOWNERS-style globs: a write is misbehaviour (ET10 protected-path write). */
  readonly protected_globs: readonly string[];
  /** Globs whose change is a sensitive path: R1 (the work belongs to a higher lane), free and logged. */
  readonly sensitive_globs: readonly string[];
  /** Locked tests (the oracles after 6.3): an edit is misbehaviour (ET10). */
  readonly locked_paths: readonly string[];
  /** The Unit's scope; empty means the whole repo. A change outside it is scope drift (B8, then ET9). */
  readonly scope_globs: readonly string[];
  readonly diff_budget: { readonly max_files: number; readonly max_lines: number };
}

/** The factory's protected set (OB §4.1 item 7, §6.6): instruction files, CODEOWNERS, CI, the factory's own knowledge, agent harness files. */
export const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
  ...new Set([
    ...PROTECTED_PATH_PROBES,
    '**/AGENTS.md',
    '**/CLAUDE.md',
    '.github/**',
    '.factory/**',
    '.claude/**',
    '**/.mcp.json',
    '.cursor/**',
    '.codex/**',
  ]),
];

export const DEFAULT_SENSITIVE_GLOBS: readonly string[] = [
  '**/migrations/**',
  '**/auth/**',
  '**/security/**',
  '**/secrets/**',
  'Dockerfile*',
  '**/Dockerfile*',
  'docker-compose*.y*ml',
  'infra/**',
  'terraform/**',
  '**/*.tf',
];

/**
 * A diff budget per lane. The catalogue gives lanes an envelope in money, not a size in lines, so these are the
 * defaults of this build (a tunable, M1-gated config later): small work stays small.
 */
export const DEFAULT_DIFF_BUDGET: Readonly<
  Record<string, { max_files: number; max_lines: number }>
> = {
  L0: { max_files: 5, max_lines: 80 },
  L1: { max_files: 15, max_lines: 400 },
  L2: { max_files: 15, max_lines: 400 },
  L3: { max_files: 15, max_lines: 400 },
  L4: { max_files: 40, max_lines: 1500 },
  L5: { max_files: 40, max_lines: 1500 },
  L6: { max_files: 60, max_lines: 3000 },
  L7: { max_files: 60, max_lines: 3000 },
  L8: { max_files: 60, max_lines: 3000 },
};

/** The next lane up the planning ladder (R1's target), or null at the top. L7 and L8 are not on the ladder. */
export const nextLaneUp = (lane: string): string | null => {
  const ladder = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
  const i = ladder.indexOf(lane);
  return i < 0 ? null : (ladder[i + 1] ?? null);
};

const cache = new Map<string, RegExp>();
const re = (g: string): RegExp => {
  let r = cache.get(g);
  if (r === undefined) {
    r = patternRegex(g);
    cache.set(g, r);
  }
  return r;
};

/** `true` when `path` (repo-relative) matches one of the CODEOWNERS-style globs. */
export const matchesAny = (path: string, globs: readonly string[]): boolean => {
  const p = path.replace(/^\/+/, '');
  return globs.some((g) => re(g).test(p));
};

/** A path the agent names for a write: what it is, relative to the repo, or why it is out of bounds. */
export function writeTripwire(policy: TripwirePolicy, path: string): Tripwire | null {
  const p = path.replace(/^\.\//, '');
  if (p.startsWith('/') || p.split('/').includes('..')) {
    return {
      kind: 'protected_path_write',
      class: 'quarantine',
      detail: `a write outside the workspace (${p.slice(0, 80)})`,
      path: p.slice(0, 200),
    };
  }
  if (policy.locked_paths.includes(p) || matchesAny(p, policy.locked_paths)) {
    return {
      kind: 'locked_test_edit',
      class: 'quarantine',
      detail: `an edit of the locked test ${p}`,
      path: p,
    };
  }
  if (matchesAny(p, policy.protected_globs)) {
    return {
      kind: 'protected_path_write',
      class: 'quarantine',
      detail: `a write to the protected path ${p}`,
      path: p,
    };
  }
  return null;
}

/** A read of a credential path. */
export function readTripwire(path: string): Tripwire | null {
  const p = path.slice(0, 300);
  if (SECRET_PATH.test(p) || p.startsWith('/proc/') || p.startsWith('/etc/shadow')) {
    return {
      kind: 'secret_access',
      class: 'quarantine',
      detail: `a read of the credential path ${p.slice(0, 80)}`,
      path: p,
    };
  }
  return null;
}

// ---------------------------------------------------------------- dependencies (X3)

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const names = (text: string, file: string): Set<string> | null => {
  const base = file.split('/').pop() ?? file;
  const out = new Set<string>();
  try {
    if (base === 'package.json') {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const f of DEP_FIELDS) {
        const o = j[f];
        if (o !== null && typeof o === 'object')
          for (const k of Object.keys(o)) out.add(`${f}:${k}`);
      }
      return out;
    }
    if (/^requirements.*\.txt$/.test(base)) {
      for (const l of text.split('\n')) {
        const t = l.trim();
        if (t !== '' && !t.startsWith('#') && !t.startsWith('-'))
          out.add(t.split(/[=<>~!\s;[]/)[0] ?? t);
      }
      return out;
    }
    if (base === 'go.mod') {
      for (const l of text.split('\n')) {
        const m = /^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v[\w.+-]+/.exec(l);
        if (m) out.add(m[1] as string);
      }
      return out;
    }
    if (base === 'Cargo.toml') {
      let inDeps = false;
      for (const l of text.split('\n')) {
        const sec = /^\s*\[(.+)\]\s*$/.exec(l);
        if (sec) inDeps = /dependencies/.test(sec[1] as string);
        else if (inDeps) {
          const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(l);
          if (m) out.add(m[1] as string);
        }
      }
      return out;
    }
    if (base === 'Gemfile') {
      for (const l of text.split('\n')) {
        const m = /^\s*gem\s+['"]([^'"]+)['"]/.exec(l);
        if (m) out.add(m[1] as string);
      }
      return out;
    }
  } catch {
    return null;
  }
  return null;
};

export const isManifest = (p: string): boolean =>
  /(^|\/)(package\.json|requirements[\w.-]*\.txt|go\.mod|Cargo\.toml|Gemfile)$/.test(p);

/** Dependencies a manifest gained between two texts (`before` may be absent). An unreadable manifest gains none here; the lockfile check covers it. */
export function addedDependencies(file: string, before: string | null, after: string): string[] {
  const b = before === null ? new Set<string>() : (names(before, file) ?? new Set<string>());
  const a = names(after, file);
  if (a === null) return [];
  return [...a].filter((n) => !b.has(n)).sort();
}

export const isLockfile = (p: string): boolean =>
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|uv\.lock)$/.test(
    p,
  );

// ---------------------------------------------------------------- stub tests (ET10: stub passes)

const STUB_ASSERTIONS: RegExp[] = [
  /\bassert(\.ok|\.equal|\.strictEqual|\.deepStrictEqual)?\(\s*true\s*(,\s*true\s*)?(,|\))/,
  /\bassert\.(equal|strictEqual|deepEqual|deepStrictEqual)\(\s*(\d+|'[^']*'|"[^"]*"|true|false|null)\s*,\s*\2\s*[,)]/,
  /\bexpect\(\s*true\s*\)\.(toBe|toEqual|toBeTruthy)\(\s*(true)?\s*\)/,
  /\bexpect\(\s*(\d+|'[^']*'|"[^"]*")\s*\)\.(toBe|toEqual)\(\s*\1\s*\)/,
  /\bt\.pass\(/,
  /^\s*assert\s+True\s*$/m,
  /^\s*assert\s+(\d+)\s*==\s*\1\s*$/m,
  /\bt\.Skip\(/,
];
const TEST_FILE =
  /(^|\/)(test|tests|__tests__|spec)(\/|$)|[._-](test|spec)\.[a-z]+$|^test_.*\.py$|_test\.(go|py)$/;
export const isTestPath = (p: string): boolean => TEST_FILE.test(p);

/**
 * A test file that cannot fail: its only assertions are tautologies, or its test bodies are empty. A static probe
 * (the mutation-based stub probe is S7 7.2, M14); it is what the 6.5 self-check can see for free. Returns a reason or null.
 */
export function stubReason(path: string, text: string): string | null {
  if (!isTestPath(path)) return null;
  const hasTestCall = /\b(it|test|describe|def test_|func Test)\b/.test(text);
  if (!hasTestCall) return null;
  const empty =
    /\b(it|test)\(\s*(['"`])[^'"`]*\2\s*,\s*(async\s*)?(\(\s*(t|ctx)?\s*\)|function\s*\(\s*\))\s*(=>)?\s*\{\s*\}\s*\)/.test(
      text,
    );
  if (empty) return `${path} has a test with an empty body`;
  const asserts = text.match(/\b(assert|expect)\b[\w.]*\(/g) ?? [];
  const tautologies = STUB_ASSERTIONS.some((r) => r.test(text));
  const realAsserts = asserts.length;
  if (tautologies && realAsserts <= 3) {
    return `${path} asserts only what is always true`;
  }
  return null;
}

// ---------------------------------------------------------------- the tree

export interface TreeEvidence {
  readonly base: TreeManifest;
  readonly now: TreeManifest;
  /** Text of a path at `base` (null: absent) and `now`; only called for files that changed. */
  readonly before: (path: string) => string | null;
  readonly after: (path: string) => string | null;
  /** The sha256 each locked test had when it was locked. */
  readonly locks: Readonly<Record<string, string>>;
}

export interface TreeVerdict {
  readonly tripwires: Tripwire[];
  readonly files_changed: number;
  readonly lines_changed: number;
  readonly paths: {
    readonly added: readonly string[];
    readonly modified: readonly string[];
    readonly deleted: readonly string[];
  };
}

/**
 * The factory's own look at the tree a session came back with: protected writes, locked-test edits, stub tests,
 * new dependencies, sensitive paths, the diff against the lane budget and the Unit's scope. A path of the tree
 * that is a credential file is a secret access too (the session wrote or fetched one).
 */
export function evaluateTree(policy: TripwirePolicy, ev: TreeEvidence): TreeVerdict {
  const d = diffManifests(ev.base, ev.now);
  const t: Tripwire[] = [];
  const changed = [...d.added, ...d.modified, ...d.deleted].filter(isTreePath);
  let lines = 0;
  for (const p of changed) {
    // a locked path is judged by its HASH (a lock is a hash): the oracle files the factory added at 6.3 are changes against
    // the base tree and are not edits; a different hash, a deletion or a new file at a locked path is
    const w = writeTripwire({ ...policy, locked_paths: [] }, p);
    if (w !== null) t.push(w);
    const locked = ev.locks[p] !== undefined || policy.locked_paths.includes(p);
    if (locked) {
      const want = ev.locks[p] ?? ev.base[p]?.sha256;
      if ((ev.now[p]?.sha256 ?? 'deleted') !== want) {
        t.push({
          kind: 'locked_test_edit',
          class: 'quarantine',
          detail: `the locked test ${p} changed`,
          path: p,
        });
      }
    }
    if (SECRET_PATH.test(p) && !d.deleted.includes(p)) {
      t.push({
        kind: 'secret_access',
        class: 'quarantine',
        detail: `a credential-shaped file appeared (${p})`,
        path: p,
      });
    }
    const before = ev.before(p);
    const after = ev.after(p);
    if (after !== null) {
      lines += lineDelta(before ?? '', after).added + lineDelta(before ?? '', after).removed;
      const stub = stubReason(p, after);
      if (
        stub !== null &&
        !d.deleted.includes(p) &&
        (before === null || stubReason(p, before) === null)
      ) {
        t.push({ kind: 'stub_test', class: 'quarantine', detail: stub, path: p });
      }
      if (isManifest(p)) {
        const gained = addedDependencies(p, before, after);
        if (gained.length > 0) {
          t.push({
            kind: 'new_dependency',
            class: 'gate_x3',
            detail: `${p} gains ${gained.slice(0, 5).join(', ')}`,
            path: p,
          });
        }
      }
    } else if (before !== null) lines += lineDelta(before, '').removed;
    if (matchesAny(p, policy.sensitive_globs)) {
      t.push({
        kind: 'sensitive_path',
        class: 'relane_r1',
        detail: `a sensitive path changed (${p})`,
        path: p,
      });
    }
    if (policy.scope_globs.length > 0 && !matchesAny(p, policy.scope_globs) && !isLockfile(p)) {
      t.push({
        kind: 'scope_drift',
        class: 'scope',
        detail: `${p} is outside the Unit's scope`,
        path: p,
      });
    }
  }
  if (changed.length > policy.diff_budget.max_files || lines > policy.diff_budget.max_lines) {
    t.push({
      kind: 'diff_over_lane_budget',
      class: 'relane_r1',
      detail: `${changed.length} files and ${lines} lines against ${policy.diff_budget.max_files} files and ${policy.diff_budget.max_lines} lines`,
    });
  }
  return {
    tripwires: t,
    files_changed: changed.length,
    lines_changed: lines,
    paths: { added: d.added, modified: d.modified, deleted: d.deleted },
  };
}
