import {
  CODE_GRAPH_SCHEMA_ID,
  CodeGraph,
  codeGraphHash,
  type CodeFileNode,
  type CodeGraph as Graph,
  type Fact,
} from '@aisdlc/contracts';

// A small monorepo's code graph (what knowledge serves at the census head) for the Full baseline tests:
// two packages, an API service that uses one of them, tests, a vendored file and a protected path.

export const B = (c: string): string => c.repeat(40);
export const HEAD = B('d');

const file = (path: string, o: Partial<CodeFileNode> = {}): CodeFileNode => ({
  path,
  blob: B('1'),
  language: path.endsWith('.py') ? 'python' : path.endsWith('.ts') ? 'typescript' : 'other',
  role: 'source',
  area: '.',
  lines: 10,
  exports: [],
  ...o,
});

export function graphFixture(
  o: { files?: CodeFileNode[]; truncated?: boolean; sha?: string } = {},
): Graph {
  const files = o.files ?? [
    file('package.json', { role: 'config', language: 'other' }),
    file('packages/core/package.json', {
      role: 'config',
      language: 'other',
      area: 'packages/core',
    }),
    file('packages/core/src/money.ts', {
      area: 'packages/core',
      exports: ['Ledger', 'Money'],
      blob: B('2'),
    }),
    file('packages/core/test/money.test.ts', { area: 'packages/core', role: 'test', blob: B('3') }),
    file('services/api/package.json', { role: 'config', language: 'other', area: 'services/api' }),
    file('services/api/src/main.ts', { area: 'services/api', exports: ['start'], blob: B('4') }),
    file('services/api/src/migrations/0001.ts', { area: 'services/api', blob: B('5') }),
    file('services/api/test/main.test.ts', { area: 'services/api', role: 'test', blob: B('6') }),
    file('services/api/test/vendor/old.test.ts', {
      area: 'services/api',
      role: 'test',
      blob: B('7'),
    }),
    file('.github/workflows/ci.yml', { role: 'config', language: 'other' }),
    file('README.md', { role: 'doc', language: 'other' }),
  ];
  const paths = new Set(files.map((f) => f.path));
  const edges = [
    { from: 'packages/core/test/money.test.ts', to: 'packages/core/src/money.ts', line: 1 },
    { from: 'services/api/src/main.ts', to: 'packages/core/package.json', line: 1 },
    { from: 'services/api/src/main.ts', to: 'packages/core/src/money.ts', line: 2 },
    { from: 'services/api/test/main.test.ts', to: 'services/api/src/main.ts', line: 1 },
    { from: 'services/api/test/main.test.ts', to: 'services/api/src/migrations/0001.ts', line: 2 },
    { from: 'services/api/test/vendor/old.test.ts', to: 'services/api/src/main.ts', line: 1 },
  ].filter((e) => paths.has(e.from) && paths.has(e.to));
  const body = {
    schema: CODE_GRAPH_SCHEMA_ID,
    repo: 'acme/app',
    commit_sha: o.sha ?? HEAD,
    files,
    edges,
    external_imports: 4,
    skipped_index: 1,
    truncated: o.truncated ?? false,
  };
  return CodeGraph.parse({ ...body, graph_hash: codeGraphHash(body) });
}

export const FACTS: Fact[] = [
  {
    kind: 'task_command',
    detector: 'task_contract',
    evidence: [{ path: 'package.json', blob: B('1'), line: 4 }],
    name: 'test',
    state: 'found',
    runner: 'npm',
    invocation: 'npm test',
    source: 'package.json#scripts',
  },
];

export const S0 = '0190a3c4-0000-7000-8000-000000000001';
export const CENSUS_HASH = 'e'.repeat(64);
