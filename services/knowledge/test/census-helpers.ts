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
  // The community and toolchain files a well-kept repo has (M6.6): all plain, no links, no secrets.
  r.write(
    'README.md',
    [
      '# app',
      '',
      'A small service that turns incoming orders into shipping labels for the warehouse team.',
      '',
      '## Usage',
      '',
      'Run `npm ci`, then `npm run check`.',
      '',
    ].join('\n'),
  );
  r.write('LICENSE', 'Permission is hereby granted, free of charge, to any person.\n');
  r.write(
    'SECURITY.md',
    '# Security\n\nReport a vulnerability privately to security@acme.example.\n',
  );
  r.write('CONTRIBUTING.md', '# Contributing\n\nOpen a pull request against main.\n');
  r.write('.github/pull_request_template.md', '## What changed\n\n## How it was tested\n');
  r.write(
    '.github/dependabot.yml',
    [
      'version: 2',
      'updates:',
      '  - package-ecosystem: npm',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '',
    ].join('\n'),
  );
  r.write('.env.example', 'DATABASE_URL=\nAPI_TOKEN=changeme\nLOG_LEVEL=info\n');
  r.write('.gitattributes', 'package-lock.json linguist-generated=true\n');
  r.write('.nvmrc', '22\n');
  r.write('.c8rc.json', JSON.stringify({ reporter: ['lcov'] }));
  r.write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
  r.write(
    'docs/adr/0001-record-decisions.md',
    '# 1. Record decisions\n\nWe keep decision records.\n',
  );
  r.write('docs/runbooks/deploy.md', '# Deploy\n\nSteps for a deploy.\n');
  return r;
}
