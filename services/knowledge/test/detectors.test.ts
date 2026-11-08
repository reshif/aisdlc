import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CRITERIA_LIST } from '@aisdlc/catalogue';
import type { DetectorsResult, Fact } from '@aisdlc/contracts';
import { buildDetectors, detectorSetVersion } from '../src/detectors/index.js';
import { FixtureRepo, detect, gitEnv, scratchDir } from '../src/testing.js';

// M6.3: one fixture repo per detector, built with real git and read through the hardened object
// reader of a bare mirror. Nothing is checked out and nothing in the fixtures is ever run.

const scratch = scratchDir();
afterAll(() => scratch.dispose());

let n = 0;
function repo(files: Record<string, string>): FixtureRepo {
  const r = new FixtureRepo(scratch.dir, `r${++n}`);
  for (const [p, c] of Object.entries(files)) r.write(p, c);
  r.commit('fixture');
  return r;
}

type Of<K extends Fact['kind']> = Extract<Fact, { kind: K }>;
const factsOf = <K extends Fact['kind']>(r: DetectorsResult, kind: K): Of<K>[] =>
  r.facts.filter((f): f is Of<K> => f.kind === kind);

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

describe('the registry', () => {
  it('has one detector per id, and the version is a hash over their versions', () => {
    const ds = buildDetectors();
    const ids = ds.map((d) => d.info.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      [
        'stack',
        'task_contract',
        'lockfiles',
        'codeowners',
        'tier_data_class',
        'tier_exposure',
        'tier_blast_radius',
        'inventory',
        'b5_workflows',
        'b6_apply_on_merge',
        'content_lint',
        'presence',
      ].sort(),
    );
    const v = detectorSetVersion(ds);
    expect(v).toMatch(/^detectors\/\d+:[0-9a-f]{12}$/);
    expect(detectorSetVersion(buildDetectors())).toBe(v);
    const bumped = ds.map((d, i) => (i === 0 ? { ...d, info: { ...d.info, version: '99' } } : d));
    expect(detectorSetVersion(bumped)).not.toBe(v);
    // The lint's version follows its allow-list: a different config is a different detector set.
    expect(detectorSetVersion(buildDetectors({ urlAllowList: ['docs.example.org'] }))).not.toBe(v);
  });

  it('every criterion a detector feeds exists in the catalogue', () => {
    const known = new Set(CRITERIA_LIST.map((c) => c.id));
    for (const d of buildDetectors())
      for (const id of d.info.criteria) expect(known.has(id), `${d.info.id}: ${id}`).toBe(true);
  });

  it('a result carries the version and the detectors, and an empty repo is T0, unattested', async () => {
    const { result } = await detect(repo({ 'README.md': '# empty\n' }));
    expect(result.detector_set_version).toBe(detectorSetVersion(buildDetectors()));
    expect(result.detectors.map((d) => d.id)).toHaveLength(12);
    expect(result.status).toBe('ok');
    expect(result.tier.floor).toBe('T0');
    expect(result.default_branch).toBe('main');
  });
});

describe('stack', () => {
  it('reads languages, frameworks and package managers from manifests', async () => {
    const { result } = await detect(
      repo({
        'package.json': JSON.stringify({
          packageManager: 'pnpm@9.0.0',
          dependencies: { react: '^18', express: '^4' },
          devDependencies: { typescript: '^5', vite: '^5' },
        }),
        'pyproject.toml': lines(
          '[project]',
          'name = "x"',
          'dependencies = ["Django>=4", "celery"]',
          '[tool.poetry]',
          'name = "x"',
        ),
        'go.mod': lines('module x', 'require github.com/gin-gonic/gin v1.9.0'),
        'Cargo.toml': lines('[package]', 'name = "x"', '[dependencies]', 'axum = "0.7"'),
        'pom.xml':
          '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>',
        Gemfile: "gem 'rails'\n",
        'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }),
      }),
    );
    const stack = factsOf(result, 'stack').map((f) => `${f.category}:${f.name}`);
    for (const want of [
      'language:javascript',
      'language:typescript',
      'framework:react',
      'framework:express',
      'framework:vite',
      'package_manager:pnpm',
      'language:python',
      'framework:django',
      'framework:celery',
      'package_manager:poetry',
      'language:go',
      'framework:gin',
      'language:rust',
      'framework:axum',
      'package_manager:cargo',
      'language:java',
      'framework:spring-boot',
      'language:ruby',
      'framework:rails',
      'language:php',
      'framework:laravel',
      'manifest:package.json',
    ])
      expect(stack, want).toContain(want);
    const react = factsOf(result, 'stack').find((f) => f.name === 'react');
    expect(react?.evidence[0]).toMatchObject({ path: 'package.json', line: 1 });
    expect(react?.evidence[0]?.blob).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a manifest that does not parse is a coverage item, not an empty stack', async () => {
    const { result, coverage } = await detect(
      repo({ 'package.json': '{ not json', 'Cargo.toml': '[[[' }),
    );
    expect(
      coverage
        .filter((c) => c.kind === 'unparseable_file')
        .map((c) => c.path)
        .sort(),
    ).toEqual(['Cargo.toml', 'package.json']);
    expect(factsOf(result, 'stack').some((f) => f.category === 'framework')).toBe(false);
  });

  it('skips vendored manifests', async () => {
    const { result } = await detect(
      repo({ 'node_modules/x/package.json': '{"dependencies":{"react":"1"}}', 'README.md': 'x' }),
    );
    expect(factsOf(result, 'stack')).toEqual([]);
  });
});

describe('task contract', () => {
  it('maps the eight names onto package.json scripts and reports found and missing, with the script name and never its body', async () => {
    const { result } = await detect(
      repo({
        'package.json': JSON.stringify(
          {
            scripts: {
              setup: 'node scripts/setup.js --secret-flag',
              build: 'tsc',
              test: 'vitest run',
              'test:fast': 'vitest run --changed',
              lint: 'eslint .',
              'format:check': 'prettier --check .',
              typecheck: 'tsc --noEmit',
            },
          },
          null,
          2,
        ),
      }),
    );
    const t = Object.fromEntries(factsOf(result, 'task_command').map((f) => [f.name, f]));
    expect(Object.keys(t).sort()).toEqual([
      'build',
      'check',
      'format-check',
      'lint',
      'setup',
      'test',
      'test-fast',
      'typecheck',
    ]);
    expect(t['test']).toMatchObject({
      state: 'found',
      runner: 'npm',
      invocation: 'npm run test',
      source: 'package.json#scripts',
    });
    expect(t['test-fast']).toMatchObject({ state: 'found', invocation: 'npm run test:fast' });
    expect(t['format-check']).toMatchObject({ state: 'found', invocation: 'npm run format:check' });
    expect(t['check']).toMatchObject({
      state: 'missing',
      runner: null,
      invocation: null,
      evidence: [],
    });
    expect(JSON.stringify(result)).not.toContain('--secret-flag');
    expect(t['lint']?.evidence[0]?.line).toBeGreaterThan(1);
  });

  it('reads Makefile targets by name only and never runs make', async () => {
    const marker = join(scratch.dir, 'make-ran');
    const r = repo({
      Makefile: lines(
        `.PHONY: test lint`,
        `SHELL := /bin/sh`,
        `test: build`,
        `\ttouch ${marker}`,
        `lint check:`,
        `\ttouch ${marker}`,
        `%.o: %.c`,
        `\tcc -c $<`,
        `$(shell touch ${marker}):`,
      ),
    });
    const { result } = await detect(r);
    const t = Object.fromEntries(factsOf(result, 'task_command').map((f) => [f.name, f]));
    expect(t['test']).toMatchObject({
      state: 'found',
      runner: 'make',
      invocation: 'make test',
      source: 'Makefile',
    });
    expect(t['lint']?.state).toBe('found');
    expect(t['check']?.state).toBe('found');
    expect(t['build']?.state).toBe('missing');
    expect(existsSync(marker)).toBe(false);
  });

  it('maps justfile recipes, tox environments, nox sessions and pyproject task tables', async () => {
    const { result } = await detect(
      repo({
        justfile: lines(
          'set shell := ["bash", "-c"]',
          'version := "1"',
          '',
          'build:',
          '    cargo build',
          'typecheck arg="x":',
          '    mypy',
        ),
        'tox.ini': lines('[tox]', 'envlist = py312', '[testenv:lint]', 'commands = ruff check .'),
        'noxfile.py': lines(
          'import nox',
          '',
          '@nox.session',
          'def tests(session):',
          '    pass',
          '',
          '@nox.session(name="format-check")',
          'def fmt(session):',
          '    pass',
        ),
        'pyproject.toml': lines(
          '[tool.poe.tasks]',
          'setup = "pip install -e ."',
          'check = "pytest"',
        ),
      }),
    );
    const t = Object.fromEntries(factsOf(result, 'task_command').map((f) => [f.name, f]));
    expect(t['build']).toMatchObject({ runner: 'just', invocation: 'just build' });
    expect(t['typecheck']).toMatchObject({ runner: 'just', invocation: 'just typecheck' });
    expect(t['lint']).toMatchObject({ runner: 'tox', invocation: 'tox -e lint' });
    expect(t['test']).toMatchObject({ runner: 'nox', invocation: 'nox -s tests' });
    expect(t['format-check']).toMatchObject({ runner: 'nox', invocation: 'nox -s format-check' });
    expect(t['setup']).toMatchObject({ runner: 'poe', invocation: 'poe setup' });
    expect(t['check']).toMatchObject({ runner: 'poe', invocation: 'poe check' });
  });

  it('names the toolchain default when the repo has no script of its own, and says so', async () => {
    const { result } = await detect(
      repo({ 'Cargo.toml': '[package]\nname = "x"\n', 'go.mod': 'module x\n' }),
    );
    const test = factsOf(result, 'task_command').find((f) => f.name === 'test');
    expect(test?.source).toMatch(/^default:/);
  });
});

describe('lockfiles', () => {
  it('npm: feasible when package-lock agrees, infeasible when it does not, absent when there is none', async () => {
    const lock = (deps: Record<string, string>) =>
      JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: deps } } });
    const ok = await detect(
      repo({
        'package.json': JSON.stringify({ dependencies: { a: '^1' } }),
        'package-lock.json': lock({ a: '^1' }),
      }),
    );
    expect(factsOf(ok.result, 'lockfile')[0]).toMatchObject({
      state: 'present',
      lockfile: 'package-lock.json',
      frozen_install: 'feasible',
      inherited: false,
    });
    const bad = await detect(
      repo({
        'package.json': JSON.stringify({ dependencies: { a: '^2' } }),
        'package-lock.json': lock({ a: '^1' }),
      }),
    );
    expect(factsOf(bad.result, 'lockfile')[0]).toMatchObject({
      state: 'present',
      frozen_install: 'infeasible',
    });
    const none = await detect(repo({ 'package.json': '{}' }));
    expect(factsOf(none.result, 'lockfile')[0]).toMatchObject({
      state: 'absent',
      lockfile: null,
      frozen_install: 'infeasible',
    });
  });

  it('a workspace package uses the root lockfile, marked inherited, and an unchecked lockfile is unknown', async () => {
    const { result } = await detect(
      repo({
        'package.json': '{"workspaces":["pkg/*"]}',
        'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }),
        'pkg/a/package.json': '{"name":"a"}',
        'py/pyproject.toml': '[project]\nname="p"\n',
        'py/uv.lock': 'version = 1\n',
      }),
    );
    const by = Object.fromEntries(factsOf(result, 'lockfile').map((f) => [f.manifest, f]));
    expect(by['pkg/a/package.json']).toMatchObject({
      lockfile: 'package-lock.json',
      inherited: true,
      frozen_install: 'unknown',
    });
    expect(by['py/pyproject.toml']).toMatchObject({
      lockfile: 'py/uv.lock',
      frozen_install: 'unknown',
    });
  });

  it('python requirements are their own lock only when every line is pinned; go, cargo and maven', async () => {
    const { result } = await detect(
      repo({
        'pinned/requirements.txt': lines(
          '# c',
          'flask==3.0.0',
          'requests==2.31.0 --hash=sha256:abc',
        ),
        'loose/requirements.txt': lines('flask>=3', 'requests'),
        'g/go.mod': lines('module g', 'require github.com/x/y v1.0.0'),
        'g/go.sum': 'github.com/x/y v1.0.0 h1:abc=\n',
        'bare/go.mod': lines('module bare'),
        'c/Cargo.toml': '[package]\nname="c"\n',
        'm/pom.xml': '<project/>',
      }),
    );
    const by = Object.fromEntries(factsOf(result, 'lockfile').map((f) => [f.manifest, f]));
    expect(by['pinned/requirements.txt']).toMatchObject({
      state: 'present',
      frozen_install: 'feasible',
    });
    expect(by['loose/requirements.txt']).toMatchObject({
      state: 'absent',
      frozen_install: 'infeasible',
    });
    expect(by['g/go.mod']).toMatchObject({ state: 'present', lockfile: 'g/go.sum' });
    expect(by['bare/go.mod']).toMatchObject({ state: 'absent', frozen_install: 'feasible' });
    expect(by['c/Cargo.toml']).toMatchObject({ state: 'absent', frozen_install: 'infeasible' });
    expect(by['m/pom.xml']).toMatchObject({ state: 'absent', frozen_install: 'infeasible' });
  });

  it('an unparseable package.json beside a lockfile is a coverage item and unknown, not feasible', async () => {
    const { result, coverage } = await detect(
      repo({
        'package.json': '{ nope',
        'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
      }),
    );
    expect(factsOf(result, 'lockfile')[0]?.frozen_install).toBe('unknown');
    expect(coverage.some((c) => c.kind === 'unparseable_file' && c.path === 'package.json')).toBe(
      true,
    );
  });
});

describe('CODEOWNERS (the shared parser)', () => {
  it('absent: nothing covers the protected set', async () => {
    const { result } = await detect(repo({ 'README.md': 'x' }));
    const c = factsOf(result, 'codeowners')[0];
    expect(c).toMatchObject({ state: 'absent', path: null });
    expect(c?.protected_set.covered).toBe(false);
    expect(c?.protected_set.uncovered).toContain('AGENTS.md');
  });

  it('reports owners, errors with lines, and whether the protected set is covered', async () => {
    const { result } = await detect(
      repo({
        '.github/CODEOWNERS': lines(
          '# owners',
          '*           @acme/platform @alice',
          '/docs/      docs@example.com',
          '!negated @bob',
          'src/ not an owner',
        ),
        CODEOWNERS: '* @shadowed\n',
      }),
    );
    const c = factsOf(result, 'codeowners')[0];
    expect(c).toMatchObject({
      state: 'present',
      path: '.github/CODEOWNERS',
      shadowed: ['CODEOWNERS'],
      rule_count: 2,
    });
    expect(c?.owners).toEqual(['email:docs@example.com', 'team:acme/platform', 'user:alice']);
    expect(c?.errors.map((e) => e.line)).toEqual([4, 5]);
    expect(c?.protected_set).toEqual({ covered: true, uncovered: [] });
    expect(c?.evidence[0]).toMatchObject({ path: '.github/CODEOWNERS', line: 2 });
  });

  it('a file that covers only some of the protected set names what is left', async () => {
    const { result } = await detect(
      repo({ CODEOWNERS: lines('/src/ @a', '/AGENTS.md @a', '/.github/ @a', '/.claude/ ') }),
    );
    const c = factsOf(result, 'codeowners')[0];
    expect(c?.protected_set.covered).toBe(false);
    expect(c?.protected_set.uncovered).toEqual(
      expect.arrayContaining(['CLAUDE.md', '.factory/knowledge/index.yaml', '.mcp.json']),
    );
    // `/.claude/` with no owners clears ownership: not covered.
    expect(c?.protected_set.uncovered).toContain('.claude/settings.json');
    expect(c?.protected_set.uncovered).not.toContain('AGENTS.md');
    expect(c?.protected_set.uncovered).not.toContain('.github/workflows/ci.yml');
  });

  it('a hostile CODEOWNERS is parsed as data (no command runs, nothing hangs)', async () => {
    const t = performance.now();
    const { result } = await detect(
      repo({ CODEOWNERS: `* $(touch /tmp/x) @a\n${'\\'.repeat(50_000)} @a\n` }),
    );
    expect(performance.now() - t).toBeLessThan(10_000);
    expect(factsOf(result, 'codeowners')[0]?.errors.length).toBeGreaterThan(0);
  });
});

describe('tier floor', () => {
  const signals = (r: DetectorsResult): string[] =>
    factsOf(r, 'tier_signal')
      .map((f) => f.signal)
      .sort();

  it('T0 when nothing fires, and the unattested T0 is represented so M7.4 can block M4', async () => {
    const { result } = await detect(
      repo({ 'src/index.ts': 'export const a = 1;\n', 'README.md': 'x' }),
    );
    expect(result.tier).toEqual({
      floor: 'T0',
      signals: [],
      attestation: {
        regulatory: 'unattested',
        criticality: 'unattested',
        t0_positive: 'unattested',
      },
      blocks_m4_until_attested: true,
      blocks_m4_reasons: ['t0_unattested', 'regulatory_unattested', 'criticality_unattested'],
    });
  });

  it('data_class: two PII kinds are T1 (with evidence), one is not; a sensitive field is T2', async () => {
    const one = await detect(repo({ 'db/schema.sql': 'create table u (id int, email text);\n' }));
    expect(signals(one.result)).toEqual([]);
    const pii = await detect(
      repo({
        'db/schema.sql': lines(
          'create table u (',
          '  id int,',
          '  email text,',
          '  firstName text',
          ');',
        ),
      }),
    );
    expect(signals(pii.result)).toEqual(['dc.pii']);
    expect(pii.result.tier.floor).toBe('T1');
    const sig = factsOf(pii.result, 'tier_signal')[0];
    expect(sig).toMatchObject({ criterion: 'data_class', floor: 'T1' });
    expect(sig?.evidence.map((e) => [e.path, e.line])).toEqual([
      ['db/schema.sql', 3],
      ['db/schema.sql', 4],
    ]);
    const sens = await detect(
      repo({ 'models/patient.py': 'class P:\n    patient_id = 1\n    ssn = ""\n' }),
    );
    expect(signals(sens.result)).toEqual(['dc.sensitive_pii']);
    expect(sens.result.tier.floor).toBe('T2');
    // Fixtures and tests are mock data, not what the system holds.
    const mock = await detect(
      repo({
        'test/fixtures/people.sql': 'insert into people (ssn, email, phone) values (1,2,3);\n',
      }),
    );
    expect(signals(mock.result)).toEqual([]);
  });

  it('exposure: routing config is T1, wildcard CORS or a public ingress is T2', async () => {
    const routing = await detect(
      repo({
        'deploy/ingress.yaml':
          'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: web\n',
      }),
    );
    expect(signals(routing.result)).toContain('ex.routing');
    const nginx = await detect(repo({ 'nginx.conf': 'server { listen 80; }\n' }));
    expect(signals(nginx.result)).toEqual(['ex.routing']);
    const cors = await detect(
      repo({ 'src/server.ts': "import cors from 'cors';\napp.use(cors({ origin: '*' }));\n" }),
    );
    expect(signals(cors.result)).toEqual(['ex.open']);
    expect(factsOf(cors.result, 'tier_signal')[0]?.evidence[0]).toMatchObject({
      path: 'src/server.ts',
      line: 2,
    });
    const open = await detect(
      repo({
        'infra/sg.tf': lines(
          'resource "aws_security_group_rule" "in" {',
          '  type = "ingress"',
          '  cidr_blocks = ["0.0.0.0/0"]',
          '}',
        ),
      }),
    );
    expect(signals(open.result)).toContain('ex.open');
    const lb = await detect(
      repo({ 'k8s/svc.yaml': 'kind: Service\nspec:\n  type: LoadBalancer\n' }),
    );
    expect(signals(lb.result)).toContain('ex.open');
    expect(lb.result.tier.floor).toBe('T2');
  });

  it('blast radius: migrations and IaC are T1, a prod inventory is T2', async () => {
    const mig = await detect(repo({ 'db/migrate/001_init.rb': 'class Init; end\n' }));
    expect(signals(mig.result)).toEqual(['br.migration']);
    const iac = await detect(
      repo({ 'infra/main.tf': 'terraform {}\n', 'charts/app/Chart.yaml': 'name: app\n' }),
    );
    expect(signals(iac.result)).toEqual(['br.iac']);
    expect(iac.result.tier.floor).toBe('T1');
    const cfn = await detect(
      repo({ 'template.yaml': "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n" }),
    );
    expect(signals(cfn.result)).toEqual(['br.iac']);
    const prod = await detect(repo({ 'ansible/inventory/production': '[web]\nweb1\n' }));
    expect(signals(prod.result)).toEqual(['br.prod_inventory']);
    expect(prod.result.tier.floor).toBe('T2');
    // A Rails config/environments/production.rb is application config, not an inventory.
    const rails = await detect(
      repo({ 'config/environments/production.rb': 'Rails.application.configure {}\n' }),
    );
    expect(signals(rails.result)).toEqual([]);
  });

  it('the floor is the highest signal, and regulatory and criticality are never inferred', async () => {
    const { result } = await detect(
      repo({
        'db/migrate/1.rb': 'x\n',
        'src/server.ts': "app.use(cors({ origin: '*' }));\n",
        'docs/regulatory.md':
          'This system is subject to HIPAA and PCI-DSS. It is business-critical with an on-call SLA.\n',
        'SLO.md': 'sla 99.99\n',
      }),
    );
    expect(result.tier.floor).toBe('T2');
    expect(result.tier.signals).toEqual(['br.migration', 'ex.open']);
    expect(result.tier.attestation.regulatory).toBe('unattested');
    expect(result.tier.attestation.criticality).toBe('unattested');
    expect(result.tier.attestation.t0_positive).toBe('not_applicable');
    expect(result.tier.blocks_m4_until_attested).toBe(true);
    expect(result.tier.blocks_m4_reasons).toEqual([
      'regulatory_unattested',
      'criticality_unattested',
    ]);
    expect(
      factsOf(result, 'tier_signal').every((f) =>
        ['data_class', 'exposure', 'blast_radius'].includes(f.criterion),
      ),
    ).toBe(true);
  });
});

describe('instruction and harness inventory', () => {
  it('lists every instruction and harness file as data, with line counts, chain size and auto-run flags', async () => {
    const big = `${'x'.repeat(40)}\n`.repeat(200); // 200 lines, 8200 bytes
    const { result } = await detect(
      repo({
        'AGENTS.md': lines('# app', 'one', 'two'),
        'svc/AGENTS.md': big,
        'svc/deep/AGENTS.md': big,
        'CLAUDE.md': '@AGENTS.md\n',
        '.claude/settings.json': JSON.stringify({
          hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }] },
        }),
        '.claude/commands/ship.md': '# ship\n',
        '.mcp.json': JSON.stringify({
          mcpServers: {
            a: { command: 'node', args: ['x.js'] },
            b: { url: 'https://example.com/mcp' },
          },
        }),
        '.cursor/rules/a.mdc': 'rule\n',
        '.github/copilot-instructions.md': 'be nice\n',
        '.windsurfrules': 'x\n',
        '.husky/pre-commit': 'npm test\n',
        '.devcontainer/devcontainer.json': '{\n // c\n "postCreateCommand": "npm ci",\n}\n',
        '.vscode/tasks.json':
          '{ "version": "2.0.0", "tasks": [ { "label": "x", "runOptions": { "runOn": "folderOpen" } } ] }',
        '.envrc': 'export A=1\n',
        'package.json': JSON.stringify({ scripts: { postinstall: 'node x.js' } }),
      }),
    );
    const inv = Object.fromEntries(
      factsOf(result, 'instruction_file').map((f) => [f.inventory, f]),
    );
    expect(inv['agents_md']).toMatchObject({
      state: 'data',
      file_count: 3,
      auto_run: 'not_applicable',
    });
    expect(inv['agents_md']?.detail).toMatchObject({
      root_present: true,
      root_lines: 3,
      nested_count: 2,
      nested_over_limit: 2,
      chain_over_limit: false,
    });
    expect(inv['agents_md']?.detail['max_chain_bytes']).toBeGreaterThan(16_000);
    expect(inv['agents_md']?.files.find((f) => f.path === 'svc/AGENTS.md')?.lines).toBe(200);
    expect(inv['claude_md']?.detail).toMatchObject({ root_stub: true, all_stubs: true });
    expect(inv['claude_dir']).toMatchObject({ state: 'data', auto_run: 'yes' });
    expect(inv['claude_dir']?.detail).toMatchObject({ settings: 1, commands: 1 });
    expect(inv['mcp_json']).toMatchObject({ state: 'data', auto_run: 'yes' });
    expect(inv['mcp_json']?.detail).toMatchObject({ mcp_servers: 2, mcp_stdio_servers: 1 });
    for (const k of [
      'cursor',
      'copilot_instructions',
      'windsurf',
      'git_hooks',
      'devcontainer',
      'vscode_tasks',
      'direnv',
      'install_scripts',
    ])
      expect(inv[k]?.state, k).toBe('data');
    expect(inv['devcontainer']?.auto_run).toBe('yes');
    expect(inv['vscode_tasks']?.auto_run).toBe('yes');
    expect(inv['copilot_instructions']?.auto_run).toBe('no');
    expect(inv['git_hooks']?.auto_run).toBe('yes');
    for (const k of ['gemini', 'aider', 'continue', 'pre_commit_config'])
      expect(inv[k], k).toMatchObject({
        state: 'absent',
        file_count: 0,
        auto_run: 'not_applicable',
        evidence: [],
      });
    // Never loaded as guidance: no state but absent or data, and no text from any of them in the result.
    expect(new Set(Object.values(inv).map((f) => f.state))).toEqual(new Set(['absent', 'data']));
    expect(JSON.stringify(result)).not.toContain('be nice');
  });

  it('a CLAUDE.md that is not the stub, a symlink stub, and a chain over 32 KiB', async () => {
    const r = new FixtureRepo(scratch.dir, `r${++n}`);
    r.write('AGENTS.md', 'a'.repeat(20_000))
      .write('pkg/AGENTS.md', 'b'.repeat(20_000))
      .write('CLAUDE.md', '# own text\n');
    r.write('pkg/real.md', 'x');
    r.commit('c');
    const a = await detect(r);
    const inv = factsOf(a.result, 'instruction_file');
    expect(inv.find((f) => f.inventory === 'claude_md')?.detail).toMatchObject({
      root_stub: false,
      all_stubs: false,
    });
    expect(inv.find((f) => f.inventory === 'agents_md')?.detail).toMatchObject({
      chain_over_limit: true,
      max_chain_bytes: 40_000,
    });
    const s = new FixtureRepo(scratch.dir, `r${++n}`);
    s.write('AGENTS.md', 'x\n');
    s.git('add', '-A');
    s.git('commit', '-q', '-m', 'a');
    execSymlink(s.dir);
    const b = await detect(s);
    expect(
      factsOf(b.result, 'instruction_file').find((f) => f.inventory === 'claude_md')?.detail,
    ).toMatchObject({ root_stub: true });
  });

  it('unparseable harness config is auto-run unknown (never "no") and a coverage item', async () => {
    const { result, coverage } = await detect(
      repo({ '.claude/settings.json': '{ broken', '.vscode/tasks.json': '{ also broken' }),
    );
    const inv = Object.fromEntries(
      factsOf(result, 'instruction_file').map((f) => [f.inventory, f]),
    );
    expect(inv['claude_dir']?.auto_run).toBe('unknown');
    expect(inv['vscode_tasks']?.auto_run).toBe('unknown');
    expect(coverage.filter((c) => c.kind === 'unparseable_file')).toHaveLength(2);
  });
});

function execSymlink(dir: string): void {
  symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['commit', '-q', '-m', 'link'], { cwd: dir, env: gitEnv() });
}
