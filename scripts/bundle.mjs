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
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('usage: bundle.mjs <entry-name>...   (src/<name>.ts -> dist/<name>.js)');
  process.exit(2);
}

const cwd = process.cwd();
const outdir = join(cwd, 'dist');
rmSync(outdir, { recursive: true, force: true });

// The Cedar WebAssembly build (`@cedar-policy/cedar-wasm/nodejs`, used by `@aisdlc/pdp`) is a
// CommonJS file that finds its `.wasm` with `__dirname`, which an ESM bundle does not have. The one
// way it is bundled: those two lines are rewritten to read `cedar_wasm_bg.wasm` from next to the
// bundle (`__aisdlcDir`, defined in the banner; `import.meta` cannot appear in the CommonJS file or
// esbuild would stop treating it as CommonJS), and the asset is copied into `dist/`, so a deployed `dist/` stays
// self-contained (Node 22, `dist/*.js`, `dist/cedar_wasm_bg.wasm`, `migrations/`). The build fails
// if Cedar's loader no longer looks like this, so an upgrade is looked at, never guessed.
const CEDAR_LOADER =
  /const wasmPath = `\$\{__dirname\}\/cedar_wasm_bg\.wasm`;\s*const wasmBytes = require\('fs'\)\.readFileSync\(wasmPath\);/;
const cedarWasmAsset = {
  name: 'cedar-wasm-asset',
  setup(b) {
    b.onLoad({ filter: /cedar-wasm[\\/]nodejs[\\/]cedar_wasm\.js$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      if (!CEDAR_LOADER.test(src)) {
        throw new Error(
          `${args.path}: the wasm loader is not the one scripts/bundle.mjs knows how to rewrite`,
        );
      }
      mkdirSync(outdir, { recursive: true });
      copyFileSync(
        join(dirname(args.path), 'cedar_wasm_bg.wasm'),
        join(outdir, 'cedar_wasm_bg.wasm'),
      );
      return {
        contents: src.replace(
          CEDAR_LOADER,
          "const wasmBytes = require('fs').readFileSync(require('path').join(__aisdlcDir, 'cedar_wasm_bg.wasm'));",
        ),
        loader: 'js',
      };
    });
  },
};

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
  plugins: [cedarWasmAsset],
  // Bundled CommonJS dependencies (fastify, pg) call require() on Node built-ins; an ESM bundle
  // has no require, so give it one.
  banner: {
    js: [
      "import { createRequire as __aisdlcCreateRequire } from 'node:module';",
      "import { dirname as __aisdlcDirname } from 'node:path';",
      "import { fileURLToPath as __aisdlcFileURLToPath } from 'node:url';",
      'const require = __aisdlcCreateRequire(import.meta.url);',
      'const __aisdlcDir = __aisdlcDirname(__aisdlcFileURLToPath(import.meta.url));',
    ].join('\n'),
  },
  logLevel: 'warning',
});

for (const n of names) chmodSync(join(outdir, `${n}.js`), 0o755);
