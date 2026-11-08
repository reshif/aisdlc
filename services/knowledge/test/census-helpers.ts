import type { CensusAttestations } from '@aisdlc/contracts';
import { FixtureRepo } from '../src/testing.js';

// Fixtures shared by the census tests.

/** What the code host and the owner supplied: the same for every scenario, so only the repo differs. */
export const ATTESTED: CensusAttestations = {
  repo: { visibility: 'private', owner_type: 'org', plan: 'team' },
  installation: {
    repository_selection: 'selected',
    permissions: { contents: 'read', pull_requests: 'write' },
  },
  owner_confirmed: { by: 'alice' },
  tier: { signed: 'T0', regulatory_attested: true, criticality_attested: true, t0_attested: true },
};

export const safeCi = [
  'name: ci',
  'on:',
  '  pull_request:',
  '    branches: [main]',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  check:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  '      - run: npm ci && npm run check',
  '',
].join('\n');

/** A small, clean, well-formed repo. */
export function cleanRepo(root: string, name: string): FixtureRepo {
  const r = new FixtureRepo(root, name);
  r.write(
    'package.json',
    JSON.stringify(
      {
        name: 'app',
        scripts: {
          test: 'vitest run',
          check: 'npm test && npm run lint',
          lint: 'eslint .',
          'format-check': 'prettier --check .',
          typecheck: 'tsc --noEmit',
        },
      },
      null,
      2,
    ),
  );
  r.write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
  r.write('AGENTS.md', '# app\n\nRun `npm run check` before every commit.\n');
  r.write('CLAUDE.md', '@AGENTS.md\n');
  r.write('.github/CODEOWNERS', '* @acme/core\n');
  r.write('.github/workflows/ci.yml', safeCi);
  r.write('src/index.ts', 'export const x = 1;\n');
  return r;
}
