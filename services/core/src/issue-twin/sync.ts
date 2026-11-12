import {
  ISSUE_TWIN_EVENT,
  ISSUE_TWIN_LABEL,
  ISSUE_TWIN_STREAM_PREFIX,
  IssueTwinFileIntended,
  IssueTwinLinked,
  IssueTwinRechecked,
  IssueTwinSignal,
  IssueTwinStateChanged,
  IssueTwinWriteDone,
  IssueTwinWriteIntended,
  issueTwinStream,
  parseGapId,
  parseGapMarkers,
  type Gap,
  type IssueTwinWrite,
} from '@aisdlc/contracts';
import { ok, sha256Hex, type Result } from '@aisdlc/kernel';
import type { LoopSpec } from '@aisdlc/loops';
import {
  isOwnIssue,
  type GapRecheck,
  type GapRecheckPort,
  type IssueTrackerPort,
  type TrackedIssue,
} from '@aisdlc/ports';
import type { NewEvent } from '@aisdlc/record';
import type { CoreError } from '../errors.js';
import { inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { readGoverning } from '../prr-store.js';
import { foldIssueTwin, type TwinRow, type TwinState } from './fold.js';
import { renderTwin, unverifiedComment, verifiedComment } from './render.js';
import { ISSUE_TWIN_ACTOR, twinEvents, twinLockKey } from './twin.js';

// The issue twin's sync (PLAN M16; OB §6.5 "labelled factory issues: every 10 min"; OB §7 "Sync, poll-only"). One tick
// walks every repo with an approved batch and, RECORD FIRST, does what the record says is owed:
//
//   file     a twin approved and not linked yet. Dedupe before anything is written: (1) the record's gap -> issue map
//            (a linked twin is never filed again), (2) a reconcile of the labelled issues by their hidden marker (an
//            issue the tracker filed but whose answer was lost is found, not filed twice). Only when the labelled list
//            reads `ok` and finds nothing is `issue_twin.file_intended` recorded and the issue filed, with exactly the
//            body whose hash the batch approved (a body that renders differently now is not filed: the batch is stale).
//   poll     each linked twin is read; what was seen is recorded (`issue_twin.signal_observed`) when it changed. A
//            deleted or transferred issue makes the twin `lost`.
//   recheck  a person closed the issue: the criterion is re-checked at the default branch's head. Pass ->
//            `closed_verified`; anything else (fail, unknown) -> `closed_unverified` with ONE comment, and the issue is
//            not reopened. The re-check passes while the twin is open (or closed unverified) -> it comments "verified
//            at <sha>" and closes its own issue. An issue never closes a gap: the gap ledger is the readiness record's.
//
// Writes go only to the tracker's own issues (its bot and its marker); a person's issue linked as a duplicate is read,
// never written to. Fail closed: a read that is not `ok` changes nothing, and nothing is filed without a dedupe.

export interface IssueTwinSyncDeps extends CoreDeps {
  readonly tracker: IssueTrackerPort;
  readonly recheck: GapRecheckPort;
}

export interface IssueTwinSyncReport {
  readonly repos: number;
  readonly filed: number;
  readonly reconciled: number;
  readonly signals: number;
  readonly verified: number;
  readonly unverified: number;
  readonly lost: number;
}

/** Appends what `decide` returns, under the twin's lock, after folding the stream again in the transaction. */
async function record(
  deps: CoreDeps,
  repo: string,
  decide: (s: TwinState) => NewEvent[] | null,
): Promise<Result<boolean, CoreError>> {
  return inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [twinLockKey(repo)]);
    const stream = issueTwinStream(repo);
    const drafts = decide(foldIssueTwin(await j.events(stream)));
    if (!drafts || drafts.length === 0) return ok(false);
    const w = await j.emitAll(stream, drafts);
    return w.ok ? ok(!w.value.duplicate) : w;
  });
}

const ev = (type: string, body: object, key: string | null = null): NewEvent => ({
  type,
  body: body as Record<string, unknown>,
  actor: ISSUE_TWIN_ACTOR,
  ...(key ? { idempotency_key: key } : {}),
});

const stateTo = (gap_id: string, to: TwinRow['state'], reason: string): NewEvent =>
  ev(ISSUE_TWIN_EVENT.state_changed, IssueTwinStateChanged.parse({ gap_id, to, reason }));

/** Every repo with a twin stream, by the repo name its batches carry. */
async function twinRepos(deps: CoreDeps): Promise<string[]> {
  const q = await deps.pool.query<{ repo: string }>(
    `SELECT DISTINCT ON (stream) body ->> 'repo' AS repo FROM record.record_event
      WHERE stream LIKE $1 AND type = $2 ORDER BY stream, seq DESC`,
    [`${ISSUE_TWIN_STREAM_PREFIX}%`, ISSUE_TWIN_EVENT.batch_approved],
  );
  return q.rows.map((r) => r.repo);
}

export async function syncIssueTwins(
  deps: IssueTwinSyncDeps,
): Promise<Result<IssueTwinSyncReport, CoreError>> {
  const report = {
    repos: 0,
    filed: 0,
    reconciled: 0,
    signals: 0,
    verified: 0,
    unverified: 0,
    lost: 0,
  };
  for (const repo of await twinRepos(deps)) {
    report.repos += 1;
    const r = await syncRepo(deps, repo, report);
    if (!r.ok) return r;
  }
  return ok(report);
}

async function syncRepo(
  deps: IssueTwinSyncDeps,
  repo: string,
  report: { -readonly [K in keyof IssueTwinSyncReport]: IssueTwinSyncReport[K] },
): Promise<Result<void, CoreError>> {
  const state = foldIssueTwin(await twinEvents(deps.pool, repo));
  const gov = await readGoverning(deps.pool, repo);
  const gaps = new Map<string, Gap>((gov?.governing?.prr.gaps ?? []).map((g) => [g.gap_id, g]));

  // ---- file the approved twins not linked yet (dedupe 1 is the fold: a linked twin has a number)
  const pending = [...state.twins.values()].filter(
    (t) => t.number === null && t.state === 'pending',
  );
  if (pending.length > 0) {
    const listed = await deps.tracker.list_labelled({ repo, label: ISSUE_TWIN_LABEL });
    // dedupe 2 cannot run without the list: nothing is filed this tick (fail closed)
    if (listed.state === 'ok') {
      const byMarker = new Map<string, number>();
      for (const i of listed.value) {
        if (!isOwnIssue(i, deps.tracker.login)) continue;
        for (const id of parseGapMarkers(i.body)) if (!byMarker.has(id)) byMarker.set(id, i.number);
      }
      for (const t of pending) {
        const found = byMarker.get(t.gap_id);
        if (found !== undefined) {
          const w = await record(deps, repo, (s) =>
            s.twins.get(t.gap_id)?.number === null ? [linkedEvent(t, found, 'reconciled')] : null,
          );
          if (!w.ok) return w;
          if (w.value) report.reconciled += 1;
          continue;
        }
        const filed = await fileOne(deps, repo, t, gaps.get(t.gap_id));
        if (!filed.ok) return filed;
        if (filed.value) report.filed += 1;
      }
    }
  }

  // ---- poll the linked twins
  const linked = foldIssueTwin(await twinEvents(deps.pool, repo));
  const recheckCache = new Map<string, GapRecheck>();
  const recheckOf = async (t: TwinRow): Promise<GapRecheck> => {
    const hit = recheckCache.get(t.gap_id);
    if (hit) return hit;
    const p = parseGapId(t.gap_id);
    const r = await deps.recheck.recheck({
      repo,
      criterion: t.criterion,
      area: p?.area ?? null,
    });
    recheckCache.set(t.gap_id, r);
    return r;
  };
  for (const t of linked.twins.values()) {
    if (t.number === null || t.state === 'closed_verified' || t.state === 'lost') continue;
    const number = t.number;
    const read = await deps.tracker.read_issue({ repo, number });
    if (read.state === 'unreadable' && read.reason === 'not_found') {
      const w = await record(deps, repo, (s) =>
        s.twins.get(t.gap_id)?.state === 'lost'
          ? null
          : [
              ev(ISSUE_TWIN_EVENT.signal_observed, signal(t.gap_id, number, 'missing', false)),
              stateTo(t.gap_id, 'lost', 'the issue was deleted or transferred'),
            ],
      );
      if (!w.ok) return w;
      if (w.value) {
        report.lost += 1;
        report.signals += 1;
      }
      continue;
    }
    if (read.state !== 'ok') continue; // no answer is not news
    const issue = read.value;
    const own = isOwnIssue(issue, deps.tracker.login);
    const closedByFactory =
      issue.state === 'closed' &&
      issue.closed_by !== null &&
      issue.closed_by.toLowerCase() === deps.tracker.login.toLowerCase();
    const seen = issue.state;
    const s1 = await record(deps, repo, (s) => {
      const cur = s.twins.get(t.gap_id);
      if (!cur || cur.last_seen === seen) return null;
      return [
        ev(ISSUE_TWIN_EVENT.signal_observed, signal(t.gap_id, number, seen, closedByFactory)),
      ];
    });
    if (!s1.ok) return s1;
    if (s1.value) report.signals += 1;

    // the factory's own close went through but was not recorded (a crash after the write): finish the record
    if (closedByFactory && t.writes_intended.has('verified_close')) {
      const w = await finishWrite(
        deps,
        repo,
        t.gap_id,
        number,
        'verified_close',
        'closed_verified',
        'verified at the head; closed by the factory',
      );
      if (!w.ok) return w;
      if (w.value) report.verified += 1;
      continue;
    }

    if (issue.state === 'open' && t.state === 'closed_unverified') {
      // a person reopened it: the twin follows the issue (the factory never reopens one itself)
      const w = await record(deps, repo, (s) =>
        s.twins.get(t.gap_id)?.state === 'closed_unverified'
          ? [stateTo(t.gap_id, 'open', 'reopened on the host')]
          : null,
      );
      if (!w.ok) return w;
    }

    const rc = await recheckOf(t);
    const rr = await record(deps, repo, (s) => {
      const cur = s.twins.get(t.gap_id);
      if (!cur) return null;
      if (cur.recheck && cur.recheck.result === rc.result && cur.recheck.sha === rc.sha)
        return null;
      return [
        ev(
          ISSUE_TWIN_EVENT.rechecked,
          IssueTwinRechecked.parse({
            gap_id: t.gap_id,
            sha: rc.sha,
            result: rc.result,
            reason: rc.reason.slice(0, 200),
          }),
        ),
      ];
    });
    if (!rr.ok) return rr;

    if (rc.result === 'pass' && rc.sha !== null) {
      // verified: comment "verified at <sha>" and close the tracker's own issue
      const v = await verifiedClose(deps, repo, t, issue, own, rc.sha);
      if (!v.ok) return v;
      if (v.value) report.verified += 1;
      continue;
    }
    if (issue.state === 'closed' && !closedByFactory && t.state === 'open') {
      // a person closed it and the criterion is not met (or could not be checked): closed_unverified, one comment
      const u = await unverified(deps, repo, t, own, rc.sha);
      if (!u.ok) return u;
      if (u.value) report.unverified += 1;
    }
  }
  return ok(undefined);
}

const signal = (
  gap_id: string,
  number: number,
  seen: IssueTwinSignal['seen'],
  closed_by_factory: boolean,
) => IssueTwinSignal.parse({ gap_id, number, seen, closed_by_factory });

const linkedEvent = (t: TwinRow, number: number, via: 'created' | 'reconciled'): NewEvent =>
  ev(
    ISSUE_TWIN_EVENT.linked,
    IssueTwinLinked.parse({ gap_id: t.gap_id, number, via, batch_id: t.batch_id, by: null }),
    `issue_twin:linked:${t.gap_id}:${number}`,
  );

async function fileOne(
  deps: IssueTwinSyncDeps,
  repo: string,
  t: TwinRow,
  gap: Gap | undefined,
): Promise<Result<boolean, CoreError>> {
  if (!gap) return ok(false); // the gap left the readiness record: nothing to file (and nothing approved to file it from)
  const rendered = renderTwin(gap);
  if (rendered.body_sha256 !== t.body_sha256) return ok(false); // not the body the batch approved: never filed
  const intent = await record(deps, repo, (s) => {
    const cur = s.twins.get(t.gap_id);
    if (!cur || cur.number !== null) return null;
    return [
      ev(
        ISSUE_TWIN_EVENT.file_intended,
        IssueTwinFileIntended.parse({
          batch_id: t.batch_id,
          gap_id: t.gap_id,
          body_sha256: t.body_sha256,
        }),
        `issue_twin:file:${t.gap_id}:${cur.intents + 1}`,
      ),
    ];
  });
  if (!intent.ok) return intent;
  if (!intent.value) return ok(false);
  const r = await deps.tracker.file_issue({
    repo,
    title: rendered.title,
    body: rendered.body,
    labels: rendered.labels,
  });
  if (r.state !== 'ok') return ok(false); // the next tick reconciles by marker before it files again
  const number = r.value.number;
  const w = await record(deps, repo, (s) =>
    s.twins.get(t.gap_id)?.number === null ? [linkedEvent(t, number, 'created')] : null,
  );
  return w.ok ? ok(w.value) : w;
}

/** Records a write's completion and the twin's new state, once. */
function finishWrite(
  deps: CoreDeps,
  repo: string,
  gap_id: string,
  number: number,
  write: IssueTwinWrite,
  to: TwinRow['state'],
  reason: string,
): Promise<Result<boolean, CoreError>> {
  return record(deps, repo, (s) => {
    const cur = s.twins.get(gap_id);
    if (!cur || cur.state === to) return null;
    return [
      ...(cur.writes_done.has(write)
        ? []
        : [
            ev(
              ISSUE_TWIN_EVENT.write_done,
              IssueTwinWriteDone.parse({ gap_id, number, write }),
              `issue_twin:write_done:${gap_id}:${write}`,
            ),
          ]),
      stateTo(gap_id, to, reason),
    ];
  });
}

async function intendWrite(
  deps: CoreDeps,
  repo: string,
  t: TwinRow,
  number: number,
  write: IssueTwinWrite,
  sha: string | null,
  body: string,
): Promise<Result<boolean, CoreError>> {
  return record(deps, repo, (s) => {
    const cur = s.twins.get(t.gap_id);
    if (!cur || cur.writes_intended.has(write)) return null;
    return [
      ev(
        ISSUE_TWIN_EVENT.write_intended,
        IssueTwinWriteIntended.parse({
          gap_id: t.gap_id,
          number,
          write,
          sha,
          body_sha256: sha256Hex(body),
        }),
        `issue_twin:write:${t.gap_id}:${write}`,
      ),
    ];
  });
}

async function verifiedClose(
  deps: IssueTwinSyncDeps,
  repo: string,
  t: TwinRow,
  issue: TrackedIssue,
  own: boolean,
  sha: string,
): Promise<Result<boolean, CoreError>> {
  const number = issue.number;
  if (!own) {
    // a person's issue linked as the twin: read, never written to; the twin is verified all the same
    return finishWrite(
      deps,
      repo,
      t.gap_id,
      number,
      'verified_close',
      'closed_verified',
      `verified at ${sha}`,
    );
  }
  const body = verifiedComment(sha);
  const i = await intendWrite(deps, repo, t, number, 'verified_close', sha, body);
  if (!i.ok) return i;
  if (!t.writes_done.has('verified_close')) {
    const c = await deps.tracker.comment_issue({ repo, number, body });
    if (c.state !== 'ok') return ok(false);
    const k = await deps.tracker.close_issue({ repo, number });
    if (k.state !== 'ok') return ok(false);
  }
  return finishWrite(
    deps,
    repo,
    t.gap_id,
    number,
    'verified_close',
    'closed_verified',
    `verified at ${sha}`,
  );
}

async function unverified(
  deps: IssueTwinSyncDeps,
  repo: string,
  t: TwinRow,
  own: boolean,
  sha: string | null,
): Promise<Result<boolean, CoreError>> {
  const number = t.number as number;
  const reason = 'closed on the host; the re-check did not pass';
  // one comment, ever: a second close after a reopen is recorded but not commented on again (a comment intended and
  // not confirmed is tried again: its answer may have been lost, which is the one way it can be written twice)
  if (own && !t.writes_done.has('comment_unverified')) {
    const body = unverifiedComment(sha);
    const i = await intendWrite(deps, repo, t, number, 'comment_unverified', sha, body);
    if (!i.ok) return i;
    const c = await deps.tracker.comment_issue({ repo, number, body });
    if (c.state !== 'ok') return ok(false);
    return finishWrite(
      deps,
      repo,
      t.gap_id,
      number,
      'comment_unverified',
      'closed_unverified',
      reason,
    );
  }
  const w = await record(deps, repo, (s) =>
    s.twins.get(t.gap_id)?.state === 'open'
      ? [stateTo(t.gap_id, 'closed_unverified', reason)]
      : null,
  );
  return w;
}

/** `issue_twin`: files approved twins and polls their state (OB §6.5: every 10 minutes). */
export function issueTwinLoop(
  deps: IssueTwinSyncDeps,
  o: {
    intervalMs?: number;
    startDelayMs?: number;
    onReport?: (r: IssueTwinSyncReport) => void;
  } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 600_000;
  return {
    name: 'issue_twin',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick() {
      const r = await syncIssueTwins(deps);
      if (!r.ok) throw new Error(r.error.message);
      o.onReport?.(r.value);
    },
  };
}
