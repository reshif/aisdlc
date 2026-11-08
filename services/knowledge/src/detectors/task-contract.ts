import { TASK_CONTRACT_NAMES, type Fact, type TaskContractName } from '@aisdlc/contracts';
import { parseJson, parseTomlSafe } from './safe-parse.js';
import { Collector, lineOfText, type Detector, type TreeFile, type TreeReader } from './types.js';

// Task-contract detector (PLAN M6.3; OB §3.3): maps `setup build test test-fast lint format-check
// typecheck check` onto the repo's own runner and reports found or missing for each. It reads
// NAMES only: package.json script names, Makefile and justfile target names, tox and nox session
// names, pyproject task tables. It never reads a script body into a fact and never runs anything.

/** Spellings of each name, normalised (lower case, `: _ .` become `-`). The exact name always wins. */
const ALIASES: Record<TaskContractName, readonly string[]> = {
  setup: ['setup', 'bootstrap', 'install-deps', 'deps', 'init'],
  build: ['build', 'compile'],
  test: ['test', 'tests', 'unit', 'test-unit', 'pytest'],
  'test-fast': [
    'test-fast',
    'fast-test',
    'test-quick',
    'quick-test',
    'tests-fast',
    'test-unit-fast',
  ],
  lint: ['lint', 'linter', 'eslint', 'lint-check', 'ruff', 'flake8', 'pylint'],
  'format-check': [
    'format-check',
    'check-format',
    'fmt-check',
    'check-fmt',
    'format-verify',
    'prettier-check',
    'black-check',
    'style-check',
  ],
  typecheck: ['typecheck', 'type-check', 'check-types', 'types', 'tsc', 'mypy', 'pyright'],
  check: ['check', 'ci', 'verify', 'validate', 'all'],
};

const norm = (s: string): string => s.toLowerCase().replace(/[:_.]/g, '-');

/** The task-contract name a runner entry stands for, or null. Exact normalised name first, then aliases. */
export function taskNameFor(entry: string): TaskContractName | null {
  const n = norm(entry);
  for (const t of TASK_CONTRACT_NAMES) if (n === t) return t;
  for (const t of TASK_CONTRACT_NAMES) if (ALIASES[t].includes(n)) return t;
  return null;
}

interface Found {
  readonly runner: string;
  readonly invocation: string;
  readonly source: string;
  readonly file: TreeFile;
  readonly line: number;
  /** Exact spelling of a task-contract name beats an alias. */
  readonly exact: boolean;
}

/** Makefile target names only (`name:` at column 0, not `:=`, not a variable, not a special `.` target). */
export function makeTargets(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (l.startsWith('\t') || l.startsWith(' ') || l.startsWith('#')) return;
    const m = /^([A-Za-z0-9_][A-Za-z0-9_./ -]*?)\s*:(?![=:])(?!.*[=]\s*$)/.exec(l);
    if (!m) return;
    // `a b c: deps`: several targets share a rule. A `%` pattern or `$(var)` target is not a name.
    for (const name of (m[1] as string).split(/\s+/))
      if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) out.push({ name, line: i + 1 });
  });
  return out;
}

/** justfile recipe names (`name args:` at column 0; `name := value` and `set`, `alias` are not recipes). */
export function justRecipes(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^[ \t#]/.test(l) || l === '') return;
    if (/^(?:set|alias|import|mod|export)\b/.test(l)) return;
    const m = /^@?([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:]*?)?:(?!=)/.exec(l);
    if (m) out.push({ name: m[1] as string, line: i + 1 });
  });
  return out;
}

/** `[testenv:name]` sections of tox.ini, and the names in `envlist`. */
export function toxEnvs(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = /^\[testenv:([A-Za-z0-9_.-]+)\]/.exec(l);
    if (m) out.push({ name: m[1] as string, line: i + 1 });
  });
  return out;
}

/** noxfile.py session names: `def name(session` after an `@nox.session` decorator, or `name="..."` in it. Text scan only. */
export function noxSessions(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*@nox\.session\b/.test(lines[i] as string)) continue;
    const named = /name\s*=\s*["']([A-Za-z0-9_.-]+)["']/.exec(lines[i] as string);
    for (let j = i; j < Math.min(lines.length, i + 8); j++) {
      const d = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*session\b/.exec(lines[j] as string);
      if (d) {
        out.push({ name: named ? (named[1] as string) : (d[1] as string), line: j + 1 });
        break;
      }
    }
  }
  return out;
}

const MAKEFILES = ['Makefile', 'makefile', 'GNUmakefile'];
const JUSTFILES = ['justfile', 'Justfile', '.justfile'];

export function taskContractDetector(): Detector {
  return {
    info: { id: 'task_contract', version: '1', criteria: ['RS-BT-1', 'RS-BT-2', 'RS-BT-7'] },
    async run(reader: TreeReader) {
      const c = new Collector('task_contract', reader);
      const found = new Map<TaskContractName, Found>();
      const offer = (name: TaskContractName, f: Found): void => {
        const prior = found.get(name);
        if (!prior || (!prior.exact && f.exact)) found.set(name, f);
      };
      const offerEntry = (
        entry: string,
        runner: string,
        invocation: (e: string) => string,
        source: string,
        file: TreeFile,
        line: number,
      ): void => {
        const name = taskNameFor(entry);
        if (name)
          offer(name, {
            runner,
            invocation: invocation(entry),
            source,
            file,
            line,
            exact: norm(entry) === name,
          });
      };

      // package.json scripts at the root (the runner an agent would use from the repo root).
      const pkg = await c.text('package.json', 4 * 1024 * 1024);
      let pm = 'npm';
      if (pkg) {
        const p = parseJson(pkg.text);
        if (!p.ok) c.unparseable(pkg.file, p.why);
        else if (p.value !== null && typeof p.value === 'object') {
          const o = p.value as Record<string, unknown>;
          const field = typeof o['packageManager'] === 'string' ? o['packageManager'] : '';
          pm =
            /^(npm|yarn|pnpm|bun)@/.exec(field)?.[1] ??
            (reader.get('pnpm-lock.yaml')
              ? 'pnpm'
              : reader.get('yarn.lock')
                ? 'yarn'
                : reader.get('bun.lock')
                  ? 'bun'
                  : 'npm');
          const scripts = o['scripts'];
          if (scripts !== null && typeof scripts === 'object') {
            const npmScripts = Object.keys(scripts as Record<string, unknown>);
            const base = pkg.text.indexOf('"scripts"');
            for (const s of npmScripts) {
              const at = base === -1 ? -1 : pkg.text.indexOf(`"${s}"`, base);
              const line = at === -1 ? 1 : pkg.text.slice(0, at).split('\n').length;
              offerEntry(
                s,
                pm,
                (e) => (e === 'test' && pm !== 'npm' ? `${pm} test` : `${pm} run ${e}`),
                'package.json#scripts',
                pkg.file,
                line,
              );
            }
          }
        }
      }
      // Package-manager default for `setup`: the frozen install, when a lockfile makes it possible.
      if (pkg && !found.has('setup')) {
        const frozen: Record<string, [string, string]> = {
          npm: ['package-lock.json', 'npm ci'],
          yarn: ['yarn.lock', 'yarn install --frozen-lockfile'],
          pnpm: ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
          bun: ['bun.lock', 'bun install --frozen-lockfile'],
        };
        const [lock, cmd] = frozen[pm] ?? frozen['npm']!;
        if (reader.get(lock))
          offer('setup', {
            runner: pm,
            invocation: cmd,
            source: `default:${lock}`,
            file: pkg.file,
            line: 1,
            exact: false,
          });
      }

      for (const name of MAKEFILES) {
        const t = reader.get(name) ? await c.text(name, 1024 * 1024) : null;
        if (!t) continue;
        for (const x of makeTargets(t.text))
          offerEntry(x.name, 'make', (e) => `make ${e}`, name, t.file, x.line);
        break;
      }
      for (const name of JUSTFILES) {
        const t = reader.get(name) ? await c.text(name, 1024 * 1024) : null;
        if (!t) continue;
        for (const x of justRecipes(t.text))
          offerEntry(x.name, 'just', (e) => `just ${e}`, name, t.file, x.line);
        break;
      }

      const py = await c.text('pyproject.toml');
      if (py) {
        const t = parseTomlSafe(py.text);
        if (!t.ok) c.unparseable(py.file, t.why);
        else {
          const tool = (t.value['tool'] ?? {}) as Record<string, unknown>;
          const table = (v: unknown): string[] =>
            v !== null && typeof v === 'object' && !Array.isArray(v)
              ? Object.keys(v as object)
              : [];
          const sets: Array<[string[], string, (e: string) => string, string]> = [
            [
              table((tool['pdm'] as Record<string, unknown> | undefined)?.['scripts']),
              'pdm',
              (e) => `pdm run ${e}`,
              'pyproject.toml#tool.pdm.scripts',
            ],
            [
              table((tool['poe'] as Record<string, unknown> | undefined)?.['tasks']),
              'poe',
              (e) => `poe ${e}`,
              'pyproject.toml#tool.poe.tasks',
            ],
            [
              table((tool['taskipy'] as Record<string, unknown> | undefined)?.['tasks']),
              'taskipy',
              (e) => `task ${e}`,
              'pyproject.toml#tool.taskipy.tasks',
            ],
            [
              table((tool['poetry'] as Record<string, unknown> | undefined)?.['scripts']),
              'poetry',
              (e) => `poetry run ${e}`,
              'pyproject.toml#tool.poetry.scripts',
            ],
            [
              table((t.value['project'] as Record<string, unknown> | undefined)?.['scripts']),
              'project.scripts',
              (e) => e,
              'pyproject.toml#project.scripts',
            ],
          ];
          const hatch = (tool['hatch'] as Record<string, unknown> | undefined)?.['envs'];
          for (const [env, cfg] of Object.entries((hatch ?? {}) as Record<string, unknown>))
            sets.push([
              table((cfg as Record<string, unknown> | undefined)?.['scripts']),
              'hatch',
              (e) => `hatch run ${env === 'default' ? '' : `${env}:`}${e}`,
              `pyproject.toml#tool.hatch.envs.${env}.scripts`,
            ]);
          for (const [names, runner, inv, src] of sets)
            for (const n of names) offerEntry(n, runner, inv, src, py.file, lineOfText(py.text, n));
        }
      }
      const tox = reader.get('tox.ini') ? await c.text('tox.ini', 512 * 1024) : null;
      if (tox)
        for (const x of toxEnvs(tox.text))
          offerEntry(x.name, 'tox', (e) => `tox -e ${e}`, 'tox.ini', tox.file, x.line);
      const nox = reader.get('noxfile.py') ? await c.text('noxfile.py', 512 * 1024) : null;
      if (nox)
        for (const x of noxSessions(nox.text))
          offerEntry(x.name, 'nox', (e) => `nox -s ${e}`, 'noxfile.py', nox.file, x.line);

      // Toolchains that carry their own conventional commands: reported as such, never as a script.
      const defaults: Array<[string, string, Partial<Record<TaskContractName, string>>]> = [
        [
          'Cargo.toml',
          'cargo',
          {
            build: 'cargo build',
            test: 'cargo test',
            lint: 'cargo clippy',
            'format-check': 'cargo fmt --check',
            typecheck: 'cargo check',
          },
        ],
        [
          'go.mod',
          'go',
          {
            build: 'go build ./...',
            test: 'go test ./...',
            lint: 'go vet ./...',
            typecheck: 'go vet ./...',
          },
        ],
        ['pom.xml', 'maven', { build: 'mvn package', test: 'mvn test', check: 'mvn verify' }],
        ['Gemfile', 'bundler', { setup: 'bundle install', test: 'bundle exec rake test' }],
        ['composer.json', 'composer', { setup: 'composer install', test: 'composer test' }],
      ];
      for (const [manifest, runner, cmds] of defaults) {
        const f = reader.get(manifest);
        if (!f) continue;
        for (const [name, cmd] of Object.entries(cmds) as Array<[TaskContractName, string]>)
          offer(name, {
            runner,
            invocation: cmd,
            source: `default:${manifest}`,
            file: f,
            line: 1,
            exact: false,
          });
      }
      const gradle =
        reader.get('gradlew') ?? reader.get('build.gradle') ?? reader.get('build.gradle.kts');
      if (gradle) {
        for (const [name, cmd] of [
          ['build', 'gradle build'],
          ['test', 'gradle test'],
          ['check', 'gradle check'],
        ] as const)
          offer(name, {
            runner: 'gradle',
            invocation: cmd,
            source: 'default:build.gradle',
            file: gradle,
            line: 1,
            exact: false,
          });
      }

      for (const name of TASK_CONTRACT_NAMES) {
        const f = found.get(name);
        const fact: Fact = f
          ? {
              kind: 'task_command',
              detector: 'task_contract',
              name,
              state: 'found',
              runner: f.runner,
              invocation: f.invocation,
              source: f.source,
              evidence: [c.evidence(f.file, f.line)],
            }
          : {
              kind: 'task_command',
              detector: 'task_contract',
              name,
              state: 'missing',
              runner: null,
              invocation: null,
              source: null,
              evidence: [],
            };
        c.add(fact);
      }
      return c.output();
    },
  };
}
