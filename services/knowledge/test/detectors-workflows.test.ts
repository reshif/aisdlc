import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DetectorsResult, Fact } from '@aisdlc/contracts';
import {
  branchAllowed,
  buildDetectors,
  runDetectors,
  unsafeContexts,
} from '../src/detectors/index.js';
import { FixtureRepo, detect, openFixture, scratchDir } from '../src/testing.js';

// M6.3: B5 (dangerous workflows, an in-house safe-YAML check) and B6 (apply-on-merge), with
// fixture repos built with real git. The workflows are parsed, never run.

const scratch = scratchDir();
afterAll(() => scratch.dispose());

let n = 0;
function repo(files: Record<string, string>): FixtureRepo {
  const r = new FixtureRepo(scratch.dir, `w${++n}`);
  for (const [p, c] of Object.entries(files)) r.write(p, c);
  r.commit('fixture');
  return r;
}
const wf = (body: string, name = 'ci'): Record<string, string> => ({
  [`.github/workflows/${name}.yml`]: body,
});
type Of<K extends Fact['kind']> = Extract<Fact, { kind: K }>;
const factsOf = <K extends Fact['kind']>(r: DetectorsResult, kind: K): Of<K>[] =>
  r.facts.filter((f): f is Of<K> => f.kind === kind);
const found = (r: DetectorsResult): string[] =>
  factsOf(r, 'workflow_finding')
    .map((f) => `${f.severity}:${f.rule}`)
    .sort();
const y = (...l: string[]): string => `${l.join('\n')}\n`;

describe('B5: dangerous workflows', () => {
  it('no workflows is met; a plain CI workflow is met', async () => {
    const none = (await detect(repo({ 'README.md': 'x' }))).result;
    expect(none.b5).toEqual({ status: 'met', red: 0, amber: 0, workflows_unanalysed: 0 });
    const ok = (
      await detect(
        repo(
          wf(
            y(
              'name: ci',
              'on:',
              '  push:',
              '    branches: [main]',
              '  pull_request:',
              'permissions:',
              '  contents: read',
              'jobs:',
              '  test:',
              '    runs-on: ubuntu-latest',
              '    steps:',
              '      - uses: actions/checkout@v4',
              '      - run: npm ci && npm test',
              '      - run: echo "PR ${{ github.event.pull_request.number }} at ${{ github.sha }}"',
            ),
          ),
        ),
      )
    ).result;
    expect(found(ok)).toEqual([]);
    expect(ok.b5.status).toBe('met');
  });

  it('pull_request_target that checks out the PR head is red, with the line', async () => {
    const { result } = await detect(
      repo(
        wf(
          y(
            'on: pull_request_target',
            'jobs:',
            '  build:',
            '    runs-on: ubuntu-latest',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '        with:',
            '          ref: ${{ github.event.pull_request.head.sha }}',
            '      - run: npm test',
          ),
        ),
      ),
    );
    expect(found(result)).toEqual(['red:pr_target_head_checkout']);
    expect(result.b5).toMatchObject({ status: 'blocked', red: 1 });
    const f = factsOf(result, 'workflow_finding')[0];
    expect(f).toMatchObject({ path: '.github/workflows/ci.yml', job: 'build' });
    expect(f?.evidence[0]?.line).toBe(8);
    expect(f?.evidence[0]?.blob).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the other ways to check out the head: github.head_ref, gh pr checkout, a workflow_run head', async () => {
    const a = await detect(
      repo(
        wf(
          y(
            'on: pull_request_target',
            'jobs:',
            '  j:',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '        with:',
            '          ref: ${{ github.head_ref }}',
          ),
        ),
      ),
    );
    expect(found(a.result)).toContain('red:pr_target_head_checkout');
    const b = await detect(
      repo(
        wf(
          y(
            'on: pull_request_target',
            'jobs:',
            '  j:',
            '    steps:',
            '      - run: gh pr checkout ${{ github.event.number }}',
          ),
        ),
      ),
    );
    expect(found(b.result)).toContain('red:pr_target_head_checkout');
    const c = await detect(
      repo(
        wf(
          y(
            'on:',
            '  workflow_run:',
            '    workflows: [ci]',
            '    types: [completed]',
            'jobs:',
            '  j:',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '        with:',
            '          ref: ${{ github.event.workflow_run.head_sha }}',
          ),
        ),
      ),
    );
    expect(found(c.result)).toEqual(['red:workflow_run_head_checkout']);
    // The default checkout of a pull_request_target is the base branch: safe.
    const d = await detect(
      repo(
        wf(
          y(
            'on: pull_request_target',
            'jobs:',
            '  j:',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '      - run: echo hi',
          ),
        ),
      ),
    );
    expect(found(d.result)).toEqual([]);
  });

  it('secrets on PR or agent/** triggers are red (GITHUB_TOKEN is not a secret here)', async () => {
    const pr = await detect(
      repo(
        wf(
          y(
            'on: [pull_request]',
            'permissions: {}',
            'jobs:',
            '  j:',
            '    steps:',
            '      - run: deploy --token ${{ secrets.DEPLOY_KEY }}',
          ),
        ),
      ),
    );
    expect(found(pr.result)).toEqual(['red:secrets_on_pr_trigger']);
    expect(factsOf(pr.result, 'workflow_finding')[0]?.evidence[0]?.line).toBe(6);
    const agent = await detect(
      repo(
        wf(
          y(
            'on:',
            '  push:',
            '    branches: ["agent/**"]',
            'permissions: {}',
            'jobs:',
            '  j:',
            '    steps:',
            '      - run: x',
            '        env:',
            '          K: ${{ secrets.API_TOKEN }}',
          ),
        ),
      ),
    );
    expect(found(agent.result)).toEqual(['red:secrets_on_agent_trigger']);
    const unfiltered = await detect(
      repo(
        wf(
          y(
            'on: push',
            'permissions: {}',
            'jobs:',
            '  j:',
            '    steps:',
            '      - run: x',
            '        env:',
            '          K: ${{ secrets.API_TOKEN }}',
          ),
        ),
      ),
    );
    expect(found(unfiltered.result)).toEqual(['red:secrets_on_agent_trigger']);
    const mainOnly = await detect(
      repo(
        wf(
          y(
            'on:',
            '  push:',
            '    branches: [main]',
            'permissions: {}',
            'jobs:',
            '  j:',
            '    steps:',
            '      - run: x',
            '        env:',
            '          K: ${{ secrets.API_TOKEN }}',
          ),
        ),
      ),
    );
    expect(found(mainOnly.result)).toEqual([]);
    const tokenOnly = await detect(
      repo(
        wf(
          y(
            'on: pull_request',
            'permissions: {contents: read}',
            'jobs:',
            '  j:',
            '    steps:',
            '      - run: gh x',
            '        env:',
            '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
          ),
        ),
      ),
    );
    expect(found(tokenOnly.result)).toEqual([]);
    const inherit = await detect(
      repo(
        wf(
          y(
            'on: pull_request',
            'permissions: {}',
            'jobs:',
            '  call:',
            '    uses: ./.github/workflows/reusable.yml',
            '    secrets: inherit',
          ),
        ),
      ),
    );
    expect(found(inherit.result)).toEqual(['red:secrets_on_pr_trigger']);
  });

  it('attacker-controlled contexts in run: are red; safe numbers and shas are not; the line is inside a block scalar', async () => {
    const { result } = await detect(
      repo(
        wf(
          y(
            'on: issues',
            'permissions: {}',
            'jobs:',
            '  triage:',
            '    steps:',
            '      - name: ok',
            '        run: echo "${{ github.event.issue.number }} ${{ github.sha }}"',
            '      - name: bad title',
            '        run: |',
            '          echo starting',
            '          echo "${{ github.event.issue.title }}"',
            '      - name: bad branch',
            '        run: git checkout ${{ github.head_ref }}',
            '      - name: comment',
            '        run: echo ${{ github.event.comment.body }}',
          ),
        ),
      ),
    );
    const f = factsOf(result, 'workflow_finding').filter(
      (x) => x.rule === 'untrusted_context_in_run',
    );
    expect(f.map((x) => x.evidence[0]?.line).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      11, 13, 15,
    ]);
    expect(f.every((x) => x.severity === 'red' && x.job === 'triage')).toBe(true);
  });

  it('unsafeContexts and branchAllowed behave as documented', () => {
    expect(unsafeContexts('github.event.pull_request.title')).toEqual([
      'github.event.pull_request.title',
    ]);
    expect(unsafeContexts('github.event.pull_request.number')).toEqual([]);
    expect(unsafeContexts('github.event.commits[0].message')).toEqual([
      'github.event.commits.message',
    ]);
    expect(unsafeContexts('github.ref_name')).toEqual(['github.ref_name']);
    expect(unsafeContexts('secrets.X')).toEqual([]);
    expect(branchAllowed(null, 'agent/x')).toBe(true);
    expect(branchAllowed({ branches: ['main'] }, 'agent/x')).toBe(false);
    expect(branchAllowed({ branches: ['**'] }, 'agent/x')).toBe(true);
    expect(branchAllowed({ branches: ['*'] }, 'agent/x')).toBe(false);
    expect(branchAllowed({ branches: ['**', '!agent/**'] }, 'agent/x')).toBe(false);
    expect(branchAllowed({ 'branches-ignore': ['agent/**'] }, 'agent/x')).toBe(false);
    expect(branchAllowed({ tags: ['v*'] }, 'main')).toBe(false);
  });

  it('amber posture: unpinned third-party actions with secrets, and no permissions on a writing workflow', async () => {
    const { result } = await detect(
      repo(
        wf(
          y(
            'on:',
            '  push:',
            '    branches: [main]',
            'jobs:',
            '  release:',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '      - uses: some-org/publish@v2',
            '      - uses: other-org/pinned@0123456789abcdef0123456789abcdef01234567',
            '      - run: npm publish',
            '        env:',
            '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
          ),
        ),
      ),
    );
    expect(found(result)).toEqual([
      'amber:missing_permissions_on_writing_workflow',
      'amber:unpinned_action_with_secrets',
    ]);
    expect(result.b5).toMatchObject({ status: 'met', red: 0, amber: 2 });
    const un = factsOf(result, 'workflow_finding').find(
      (f) => f.rule === 'unpinned_action_with_secrets',
    );
    expect(un?.evidence[0]?.line).toBe(8);
  });

  it('a workflow that cannot be parsed makes B5 unknown with a coverage item; hostile YAML is refused, not expanded', async () => {
    const bomb = y(
      'a: &a [x, x, x, x, x, x, x, x, x]',
      ...'bcdefghij'.split('').map(
        (k, i) =>
          `${k}: &${k} [${Array(9)
            .fill(`*${i === 0 ? 'a' : 'bcdefghij'[i - 1]}`)
            .join(', ')}]`,
      ),
      'on: push',
    );
    const { result, coverage } = await detect(
      repo({
        ...wf('on: [push\njobs: {', 'broken'),
        ...wf(bomb, 'bomb'),
        ...wf(
          `on: push\nx: !!python/object/apply:os.system ["touch /tmp/pwned"]\nm: &m {a: 1}\nn:\n  <<: *m\njobs: {}\n`,
          'tags',
        ),
        ...wf(`${'['.repeat(5000)}${']'.repeat(5000)}\n`, 'deep'),
      }),
    );
    expect(result.b5.status).toBe('unknown');
    expect(result.b5.workflows_unanalysed).toBeGreaterThanOrEqual(3);
    const items = coverage.filter((c) => c.path?.startsWith('.github/workflows/'));
    expect(items.find((c) => c.path?.endsWith('broken.yml'))?.kind).toBe('unparseable_file');
    expect(items.find((c) => c.path?.endsWith('bomb.yml'))?.kind).toBe('parse_limit');
    expect(items.find((c) => c.path?.endsWith('deep.yml'))).toBeDefined();
    // A custom tag is data (a string), never constructed; the file is analysed, not a coverage item.
    expect(items.find((c) => c.path?.endsWith('tags.yml'))).toBeUndefined();
  });

  it('a workflow over the size limit is a parse_limit coverage item', async () => {
    const { result, coverage } = await detect(
      repo(wf(`on: push\n# ${'x'.repeat(600_000)}\njobs: {}\n`, 'huge')),
    );
    expect(coverage.find((c) => c.path?.endsWith('huge.yml'))?.kind).toBe('parse_limit');
    expect(result.b5.status).toBe('unknown');
  });
});

describe('B6: apply on merge', () => {
  const aom = (r: DetectorsResult): string[] =>
    factsOf(r, 'apply_on_merge')
      .map((f) => `${f.confidence}:${f.rule}`)
      .sort();

  it('a deploy step on push to the default branch is apply-on-merge, high confidence, and T2', async () => {
    const { result } = await detect(
      repo(
        wf(
          y(
            'on:',
            '  push:',
            '    branches: [main]',
            'permissions: {}',
            'jobs:',
            '  deploy:',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '      - run: |',
            '          terraform init',
            '          terraform apply -auto-approve',
          ),
        ),
      ),
    );
    expect(aom(result)).toEqual(['high:terraform_apply']);
    expect(result.b6).toEqual({ detected: true, high: 1, medium: 0 });
    expect(result.tier.floor).toBe('T2');
    expect(result.tier.signals).toContain('aom.terraform_apply');
    expect(factsOf(result, 'apply_on_merge')[0]?.evidence[0]?.line).toBe(11);
  });

  it('kubectl, helm, serverless and cloud actions; a pull_request closed as merged', async () => {
    for (const [cmd, rule] of [
      ['kubectl apply -f k8s/', 'kubectl_apply'],
      ['helm upgrade --install app ./chart', 'helm_upgrade'],
      ['npx serverless deploy', 'serverless_deploy'],
      ['pulumi up --yes', 'pulumi_up'],
      ['cdk deploy --all', 'cdk_deploy'],
      ['firebase deploy', 'cloud_cli_deploy'],
    ] as const) {
      const { result } = await detect(
        repo(
          wf(
            y(
              'on: { push: { branches: [main] } }',
              'permissions: {}',
              'jobs:',
              '  d:',
              '    steps:',
              `      - run: ${cmd}`,
            ),
          ),
        ),
      );
      expect(aom(result), cmd).toEqual([`high:${rule}`]);
    }
    const act = await detect(
      repo(
        wf(
          y(
            'on: { push: { branches: [main] } }',
            'permissions: {}',
            'jobs:',
            '  d:',
            '    steps:',
            '      - uses: azure/webapps-deploy@v3',
          ),
        ),
      ),
    );
    expect(aom(act.result)).toEqual(['high:deploy_action']);
    const env = await detect(
      repo(
        wf(
          y(
            'on: { push: { branches: [main] } }',
            'permissions: {}',
            'jobs:',
            '  d:',
            '    environment: production',
            '    steps:',
            '      - run: ./go.sh',
          ),
        ),
      ),
    );
    expect(aom(env.result)).toEqual(['high:workflow_environment']);
    const merged = await detect(
      repo(
        wf(
          y(
            'on:',
            '  pull_request:',
            '    types: [closed]',
            'permissions: {}',
            'jobs:',
            '  d:',
            '    if: github.event.pull_request.merged == true',
            '    steps:',
            '      - run: helm upgrade a b',
          ),
        ),
      ),
    );
    expect(aom(merged.result)).toEqual(['high:helm_upgrade']);
  });

  it('a deploy on another branch, on a tag, or on a PR is not apply-on-merge; a test environment is not a deploy', async () => {
    for (const trigger of [
      'on: { push: { branches: [release] } }',
      'on: { push: { tags: ["v*"] } }',
      'on: pull_request',
      'on: workflow_dispatch',
    ]) {
      const { result } = await detect(
        repo(
          wf(
            y(
              trigger,
              'permissions: {}',
              'jobs:',
              '  d:',
              '    steps:',
              '      - run: terraform apply',
            ),
          ),
        ),
      );
      expect(aom(result), trigger).toEqual([]);
    }
    const t = await detect(
      repo(
        wf(
          y(
            'on: { push: { branches: [main] } }',
            'permissions: {}',
            'jobs:',
            '  d:',
            '    environment: test',
            '    steps:',
            '      - run: npm test',
          ),
        ),
      ),
    );
    expect(aom(t.result)).toEqual([]);
    expect(t.result.b6.detected).toBe(false);
  });

  it('other CI and platform config are medium and do not raise the floor; GitOps auto-sync is high', async () => {
    const { result } = await detect(
      repo({
        '.gitlab-ci.yml': y('deploy:', '  script:', '    - kubectl apply -f k8s/'),
        'vercel.json': '{}',
        'README.md': 'x',
      }),
    );
    expect(aom(result)).toEqual(['medium:kubectl_apply', 'medium:platform_config']);
    expect(result.b6).toEqual({ detected: true, high: 0, medium: 2 });
    expect(result.tier.signals.filter((s) => s.startsWith('aom.'))).toEqual([]);
    const argo = await detect(
      repo({
        'argocd/app.yaml': y(
          'apiVersion: argoproj.io/v1alpha1',
          'kind: Application',
          'spec:',
          '  syncPolicy:',
          '    automated:',
          '      prune: true',
        ),
      }),
    );
    expect(aom(argo.result)).toEqual(['high:gitops_auto_sync']);
    expect(argo.result.tier.floor).toBe('T2');
  });
});

describe('coverage and failure', () => {
  it('a file over the per-file cap is a coverage item, and the detector reports what it could, not silence', async () => {
    const { result, coverage } = await detect(
      repo({ 'package.json': JSON.stringify({ dependencies: { react: '1' } }) + ' '.repeat(2000) }),
      { maxFileBytes: 1000 },
    );
    expect(coverage.find((c) => c.path === 'package.json')?.kind).toBe('file_over_cap');
    expect(factsOf(result, 'stack').some((f) => f.category === 'framework')).toBe(false);
  });

  it('a blob git cannot read is an unreadable_object coverage item and the status is error, never "found nothing"', async () => {
    const r = repo({ 'package.json': '{"dependencies":{"react":"1"}}', 'README.md': 'x' });
    const f = await openFixture(r);
    try {
      // The fetch left the objects in a pack: removing it makes every object unreadable for git.
      const packs = join(f.mirror.dir, 'objects', 'pack');
      for (const name of readdirSync(packs)) rmSync(join(packs, name));
      const { result, coverage } = await runDetectors(f.reader, buildDetectors());
      expect(
        coverage.some((c) => c.kind === 'unreadable_object' && c.path === 'package.json'),
      ).toBe(true);
      expect(result.status).toBe('error');
      expect(result.errors.some((e) => e.code === 'unreadable_object')).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it('a detector that throws is recorded as an error and its facts are absent; the others still run', async () => {
    const r = repo({ 'README.md': 'x' });
    const f = await openFixture(r);
    try {
      const boom = {
        info: { id: 'stack' as const, version: '1', criteria: [] },
        run: () => Promise.reject(new Error('secret detail from the repo')),
      };
      const { result } = await runDetectors(f.reader, [boom, ...buildDetectors().slice(1)]);
      expect(result.status).toBe('error');
      expect(result.errors).toEqual([
        {
          detector: 'stack',
          code: 'detector_failed',
          message: 'the stack detector failed (detector_failed)',
        },
      ]);
      expect(JSON.stringify(result)).not.toContain('secret detail');
      expect(factsOf(result, 'task_command')).toHaveLength(8);
    } finally {
      await f.dispose();
    }
  });

  it('the job deadline stops the run with a timeout error', async () => {
    const f = await openFixture(repo({ 'README.md': 'x' }));
    try {
      const ac = new AbortController();
      ac.abort();
      const { result } = await runDetectors(f.reader, buildDetectors(), ac.signal);
      expect(result.status).toBe('error');
      expect(new Set(result.errors.map((e) => e.code))).toEqual(new Set(['timeout']));
      expect(result.facts).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
});
