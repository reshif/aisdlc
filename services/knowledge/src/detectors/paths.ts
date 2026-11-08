import type { TreeFile, TreeReader } from './types.js';
import { basename, dirname } from './types.js';

// Path helpers shared by the detectors. Pure string work over the head tree's paths.

/** Directories that hold someone else's code or build output: never read for what this repo is. */
const VENDORED =
  /(?:^|\/)(?:node_modules|vendor|third_party|\.venv|venv|site-packages|dist|build|target|\.git|bower_components|\.tox|__pycache__)\//;
/** Test and fixture paths: field names and configs there are mock data, not what the system is. */
const TESTISH =
  /(?:^|\/)(?:tests?|__tests__|__mocks__|spec|specs|e2e|fixtures?|testdata|mocks?|examples?|samples?|docs?)\/|\.(?:test|spec)\.[a-z]+$|(?:^|\/)(?:conftest|testing)\.[a-z]+$/;

export const isVendored = (p: string): boolean => VENDORED.test(p);
export const isTestish = (p: string): boolean => TESTISH.test(p);
/** Paths a detector reads for the system's own shape: not vendored, not a test or fixture. */
export const isOwnSource = (p: string): boolean => !isVendored(p) && !isTestish(p);

export type Ecosystem = 'npm' | 'python' | 'go' | 'rust' | 'maven' | 'gradle' | 'ruby' | 'php';

export interface Manifest {
  readonly file: TreeFile;
  readonly ecosystem: Ecosystem;
  readonly dir: string;
}

const MANIFEST_NAMES: ReadonlyArray<readonly [RegExp, Ecosystem]> = [
  [/^package\.json$/, 'npm'],
  [/^pyproject\.toml$/, 'python'],
  [/^setup\.cfg$/, 'python'],
  [/^setup\.py$/, 'python'],
  [/^Pipfile$/, 'python'],
  [/^requirements[\w.-]*\.txt$/, 'python'],
  [/^go\.mod$/, 'go'],
  [/^Cargo\.toml$/, 'rust'],
  [/^pom\.xml$/, 'maven'],
  [/^build\.gradle(?:\.kts)?$/, 'gradle'],
  [/^Gemfile$/, 'ruby'],
  [/^composer\.json$/, 'php'],
];

export const MAX_MANIFESTS = 100;

/** Every manifest in the head tree (vendored directories excluded), shallowest first. */
export function findManifests(reader: TreeReader): { manifests: Manifest[]; capped: boolean } {
  const all: Manifest[] = [];
  for (const f of reader.files) {
    if (isVendored(f.path)) continue;
    const name = basename(f.path);
    const hit = MANIFEST_NAMES.find(([re]) => re.test(name));
    if (hit) all.push({ file: f, ecosystem: hit[1], dir: dirname(f.path) });
  }
  all.sort(
    (a, b) =>
      a.dir.split('/').length - b.dir.split('/').length || (a.file.path < b.file.path ? -1 : 1),
  );
  return { manifests: all.slice(0, MAX_MANIFESTS), capped: all.length > MAX_MANIFESTS };
}

/** `a/b/c` -> `['a/b/c', 'a/b', 'a', '']`: the directory and each ancestor, the root last. */
export function ancestry(dir: string): string[] {
  const out: string[] = [];
  let d = dir;
  for (;;) {
    out.push(d);
    if (d === '') break;
    d = dirname(d);
  }
  return out;
}

export const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

/** Glob (`*`, `**`, `?`) as an anchored regex, for branch and path patterns. */
export function globRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
