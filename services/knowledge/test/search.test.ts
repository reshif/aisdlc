import { join } from 'node:path';
import { makeCanary } from '@aisdlc/secrets-rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FileBundleSource,
  FixtureRepo,
  scratchDir,
  startKnowledgeStack,
  type KnowledgeStack,
} from '../src/testing.js';

// M12.1 (2.1b): the read-only repository search an agent's `KnowledgeSearch` tool runs. It answers only
// for the commit the caller names, from the head tree the last census job indexed, never from a file the
// shared secret ruleset hits, and only to a caller holding scope `search`.

const scratch = scratchDir();
const canary = makeCanary('search-test');
let s: KnowledgeStack;
let head = '';

beforeAll(async () => {
  const r = new FixtureRepo(scratch.dir, 's');
  r.write(
    'src/audit.ts',
    'export function writeAudit() {}\n// the audit log is one table\nexport const x = 1;\n',
  );
  r.write('docs/spec.md', '# Spec\nREQ-12 the audit log records every change\n');
  r.write('src/keys.ts', `export const K = '${canary}';\n// audit key\n`);
  r.write('img.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
  head = r.commit('1');
  const b = r.bundle(join(scratch.dir, 's.bundle'));
  s = await startKnowledgeStack({ source: new FileBundleSource(b.file, b.manifest) });
  await s.runJob();
});
afterAll(async () => {
  await s?.stop();
  scratch.dispose();
});

const search = (token: string | null, q: Record<string, string>) =>
  s.call(token, 'GET', `/v1/repos/acme/app/search?${new URLSearchParams(q).toString()}`);
const hits = (r: { json: unknown }) =>
  (
    r.json as {
      hits: Array<{
        path: string;
        blob_sha: string;
        commit_sha: string;
        excerpt: string;
        line_from: number;
      }>;
    }
  ).hits;

describe('search', () => {
  it('finds a term at the named commit, with the blob it came from and a short excerpt', async () => {
    const r = await search(s.tokens.search, { q: 'audit log', sha: head });
    expect(r.status).toBe(200);
    expect(hits(r).map((h) => h.path)).toEqual(['docs/spec.md', 'src/audit.ts']);
    const h = hits(r)[1];
    expect(h?.commit_sha).toBe(head);
    expect(h?.blob_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(h?.excerpt).toContain('the audit log is one table');
    expect((h?.excerpt ?? '').split('\n').length).toBeLessThanOrEqual(3);
  });

  it('a path prefix and a limit narrow it, and LIKE metacharacters in a query are literal', async () => {
    expect(
      hits(await search(s.tokens.search, { q: 'audit', sha: head, path_prefix: 'docs/' })).map(
        (h) => h.path,
      ),
    ).toEqual(['docs/spec.md']);
    expect(hits(await search(s.tokens.search, { q: 'audit', sha: head, limit: '1' }))).toHaveLength(
      1,
    );
    expect(hits(await search(s.tokens.search, { q: '%%', sha: head }))).toHaveLength(0);
  });

  it('answers only for the commit it was built at: another commit is stale (409), never an answer from this one', async () => {
    const r = await search(s.tokens.search, { q: 'audit', sha: 'b'.repeat(40) });
    expect(r.status).toBe(409);
    expect(r.text).not.toContain('audit log');
  });

  it('a file the secret ruleset hits is not indexed (not even around the secret), nor is a binary file', async () => {
    expect((await search(s.tokens.search, { q: 'audit key', sha: head })).text).not.toContain(
      'keys.ts',
    );
    expect(hits(await search(s.tokens.search, { q: canary.slice(0, 12), sha: head }))).toHaveLength(
      0,
    );
    const all = await s.db.pool.query('SELECT path, content FROM knowledge.repo_file');
    expect(JSON.stringify(all.rows)).not.toContain(canary);
    expect(all.rows.map((x) => x.path)).not.toContain('img.bin');
    expect(all.rows.map((x) => x.path)).not.toContain('src/keys.ts');
  });

  it('no index: 404; a malformed query: 400; the scope is its own', async () => {
    const none = await s.call(
      s.tokens.search,
      'GET',
      `/v1/repos/acme/other/search?q=audit&sha=${head}`,
    );
    expect(none.status).toBe(404);
    expect((await search(s.tokens.search, { q: 'a', sha: head })).status).toBe(400);
    expect((await search(s.tokens.search, { q: 'audit', sha: 'nope' })).status).toBe(400);
    expect((await search(null, { q: 'audit', sha: head })).status).toBe(401);
    // census, security and none cannot search; search cannot read a census or a finding
    for (const t of [s.tokens.census, s.tokens.security, s.tokens.none]) {
      expect((await search(t, { q: 'audit', sha: head })).status).toBe(403);
    }
    expect((await s.call(s.tokens.search, 'GET', '/v1/repos/acme/app/census/latest')).status).toBe(
      403,
    );
    expect((await s.call(s.tokens.search, 'GET', '/v1/security/findings')).status).toBe(403);
  });

  it('a new census replaces the index whole', async () => {
    const before = await s.db.pool.query('SELECT commit_sha FROM knowledge.repo_index');
    expect(before.rows).toHaveLength(1);
    await s.runJob();
    const after = await s.db.pool.query('SELECT commit_sha, files FROM knowledge.repo_index');
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.files).toBe(2);
  });
});
