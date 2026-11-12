import {
  ISSUE_TWIN_EVENT,
  ISSUE_TWIN_LABEL,
  ISSUE_TWIN_LEDGER_ENTRY_TYPE,
  WORK_EVENT,
  gapMarker,
  issueTwinStream,
  workStream,
  type Gap,
  type IssueTwinDisposition,
} from '@aisdlc/contracts';
import { hashCanonical, sha256Hex } from '@aisdlc/kernel';
import { recordObservation } from '@aisdlc/loops';
import { readUnknown, type IssueTrackerPort } from '@aisdlc/ports';
import { lintText } from '@aisdlc/text-lint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CensusGapRecheck,
  FakeKnowledge,
  approveBatch,
  issueTwinView,
  linkDuplicate,
  readTwin,
  renderTwin,
  requestFromTwin,
  syncIssueTwins,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import { censusFixture } from './cards-fixtures.js';
import { HEAD, TRACKER_LOGIN, seedTwinRepo, type Seeded } from './issue-twin-fixtures.js';
import { loadReports } from './prr-fixtures.js';

// The GitHub issue twin in core (PLAN M16; OB §7; DEC-20(a)): a batch a person approves (record event + ledger entry,
// the exact list and the hash of the rendered bodies), the sync that files exactly that list (dedupe by the record's
// map and by marker), the poll signals (a person's close, a re-check, a deleted issue), the remediation request that
// goes through the normal intake, and the disclosure rule (SEC-OB-4). Real Postgres, ledger and Notary; the code host
// is the in-memory FakeGitHub through the tracker's own credential.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
});
afterAll(async () => {
  await s.stop();
});

const okv = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const ldeps = () => ({ ...s.deps, ledger: s.config.ledger });
const seed = (o: Parameters<typeof seedTwinRepo>[1] = {}) => seedTwinRepo(s, o);

const rows = (
  t: Seeded,
  pick: (g: Gap) => IssueTwinDisposition | null,
): Array<{ gap_id: string; disposition: IssueTwinDisposition }> =>
  t.gaps.flatMap((g) => {
    const d = pick(g);
    return d ? [{ gap_id: g.gap_id, disposition: d }] : [];
  });

const approve = (t: Seeded, pick: (g: Gap) => IssueTwinDisposition | null, by = 'alice') =>
  approveBatch(ldeps(), pid(t.project), {
    repo: t.repo as never,
    rows: rows(t, pick) as never,
    on_behalf_of: pr(by),
  });

const twinEventsOf = async (repo: string, type: string) =>
  (
    await s.record.pool.query<{ body: Record<string, unknown> }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq',
      [issueTwinStream(repo), type],
    )
  ).rows.map((r) => r.body);

const sync = async (t: Seeded) => okv(await syncIssueTwins(t.sync));

const first = (t: Seeded, criterion: string): Gap => {
  const g = t.gaps.find((x) => x.criterion === criterion);
  if (!g) throw new Error(`no gap ${criterion}`);
  return g;
};

describe('a batch is a decision event: the exact list and the hash of the rendered bodies, on the record and the ledger', () => {
  it('the view offers every open public-safe gap with its default; a batch is recorded and ledgered', async () => {
    const t = await seed({ fileIssue: ['RS-BT-2'] });
    const before = okv({ ok: true, value: await issueTwinView(s.record.pool, t.project) });
    const repo = before.repos[0];
    expect(repo?.candidates.length).toBe(t.gaps.length);
    expect(repo?.candidates.find((c) => c.criterion === 'RS-BT-2')?.default).toBe('file_issue');
    expect(repo?.candidates.find((c) => c.criterion === 'RS-BT-5')?.default).toBe('track_only');
    expect(repo?.candidates.every((c) => c.disclosure === 'pass')).toBe(true);

    const filed = ['RS-BT-2', 'RS-BT-5', 'RS-TH-1'];
    const b = okv(
      await approve(t, (g) => (filed.includes(g.criterion) ? 'file_issue' : 'track_only')),
    );
    expect(b).toMatchObject({ filed: 3, tracked: t.gaps.length - 3 });

    const [ev] = await twinEventsOf(t.repo, ISSUE_TWIN_EVENT.batch_approved);
    const fileRows = (
      ev?.['rows'] as Array<{ gap_id: string; disposition: string; body_sha256: string | null }>
    ).filter((r) => r.disposition === 'file_issue');
    expect(fileRows.map((r) => r.body_sha256).sort()).toEqual(
      filed.map((c) => renderTwin(first(t, c)).body_sha256).sort(),
    );
    expect(b.bodies_hash).toBe(
      hashCanonical(fileRows.map((r) => ({ gap_id: r.gap_id, body_sha256: r.body_sha256 }))),
    );
    const entry = (
      await s.record.pool.query<{
        subject_hash: string;
        subject_kind: string;
        actor: string;
        body: Record<string, unknown>;
      }>(
        'SELECT subject_hash, subject_kind, actor, body FROM ledger.ledger_entry WHERE entry_id = $1 AND entry_type = $2',
        [b.ledger_entry_id, ISSUE_TWIN_LEDGER_ENTRY_TYPE],
      )
    ).rows[0];
    expect(entry).toMatchObject({
      subject_hash: b.bodies_hash,
      subject_kind: 's0_record',
      actor: 'alice',
    });
    expect(entry?.body['kind']).toBe('issue_twin_batch');
    expect((entry?.body['rows'] as unknown[]).length).toBe(t.gaps.length);

    const after = await issueTwinView(s.record.pool, t.project);
    expect(after.repos[0]?.candidates.map((c) => c.criterion).sort()).toEqual(
      t.gaps
        .filter((g) => !filed.includes(g.criterion))
        .map((g) => g.criterion)
        .sort(),
    );
    expect(after.repos[0]?.twins.map((x) => [x.criterion, x.state])).toEqual(
      filed.map((c) => [c, 'pending']).sort(),
    );
    expect(after.repos[0]?.batches).toEqual([
      expect.objectContaining({
        batch_id: b.batch_id,
        filed: 3,
        ledger_entry_id: b.ledger_entry_id,
      }),
    ]);
  });

  it('refuses a gap it does not know, a gap twice, a gap that already has a twin, and an empty batch', async () => {
    const t = await seed();
    const g = t.gaps[0] as Gap;
    const bad = async (r: Array<{ gap_id: string; disposition: IssueTwinDisposition }>) =>
      approveBatch(ldeps(), pid(t.project), {
        repo: t.repo as never,
        rows: r as never,
        on_behalf_of: pr('alice'),
      });
    expect(
      await bad([{ gap_id: 'gap:acme.nope:RS-BT-2:.', disposition: 'file_issue' }]),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(
      await bad([
        { gap_id: g.gap_id, disposition: 'file_issue' },
        { gap_id: g.gap_id, disposition: 'track_only' },
      ]),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    okv(await bad([{ gap_id: g.gap_id, disposition: 'file_issue' }]));
    expect(await bad([{ gap_id: g.gap_id, disposition: 'file_issue' }])).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    // a repo that is not the project's is not found
    expect(
      await approveBatch(ldeps(), pid('tw-nobody'), {
        repo: t.repo as never,
        rows: [{ gap_id: g.gap_id, disposition: 'file_issue' }] as never,
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect((await twinEventsOf(t.repo, ISSUE_TWIN_EVENT.batch_approved)).length).toBe(1);
  });
});

describe('the sync files exactly the approved list, once', () => {
  it('approved N -> exactly N issues with the two labels and the marker; a re-run files 0', async () => {
    const t = await seed();
    const filed = ['RS-BT-2', 'RS-CC-3'];
    okv(await approve(t, (g) => (filed.includes(g.criterion) ? 'file_issue' : 'track_only')));
    const r1 = await sync(t);
    expect(r1).toMatchObject({ filed: 2, reconciled: 0 });
    const issues = t.host.issuesOf(t.repo);
    expect(issues.length).toBe(2);
    for (const i of issues) {
      expect([...i.labels].sort()).toEqual([ISSUE_TWIN_LABEL, 'gap:tracked']);
      expect(i.author).toEqual({ login: TRACKER_LOGIN, type: 'Bot' });
      const gap = t.gaps.find((g) => i.body.includes(gapMarker(g.gap_id)));
      expect(gap && sha256Hex(i.body)).toBe(gap && renderTwin(gap).body_sha256);
    }
    const r2 = await sync(t);
    expect(r2).toMatchObject({ filed: 0, reconciled: 0 });
    expect(t.host.issuesOf(t.repo).length).toBe(2);
    const v = await issueTwinView(s.record.pool, t.project);
    expect(v.repos[0]?.twins.map((x) => [x.state, x.via])).toEqual([
      ['open', 'created'],
      ['open', 'created'],
    ]);
    // record first: the intent is in the record before the issue, the link after it
    expect((await twinEventsOf(t.repo, ISSUE_TWIN_EVENT.file_intended)).length).toBe(2);
  });

  it('an issue filed whose answer was lost is found by its marker, not filed twice', async () => {
    const t = await seed();
    okv(await approve(t, (g) => (g.criterion === 'RS-BT-2' ? 'file_issue' : null)));
    // the host files the issue but the answer never arrives
    const lossy: IssueTrackerPort = {
      login: t.tracker.login,
      list_labelled: (q) => t.tracker.list_labelled(q),
      read_issue: (q) => t.tracker.read_issue(q),
      comment_issue: (q) => t.tracker.comment_issue(q),
      close_issue: (q) => t.tracker.close_issue(q),
      file_issue: async (q) => {
        await t.tracker.file_issue(q);
        return readUnknown('timeout', 'timed out');
      },
    };
    expect(okv(await syncIssueTwins({ ...t.sync, tracker: lossy }))).toMatchObject({ filed: 0 });
    expect(t.host.issuesOf(t.repo).length).toBe(1);
    expect(await sync(t)).toMatchObject({ filed: 0, reconciled: 1 });
    expect(t.host.issuesOf(t.repo).length).toBe(1);
    const tw = await readTwin(s.record.pool, t.repo);
    expect([...tw.twins.values()].map((x) => [x.via, x.number])).toEqual([
      ['reconciled', t.host.issuesOf(t.repo)[0]?.number],
    ]);
  });

  it('a person’s issue that copies the marker is not taken for the twin; a host that does not answer files nothing', async () => {
    const t = await seed();
    const g = first(t, 'RS-BT-2');
    t.host.openIssue(t.repo, {
      title: 'copied',
      body: gapMarker(g.gap_id),
      labels: [ISSUE_TWIN_LABEL],
      author: 'mallory',
    });
    okv(await approve(t, (x) => (x.gap_id === g.gap_id ? 'file_issue' : null)));
    t.host.breakChecksApi(readUnknown('server_error', 'down'));
    expect(await sync(t)).toMatchObject({ filed: 0, reconciled: 0 });
    expect((await twinEventsOf(t.repo, ISSUE_TWIN_EVENT.file_intended)).length).toBe(0);
    t.host.unbreak();
    expect(await sync(t)).toMatchObject({ filed: 1, reconciled: 0 });
    expect(t.host.issuesOf(t.repo).filter((i) => i.author.login === TRACKER_LOGIN).length).toBe(1);
  });
});

describe('poll sync: a person’s close, the re-check, a deleted issue', () => {
  it('human close -> re-check fails -> closed_unverified, ONE comment, not reopened; a second close adds none', async () => {
    const t = await seed();
    okv(await approve(t, (g) => (g.criterion === 'RS-BT-2' ? 'file_issue' : null)));
    await sync(t);
    const number = t.host.issuesOf(t.repo)[0]?.number as number;
    t.recheck.set(t.repo, 'RS-BT-2', 'fail', HEAD);
    // open and failing: nothing is written
    expect(await sync(t)).toMatchObject({ verified: 0, unverified: 0 });
    expect(t.host.issuesOf(t.repo)[0]?.comments).toEqual([]);
    t.host.closeIssueAs(t.repo, number, 'mona');
    expect(await sync(t)).toMatchObject({ unverified: 1 });
    const one = t.host.issuesOf(t.repo)[0];
    expect(one?.state).toBe('closed');
    expect(one?.comments.map((c) => c.body)).toEqual([
      expect.stringContaining(`the criterion is not met at \`${HEAD}\``),
    ]);
    await sync(t);
    // reopened by a person, closed again: the twin follows; still one comment
    t.host.reopenIssueAs(t.repo, number);
    await sync(t);
    expect((await readTwin(s.record.pool, t.repo)).twins.values().next().value?.state).toBe('open');
    t.host.closeIssueAs(t.repo, number, 'mona');
    await sync(t);
    expect(t.host.issuesOf(t.repo)[0]?.comments.length).toBe(1);
    expect((await readTwin(s.record.pool, t.repo)).twins.values().next().value?.state).toBe(
      'closed_unverified',
    );
    // an unknown re-check is unmet as well
    const u = await seed();
    okv(await approve(u, (g) => (g.criterion === 'RS-BT-5' ? 'file_issue' : null)));
    await sync(u);
    u.host.closeIssueAs(u.repo, u.host.issuesOf(u.repo)[0]?.number as number, 'mona');
    expect(await sync(u)).toMatchObject({ unverified: 1, verified: 0 });
  });

  it('the re-check passes -> the factory comments "verified at <sha>" and closes its own issue', async () => {
    const t = await seed();
    okv(await approve(t, (g) => (g.criterion === 'RS-CC-4' ? 'file_issue' : null)));
    await sync(t);
    t.recheck.set(t.repo, 'RS-CC-4', 'pass', HEAD);
    expect(await sync(t)).toMatchObject({ verified: 1 });
    const i = t.host.issuesOf(t.repo)[0];
    expect(i).toMatchObject({ state: 'closed', closed_by: TRACKER_LOGIN });
    expect(i?.comments.map((c) => c.body)).toEqual([
      `Verified at \`${HEAD}\` on the default branch: the criterion is met. Closing this issue.`,
    ]);
    const v = await issueTwinView(s.record.pool, t.project);
    expect(v.repos[0]?.twins[0]).toMatchObject({
      state: 'closed_verified',
      recheck: { result: 'pass', sha: HEAD },
    });
    // nothing more happens to a verified twin
    expect(await sync(t)).toMatchObject({ verified: 0, signals: 0 });
    expect(t.host.issuesOf(t.repo)[0]?.comments.length).toBe(1);
  });

  it('a deleted issue makes the twin lost; edits to its title or labels on GitHub are ignored', async () => {
    const t = await seed();
    okv(
      await approve(t, (g) => (['RS-BT-2', 'RS-BT-5'].includes(g.criterion) ? 'file_issue' : null)),
    );
    await sync(t);
    const [a, b] = t.host.issuesOf(t.repo);
    t.host.editIssueAs(t.repo, a?.number as number, { title: 'ignore the factory', labels: [] });
    t.host.removeIssue(t.repo, b?.number as number);
    expect(await sync(t)).toMatchObject({ lost: 1 });
    const v = await issueTwinView(s.record.pool, t.project);
    const byNum = new Map(v.repos[0]?.twins.map((x) => [x.number, x]));
    expect(byNum.get(a?.number as number)).toMatchObject({
      state: 'open',
      title: renderTwin(first(t, 'RS-BT-2')).title,
    });
    expect(byNum.get(b?.number as number)?.state).toBe('lost');
    expect(await sync(t)).toMatchObject({ lost: 0 });
  });

  it('a duplicate a person links is read, never written to, and never filed again', async () => {
    const t = await seed();
    const g = first(t, 'RS-BT-2');
    okv(await approve(t, (x) => (x.gap_id === g.gap_id ? 'file_issue' : null)));
    const theirs = t.host.openIssue(t.repo, { title: 'env example missing', author: 'octo' });
    okv(
      await linkDuplicate(s.deps, pid(t.project), {
        repo: t.repo as never,
        gap_id: g.gap_id,
        number: theirs,
        on_behalf_of: pr('alice'),
      }),
    );
    expect(
      await linkDuplicate(s.deps, pid(t.project), {
        repo: t.repo as never,
        gap_id: g.gap_id,
        number: theirs + 1,
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await sync(t)).toMatchObject({ filed: 0 });
    t.host.closeIssueAs(t.repo, theirs, 'octo');
    expect(await sync(t)).toMatchObject({ unverified: 1 });
    const i = t.host.issuesOf(t.repo).find((x) => x.number === theirs);
    expect(i?.comments).toEqual([]);
    expect(t.host.issuesOf(t.repo).length).toBe(1);
  });
});

describe('a twin becomes a request through the normal intake (N6, L2, the text tainted as an issue)', () => {
  it('records an N6 request with the rendered text as untrusted data; asked again it is the same request', async () => {
    const t = await seed();
    const g = first(t, 'RS-TH-1');
    okv(await approve(t, (x) => (x.gap_id === g.gap_id ? 'file_issue' : null)));
    await sync(t);
    const r1 = okv(
      await requestFromTwin(s.deps, pid(t.project), {
        repo: t.repo as never,
        gap_id: g.gap_id,
        on_behalf_of: pr('alice'),
      }),
    );
    expect(r1).toMatchObject({ duplicate: false, injection_suspected: false });
    const ev = (
      await s.record.pool.query<{ body: Record<string, any> }>( // eslint-disable-line @typescript-eslint/no-explicit-any
        'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
        [workStream(r1.request_id), WORK_EVENT.requested],
      )
    ).rows[0]?.body;
    expect(ev?.['lane']).toBe('L2');
    expect(ev?.['request_text']).toMatchObject({
      taint: 'untrusted',
      origin: 'issue',
      provenance: { channel: 'N6', source: 'factory_proposed', submitted_by: 'alice' },
    });
    expect(ev?.['request_text'].text).toContain(g.gap_id);
    const r2 = okv(
      await requestFromTwin(s.deps, pid(t.project), {
        repo: t.repo as never,
        gap_id: g.gap_id,
        on_behalf_of: pr('alice'),
      }),
    );
    expect(r2).toMatchObject({ duplicate: true, request_id: r1.request_id });
    const v = await issueTwinView(s.record.pool, t.project);
    expect(v.repos[0]?.twins[0]?.request?.request_id).toBe(r1.request_id);
    // a gap in no batch is refused
    const other = first(t, 'RS-BT-6');
    expect(
      await requestFromTwin(s.deps, pid(t.project), {
        repo: t.repo as never,
        gap_id: other.gap_id,
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
  });
});

describe('SEC-OB-4 disclosure golden test: a seeded public repo with a secret in its history', () => {
  it('the security gap is never offered, never filed, and no issue text names it, a path or a commit', async () => {
    const t = await seed({ golden: 'b', visibility: 'public' });
    const sec = t.gaps.find((g) => g.visibility_class === 'private_only') as Gap;
    expect(sec).toBeDefined();
    const v = await issueTwinView(s.record.pool, t.project);
    expect(v.repos[0]?.visibility).toBe('public');
    expect(v.repos[0]?.candidates.map((c) => c.gap_id)).not.toContain(sec.gap_id);
    expect(v.repos[0]?.private_only).toEqual([{ gap_id: sec.gap_id, criterion: sec.criterion }]);
    // a person cannot file it, or request from it
    expect(await approve(t, (g) => (g.gap_id === sec.gap_id ? 'file_issue' : null))).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    expect(
      await requestFromTwin(s.deps, pid(t.project), {
        repo: t.repo as never,
        gap_id: sec.gap_id,
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    // every other gap filed, then a person's close and a factory verify, so every kind of text is written
    okv(await approve(t, (g) => (g.gap_id === sec.gap_id ? 'track_only' : 'file_issue')));
    await sync(t);
    const issues = t.host.issuesOf(t.repo);
    expect(issues.length).toBe(t.gaps.length - 1);
    t.host.closeIssueAs(t.repo, issues[0]?.number as number, 'mona');
    t.recheck.set(
      t.repo,
      (t.gaps.find((g) => issues[1]?.body.includes(g.gap_id)) as Gap).criterion,
      'pass',
      HEAD,
    );
    await sync(t);
    const text = t.host
      .issuesOf(t.repo)
      .flatMap((i) => [i.title, i.body, ...i.comments.map((c) => c.body)]);
    for (const x of text) {
      expect(x).not.toContain('RS-SEC');
      expect(x).not.toMatch(/\bfindings?\b|fingerprint|hmac/i);
      // no path, no commit of the history: the only sha is the default branch's head a comment names
      expect(x.replaceAll(HEAD, '')).not.toMatch(/[0-9a-f]{40}/);
      expect(x).not.toMatch(/\/[\w.-]+\.\w+/);
      expect(lintText(x)).toEqual([]);
    }
  });
});

describe('the re-check is a census at exactly the default branch head', () => {
  it('pass or fail only from a census taken at the head the poll recorded; anything else is unknown', async () => {
    const repo = 'acme/rc-1';
    const knowledge = new FakeKnowledge();
    const rc = new CensusGapRecheck({ pool: s.record.pool, knowledge });
    const ask = () => rc.recheck({ repo, criterion: 'RS-BT-2', area: '.' });
    expect(await ask()).toMatchObject({ result: 'unknown', sha: null });
    await recordObservation(s.record.pool, {
      kind: 'default_branch_head',
      repo: repo as never,
      project_id: pid('rc-1'),
      value: { branch: 'main', sha: HEAD },
      poll_interval_ms: 600_000,
    });
    expect(await ask()).toMatchObject({ result: 'unknown', sha: HEAD });
    const latest = censusFixture(repo);
    const at = (status: 'met' | 'unmet', sha: string) => ({
      ...latest,
      census: {
        ...latest.census,
        baseline_sha: sha,
        criteria: latest.census.criteria.map((c) => (c.id === 'RS-BT-2' ? { ...c, status } : c)),
      },
    });
    knowledge.setCensusRecord(repo, at('met', 'f'.repeat(40)) as never);
    expect(await ask()).toMatchObject({
      result: 'unknown',
      reason: 'no census at the head of the default branch',
    });
    knowledge.setCensusRecord(repo, at('met', HEAD) as never);
    expect(await ask()).toMatchObject({ result: 'pass', sha: HEAD });
    knowledge.setCensusRecord(repo, at('unmet', HEAD) as never);
    expect(await ask()).toMatchObject({ result: 'fail', sha: HEAD });
    knowledge.down = true;
    expect(await ask()).toMatchObject({ result: 'unknown' });
  });
});
