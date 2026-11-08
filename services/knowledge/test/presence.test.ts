import { afterAll, describe, expect, it } from 'vitest';
import { CATALOGUE } from '@aisdlc/catalogue';
import { IntakeResult, type CensusCriterionResult, type Fact } from '@aisdlc/contracts';
import { makeCanary } from '@aisdlc/secrets-rules';
import { assembleCensus } from '../src/census/index.js';
import { FixtureRepo, detect, scratchDir } from '../src/testing.js';
import { ATTESTED } from './census-helpers.js';

// M6.6: the presence detector, one fixture repo per newly observed criterion, with a pass and a fail
// case each, evaluated through the real census assembly (so the criterion ids come from the
// catalogue). Real git, nothing executed.

const scratch = scratchDir();
afterAll(() => scratch.dispose());

const SHA = 'a'.repeat(40);
const HEX = 'b'.repeat(64);
let n = 0;

async function run(files: Record<string, string>, over: { maxFileBytes?: number } = {}) {
  const r = new FixtureRepo(scratch.dir, `p${++n}`);
  for (const [p, c] of Object.entries(files)) r.write(p, c);
  r.commit('fixture');
  const { result, coverage } = await detect(r, over);
  return { result, coverage };
}

async function criterion(
  files: Record<string, string>,
  id: string,
): Promise<CensusCriterionResult> {
  const { result } = await run(files);
  const intake = IntakeResult.parse({
    repo: 'acme/app',
    base_sha: SHA,
    manifest: {
      repo: 'acme/app',
      head_sha: SHA,
      refs_covered: 'all',
      ref_count: 1,
      commit_count: 1,
      bytes: 1,
      duration_ms: 0,
    },
    bundle_sha256: HEX,
    bundle_bytes: 1,
    refs: [{ name: 'refs/heads/main', sha: SHA }],
    head_tree: { files: 1, bytes: 1 },
    coverage_items: [],
    coverage_counts: {},
    scan_status: 'ok',
    scan_error: null,
    scan_coverage: {
      refs_covered: 'all',
      ref_count: 1,
      commits_scanned: 1,
      blobs_scanned: 1,
      truncated: false,
      cap_reached: false,
      lfs_unscanned: 0,
      submodules_listed: 0,
      rules_version: 'secrets-rules/2:000000000000',
    },
    security_summary: {
      history_scan: {
        status: 'ok',
        refs_covered: 'all',
        commits_scanned: 1,
        truncated: false,
        open: 0,
        rotated: 0,
        false_positive: 0,
        accepted_test_fixture: 0,
        rules_version: 'secrets-rules/2:000000000000',
      },
    },
    finding_counts: { open: 0, rotated: 0, false_positive: 0, accepted_test_fixture: 0 },
    detectors: result,
  });
  const c = assembleCensus(intake, CATALOGUE, 'light', ATTESTED);
  const r = c.criteria.find((x) => x.id === id);
  if (!r) throw new Error(`no ${id}`);
  return r;
}

const L = (...l: string[]): string => `${l.join('\n')}\n`;
const verdict = async (files: Record<string, string>, id: string) => {
  const r = await criterion(files, id);
  return { observed: r.observed, reasons: r.reasons };
};

type Presence = Extract<Fact, { kind: 'presence' }>;
const presence = async (files: Record<string, string>, item: string): Promise<Presence> => {
  const { result } = await run(files);
  const f = result.facts.find((x): x is Presence => x.kind === 'presence' && x.item === item);
  if (!f) throw new Error(`no presence fact ${item}`);
  return f;
};

describe('the presence detector', () => {
  it('always emits one fact per item, absent is a fact, and the evidence is {path, blob, line}', async () => {
    const { result } = await run({ 'x.txt': 'x\n' });
    const items = result.facts.filter((f): f is Presence => f.kind === 'presence');
    expect(new Set(items.map((f) => f.item)).size).toBe(19);
    expect(items.every((f) => f.state === 'absent' || f.state === 'present')).toBe(true);
    const readme = await presence({ 'README.md': '# a\n\n## Usage\n' }, 'readme');
    expect(readme.evidence[0]).toMatchObject({ path: 'README.md', line: expect.any(Number) });
    expect(readme.evidence[0]?.blob).toMatch(/^[0-9a-f]{40}$/);
    expect(result.detector_set_version).toMatch(/^detectors\/1:[0-9a-f]{12}$/);
  });

  it('RS-KN-1: README with a purpose and how-to-run heading', async () => {
    const good = L('# app', '', '## About', '', 'It does things.', '', '## Getting started', '');
    expect(await verdict({ 'README.md': good }, 'RS-KN-1')).toEqual({
      observed: 'pass',
      reasons: [],
    });
    // an intro of real prose under the title is a purpose too
    const intro = L(
      '# app',
      '',
      'A service that prints shipping labels for the warehouse.',
      '',
      '## Run',
      '',
    );
    expect((await verdict({ 'README.rst': intro }, 'RS-KN-1')).observed).toBe('pass');
    expect(await verdict({ 'README.md': L('# app', '', '## Usage') }, 'RS-KN-1')).toEqual({
      observed: 'fail',
      reasons: ['readme_no_purpose'],
    });
    expect(await verdict({ 'README.md': L('# app', '', '## About', 'x') }, 'RS-KN-1')).toEqual({
      observed: 'fail',
      reasons: ['readme_no_run_instructions'],
    });
    // headings inside a code fence do not count
    const fenced = L('# app', '```', '## Usage', '## About', '```');
    expect((await verdict({ 'README.md': fenced }, 'RS-KN-1')).observed).toBe('fail');
    expect(await verdict({ 'a.txt': 'x' }, 'RS-KN-1')).toEqual({
      observed: 'fail',
      reasons: ['no_readme'],
    });
  });

  it('RS-PUB-1: a non-empty LICENSE', async () => {
    expect((await verdict({ LICENSE: 'MIT\n' }, 'RS-PUB-1')).observed).toBe('pass');
    expect((await verdict({ 'LICENSE.md': 'MIT\n' }, 'RS-PUB-1')).observed).toBe('pass');
    expect(await verdict({ LICENSE: '' }, 'RS-PUB-1')).toEqual({
      observed: 'fail',
      reasons: ['license_empty'],
    });
    expect(await verdict({ 'a.txt': 'x' }, 'RS-PUB-1')).toEqual({
      observed: 'fail',
      reasons: ['no_license'],
    });
  });

  it('RS-PUB-2: SECURITY.md with a private-reporting pointer', async () => {
    const good = L('# Security', '', 'Report a vulnerability privately to sec@acme.example.');
    expect((await verdict({ '.github/SECURITY.md': good }, 'RS-PUB-2')).observed).toBe('pass');
    expect(
      (await verdict({ 'SECURITY.md': L('Use the security/advisories page.') }, 'RS-PUB-2'))
        .observed,
    ).toBe('pass');
    expect(
      await verdict({ 'SECURITY.md': L('# Security', '', 'Be careful.') }, 'RS-PUB-2'),
    ).toEqual({
      observed: 'fail',
      reasons: ['no_private_reporting_pointer'],
    });
    expect(await verdict({ 'a.txt': 'x' }, 'RS-PUB-2')).toEqual({
      observed: 'fail',
      reasons: ['no_security_policy'],
    });
  });

  it('RS-PUB-4: CONTRIBUTING and a PR template', async () => {
    const both = { 'CONTRIBUTING.md': '# c\n', '.github/PULL_REQUEST_TEMPLATE.md': '# t\n' };
    expect((await verdict(both, 'RS-PUB-4')).observed).toBe('pass');
    expect(await verdict({ 'CONTRIBUTING.md': '# c\n' }, 'RS-PUB-4')).toEqual({
      observed: 'fail',
      reasons: ['no_pr_template'],
    });
    expect(await verdict({ 'a.txt': 'x' }, 'RS-PUB-4')).toEqual({
      observed: 'fail',
      reasons: ['no_contributing', 'no_pr_template'],
    });
  });

  it('RS-PUB-5: Dependabot or Renovate config that is not empty', async () => {
    const dep = L('version: 2', 'updates:', '  - package-ecosystem: npm', '    directory: /');
    expect((await verdict({ '.github/dependabot.yml': dep }, 'RS-PUB-5')).observed).toBe('pass');
    expect(
      (await verdict({ 'renovate.json': '{"extends":["config:base"]}' }, 'RS-PUB-5')).observed,
    ).toBe('pass');
    expect(await verdict({ '.github/dependabot.yml': 'version: 2\n' }, 'RS-PUB-5')).toEqual({
      observed: 'fail',
      reasons: ['dependency_update_config_empty'],
    });
    expect(await verdict({ 'a.txt': 'x' }, 'RS-PUB-5')).toEqual({
      observed: 'fail',
      reasons: ['no_dependency_update_config'],
    });
    // an unparseable config is unknown, and a coverage item
    const bad = { 'renovate.json': '{ not json' };
    expect((await verdict(bad, 'RS-PUB-5')).reasons).toEqual(['dependency_update_config_unparsed']);
    expect((await run(bad)).coverage.map((c) => c.kind)).toContain('unparseable_file');
  });

  it('RS-EN-2 (head part): .env.example placeholders only, judged by the shared secret rules', async () => {
    const canary = makeCanary('presence-env');
    const ok = await verdict({ '.env.example': L('API_TOKEN=changeme', 'DB=') }, 'RS-EN-2');
    // the other half needs the probe, so a clean file alone never passes
    expect(ok).toEqual({
      observed: 'unknown',
      reasons: ['env_example_placeholders_only', 'probe_pending'],
    });
    const bad = await verdict({ '.env.example': L(`API_TOKEN=${canary}`) }, 'RS-EN-2');
    expect(bad).toEqual({ observed: 'fail', reasons: ['env_example_real_value'] });
    const { result } = await run({ '.env.example': L(`API_TOKEN=${canary}`) });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect((await verdict({ 'a.txt': 'x' }, 'RS-EN-2')).reasons).toEqual(['probe_pending']);
  });

  it('RS-EN-3: size, LFS and binaries are recorded, never guessed', async () => {
    const f = await presence(
      {
        'a.png': 'x',
        'big.bin': 'y'.repeat(10),
        '.gitattributes': L('*.bin filter=lfs diff=lfs merge=lfs -text'),
      },
      'repo_shape',
    );
    expect(f.detail).toMatchObject({ files: 3, binary_files: 2, lfs_patterns: 1, large_files: 0 });
    expect(f.evidence[0]?.path).toBe('.gitattributes');
    const r = await criterion({ 'a.png': 'x', '.gitattributes': 'x.bin filter=lfs\n' }, 'RS-EN-3');
    expect(r.observed).toBe('pass');
    expect(r.reasons).toEqual(['has_binary_files', 'lfs_tracked']);
  });

  it('RS-ST-5: generated or vendored paths declared in .gitattributes', async () => {
    const declared = { 'vendor/x.go': 'x', '.gitattributes': L('vendor/** linguist-vendored') };
    expect((await verdict(declared, 'RS-ST-5')).observed).toBe('pass');
    expect(await verdict({ 'vendor/x.go': 'x' }, 'RS-ST-5')).toEqual({
      observed: 'fail',
      reasons: ['undeclared_generated_or_vendored_paths'],
    });
    // a negated attribute is not a declaration
    const neg = { 'api.pb.go': 'x', '.gitattributes': L('*.pb.go -linguist-generated') };
    expect((await verdict(neg, 'RS-ST-5')).observed).toBe('fail');
    expect(await verdict({ 'a.txt': 'x' }, 'RS-ST-5')).toEqual({
      observed: 'pass',
      reasons: ['no_generated_or_vendored_paths'],
    });
  });

  it('RS-TH-3 and RS-TH-4: skip inventory and the quarantine manifest', async () => {
    const skipped = { 'test/a.test.ts': L("it.skip('x', () => {});", "it('y', () => {});") };
    const inv = await presence(skipped, 'skip_inventory');
    expect(inv.detail).toMatchObject({ skipped: 1, files_with_skips: 1, test_files_read: 1 });
    expect(inv.evidence[0]).toMatchObject({ path: 'test/a.test.ts', line: 1 });
    expect(await verdict(skipped, 'RS-TH-4')).toEqual({
      observed: 'pass',
      reasons: ['has_skipped_tests'],
    });
    expect(await verdict({ 'test/a.test.ts': "it('y', () => {});\n" }, 'RS-TH-4')).toEqual({
      observed: 'pass',
      reasons: [],
    });
    const py = { 'tests/test_a.py': L('@pytest.mark.xfail', 'def test_a(): pass') };
    expect((await presence(py, 'skip_inventory')).detail['skipped']).toBe(1);

    // TH-3: nothing skipped needs no manifest; a skip without one fails; a complete manifest passes
    expect(await verdict({ 'a.txt': 'x' }, 'RS-TH-3')).toEqual({
      observed: 'pass',
      reasons: ['nothing_to_quarantine'],
    });
    expect(await verdict(skipped, 'RS-TH-3')).toEqual({
      observed: 'fail',
      reasons: ['skipped_tests_without_quarantine_manifest'],
    });
    const good = L(
      'tests:',
      '  - name: a',
      '    issue: 12',
      '    owner: core',
      '    expires: 2027-01-01',
    );
    expect((await verdict({ ...skipped, 'quarantine.yml': good }, 'RS-TH-3')).observed).toBe(
      'pass',
    );
    const noExpiry = L('tests:', '  - name: a', '    issue: 12', '    owner: core');
    expect(await verdict({ ...skipped, 'quarantine.yml': noExpiry }, 'RS-TH-3')).toEqual({
      observed: 'fail',
      reasons: ['quarantine_entry_missing_issue_owner_or_expiry'],
    });
    const json = JSON.stringify([{ issue: 'X-1', owner: 'a', expiry: '2027-01-01' }]);
    expect((await verdict({ ...skipped, 'tests/quarantine.json': json }, 'RS-TH-3')).observed).toBe(
      'pass',
    );
  });

  it('RS-KN-6 and RS-OP-3: decision records and runbook pointers', async () => {
    expect((await verdict({ 'docs/adr/0001-x.md': '# 1\n' }, 'RS-KN-6')).observed).toBe('pass');
    expect((await verdict({ 'docs/decisions/001.md': '# 1\n' }, 'RS-KN-6')).observed).toBe('pass');
    expect(await verdict({ 'docs/adr/README.md': '# index\n' }, 'RS-KN-6')).toEqual({
      observed: 'fail',
      reasons: ['no_decision_records'],
    });
    expect((await verdict({ 'docs/runbooks/db.md': '# db\n' }, 'RS-OP-3')).observed).toBe('pass');
    expect((await verdict({ 'RUNBOOK.md': '# r\n' }, 'RS-OP-3')).observed).toBe('pass');
    expect(await verdict({ 'a.txt': 'x' }, 'RS-OP-3')).toEqual({
      observed: 'fail',
      reasons: ['no_runbook_pointers'],
    });
  });

  it('RS-BT-8: a CI workflow that runs check', async () => {
    const wf = (run: string) =>
      L(
        'on: pull_request',
        'permissions: {}',
        'jobs:',
        '  c:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - run: ${run}`,
      );
    const ok = await criterion(
      { '.github/workflows/ci.yml': wf('npm ci && npm run check') },
      'RS-BT-8',
    );
    expect(ok).toMatchObject({ observed: 'pass', reasons: ['required_check_not_read'] });
    expect(ok.evidence[0]).toMatchObject({ path: '.github/workflows/ci.yml', line: 7 });
    expect(
      (await verdict({ '.github/workflows/ci.yml': wf('make check') }, 'RS-BT-8')).observed,
    ).toBe('pass');
    expect(await verdict({ '.github/workflows/ci.yml': wf('echo hi') }, 'RS-BT-8')).toEqual({
      observed: 'fail',
      reasons: ['ci_does_not_run_check'],
    });
    expect(await verdict({ 'a.txt': 'x' }, 'RS-BT-8')).toEqual({
      observed: 'fail',
      reasons: ['no_ci_workflow'],
    });
    // a workflow that cannot be parsed is unknown, never "does not run check"
    expect(await verdict({ '.github/workflows/ci.yml': 'a: [' }, 'RS-BT-8')).toEqual({
      observed: 'unknown',
      reasons: ['ci_workflow_unanalysed'],
    });
  });

  it('RS-ST-1..3: a task-contract target or the tool config', async () => {
    const none = { 'a.txt': 'x' };
    for (const id of ['RS-ST-1', 'RS-ST-2', 'RS-ST-3'])
      expect((await verdict(none, id)).observed).toBe('fail');
    expect((await verdict({ '.prettierrc': '{}' }, 'RS-ST-1')).reasons).toEqual([
      'via_config:formatter_config',
    ]);
    expect((await verdict({ 'eslint.config.js': 'export default [];' }, 'RS-ST-2')).observed).toBe(
      'pass',
    );
    expect((await verdict({ 'tsconfig.json': '{}' }, 'RS-ST-3')).observed).toBe('pass');
    const py = {
      'pyproject.toml': L('[tool.ruff]', 'line-length = 100', '[tool.mypy]', 'strict = true'),
    };
    for (const id of ['RS-ST-1', 'RS-ST-2', 'RS-ST-3'])
      expect((await verdict(py, id)).observed).toBe('pass');
    const pkg = { 'package.json': JSON.stringify({ prettier: {}, eslintConfig: {} }) };
    expect((await verdict(pkg, 'RS-ST-1')).observed).toBe('pass');
    expect((await verdict(pkg, 'RS-ST-3')).observed).toBe('fail');
    // a script in the task contract still counts, without any config file
    const script = { 'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }) };
    expect((await verdict(script, 'RS-ST-2')).observed).toBe('pass');
  });

  it('RS-BT-4: toolchain pinning files', async () => {
    for (const files of [
      { '.nvmrc': '22\n' },
      { '.tool-versions': 'nodejs 22.1.0\n' },
      { 'rust-toolchain.toml': '[toolchain]\nchannel = "1.80"\n' },
      { '.python-version': '3.12\n' },
      { 'go.mod': 'module x\n\ngo 1.22\n' },
      { 'package.json': JSON.stringify({ engines: { node: '>=22' } }) },
    ])
      expect((await verdict(files, 'RS-BT-4')).observed, JSON.stringify(files)).toBe('pass');
    expect(await verdict({ 'go.mod': 'module x\n' }, 'RS-BT-4')).toEqual({
      observed: 'fail',
      reasons: ['no_toolchain_pin'],
    });
    expect((await verdict({ 'package.json': '{}' }, 'RS-BT-4')).observed).toBe('fail');
  });

  it('RS-TH-5: coverage tooling is looked for, the report is the probe', async () => {
    expect(await verdict({ 'a.txt': 'x' }, 'RS-TH-5')).toEqual({
      observed: 'fail',
      reasons: ['no_coverage_tooling'],
    });
    for (const files of [
      { '.coveragerc': '[run]\n' },
      { 'vitest.config.ts': "export default { test: { coverage: { provider: 'v8' } } };\n" },
      { 'package.json': JSON.stringify({ scripts: { test: 'vitest run --coverage' } }) },
      { 'pyproject.toml': '[tool.coverage.run]\nbranch = true\n' },
    ])
      expect(await verdict(files, 'RS-TH-5'), JSON.stringify(files)).toEqual({
        observed: 'unknown',
        reasons: ['probe_pending'],
      });
  });

  it('an over-limit or unreadable file is a coverage item, and its facts say unread', async () => {
    const { result, coverage } = await run(
      { 'README.md': `# a\n\n## About\n${'x'.repeat(2000)}\n` },
      { maxFileBytes: 1000 },
    );
    expect(coverage.some((c) => c.path === 'README.md' && c.kind === 'file_over_cap')).toBe(true);
    const f = result.facts.find((x): x is Presence => x.kind === 'presence' && x.item === 'readme');
    expect(f?.detail).toMatchObject({ purpose: null, run: null });
  });

  it('what cannot be decided from the tree stays unknown with its cause', async () => {
    const files = { 'a.txt': 'x' };
    expect((await verdict(files, 'RS-TH-2')).reasons).toEqual(['needs_history']);
    expect((await verdict(files, 'RS-CC-7')).reasons).toEqual(['needs_history']);
    expect((await verdict(files, 'RS-BT-6')).reasons).toEqual(['probe_pending']);
    expect((await verdict(files, 'RS-TH-6')).reasons).toEqual(['probe_pending']);
    for (const id of ['RS-BT-2', 'RS-BT-5', 'RS-BT-7', 'RS-TH-1', 'RS-KN-3'])
      expect((await verdict(files, id)).reasons).toEqual(['probe_pending']);
  });
});
