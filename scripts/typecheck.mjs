// Typechecks every workspace (or the ones named), checking exactly what each workspace's own
// `typecheck` script (`tsc -p tsconfig.check.json`) checks, in far less time:
//
// 1. Workspaces whose tsconfig.check.json is the same text (so, at the same depth, the same compiler
//    options) are checked as ONE program over the union of their `include`s. Packages export
//    TypeScript source, so each workspace's own program re-checks the source of every workspace it
//    imports: 36 programs re-checked contracts and kernel 36 times. One program checks each file once,
//    under the same options; the set of files is the union of the per-workspace programs (every file
//    any of them would check is a root or is imported by one). What one program could change is
//    visibility: a global or a module augmentation one workspace declares is seen by all. So a
//    workspace with a `.d.ts` file, `declare global`, `declare module` or a `/// <reference` in its
//    `include` is checked alone, and when one of those is in a workspace's `src` (which other
//    workspaces can import) nothing is grouped at all. All workspaces are ESM (`"type": "module"`),
//    so no file is a global script.
// 2. The programs run in parallel (one per CPU by default).
// 3. Each `tsc` gets `--incremental` with its build info under node_modules/.cache/tsc/, so a run on
//    an unchanged tree only re-reads files (tsc re-checks what changed and every file that depends on it).
//
//   node scripts/typecheck.mjs                    every workspace
//   node scripts/typecheck.mjs @aisdlc/core ...   only these (by package name)
//   TYPECHECK_GROUP=0        one program per workspace, as `npm run typecheck --workspaces` does
//   TYPECHECK_INCREMENTAL=0  no build info (a cold check)
//   TYPECHECK_JOBS=2         at most 2 programs at a time
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const only = new Set(process.argv.slice(2));
const jobs = Math.max(1, Number(process.env['TYPECHECK_JOBS'] ?? availableParallelism()));
const incremental = process.env['TYPECHECK_INCREMENTAL'] !== '0';
let grouping = process.env['TYPECHECK_GROUP'] !== '0';
const cacheDir = join(root, 'node_modules', '.cache', 'tsc');
const tscBin = join(root, 'node_modules', '.bin', 'tsc');

const workspaces = ['packages', 'services']
  .flatMap((d) =>
    readdirSync(join(root, d), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, d, e.name, 'package.json')))
      .map((e) => join(root, d, e.name)),
  )
  .map((dir) => ({ dir, json: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
  .filter((w) => typeof w.json.scripts?.typecheck === 'string')
  .filter((w) => only.size === 0 || only.has(w.json.name));

for (const name of only) {
  if (!workspaces.some((w) => w.json.name === name)) {
    console.error(`typecheck: no workspace ${name} with a typecheck script`);
    process.exit(2);
  }
}
mkdirSync(cacheDir, { recursive: true });

const GLOBAL_DECL = /declare\s+global\b|declare\s+module\b|\/\/\/\s*<reference\b/;

/** Files under `dir` (recursively, no node_modules or dist) that could widen what another file sees. */
function widening(dir) {
  const hits = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    if (!statSync(d).isDirectory()) {
      if (
        /\.d\.[cm]?ts$/.test(d) ||
        (/\.[cm]?tsx?$/.test(d) && GLOBAL_DECL.test(readFileSync(d, 'utf8')))
      )
        hits.push(d);
      return;
    }
    for (const e of readdirSync(d)) if (e !== 'node_modules' && e !== 'dist') walk(join(d, e));
  };
  walk(dir);
  return hits;
}

/** How a workspace can join a group: its config's text and `include`, or `null` (it runs alone). */
function groupable(w) {
  const m = /^tsc -p (\S+)$/.exec(w.json.scripts.typecheck.trim());
  if (!m) return null;
  const file = join(w.dir, m[1]);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return null; // comments or trailing commas: not worth parsing here, it runs alone
  }
  const keys = Object.keys(cfg).sort().join(',');
  if (keys !== 'compilerOptions,extends,include' || !Array.isArray(cfg.include)) return null;
  if (cfg.include.some((p) => typeof p !== 'string' || /[*?]/.test(p) || p.startsWith('..')))
    return null;
  const hits = cfg.include.flatMap((p) => widening(join(w.dir, p)));
  if (hits.length > 0) {
    if (hits.some((h) => relative(w.dir, h).startsWith(`src${'/'}`))) {
      grouping = false;
      console.log(`typecheck: ${relative(root, hits[0])} declares globals in a src/: no grouping`);
    }
    return null;
  }
  // Same text at the same depth below the root: the same `extends`, so the same options.
  const key = `${relative(root, dirname(file)).split(/[\\/]/).length}:${m[1]}:${text}`;
  return { key, file, include: cfg.include.map((p) => join(w.dir, p)) };
}

const slug = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const info = (id) =>
  incremental
    ? ['--incremental', '--tsBuildInfoFile', join(cacheDir, `${slug(id)}.tsbuildinfo`)]
    : [];

const tasks = [];
const groups = new Map();
for (const w of workspaces) {
  const g = groupable(w);
  if (g === null) {
    tasks.push({ label: w.json.name, w, members: [w] });
    continue;
  }
  const list = groups.get(g.key) ?? [];
  list.push({ w, g });
  groups.set(g.key, list);
}
for (const list of groups.values()) {
  if (!grouping || list.length === 1) {
    for (const { w } of list) tasks.push({ label: w.json.name, w, members: [w] });
    continue;
  }
  const names = list.map(({ w }) => w.json.name).sort();
  const config = join(cacheDir, `group-${slug(names.join(','))}.json`);
  const rel = (p) => relative(cacheDir, p).split('\\').join('/');
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        extends: rel(list[0].g.file),
        compilerOptions: { rootDir: rel(root) },
        include: list.flatMap(({ g }) => g.include.map(rel)),
      },
      null,
      2,
    )}\n`,
  );
  tasks.push({
    label: `${names.length} workspaces (${names.map((n) => n.replace('@aisdlc/', '')).join(', ')})`,
    members: list.map(({ w }) => w),
    command: [tscBin, '-p', config, ...info(`group:${names.join(',')}`)],
    cwd: root,
  });
}

function commandOf(t) {
  if (t.command) return { cmd: t.command.map((a) => JSON.stringify(a)).join(' '), cwd: t.cwd };
  const script = t.w.json.scripts.typecheck;
  const extra = /^tsc\s/.test(script) ? info(`ws:${t.w.json.name}`) : [];
  return { cmd: [script, ...extra.map((a) => JSON.stringify(a))].join(' '), cwd: t.w.dir };
}

function run(t) {
  const started = Date.now();
  const { cmd, cwd } = commandOf(t);
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        PATH: [
          join(cwd, 'node_modules', '.bin'),
          join(root, 'node_modules', '.bin'),
          process.env['PATH'],
        ].join(delimiter),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('close', (code, signal) => {
      const ok = code === 0 && signal === null;
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${t.label} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      );
      if (!ok || out.trim()) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
      resolve(ok);
    });
  });
}

// Biggest first, so the slowest program is not the last to start.
const queue = [...tasks].sort((a, b) => b.members.length - a.members.length);
const started = Date.now();
let failed = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) if (!(await run(t))) failed += 1;
  }),
);
const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failed > 0) {
  console.error(`typecheck: ${failed} of ${tasks.length} programs failed (${secs}s)`);
  process.exit(1);
}
console.log(
  `typecheck: ${workspaces.length} workspaces in ${tasks.length} programs ok (${secs}s, ${jobs} at a time)`,
);
