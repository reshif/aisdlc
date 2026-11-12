import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt, S0_ID } from './helpers';

// PLAN M17: the Knowledge screen outside card 3. The server decides who sees it and cuts it to the data class; the
// page shows what it is given and says when text was withheld.

const repo = (cut: boolean) => ({
  repo: 'acme/web',
  s0_id: S0_ID,
  baseline: {
    baseline_hash: 'a'.repeat(64),
    baseline_sha: 'b'.repeat(40),
    census_hash: 'c'.repeat(64),
    recorded_at: '2026-11-12T10:00:00.000Z',
    decided: true,
  },
  index: {
    files: 6,
    not_indexed: 1,
    excluded_count: 1,
    excluded: cut ? [] : [{ path: 'vendor/x.js', reason: 'generated_or_vendored' }],
  },
  areas: [
    {
      area: 'packages/money',
      manifest: 'packages/money/package.json',
      files: 3,
      source_files: 1,
      test_files: 1,
      languages: ['typescript'],
      depends_on: [],
      used_by: ['.'],
      level: 'full',
    },
  ],
  code_graph: {
    graph_hash: 'd'.repeat(64),
    map_hash: 'e'.repeat(64),
    files: 6,
    edges: 3,
    external_imports: 0,
    truncated: false,
    area_edges: [{ from: '.', to: 'packages/money', imports: 1 }],
  },
  seeds: [
    {
      seed_id: 'seed-0123456789abcdef',
      area: 'packages/money',
      path: cut ? null : 'specs/packages-money.md',
      status: 'intended',
      verdict: 'correct',
      text: cut ? null : 'The ledger keeps balances in integer cents.',
      text_sha256: 'f'.repeat(64),
      withheld: cut,
    },
  ],
  golden: [
    {
      candidate_id: 'gt-0123456789abcdef',
      area: 'packages/money',
      test: cut ? null : 'packages/money/test/ledger.test.ts',
      subjects: cut ? [] : ['packages/money/src/index.ts'],
      verdict: 'accept',
    },
  ],
});

describe('the Knowledge screen', () => {
  it('shows the repo index, the system map, the code graph, the seeds and the golden tasks', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/acme/knowledge': {
        json: { project_id: 'acme', data_class: 'D1', repos: [repo(false)] },
      },
    });
    renderAt('/projects/acme/knowledge');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Knowledge of acme' }),
    ).toBeInTheDocument();
    const areas = await screen.findByRole('table', { name: 'Areas of acme/web' });
    expect(within(areas).getByText('packages/money')).toBeInTheDocument();
    expect(within(areas).getByText('Full')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Area imports of acme/web' })).toHaveTextContent(
      'imports packages/money',
    );
    const seeds = screen.getByRole('table', { name: 'Seeds of acme/web' });
    expect(seeds).toHaveTextContent('intended (corrected)');
    expect(seeds).toHaveTextContent('integer cents');
    expect(screen.getByRole('table', { name: 'Golden tasks of acme/web' })).toHaveTextContent(
      'packages/money/test/ledger.test.ts',
    );
    expect(screen.getByRole('list', { name: 'Excluded paths of acme/web' })).toHaveTextContent(
      'vendor/x.js',
    );
  });

  it('at D0 says the text is withheld; a refusal is a plain refusal', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/acme/knowledge': {
        json: { project_id: 'acme', data_class: 'D0', repos: [repo(true)] },
      },
    });
    renderAt('/projects/acme/knowledge');
    expect(await screen.findByText(/Shown at data class D0/)).toBeInTheDocument();
    expect(screen.getByText('withheld at your data class')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('integer cents');
  });

  it('a person below V2 gets the refusal', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      'GET /api/projects/acme/knowledge': {
        status: 403,
        json: { error: { code: 'view_level', message: 'it needs view level V2 on the project' } },
      },
    });
    renderAt('/projects/acme/knowledge');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
