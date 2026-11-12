import { ISSUE_TWIN_LABEL, gapMarker, type CodeHostRead } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import type { IssueTrackerPort } from './issue-tracker.js';

// The issue tracker's contract (PLAN M16): the same behaviour from the in-memory fake's tracker view and from the
// GitHub adapter over the in-repo fake GitHub HTTP server. A world has TWO credentials on one host: the tracker's
// (`issues: write`, `metadata: read`) and another without `issues` (the Push Broker's), so the suite shows that only
// the tracker's credential files a twin, that it writes only to issues it filed itself, and that a person's close, a
// deleted issue and a host that does not answer read back as the host has them.

export const IT_REPO = 'acme/twin';
export const IT_GAP = 'gap:acme.twin:RS-DX-3:.';
export const IT_GAP_2 = 'gap:acme.twin:RS-DOC-2:.';

export interface IssueTrackerWorld {
  readonly tracker: IssueTrackerPort;
  /** A credential whose token has no `issues` permission (the Push Broker's). */
  readonly other: IssueTrackerPort;
  /** A person files an issue. */
  personOpens(o: {
    title: string;
    body?: string;
    labels?: string[];
    author: string;
  }): Promise<number>;
  personCloses(number: number, by: string): Promise<void>;
  /** The issue is deleted or transferred. */
  removeIssue(number: number): Promise<void>;
  /** The comments on an issue, in order: who wrote them and what. */
  comments(number: number): Promise<Array<{ by: string; body: string }>>;
  /** Every request answers "no answer" (5xx) until `unbreak`. */
  breakHost(): void;
  unbreak(): void;
  close?: () => Promise<void>;
}

const value = <T>(r: CodeHostRead<T>): T => {
  if (r.state !== 'ok') throw new Error(`${r.state}/${r.reason}: ${r.message}`);
  return r.value;
};

export const twinFile = (gap = IT_GAP, title = '[onboarding] .env.example (RS-DX-3)') => ({
  repo: IT_REPO,
  title,
  body: `${gapMarker(gap)}\n\nWhat is missing: an .env.example.\n\nFactory gap id: ${gap}`,
  labels: [ISSUE_TWIN_LABEL, 'gap:tracked'],
});

export function issueTrackerContract(
  name: string,
  makeWorld: () => Promise<IssueTrackerWorld>,
): void {
  describe(`IssueTrackerPort contract: ${name}`, () => {
    const withWorld = async (f: (w: IssueTrackerWorld) => Promise<void>): Promise<void> => {
      const w = await makeWorld();
      try {
        await f(w);
      } finally {
        await w.close?.();
      }
    };

    it('files a twin with its two labels and its marker, authored by the tracker; lists only labelled issues', () =>
      withWorld(async (w) => {
        const mine = value(await w.tracker.file_issue(twinFile()));
        const person = await w.personOpens({ title: 'a bug', body: 'it breaks', author: 'octo' });
        expect(person).not.toBe(mine.number);
        const listed = value(
          await w.tracker.list_labelled({ repo: IT_REPO, label: ISSUE_TWIN_LABEL }),
        );
        expect(listed.map((i) => i.number)).toEqual([mine.number]);
        const one = value(await w.tracker.read_issue({ repo: IT_REPO, number: mine.number }));
        expect(one).toMatchObject({
          number: mine.number,
          state: 'open',
          title: '[onboarding] .env.example (RS-DX-3)',
          author: { login: w.tracker.login, type: 'Bot' },
          closed_by: null,
        });
        expect([...one.labels].sort()).toEqual([ISSUE_TWIN_LABEL, 'gap:tracked']);
        expect(one.body).toContain(gapMarker(IT_GAP));
        const theirs = value(await w.tracker.read_issue({ repo: IT_REPO, number: person }));
        expect(theirs.author).toEqual({ login: 'octo', type: 'User' });
      }));

    it('refuses what is not a twin, and a credential without issues:write files nothing', () =>
      withWorld(async (w) => {
        for (const bad of [
          { ...twinFile(), labels: [ISSUE_TWIN_LABEL, 'gap:tracked', 'bug'] },
          { ...twinFile(), labels: ['gap:tracked', 'gap:blocking'] },
          { ...twinFile(), body: 'no marker at all' },
          { ...twinFile(), body: `${gapMarker(IT_GAP)} ${gapMarker(IT_GAP_2)}` },
          { ...twinFile(), title: 'Fix the env file' },
        ]) {
          const r = await w.tracker.file_issue(bad);
          expect(r.state === 'unreadable' && r.reason, JSON.stringify(bad.labels)).toBe('refused');
        }
        expect((await w.other.file_issue(twinFile())).state).toBe('unreadable');
        expect(
          value(await w.tracker.list_labelled({ repo: IT_REPO, label: ISSUE_TWIN_LABEL })),
        ).toEqual([]);
      }));

    it('comments on and closes its own twin; never writes to a person’s issue, even one that copies the marker', () =>
      withWorld(async (w) => {
        const mine = value(await w.tracker.file_issue(twinFile())).number;
        value(
          await w.tracker.comment_issue({ repo: IT_REPO, number: mine, body: 'verified at abc' }),
        );
        expect(value(await w.tracker.close_issue({ repo: IT_REPO, number: mine }))).toEqual({
          number: mine,
        });
        // closing again is a no-op, not an error
        expect((await w.tracker.close_issue({ repo: IT_REPO, number: mine })).state).toBe('ok');
        const closed = value(await w.tracker.read_issue({ repo: IT_REPO, number: mine }));
        expect(closed).toMatchObject({ state: 'closed', closed_by: w.tracker.login });
        expect(await w.comments(mine)).toEqual([{ by: w.tracker.login, body: 'verified at abc' }]);

        const copy = await w.personOpens({
          title: '[onboarding] copied',
          body: gapMarker(IT_GAP_2),
          labels: [ISSUE_TWIN_LABEL],
          author: 'octo',
        });
        const c = await w.tracker.comment_issue({ repo: IT_REPO, number: copy, body: 'x' });
        expect(c.state === 'unreadable' && c.reason).toBe('refused');
        const k = await w.tracker.close_issue({ repo: IT_REPO, number: copy });
        expect(k.state === 'unreadable' && k.reason).toBe('refused');
        expect(await w.comments(copy)).toEqual([]);
        expect(value(await w.tracker.read_issue({ repo: IT_REPO, number: copy })).state).toBe(
          'open',
        );
      }));

    it('a person’s close reads back closed with who closed it; a removed issue is not found', () =>
      withWorld(async (w) => {
        const a = value(await w.tracker.file_issue(twinFile())).number;
        const b = value(
          await w.tracker.file_issue(twinFile(IT_GAP_2, '[onboarding] CONTRIBUTING (RS-DOC-2)')),
        ).number;
        await w.personCloses(a, 'mona');
        expect(value(await w.tracker.read_issue({ repo: IT_REPO, number: a }))).toMatchObject({
          state: 'closed',
          closed_by: 'mona',
        });
        await w.removeIssue(b);
        const gone = await w.tracker.read_issue({ repo: IT_REPO, number: b });
        expect(gone.state === 'unreadable' && gone.reason).toBe('not_found');
        const listed = value(
          await w.tracker.list_labelled({ repo: IT_REPO, label: ISSUE_TWIN_LABEL }),
        );
        expect(listed.map((i) => [i.number, i.state])).toEqual([[a, 'closed']]);
      }));

    it('no answer is unknown, never an empty list', () =>
      withWorld(async (w) => {
        w.breakHost();
        const r = await w.tracker.list_labelled({ repo: IT_REPO, label: ISSUE_TWIN_LABEL });
        expect(r.state).toBe('unknown');
        expect((await w.tracker.file_issue(twinFile())).state).toBe('unknown');
        w.unbreak();
        expect(
          (await w.tracker.list_labelled({ repo: IT_REPO, label: ISSUE_TWIN_LABEL })).state,
        ).toBe('ok');
      }));
  });
}
