// `npm run check`: the workspace dependency check, then typecheck, lint and format:check side by
// side (their output is held and printed whole, one step after the other), then the tests. A failing
// static step stops the run before the tests start.
//
// `npm run check:changed [-- <base>]`: the same steps over what changed against <base> (default
// origin/main, else main; or $CHECK_BASE), counting commits since the merge base, staged, unstaged
// and untracked files. The Vitest projects run are the workspaces that changed plus every workspace
// that depends on them (the workspace graph of the package.json files, transitively), plus the
// projects that read the whole tree (secrets-rules' self-test, evals' import-graph walk), plus
// migrate and gateway when a migration changed. A change outside packages/* and services/* (root
// config, scripts/, platform/, docs/, the lockfile) runs every project. Typecheck runs the same
// workspaces; lint and format:check run over the whole tree (both are cached, so that is quick).
// It is a fast first pass while working: `npm run check` is still what must pass before a commit.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const changed = args.includes('--changed');
const baseArg = args.find((a) => !a.startsWith('--'));

function run(label, cmd, cmdArgs, { buffer }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: root,
      stdio: buffer ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      // Held output is piped: keep its colours when it is printed to a terminal.
      env:
        buffer && process.stdout.isTTY && process.env['FORCE_COLOR'] === undefined
          ? { ...process.env, FORCE_COLOR: '1' }
          : process.env,
    });
    let out = '';
    if (buffer) {
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (out += b));
    }
    child.on('close', (code, signal) => {
      const ok = code === 0 && signal === null;
      resolve({ label, ok, out, secs: ((Date.now() - started) / 1000).toFixed(1) });
    });
  });
}

function git(...a) {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
}

function workspaces() {
  return ['packages', 'services'].flatMap((d) =>
    readdirSync(join(root, d), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, d, e.name, 'package.json')))
      .map((e) => {
        const dir = join(d, e.name);
        const json = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
        const deps = Object.keys({
          ...json.dependencies,
          ...json.devDependencies,
          ...json.peerDependencies,
        });
        return {
          dir,
          name: json.name,
          deps,
          vitest: existsSync(join(root, dir, 'vitest.config.ts')),
        };
      }),
  );
}

/** Vitest project name of a workspace: the `name` in its vitest.config.ts. */
function projectOf(w) {
  const m = /\bname:\s*'([^']+)'/.exec(readFileSync(join(root, w.dir, 'vitest.config.ts'), 'utf8'));
  return m ? m[1] : null;
}

/** The selection for --changed: `null` means everything. */
function selection() {
  const candidates = [baseArg, process.env['CHECK_BASE'], 'origin/main', 'main'].filter(Boolean);
  const base = candidates.find((ref) => {
    try {
      git('rev-parse', '--verify', '-q', `${ref}^{commit}`);
      return true;
    } catch {
      return false;
    }
  });
  if (!base) {
    console.error(`check:changed: none of ${candidates.join(', ')} is a commit; pass a base ref`);
    process.exit(2);
  }
  const mergeBase = git('merge-base', base, 'HEAD');
  const files = new Set(
    [git('diff', '--name-only', mergeBase), git('ls-files', '--others', '--exclude-standard')]
      .join('\n')
      .split('\n')
      .filter(Boolean),
  );
  console.log(
    `check:changed: ${files.size} changed files against ${base} (${mergeBase.slice(0, 12)})`,
  );
  if (files.size === 0) return { files, workspaces: [] };
  const all = workspaces();
  const byDir = new Map(all.map((w) => [w.dir.split(sep).join('/'), w]));
  const hit = new Set();
  for (const f of files) {
    const dir = f.split('/').slice(0, 2).join('/');
    const w = byDir.get(dir);
    if (!w) {
      console.log(`check:changed: ${f} is outside the workspaces: everything runs`);
      return null;
    }
    hit.add(w.name);
  }
  // Dependents, transitively.
  for (let grew = true; grew;) {
    grew = false;
    for (const w of all) {
      if (!hit.has(w.name) && w.deps.some((d) => hit.has(d))) {
        hit.add(w.name);
        grew = true;
      }
    }
  }
  hit.add('@aisdlc/secrets-rules');
  hit.add('@aisdlc/evals');
  if ([...files].some((f) => f.includes('/migrations/'))) {
    hit.add('@aisdlc/migrate');
    hit.add('@aisdlc/gateway');
  }
  return { files, workspaces: all.filter((w) => hit.has(w.name)) };
}

const started = Date.now();
const sel = changed ? selection() : null;

const deps = await run('workspace deps', process.execPath, ['scripts/check-workspace-deps.mjs'], {
  buffer: true,
});
process.stdout.write(deps.out);
if (!deps.ok) process.exit(1);

const typecheckArgs = sel ? sel.workspaces.map((w) => w.name) : [];
if (sel && sel.workspaces.length === 0) {
  console.log('check:changed: nothing changed');
  process.exit(0);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const statics = await Promise.all([
  run('typecheck', process.execPath, ['scripts/typecheck.mjs', ...typecheckArgs], { buffer: true }),
  run('lint', npm, ['run', '--silent', 'lint'], { buffer: true }),
  run('format:check', npm, ['run', '--silent', 'format:check'], { buffer: true }),
]);
for (const r of statics) {
  console.log(`\n── ${r.label}: ${r.ok ? 'ok' : 'FAILED'} (${r.secs}s)`);
  if (r.out.trim()) process.stdout.write(r.out.endsWith('\n') ? r.out : `${r.out}\n`);
}
if (statics.some((r) => !r.ok)) {
  console.error(
    `\ncheck: ${statics
      .filter((r) => !r.ok)
      .map((r) => r.label)
      .join(', ')} failed; tests not run`,
  );
  process.exit(1);
}

const projects = sel
  ? sel.workspaces
      .filter((w) => w.vitest)
      .map(projectOf)
      .filter((p) => p !== null)
  : [];
if (sel) console.log(`\n── test: projects ${projects.join(', ')}`);
else console.log('\n── test');
const test = await run(
  'test',
  npm,
  [
    'run',
    'test',
    ...(projects.length > 0 ? ['--', ...projects.flatMap((p) => ['--project', p])] : []),
  ],
  { buffer: false },
);
const secs = ((Date.now() - started) / 1000).toFixed(1);
if (!test.ok) {
  console.error(`\ncheck: tests failed (${secs}s)`);
  process.exit(1);
}
console.log(`\ncheck: ok (${secs}s${sel ? `, ${projects.length} projects` : ''})`);
