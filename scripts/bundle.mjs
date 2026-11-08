// Bundles the entrypoints of one workspace into dist/, run from that workspace's directory:
//   node ../../scripts/bundle.mjs main            -> src/main.ts            -> dist/main.js
//   node ../../scripts/bundle.mjs verify-ledger demo-writer
//
// One self-contained ESM file per entrypoint, so `node dist/<name>.js` works with no TypeScript
// loader and no workspace symlinks. Workspace packages (which export TypeScript source) and
// third-party dependencies are all bundled, so a deployed `dist/` needs only Node 22 and the
// workspace's own non-code files (migrations/, which are found relative to dist/ as `../migrations`).
//
// Why third-party code is bundled rather than left external: the artefact is then the same bytes
// that ran in CI, with no dependency resolution at start-up, and nothing but `dist/` and
// `migrations/` has to be shipped. The one exception is `pg-native`: `pg` loads it lazily and
// only when `pg.native` is touched, which nothing here does, and it is an optional native addon.
// It stays external, so a missing addon can never break the build or the start, and a require of
// it would fail loudly at run time instead of silently bundling a broken stub.
import { build } from 'esbuild';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('usage: bundle.mjs <entry-name>...   (src/<name>.ts -> dist/<name>.js)');
  process.exit(2);
}

const cwd = process.cwd();
const outdir = join(cwd, 'dist');
rmSync(outdir, { recursive: true, force: true });

await build({
  absWorkingDir: cwd,
  entryPoints: Object.fromEntries(names.map((n) => [n, join('src', `${n}.ts`)])),
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  sourcesContent: false,
  external: ['pg-native'],
  // Bundled CommonJS dependencies (fastify, pg) call require() on Node built-ins; an ESM bundle
  // has no require, so give it one.
  banner: {
    js: "import { createRequire as __aisdlcCreateRequire } from 'node:module';\nconst require = __aisdlcCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

for (const n of names) chmodSync(join(outdir, `${n}.js`), 0o755);
