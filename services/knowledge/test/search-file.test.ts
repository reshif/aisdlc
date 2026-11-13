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

// The onboarder's RepoRead backend: one file of the indexed head tree at the commit the caller names. Same index, same
// commit rule and scope as the search; never a file the secret ruleset hits (then or now), a binary or an absent file
// (one answer for all three), a window of at most 400 lines, a path that stays inside the repository.

const scratch = scratchDir();
const canary = makeCanary('file-test');
let s: KnowledgeStack;
let head = '';

beforeAll(async () => {
  const r = new FixtureRepo(scratch.dir, 's');
  r.write(
    'src/audit.ts',
    'export function writeAudit() {}\n// the audit log is one table\nexport const x = 1;\n',
  );
  r.write('src/keys.ts', `export const K = '${canary}';\n`);
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

const file = (token: string | null, q: Record<string, string>) =>
  s.call(token, 'GET', `/v1/repos/acme/app/file?${new URLSearchParams(q).toString()}`);

interface FileJson {
  path: string;
  blob_sha: string;
  commit_sha: string;
  content: string;
  total_lines: number;
  truncated: boolean;
  line_from: number;
  line_to: number;
}

describe('file (the onboarder’s RepoRead)', () => {
  it('returns one indexed file at the named commit, with its blob and a window of lines', async () => {
    const r = await file(s.tokens.search, { path: 'src/audit.ts', sha: head });
    expect(r.status).toBe(200);
    const f = r.json as FileJson;
    expect(f.path).toBe('src/audit.ts');
    expect(f.commit_sha).toBe(head);
    expect(f.blob_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(f.content).toContain('the audit log is one table');
    expect(f.truncated).toBe(false);
    const part = (
      await file(s.tokens.search, { path: 'src/audit.ts', sha: head, line_from: '2', line_to: '2' })
    ).json as FileJson;
    expect(part.content).toBe('// the audit log is one table');
    expect([part.line_from, part.line_to]).toEqual([2, 2]);
  });

  it('never a file the index does not hold or the ruleset hits: one answer for absent, binary and secret (404 not_available)', async () => {
    for (const path of ['src/keys.ts', 'img.bin', 'nope.txt']) {
      const r = await file(s.tokens.search, { path, sha: head });
      expect(r.status).toBe(404);
      expect(r.text).toContain('not_available');
      expect(r.text).not.toContain(canary);
    }
  });

  it('a file that holds a secret by the CURRENT ruleset is not served even if it was indexed before', async () => {
    await s.db.pool.query(
      "INSERT INTO knowledge.repo_file (repo, path, blob_sha, content) VALUES ('acme/app', 'late.txt', $1, $2)",
      ['c'.repeat(40), `token = ${canary}\n`],
    );
    const r = await file(s.tokens.search, { path: 'late.txt', sha: head });
    expect(r.status).toBe(404);
    expect(r.text).not.toContain(canary);
    await s.db.pool.query("DELETE FROM knowledge.repo_file WHERE path = 'late.txt'");
  });

  it('a long file is cut to a window of 400 lines and says so', async () => {
    const long = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n');
    await s.db.pool.query(
      "INSERT INTO knowledge.repo_file (repo, path, blob_sha, content) VALUES ('acme/app', 'long.txt', $1, $2)",
      ['d'.repeat(40), long],
    );
    const r = (await file(s.tokens.search, { path: 'long.txt', sha: head })).json as FileJson;
    expect(r.truncated).toBe(true);
    expect(r.line_to).toBe(400);
    expect(r.total_lines).toBe(900);
    expect(r.content.split('\n')).toHaveLength(400);
    const next = (await file(s.tokens.search, { path: 'long.txt', sha: head, line_from: '401' }))
      .json as FileJson;
    expect(next.content.startsWith('line 401')).toBe(true);
    await s.db.pool.query("DELETE FROM knowledge.repo_file WHERE path = 'long.txt'");
  });

  it('the commit rule, the path rule and the scope', async () => {
    expect(
      (await file(s.tokens.search, { path: 'src/audit.ts', sha: 'b'.repeat(40) })).status,
    ).toBe(409);
    for (const path of ['../etc/passwd', '/etc/passwd', 'a/../../b']) {
      expect((await file(s.tokens.search, { path, sha: head })).status).toBe(400);
    }
    expect((await file(s.tokens.search, { sha: head })).status).toBe(400);
    expect((await file(null, { path: 'src/audit.ts', sha: head })).status).toBe(401);
    for (const t of [s.tokens.census, s.tokens.security, s.tokens.none]) {
      expect((await file(t, { path: 'src/audit.ts', sha: head })).status).toBe(403);
    }
    const none = await s.call(
      s.tokens.search,
      'GET',
      `/v1/repos/acme/other/file?path=a&sha=${head}`,
    );
    expect(none.status).toBe(404);
  });
});
