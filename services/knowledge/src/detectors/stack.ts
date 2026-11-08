import type { Fact, StackCategory } from '@aisdlc/contracts';
import { findManifests, join, MAX_MANIFESTS, type Manifest } from './paths.js';
import { parseJson, parseTomlSafe } from './safe-parse.js';
import { Collector, basename, lineOfText, type Detector, type TreeReader } from './types.js';

// Stack detector (PLAN M6.3): languages, frameworks and package managers from manifests. Reads
// manifests only through safe parsers (JSON, TOML) or a name scan (pom.xml, Gemfile, Gradle). It
// reports names; it never runs a package manager and never resolves anything.

const NPM_FRAMEWORKS: Record<string, string> = {
  react: 'react',
  next: 'next.js',
  vue: 'vue',
  nuxt: 'nuxt',
  svelte: 'svelte',
  '@sveltejs/kit': 'sveltekit',
  '@angular/core': 'angular',
  express: 'express',
  fastify: 'fastify',
  koa: 'koa',
  hono: 'hono',
  '@nestjs/core': 'nestjs',
  '@remix-run/react': 'remix',
  astro: 'astro',
  electron: 'electron',
  'react-native': 'react-native',
  vite: 'vite',
};
const PY_FRAMEWORKS: Record<string, string> = {
  django: 'django',
  flask: 'flask',
  fastapi: 'fastapi',
  starlette: 'starlette',
  tornado: 'tornado',
  aiohttp: 'aiohttp',
  celery: 'celery',
  pytorch: 'pytorch',
  torch: 'pytorch',
  tensorflow: 'tensorflow',
};
const GO_FRAMEWORKS: Array<[RegExp, string]> = [
  [/github\.com\/gin-gonic\/gin\b/, 'gin'],
  [/github\.com\/labstack\/echo\b/, 'echo'],
  [/github\.com\/gofiber\/fiber\b/, 'fiber'],
  [/github\.com\/go-chi\/chi\b/, 'chi'],
  [/github\.com\/gorilla\/mux\b/, 'gorilla-mux'],
  [/google\.golang\.org\/grpc\b/, 'grpc'],
];
const RUST_FRAMEWORKS = ['actix-web', 'axum', 'rocket', 'tokio', 'warp'];
const TEXT_FRAMEWORKS: Array<[RegExp, string, 'maven' | 'gradle' | 'ruby' | 'php']> = [
  [/spring-boot/i, 'spring-boot', 'maven'],
  [/quarkus/i, 'quarkus', 'maven'],
  [/micronaut/i, 'micronaut', 'maven'],
  [/org\.springframework\.boot|spring-boot/i, 'spring-boot', 'gradle'],
  [/io\.quarkus/i, 'quarkus', 'gradle'],
  [/io\.micronaut/i, 'micronaut', 'gradle'],
  [/['"]rails['"]/i, 'rails', 'ruby'],
  [/['"]sinatra['"]/i, 'sinatra', 'ruby'],
  [/laravel\/framework/i, 'laravel', 'php'],
  [/symfony\//i, 'symfony', 'php'],
];

const depNames = (obj: unknown): string[] =>
  obj !== null && typeof obj === 'object' ? Object.keys(obj as Record<string, unknown>) : [];

export function stackDetector(): Detector {
  return {
    info: { id: 'stack', version: '1', criteria: ['RS-BT-1', 'RS-BT-4'] },
    async run(reader: TreeReader) {
      const c = new Collector('stack', reader);
      const seen = new Map<string, Fact>();
      const add = (
        category: StackCategory,
        name: string,
        file: { path: string; blob: string },
        line = 1,
      ): void => {
        const key = `${category}\0${name}`;
        const ev = { path: file.path, blob: file.blob as never, line };
        const prior = seen.get(key);
        if (prior) {
          if (prior.evidence.length < 3 && !prior.evidence.some((e) => e.path === file.path))
            prior.evidence.push(ev);
          return;
        }
        const f: Fact = { kind: 'stack', detector: 'stack', category, name, evidence: [ev] };
        seen.set(key, f);
        c.add(f);
      };

      const { manifests, capped } = findManifests(reader);
      if (capped) c.capped('manifests', MAX_MANIFESTS);
      for (const m of manifests) {
        add('manifest', basename(m.file.path), m.file);
        await detectOne(reader, c, m, add);
      }
      return c.output();
    },
  };
}

type Add = (
  category: StackCategory,
  name: string,
  file: { path: string; blob: string },
  line?: number,
) => void;

async function detectOne(reader: TreeReader, c: Collector, m: Manifest, add: Add): Promise<void> {
  const name = basename(m.file.path);
  const got = await c.text(m.file.path, 4 * 1024 * 1024);
  if (!got) return;
  const { file, text } = got;
  switch (m.ecosystem) {
    case 'npm': {
      add('language', 'javascript', file);
      const p = parseJson(text);
      if (!p.ok) return c.unparseable(file, p.why);
      const pkg = (p.value ?? {}) as Record<string, unknown>;
      const deps = new Set([
        ...depNames(pkg['dependencies']),
        ...depNames(pkg['devDependencies']),
        ...depNames(pkg['peerDependencies']),
      ]);
      if (deps.has('typescript') || reader.get(join(m.dir, 'tsconfig.json')))
        add('language', 'typescript', file);
      for (const [dep, fw] of Object.entries(NPM_FRAMEWORKS))
        if (deps.has(dep)) add('framework', fw, file, lineOfText(text, `"${dep}"`));
      const pm = typeof pkg['packageManager'] === 'string' ? pkg['packageManager'] : '';
      const fromField = /^(npm|yarn|pnpm|bun)@/.exec(pm)?.[1];
      if (fromField) add('package_manager', fromField, file, lineOfText(text, '"packageManager"'));
      else if (reader.get(join(m.dir, 'pnpm-lock.yaml'))) add('package_manager', 'pnpm', file);
      else if (reader.get(join(m.dir, 'yarn.lock'))) add('package_manager', 'yarn', file);
      else if (reader.get(join(m.dir, 'bun.lock')) || reader.get(join(m.dir, 'bun.lockb')))
        add('package_manager', 'bun', file);
      else add('package_manager', 'npm', file);
      return;
    }
    case 'python': {
      add('language', 'python', file);
      if (name === 'pyproject.toml') {
        const t = parseTomlSafe(text);
        if (!t.ok) return c.unparseable(file, t.why);
        const proj = (t.value['project'] ?? {}) as Record<string, unknown>;
        const tool = (t.value['tool'] ?? {}) as Record<string, unknown>;
        const deps = [
          ...(Array.isArray(proj['dependencies']) ? (proj['dependencies'] as unknown[]) : []),
          ...depNames(((tool['poetry'] ?? {}) as Record<string, unknown>)['dependencies']),
        ].map(
          (d) =>
            String(d)
              .toLowerCase()
              .split(/[\s<>=!~;[(]/)[0] ?? '',
        );
        for (const d of deps) {
          const fw = PY_FRAMEWORKS[d];
          if (fw) add('framework', fw, file);
        }
        if ('poetry' in tool) add('package_manager', 'poetry', file);
        else if ('uv' in tool) add('package_manager', 'uv', file);
        else if ('pdm' in tool) add('package_manager', 'pdm', file);
        else if ('hatch' in tool) add('package_manager', 'hatch', file);
        else add('package_manager', 'pip', file);
      } else {
        if (name === 'Pipfile') add('package_manager', 'pipenv', file);
        else add('package_manager', 'pip', file);
        for (const line of text.split('\n')) {
          const dep =
            line
              .trim()
              .toLowerCase()
              .split(/[\s<>=!~;[(#]/)[0] ?? '';
          const fw = PY_FRAMEWORKS[dep];
          if (fw) add('framework', fw, file, lineOfText(text, line));
        }
      }
      return;
    }
    case 'go':
      add('language', 'go', file);
      add('package_manager', 'go modules', file);
      for (const [re, fw] of GO_FRAMEWORKS) if (re.test(text)) add('framework', fw, file);
      return;
    case 'rust': {
      add('language', 'rust', file);
      add('package_manager', 'cargo', file);
      const t = parseTomlSafe(text);
      if (!t.ok) return c.unparseable(file, t.why);
      const deps = new Set([
        ...depNames(t.value['dependencies']),
        ...depNames(t.value['dev-dependencies']),
      ]);
      for (const fw of RUST_FRAMEWORKS) if (deps.has(fw)) add('framework', fw, file);
      return;
    }
    case 'maven':
    case 'gradle':
    case 'ruby':
    case 'php': {
      const lang = {
        maven: 'java',
        gradle: name.endsWith('.kts') ? 'kotlin' : 'java',
        ruby: 'ruby',
        php: 'php',
      }[m.ecosystem];
      add('language', lang, file);
      add(
        'package_manager',
        { maven: 'maven', gradle: 'gradle', ruby: 'bundler', php: 'composer' }[m.ecosystem],
        file,
      );
      const body = m.ecosystem === 'php' ? phpRequires(text) : text;
      for (const [re, fw, eco] of TEXT_FRAMEWORKS)
        if (eco === m.ecosystem && re.test(body)) add('framework', fw, file);
      return;
    }
  }
}

/** composer.json: only the `require` and `require-dev` names, as text for the framework patterns. */
function phpRequires(text: string): string {
  const p = parseJson(text);
  if (!p.ok || p.value === null || typeof p.value !== 'object') return '';
  const o = p.value as Record<string, unknown>;
  return [...depNames(o['require']), ...depNames(o['require-dev'])].join('\n');
}
