import type { Fact } from '@aisdlc/contracts';
import {
  ancestry,
  findManifests,
  join,
  MAX_MANIFESTS,
  type Ecosystem,
  type Manifest,
} from './paths.js';
import { parseJson } from './safe-parse.js';
import { Collector, basename, type Detector, type TreeFile, type TreeReader } from './types.js';

// Lockfile detector (PLAN M6.3; RS-BT-3): for each manifest, is there a lockfile, and would a
// frozen install work. `feasible` only where the lockfile can be checked against the manifest here
// (npm); a present lockfile that is not checked is `unknown` (the probe in K-exec decides). Nothing
// is installed and no package manager runs.

const LOCKFILES: Record<Ecosystem, readonly string[]> = {
  npm: [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ],
  python: ['poetry.lock', 'uv.lock', 'pdm.lock', 'Pipfile.lock'],
  go: ['go.sum'],
  rust: ['Cargo.lock'],
  maven: [],
  gradle: ['gradle.lockfile'],
  ruby: ['Gemfile.lock'],
  php: ['composer.lock'],
};

const FROZEN: Record<string, string> = {
  'package-lock.json': 'npm ci',
  'npm-shrinkwrap.json': 'npm ci',
  'pnpm-lock.yaml': 'pnpm install --frozen-lockfile',
  'yarn.lock': 'yarn install --frozen-lockfile (or --immutable)',
  'bun.lock': 'bun install --frozen-lockfile',
  'bun.lockb': 'bun install --frozen-lockfile',
  'poetry.lock': 'poetry install',
  'uv.lock': 'uv sync --frozen',
  'pdm.lock': 'pdm install --frozen-lockfile',
  'Pipfile.lock': 'pipenv install --deploy',
  'go.sum': 'go mod download (verified by go.sum)',
  'Cargo.lock': 'cargo build --locked',
  'gradle.lockfile': 'gradle build --write-locks off',
  'Gemfile.lock': 'bundle install --frozen',
  'composer.lock': 'composer install',
};

const LOCK_LIMIT = 4 * 1024 * 1024;

/** Every requirement line of a requirements file is pinned with `==` (or is an option or a comment). */
export function allPinned(text: string): { pinned: boolean; deps: number } {
  let deps = 0;
  let pinned = true;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+#.*$/, '').trim();
    if (l === '' || l.startsWith('#') || l.startsWith('-') || l.startsWith('--hash')) continue;
    if (/^\\?$/.test(l)) continue;
    deps++;
    if (!/^[A-Za-z0-9_.[\]-]+\s*===?\s*[A-Za-z0-9_.!+*-]+/.test(l)) pinned = false;
  }
  return { pinned, deps };
}

type Dep = Record<string, string>;
const depMap = (v: unknown): Dep =>
  v !== null && typeof v === 'object'
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]),
      )
    : {};

export function lockfileDetector(): Detector {
  return {
    info: { id: 'lockfiles', version: '1', criteria: ['RS-BT-3'] },
    async run(reader: TreeReader) {
      const c = new Collector('lockfiles', reader);
      const { manifests, capped } = findManifests(reader);
      if (capped) c.capped('manifests', MAX_MANIFESTS);
      for (const m of manifests) c.add(await one(reader, c, m));
      return c.output();
    },
  };
}

async function one(reader: TreeReader, c: Collector, m: Manifest): Promise<Fact> {
  const name = basename(m.file.path);
  const mk = (
    state: 'present' | 'absent',
    lockfile: string | null,
    inherited: boolean,
    frozen: 'feasible' | 'infeasible' | 'unknown',
    reason: string,
    evidenceFile: TreeFile = m.file,
  ): Fact => ({
    kind: 'lockfile',
    detector: 'lockfiles',
    manifest: m.file.path,
    ecosystem: m.ecosystem,
    state,
    lockfile,
    inherited,
    frozen_install: frozen,
    reason,
    evidence: [c.evidence(evidenceFile)],
  });

  // A requirements file is its own lock when every line is pinned.
  if (m.ecosystem === 'python' && /^requirements[\w.-]*\.txt$/.test(name)) {
    const t = await c.text(m.file.path, 1024 * 1024);
    if (!t) return mk('absent', null, false, 'unknown', 'the requirements file could not be read');
    const { pinned, deps } = allPinned(t.text);
    if (deps === 0) return mk('present', m.file.path, false, 'feasible', 'no requirements to lock');
    return pinned
      ? mk('present', m.file.path, false, 'feasible', 'every requirement is pinned with ==')
      : mk('absent', null, false, 'infeasible', 'requirements are not all pinned with ==');
  }
  if (m.ecosystem === 'python' && (name === 'setup.cfg' || name === 'setup.py')) {
    // Library packaging metadata: the lock, if any, is declared by the project's pyproject or requirements.
    const sibling = LOCKFILES.python.map((l) => join(m.dir, l)).find((p) => reader.get(p));
    return sibling
      ? mk(
          'present',
          sibling,
          false,
          'unknown',
          'lockfile present; not compared with the manifest here',
        )
      : mk('absent', null, false, 'infeasible', 'no lockfile beside the manifest');
  }
  if (m.ecosystem === 'maven')
    return mk(
      'absent',
      null,
      false,
      'infeasible',
      'Maven has no lockfile; dependency versions are resolved at build',
    );
  if (m.ecosystem === 'go') {
    const t = await c.text(m.file.path, 1024 * 1024);
    const requires = t ? /^\s*require\b|^\s+[\w.-]+\.[\w./-]+\s+v\d/m.test(t.text) : true;
    const sum = reader.get(join(m.dir, 'go.sum'));
    if (!requires && !sum)
      return mk(
        'absent',
        null,
        false,
        'feasible',
        'go.mod requires nothing, so there is nothing to lock',
      );
    if (sum)
      return mk(
        'present',
        sum.path,
        false,
        'unknown',
        'go.sum present; verified by go at download',
        sum,
      );
    return mk('absent', null, false, 'infeasible', 'go.mod has requirements and no go.sum');
  }

  // Own directory first, then each ancestor (workspaces keep one lockfile at the root).
  for (const dir of ancestry(m.dir)) {
    for (const lock of LOCKFILES[m.ecosystem]) {
      if (m.ecosystem === 'python' && lock === 'Pipfile.lock' && name !== 'Pipfile') continue;
      const f = reader.get(join(dir, lock));
      if (!f) continue;
      const inherited = dir !== m.dir;
      if (
        m.ecosystem === 'npm' &&
        !inherited &&
        (lock === 'package-lock.json' || lock === 'npm-shrinkwrap.json')
      )
        return npmConsistency(c, m, f);
      return mk(
        'present',
        f.path,
        inherited,
        'unknown',
        `${inherited ? 'workspace-root ' : ''}lockfile present; not compared with the manifest here (frozen install: ${FROZEN[lock] ?? 'see the package manager'})`,
        f,
      );
    }
  }
  return mk(
    'absent',
    null,
    false,
    'infeasible',
    'no lockfile beside the manifest or in a parent directory',
  );
}

/** `npm ci` fails when package.json and the lockfile disagree: compare the root's dependency tables. */
async function npmConsistency(c: Collector, m: Manifest, lock: TreeFile): Promise<Fact> {
  const mk = (frozen: 'feasible' | 'infeasible' | 'unknown', reason: string): Fact => ({
    kind: 'lockfile',
    detector: 'lockfiles',
    manifest: m.file.path,
    ecosystem: 'npm',
    state: 'present',
    lockfile: lock.path,
    inherited: false,
    frozen_install: frozen,
    reason,
    evidence: [c.evidence(lock)],
  });
  const pkg = await c.text(m.file.path, LOCK_LIMIT);
  const lk = await c.text(lock.path, LOCK_LIMIT);
  if (!pkg || !lk) return mk('unknown', 'a file could not be read: not compared');
  const p = parseJson(pkg.text, LOCK_LIMIT);
  if (!p.ok) {
    c.unparseable(pkg.file, p.why);
    return mk('unknown', 'package.json could not be parsed');
  }
  const l = parseJson(lk.text, LOCK_LIMIT);
  if (!l.ok) {
    c.unparseable(lk.file, l.why);
    return mk('unknown', 'the lockfile could not be parsed');
  }
  const root = (
    (l.value as Record<string, unknown> | null)?.['packages'] as Record<string, unknown> | undefined
  )?.[''] as Record<string, unknown> | undefined;
  if (!root)
    return mk('unknown', 'lockfile format without a root entry (lockfileVersion 1): not compared');
  const want = p.value as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const a = depMap(want[field]);
    const b = depMap(root[field]);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys)
      if (a[k] !== b[k])
        return mk(
          'infeasible',
          `package-lock.json disagrees with package.json (${field}): npm ci would fail`,
        );
  }
  return mk('feasible', 'package-lock.json agrees with package.json: npm ci works');
}

// Used by the stack detector's package-manager guess and the task contract's default `setup`.
export { LOCKFILES };
