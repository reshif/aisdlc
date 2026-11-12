import {
  AgentPullsFact,
  InboundFactPayload,
  ProjectId,
  inboundFactStream,
} from '@aisdlc/contracts';
import { withTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { FakeGitHub, readUnknown } from '@aisdlc/ports';
import { contractSeed } from '@aisdlc/ports/testing';
import { migrateRecord } from '@aisdlc/record';
import { describe, expect, it } from 'vitest';
import { FakeWatchedPulls, observeAgentPulls } from '../src/index.js';

// M15.2: the agent PRs are polled and recorded as one `agent_pulls` fact per repo, only when something changed; a PR
// that cannot be read writes nothing (an unreadable merge state is never news).

async function withDb<T>(fn: (t: TestDatabase) => Promise<T>): Promise<T> {
  return withTestDatabase(async (t) => {
    await migrateRecord(t.pool);
    return fn(t);
  });
}

async function facts(t: TestDatabase, repo: string) {
  const r = await t.pool.query<{ body: unknown }>(
    'SELECT body FROM record.record_event WHERE stream = $1 ORDER BY seq',
    [inboundFactStream('agent_pulls', repo)],
  );
  return r.rows.map((x) => AgentPullsFact.parse(InboundFactPayload.parse(x.body).value));
}

const project = ProjectId.parse('acme');

describe('agent_pulls', () => {
  it('records the watched PRs once, again only when one changes, and nothing for an unreadable read', () =>
    withDb(async (t) => {
      const gh = new FakeGitHub(contractSeed());
      const n = gh.openPull('acme/app', {
        head_ref: 'agent/x/main',
        head_sha: '1'.repeat(40),
        author: 'aisdlc[bot]',
      });
      const watched = new FakeWatchedPulls().set([
        { repo: 'acme/app', project_id: project, number: n },
      ]);
      const d = { pool: t.pool, source: gh, watched };

      expect((await observeAgentPulls(d)).recorded).toEqual([
        { repo: 'acme/app', outcome: 'recorded' },
      ]);
      expect((await observeAgentPulls(d)).recorded).toEqual([
        { repo: 'acme/app', outcome: 'unchanged' },
      ]);
      const [first] = await facts(t, 'acme/app');
      expect(first?.pulls).toEqual([
        {
          number: n,
          state: 'open',
          merged: false,
          head_sha: '1'.repeat(40),
          base_ref: 'main',
          base_sha: 'a'.repeat(40),
          mergeable: 'current',
          merge_commit_sha: null,
          merged_at: null,
          merged_by: null,
        },
      ]);

      // the host cannot answer: no fact, the repo is reported failing
      gh.breakMethod('pr_status', readUnknown('network', 'down'));
      gh.landPull('acme/app', n, 'carol-gh');
      const broken = await observeAgentPulls(d);
      expect(broken.recorded).toEqual([]);
      expect(broken.failed.map((f) => f.repo)).toEqual(['acme/app']);
      expect(await facts(t, 'acme/app')).toHaveLength(1);

      gh.unbreak();
      expect((await observeAgentPulls(d)).recorded[0]?.outcome).toBe('recorded');
      const merged = (await facts(t, 'acme/app')).at(-1)?.pulls[0];
      expect(merged).toMatchObject({
        state: 'closed',
        merged: true,
        merged_by: 'carol-gh',
        merged_at: '2026-11-12T12:00:00.000Z',
      });
      expect(merged?.merge_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    }));

  it('a watched list nobody can read is an error, never "nothing to watch"', async () => {
    const watched = new FakeWatchedPulls().breakIt();
    await expect(
      observeAgentPulls({
        pool: undefined as never,
        source: new FakeGitHub(contractSeed()),
        watched,
      }),
    ).rejects.toThrow(/could not be read/);
  });
});
