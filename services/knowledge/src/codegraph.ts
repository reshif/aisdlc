import {
  CODE_GRAPH_MAX_EDGES,
  CODE_GRAPH_MAX_EXPORTS,
  CODE_GRAPH_MAX_FILES,
  CODE_GRAPH_SCHEMA_ID,
  CodeGraph,
  codeGraphHash,
  type CodeEdge,
  type CodeFileNode,
  type CodeFileRole,
  type CodeLanguage,
  type GitSha,
} from '@aisdlc/contracts';
import type pg from 'pg';

// The code graph of a repository's head (PLAN M17, OB §6.2 row 0.3 "full codekb"): which files there are,
// their language, role and area (the monorepo part: the nearest directory with a manifest, DEC-25), the
// names they export and the imports between them. Built from the search index (the same hardened tree
// reader the detectors use; a file that holds a secret was never indexed, so the graph never sees it) by
// plain pattern matching over TypeScript, JavaScript and Python: no code of the repo runs, nothing is
// resolved outside the repo. Deterministic: the same index gives the same bytes and the same
// `graph_hash`. It holds paths, blob ids, identifiers and counts, never file content.

export interface IndexedFile {
  readonly path: string;
  readonly blob: string;
  readonly content: string;
}

const MANIFESTS = new Set([
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
]);
const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const CONFIG_EXT = ['.json', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.lock'];
const DOC_EXT = ['.md', '.mdx', '.rst', '.txt', '.adoc'];

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dir = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const ext = (p: string): string => {
  const b = base(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i).toLowerCase();
};

export function languageOf(path: string): CodeLanguage {
  const e = ext(path);
  if (['.ts', '.tsx', '.mts', '.cts'].includes(e)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(e)) return 'javascript';
  if (e === '.py') return 'python';
  return 'other';
}

const TEST_DIR = /(^|\/)(test|tests|__tests__|spec|specs|e2e)\//;
const TEST_FILE = /(\.(test|spec)\.[a-z]+$)|(^test_[^/]*\.py$)|(_test\.py$)/;

export function roleOf(path: string): CodeFileRole {
  const lang = languageOf(path);
  const b = base(path);
  if (lang !== 'other' && (TEST_DIR.test(path) || TEST_FILE.test(b))) return 'test';
  if (MANIFESTS.has(b) || CONFIG_EXT.includes(ext(path)) || /\.config\.[a-z]+$/.test(b)) {
    return 'config';
  }
  if (lang !== 'other') return 'source';
  if (DOC_EXT.includes(ext(path))) return 'doc';
  return 'other';
}

/** The area of a path: the deepest directory above it (never the root) that holds a manifest, else `.`. */
export function areaOf(path: string, manifestDirs: ReadonlySet<string>): string {
  let d = dir(path);
  while (d !== '') {
    if (manifestDirs.has(d)) return d;
    d = dir(d);
  }
  return '.';
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

function exportsOf(lang: CodeLanguage, text: string): string[] {
  const out = new Set<string>();
  if (lang === 'typescript' || lang === 'javascript') {
    const re =
      /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
    for (const m of text.matchAll(re)) if (m[1]) out.add(m[1]);
    if (/^\s*export\s+default\b/m.test(text)) out.add('default');
  } else if (lang === 'python') {
    for (const m of text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z][\w]*)/gm)) {
      if (m[1] && !m[1].startsWith('_')) out.add(m[1]);
    }
  }
  return [...out]
    .filter((n) => IDENT.test(n))
    .sort()
    .slice(0, CODE_GRAPH_MAX_EXPORTS);
}

interface Spec {
  readonly spec: string;
  readonly line: number;
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

function jsSpecs(text: string): Spec[] {
  const out: Spec[] = [];
  const res = [
    /\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  for (const re of res) {
    for (const m of text.matchAll(re)) {
      if (m[1]) out.push({ spec: m[1], line: lineAt(text, m.index ?? 0) });
    }
  }
  return out;
}

function pySpecs(text: string): Spec[] {
  const out: Spec[] = [];
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+([^\n#]+)/gm)) {
    const line = lineAt(text, m.index ?? 0);
    const mod = m[1] ?? '';
    // `from . import a, b` names modules a and b of the package
    if (/^\.+$/.test(mod)) {
      for (const name of (m[2] ?? '').replace(/[()]/g, '').split(',')) {
        const n = name.trim().split(/\s+/)[0];
        if (n && /^\w+$/.test(n)) out.push({ spec: `${mod}${n}`, line });
      }
    } else if (mod) out.push({ spec: mod, line });
  }
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    const line = lineAt(text, m.index ?? 0);
    for (const part of (m[1] ?? '').split(',')) {
      const n = part.trim().split(/\s+/)[0];
      if (n && /^[\w.]+$/.test(n)) out.push({ spec: n, line });
    }
  }
  return out;
}

const normalise = (p: string): string | null => {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
};

function resolveJs(
  from: string,
  spec: string,
  files: ReadonlySet<string>,
  packages: ReadonlyMap<string, string>,
): string | null {
  if (spec.startsWith('.')) {
    const target = normalise(`${dir(from)}/${spec}`);
    if (target === null) return null;
    const stem = target.replace(/\.(m|c)?js$/, '');
    const tries = [
      target,
      ...JS_EXT.map((e) => `${stem}${e}`),
      ...JS_EXT.map((e) => `${target}/index${e}`),
    ];
    return tries.find((t) => files.has(t)) ?? null;
  }
  // A bare specifier that names a workspace package of this repo: the package's manifest.
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  return packages.get(name) ?? null;
}

function resolvePy(from: string, spec: string, files: ReadonlySet<string>): string | null {
  const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
  const rest = spec.slice(dots).replaceAll('.', '/');
  const roots: string[] = [];
  if (dots > 0) {
    let d = dir(from);
    for (let i = 1; i < dots; i++) d = dir(d);
    roots.push(d);
  } else roots.push('', 'src', dir(from));
  for (const r of roots) {
    const stem = [r, rest].filter((x) => x !== '').join('/');
    if (stem === '') continue;
    for (const t of [`${stem}.py`, `${stem}/__init__.py`]) if (files.has(t)) return t;
  }
  return null;
}

/** The package name a `package.json` declares, if it reads. Repo text is data: only a name-shaped string is kept. */
function packageName(content: string): string | null {
  try {
    const v = JSON.parse(content) as unknown;
    const n = v !== null && typeof v === 'object' ? (v as { name?: unknown }).name : undefined;
    return typeof n === 'string' && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]{1,100}$/.test(n) ? n : null;
  } catch {
    return null;
  }
}

/** The code graph of the indexed files. Pure. */
export function buildCodeGraph(o: {
  repo: string;
  commit_sha: string;
  files: readonly IndexedFile[];
  skipped_index: number;
}): CodeGraph {
  const sorted = [...o.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let truncated = sorted.length > CODE_GRAPH_MAX_FILES;
  const kept = sorted.slice(0, CODE_GRAPH_MAX_FILES);
  const paths = new Set(kept.map((f) => f.path));
  const manifestDirs = new Set(
    kept.filter((f) => MANIFESTS.has(base(f.path)) && dir(f.path) !== '').map((f) => dir(f.path)),
  );
  const packages = new Map<string, string>();
  for (const f of kept) {
    if (base(f.path) !== 'package.json') continue;
    const n = packageName(f.content);
    if (n !== null && !packages.has(n)) packages.set(n, f.path);
  }
  const nodes: CodeFileNode[] = kept.map((f) => {
    const language = languageOf(f.path);
    return {
      path: f.path,
      blob: f.blob as GitSha,
      language,
      role: roleOf(f.path),
      area: areaOf(f.path, manifestDirs),
      lines: f.content === '' ? 0 : f.content.split('\n').length,
      exports: exportsOf(language, f.content),
    };
  });
  const edges: CodeEdge[] = [];
  const seen = new Set<string>();
  let external = 0;
  for (const f of kept) {
    const lang = languageOf(f.path);
    if (lang === 'other') continue;
    const specs = lang === 'python' ? pySpecs(f.content) : jsSpecs(f.content);
    for (const s of specs.sort((a, b) => a.line - b.line)) {
      const to =
        lang === 'python'
          ? resolvePy(f.path, s.spec, paths)
          : resolveJs(f.path, s.spec, paths, packages);
      if (to === null || to === f.path) {
        if (to === null) external += 1;
        continue;
      }
      const key = `${f.path}\0${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (edges.length >= CODE_GRAPH_MAX_EDGES) {
        truncated = true;
        continue;
      }
      edges.push({ from: f.path, to, line: s.line });
    }
  }
  const body = {
    schema: CODE_GRAPH_SCHEMA_ID,
    repo: o.repo,
    commit_sha: o.commit_sha,
    files: nodes,
    edges,
    external_imports: external,
    skipped_index: o.skipped_index,
    truncated,
  };
  return CodeGraph.parse({ ...body, graph_hash: codeGraphHash(body) });
}

export type CodeGraphOutcome =
  | { readonly state: 'ok'; readonly graph: CodeGraph }
  | { readonly state: 'not_indexed' }
  | { readonly state: 'stale_index'; readonly indexed_sha: string };

/** The code graph of a repo at `sha`, from its search index. Read-only; rebuilt from the index on every call. */
export async function codeGraphAt(
  pool: pg.Pool,
  repo: string,
  sha: string,
): Promise<CodeGraphOutcome> {
  const idx = await pool.query<{ repo: string; commit_sha: string; skipped: number }>(
    'SELECT repo, commit_sha, skipped FROM knowledge.repo_index WHERE repo = $1',
    [repo.toLowerCase()],
  );
  const at = idx.rows[0];
  if (!at) return { state: 'not_indexed' };
  if (at.commit_sha !== sha) return { state: 'stale_index', indexed_sha: at.commit_sha };
  const rows = await pool.query<{ path: string; blob_sha: string; content: string }>(
    'SELECT path, blob_sha, content FROM knowledge.repo_file WHERE repo = $1 ORDER BY path',
    [repo.toLowerCase()],
  );
  return {
    state: 'ok',
    graph: buildCodeGraph({
      repo,
      commit_sha: sha,
      files: rows.rows.map((r) => ({ path: r.path, blob: r.blob_sha, content: r.content })),
      skipped_index: at.skipped,
    }),
  };
}
