import { createServer, type Server } from 'node:http';
import { cutKnowledgeView, ProjectKnowledgeView } from '@aisdlc/contracts';
import { bindProject, grantRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpCoreClient } from '../src/core-client.js';
import { signIn, startBffStack, type BffStack, type Browser } from '../src/testing.js';
import { CORE_TOKEN } from './portal-fixtures.js';

// PLAN M17: the Knowledge screen's read. It needs the PDP's `project.view` AND view level V2 on the project (what the
// factory knows about the code is content of the work), and the answer is cut to the person's data class: below D1
// the paths and the seed text are withheld. Core is a fake over HTTP.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SEED_TEXT = '# packages/money\n\nThe ledger keeps balances in integer cents.\n';
const view = () =>
  ProjectKnowledgeView.parse({
    project_id: 'acme',
    data_class: 'D2',
    repos: [
      {
        repo: 'acme/web',
        s0_id: '01a1bc26-f0e5-719a-a52b-a88a4b6cbe54',
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
          excluded: [{ path: 'vendor/x.js', reason: 'generated_or_vendored' }],
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
            path: 'specs/packages-money.md',
            status: 'intended',
            verdict: 'correct',
            text: SEED_TEXT,
            text_sha256: 'f'.repeat(64),
            withheld: false,
          },
        ],
        golden: [
          {
            candidate_id: 'gt-0123456789abcdef',
            area: 'packages/money',
            test: 'packages/money/test/ledger.test.ts',
            subjects: ['packages/money/src/index.ts'],
            verdict: 'accept',
          },
        ],
      },
    ],
  });

let s: BffStack;
let server: Server;
let coreUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${CORE_TOKEN}`) return send(401, {});
    if (req.url === '/v1/projects/acme/knowledge') return send(200, view());
    return send(404, { error: { code: 'not_found', message: 'no' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  coreUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  s = await startBffStack({
    override: { core: new HttpCoreClient({ baseUrl: coreUrl, token: CORE_TOKEN }) },
  });
  // alice: project admin (V3, D1); dora: viewer (V1, D0); carol: nothing on acme
  await bindProject(s.identity, 'acme', { admin: ['alice'] });
  await grantRole(s.identity.deps, 'dora', 'project.viewer', { kind: 'project', ref: 'acme' });
});
afterAll(async () => {
  await s.stop();
  await new Promise<void>((r) => server.close(() => r()));
});

const browsers = new Map<string, Browser>();
async function get(who: 'alice' | 'carol' | 'dora', path: string) {
  let b = browsers.get(who);
  if (!b) {
    b = (await signIn(s, who)).browser;
    browsers.set(who, b);
  }
  const res = await b.request(`${s.base}${path}`);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json, text };
}

describe('GET /api/projects/:id/knowledge', () => {
  it('a D1 admin sees the repo index, the map, the graph, the seeds with their text and the golden tasks', async () => {
    const r = await get('alice', '/api/projects/acme/knowledge');
    expect(r.status).toBe(200);
    expect(r.json.data_class).toBe('D1');
    const repo = r.json.repos[0];
    expect(repo.seeds[0]).toMatchObject({ text: SEED_TEXT, path: 'specs/packages-money.md' });
    expect(repo.golden[0].test).toBe('packages/money/test/ledger.test.ts');
    expect(repo.index.excluded).toHaveLength(1);
  });

  it('a viewer below V2 is refused; a person without project.view is refused', async () => {
    const dora = await get('dora', '/api/projects/acme/knowledge');
    expect(dora.status).toBe(403);
    expect(dora.json.error.code).toBe('view_level');
    expect(dora.text).not.toContain('integer cents');
    const carol = await get('carol', '/api/projects/acme/knowledge');
    expect(carol.status).toBe(403);
    expect(carol.text).not.toContain('integer cents');
  });

  it('cut to D0: paths and seed text withheld, areas and counts kept', () => {
    const v = cutKnowledgeView(view(), 'D0');
    const repo = v.repos[0];
    expect(v.data_class).toBe('D0');
    expect(repo?.seeds[0]).toMatchObject({ text: null, path: null, withheld: true });
    expect(repo?.golden[0]).toMatchObject({ test: null, subjects: [] });
    expect(repo?.index?.excluded).toEqual([]);
    expect(repo?.areas[0]?.files).toBe(3);
    expect(JSON.stringify(v)).not.toContain('integer cents');
    expect(cutKnowledgeView(view(), 'D2').repos[0]?.seeds[0]?.text).toBe(SEED_TEXT);
  });
});
