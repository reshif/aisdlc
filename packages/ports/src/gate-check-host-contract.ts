import { GATE_CHECK_NAME, type CodeHostRead } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import type { GateCheckHostPort, PullCommit } from './gate-check-host.js';

// gate-check's code-host contract (PLAN M14.5): the same behaviour from the in-memory fake's App view and from
// gate-check's GitHub adapter over the in-repo fake GitHub HTTP server. A world has TWO credentials on one host:
// gate-check's App (`checks: write`, pull requests read) and another App without `checks: write` (the Push Broker's),
// so the suite shows that only gate-check's credential writes the check run, that a check run carries the App that
// wrote it, and that a person's PR, a new push and a merge read back as the host has them.

export const GC_REPO = 'acme/gc';
export const GC_HEAD_A = 'a'.repeat(40);
export const GC_HEAD_B = 'b'.repeat(40);
/** The seeded head of `main` in every world. */
export const GC_BASE = 'c'.repeat(40);

export interface GateCheckHostWorld {
  /** gate-check's App. */
  readonly checks: GateCheckHostPort;
  /** An App whose token has no `checks: write` (the Push Broker's). */
  readonly other: GateCheckHostPort;
  /** A person opens a PR from `head_ref` at `head_sha`. */
  openPull(o: {
    head_ref: string;
    head_sha: string;
    author: string;
    title?: string;
    body?: string;
    commits?: readonly PullCommit[];
  }): Promise<number>;
  pushToPull(number: number, sha: string): Promise<void>;
  landPull(number: number, by: string): Promise<void>;
  /** Every request answers "no answer" (5xx) until `unbreak`. */
  breakHost(): void;
  unbreak(): void;
  close?: () => Promise<void>;
}

const value = <T>(r: CodeHostRead<T>): T => {
  if (r.state !== 'ok') throw new Error(`${r.state}/${r.reason}: ${r.message}`);
  return r.value;
};

export function gateCheckHostContract(
  name: string,
  makeWorld: () => Promise<GateCheckHostWorld>,
): void {
  describe(`GateCheckHostPort contract: ${name}`, () => {
    const withWorld = async (f: (w: GateCheckHostWorld) => Promise<void>): Promise<void> => {
      const w = await makeWorld();
      try {
        await f(w);
      } finally {
        await w.close?.();
      }
    };

    it('lists a person’s open PR with its author, head and commits', () =>
      withWorld(async (w) => {
        const n = await w.openPull({
          head_ref: 'feature/x',
          head_sha: GC_HEAD_A,
          author: 'octo',
          title: 'Fix it',
          body: 'body text',
          commits: [{ sha: GC_HEAD_A, message: 'fix it' }],
        });
        const open = value(await w.checks.list_pulls({ repo: GC_REPO, state: 'open' }));
        const pr = open.find((p) => p.number === n);
        expect(pr).toMatchObject({
          state: 'open',
          merged: false,
          head_sha: GC_HEAD_A,
          head_ref: 'feature/x',
          author: { login: 'octo', type: 'User' },
          title: 'Fix it',
          body: 'body text',
          merged_by: null,
        });
        expect(value(await w.checks.pull_commits({ repo: GC_REPO, number: n }))).toEqual([
          { sha: GC_HEAD_A, message: 'fix it' },
        ]);
        expect(value(await w.checks.list_pulls({ repo: GC_REPO, state: 'closed' }))).toEqual([]);
        expect(value(await w.checks.branch_head({ repo: GC_REPO, branch: 'main' }))).toBe(GC_BASE);
        expect((await w.checks.branch_head({ repo: GC_REPO, branch: 'nope' })).state).toBe(
          'unreadable',
        );
      }));

    it('writes aisdlc/gate through gate-check’s App only; the run carries that App id', () =>
      withWorld(async (w) => {
        await w.openPull({ head_ref: 'feature/y', head_sha: GC_HEAD_A, author: 'octo' });
        const run = {
          repo: GC_REPO,
          head_sha: GC_HEAD_A,
          name: GATE_CHECK_NAME,
          status: 'completed' as const,
          conclusion: 'failure' as const,
          external_id: 'v1',
          title: 'not factory work',
          summary: 'a person’s PR',
        };
        const wrote = value(await w.checks.write_check_run(run));
        expect(wrote.app_id).toBe(w.checks.app_id);
        // the other App's token has no checks:write: refused, nothing written
        const refused = await w.other.write_check_run({ ...run, external_id: 'v2' });
        expect(refused.state).toBe('unreadable');
        const runs = value(
          await w.checks.check_runs({ repo: GC_REPO, sha: GC_HEAD_A, name: GATE_CHECK_NAME }),
        );
        expect(runs.map((r) => [r.app_id, r.status, r.conclusion])).toEqual([
          [w.checks.app_id, 'completed', 'failure'],
        ]);
        expect(
          value(
            await w.checks.check_runs({ repo: GC_REPO, sha: GC_HEAD_B, name: GATE_CHECK_NAME }),
          ),
        ).toEqual([]);
      }));

    it('refuses a check run gate-check may not write (neutral, a completed run without a conclusion)', () =>
      withWorld(async (w) => {
        const base = {
          repo: GC_REPO,
          head_sha: GC_HEAD_A,
          name: GATE_CHECK_NAME,
          external_id: 'v',
          title: 't',
          summary: 's',
        };
        expect(
          (
            await w.checks.write_check_run({
              ...base,
              status: 'completed',
              conclusion: 'neutral' as never,
            })
          ).state,
        ).toBe('unreadable');
        expect(
          (await w.checks.write_check_run({ ...base, status: 'completed', conclusion: null }))
            .state,
        ).toBe('unreadable');
        expect(
          (await w.checks.write_check_run({ ...base, status: 'in_progress', conclusion: null }))
            .state,
        ).toBe('ok');
      }));

    it('a new push moves the PR head; a merge reads back closed, merged, with who merged it', () =>
      withWorld(async (w) => {
        const n = await w.openPull({ head_ref: 'feature/z', head_sha: GC_HEAD_A, author: 'octo' });
        await w.pushToPull(n, GC_HEAD_B);
        const open = value(await w.checks.list_pulls({ repo: GC_REPO, state: 'open' }));
        expect(open.find((p) => p.number === n)?.head_sha).toBe(GC_HEAD_B);
        const commits = value(await w.checks.pull_commits({ repo: GC_REPO, number: n }));
        expect(commits.map((c) => c.sha)).toContain(GC_HEAD_B);
        await w.landPull(n, 'mona');
        const closed = value(await w.checks.list_pulls({ repo: GC_REPO, state: 'closed' }));
        const pr = closed.find((p) => p.number === n);
        expect(pr).toMatchObject({
          state: 'closed',
          merged: true,
          merged_by: 'mona',
          head_sha: GC_HEAD_B,
        });
        expect(pr?.merge_commit_sha).toMatch(/^[0-9a-f]{40}$/);
      }));

    it('no answer is unknown, never an empty list', () =>
      withWorld(async (w) => {
        w.breakHost();
        const r = await w.checks.list_pulls({ repo: GC_REPO, state: 'open' });
        expect(r.state).toBe('unknown');
        const c = await w.checks.check_runs({
          repo: GC_REPO,
          sha: GC_HEAD_A,
          name: GATE_CHECK_NAME,
        });
        expect(c.state).toBe('unknown');
        w.unbreak();
        expect((await w.checks.list_pulls({ repo: GC_REPO, state: 'open' })).state).toBe('ok');
      }));
  });
}
