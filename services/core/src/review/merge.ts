import {
  AgentPullsFact,
  INBOUND_FACT_EVENT,
  ITEM_EVENT,
  InboundFactPayload,
  MERGE_EVENT,
  MergeReconciledPayload,
  inboundFactStream,
  mergeReconcileKey,
  mergeStream,
  type AgentPull,
  type MergeReconcileOutcome,
  type MergeReconcileReason,
  type PrincipalId,
  type ProjectId,
  type RepoFullName,
} from '@aisdlc/contracts';
import type { DecisionDeps } from '@aisdlc/decisions';
import { err, hashCanonical, ok, type Result } from '@aisdlc/kernel';
import type { LoopSpec, WatchedPull, WatchedPullsError, WatchedPullsPort } from '@aisdlc/loops';
import type { Executor } from '@aisdlc/record';
import { catalogueOfItem, limitValue, type ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { applyPushEvent, listPushReceipts, pushLockKey } from '../build/push.js';
import { coreError, type CoreError } from '../errors.js';
import { inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import type { MergerLinksPort } from '../clients.js';
import { openMergeX4Once } from '../merge-review.js';
import { passingPackFor } from '../verify/evidence.js';
import { ingestItem, readItem } from '../work-items.js';
import { requestRework } from '../work-signals.js';
import { readG4Standing } from './g4.js';

// 8.2 merge observed (PLAN M15.2; FL S8 8.2 "HUMAN merges on GitHub ... factory reconciles", F10 the B15 split). The
// factory never merges: a person does, on GitHub. The `agent_pulls` poll (`@aisdlc/loops`) records what the host says
// of every agent PR the work engine watches (record first); this reconciles each PR of the newest fact of each repo
// against its item:
//
//   - merged, and the merged head is exactly the head the item's newest G4 approved, whose passing Evidence Pack that
//     approval bound, while the item waits at 8.2: `completed`. When every Unit the approval bound is merged so, the
//     item is told (`item.merge_observed`) and leaves S8 (S8b where the project releases, else S9).
//   - merged any other way (no approved G4, an approval of another head, the pack not the bound one, the item ended):
//     `post_hoc_review`, never a completion, and an X4 post-hoc review of that merge through the same path gate-check's
//     bypass and unauthorised merges take (`openMergeX4Once`: one X4 per merge, whoever saw it first).
//   - open at 8.2, the host reports a conflict with the base: B15b, back to S6 to resolve it (`conflict`).
//   - open at 8.2, the base moved and the PR head is a new commit on it with no conflict (a clean rebase on the host):
//     B15a, S7 runs again on the rebased head (`rebased`): the PR's head in core moves to it, so a new pack and a new G4
//     are needed and the old approval no longer stands. The engine counts the round against the pinned catalogue's
//     `b15a_times` (recorded with the reconcile, read through `limitValue`).
//
// Every conclusion is a `merge.reconciled` event on `merge:<item>` under its key (repo, PR, commit, outcome), so seeing
// the same fact again does nothing new. Fail closed: a merge with no merge commit, a fact that does not parse, an item
// or a G4 that cannot be read is no completion.

export const MERGE_RECONCILE_OBSERVER = 'merge_reconcile';
const ACTOR = 'system.merge';

export interface MergeReconcileDeps {
  readonly pool: pg.Pool;
  readonly clock?: CoreDeps['clock'];
  /** The decision kernel, for X4. */
  readonly decisions: DecisionDeps;
  /** M15.4: the merger's principal (barred from their X4) or, unmapped, the factory admins who decide it. */
  readonly links: MergerLinksPort;
}

export interface MergeReconcileReport {
  readonly pulls: number;
  readonly recorded: number;
  readonly completed: number;
  readonly x4_opened: number;
  readonly rework: number;
}

/** The watched agent PRs: those of every item still in flight. */
export class DbWatchedPulls implements WatchedPullsPort {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<Result<WatchedPull[], WatchedPullsError>> {
    const q = await this.pool.query<{ repo: string; number: number; project_id: string }>(
      `SELECT p.repo, p.number, w.project_id FROM core.pull_request p
         JOIN core.work_item w ON w.item_id = p.item_id
        WHERE w.terminal IS NULL ORDER BY lower(p.repo), p.number`,
    );
    return ok(
      q.rows.map((r) => ({
        repo: r.repo as RepoFullName,
        project_id: r.project_id as ProjectId,
        number: r.number,
      })),
    );
  }
}

interface PullRow {
  readonly repo: string;
  readonly number: number;
  readonly item_id: string;
  readonly unit_key: string;
  readonly head_sha: string;
}

async function pullRow(db: Executor, repo: string, n: number): Promise<PullRow | null> {
  const q = await db.query<PullRow>(
    `SELECT repo, number, item_id::text AS item_id, unit_key, head_sha FROM core.pull_request
      WHERE lower(repo) = lower($1) AND number = $2`,
    [repo, n],
  );
  return q.rows[0] ?? null;
}

/** The item's reconciliations, in record order. */
export async function listMergeReconciled(
  db: Executor,
  itemId: string,
): Promise<MergeReconciledPayload[]> {
  const q = await db.query<{ body: unknown }>(
    'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq',
    [mergeStream(itemId), MERGE_EVENT.reconciled],
  );
  return q.rows.map((r) => MergeReconciledPayload.parse(r.body));
}

interface Approved {
  readonly gate_instance_id: string;
  readonly head_sha: string;
  readonly base_sha: string;
  readonly pack_sha256: string;
  /** Every Unit the approval bound, by PR. */
  readonly units: ReadonlyArray<{ readonly pr_number: number; readonly unit_key: string }>;
}

/** What the item's NEWEST G4 approved for this PR (a decided approve in the ledger), or `null`. */
async function approvedFor(db: Executor, itemId: string, row: PullRow): Promise<Approved | null> {
  const st = await readG4Standing(db, itemId);
  if ((st.state !== 'approved' && st.state !== 'head_moved') || st.review === null) return null;
  if (st.gate_instance_id === null) return null;
  const u = st.review.units.find((x) => x.unit_key === row.unit_key && x.pr_number === row.number);
  if (!u) return null;
  return {
    gate_instance_id: st.gate_instance_id,
    head_sha: u.head_sha,
    base_sha: u.base_sha,
    pack_sha256: u.pack_sha256,
    units: st.review.units.map((x) => ({ pr_number: x.pr_number, unit_key: x.unit_key })),
  };
}

const atMerge = (s: ItemState): boolean =>
  s.waiting?.kind === 'human' && s.waiting.what === 'merge';

interface Conclusion {
  readonly outcome: MergeReconcileOutcome;
  readonly reason: MergeReconcileReason;
}

/** What a merged PR is. `null`: not yet decidable (approved, but the item has not reached 8.2 yet: next time). */
async function mergedConclusion(
  db: Executor,
  s: ItemState,
  pull: AgentPull,
  approved: Approved | null,
): Promise<Conclusion | null> {
  const review = (reason: MergeReconcileReason): Conclusion => ({
    outcome: 'post_hoc_review',
    reason,
  });
  if (approved === null) return review('no_approved_g4');
  if (approved.head_sha !== pull.head_sha) return review('head_not_approved');
  const pack = await passingPackFor(db, s.item_id, pull.head_sha);
  if (pack === null || pack.pack_sha256 !== approved.pack_sha256) return review('pack_not_bound');
  if (atMerge(s)) return { outcome: 'completed', reason: 'approved_head' };
  // the approval is in the ledger and the driver has not yet moved the item on to 8.2: decided next time
  const w = s.waiting;
  if (s.terminal === null && w?.kind === 'gates' && w.gates.includes('G4')) return null;
  // anywhere else (ended, sent back to S6 or S7) the merge is not the one 8.2 waits for
  return review('item_not_at_8_2');
}

/** What an open PR at 8.2 is: B15b on a conflict, B15a on a clean rebase onto a moved base, else nothing. */
async function openConclusion(
  db: Executor,
  s: ItemState,
  row: PullRow,
  pull: AgentPull,
  approved: Approved | null,
): Promise<Conclusion | null> {
  if (pull.state !== 'open' || approved === null || !atMerge(s)) return null;
  if (pull.mergeable === 'conflict') {
    // only about the head that was approved: a stale fact of an older head says nothing now
    return pull.head_sha === approved.head_sha
      ? { outcome: 'conflict', reason: 'merge_conflict' }
      : null;
  }
  if (pull.mergeable === 'unknown' || pull.head_sha === approved.head_sha) return null;
  // a rebase: the base moved from the one the approved pack was made on, and the new head is no head the factory
  // pushed (a stale fact of an older factory head is not one)
  if (pull.base_sha === null || pull.base_sha === approved.base_sha) return null;
  const known = (await listPushReceipts(db, s.item_id)).some(
    (r) => r.unit_key === row.unit_key && r.head_sha === pull.head_sha,
  );
  if (known) return null;
  return { outcome: 'rebased', reason: 'base_moved_clean_rebase' };
}

/** Records one conclusion (once per key); for `rebased`, the PR's head moves in the same transaction. */
async function record(
  d: MergeReconcileDeps,
  row: PullRow,
  repo: string,
  pull: AgentPull,
  c: Conclusion,
  approved: Approved | null,
  s: ItemState,
): Promise<Result<{ payload: MergeReconciledPayload; fresh: boolean }, CoreError>> {
  const sha =
    c.outcome === 'completed' || c.outcome === 'post_hoc_review'
      ? (pull.merge_commit_sha as string)
      : pull.head_sha;
  const key = mergeReconcileKey(repo, pull.number, sha, c.outcome);
  const cat = catalogueOfItem(s);
  const payload = MergeReconciledPayload.parse({
    key,
    item_id: row.item_id,
    repo,
    pr_number: pull.number,
    unit_key: row.unit_key,
    outcome: c.outcome,
    reason: c.reason,
    head_sha: pull.head_sha,
    base_sha: pull.base_sha,
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    merged_by: pull.merged_by,
    approved: approved
      ? {
          gate_instance_id: approved.gate_instance_id,
          head_sha: approved.head_sha,
          pack_sha256: approved.pack_sha256,
        }
      : null,
    b15a:
      c.outcome === 'rebased'
        ? {
            taken: s.rework.by_loop['B15:b15a_times'] ?? 0,
            limit: limitValue(cat, 'B15', 'b15a_times'),
          }
        : null,
  });
  return inCoreTx<{ payload: MergeReconciledPayload; fresh: boolean }>(
    { pool: d.pool, ...(d.clock ? { clock: d.clock } : {}) },
    async (j, tx) => {
      await lockKeys(tx, [`merge:${row.item_id}`, pushLockKey(row.item_id)]);
      const stream = mergeStream(row.item_id);
      const seen = (await j.events(stream)).find(
        (e) => (e.payload as { key?: unknown }).key === key,
      );
      if (seen) return ok({ payload: MergeReconciledPayload.parse(seen.payload), fresh: false });
      const w = await j.emit(stream, MERGE_EVENT.reconciled, payload, ACTOR);
      if (!w.ok) return w;
      await applyPushEvent(tx, {
        type: MERGE_EVENT.reconciled,
        payload,
        global_seq: w.value.global_seq,
      });
      return ok({ payload, fresh: true });
    },
  );
}

/** The X4 card's facts: ids, what the host said and what was approved; never repo text. */
export function reconcileX4Facts(p: MergeReconciledPayload): Record<string, unknown> {
  return {
    kind: 'merge_reconcile_review',
    reason: p.reason,
    security: false,
    repo: p.repo,
    pr_number: p.pr_number,
    head_sha: p.head_sha,
    merge_commit_sha: p.merge_commit_sha,
    merged_by: p.merged_by,
    merged_at: p.merged_at,
    item_id: p.item_id,
    unit_key: p.unit_key,
    approved_head_sha: p.approved?.head_sha ?? null,
    approved_g4: p.approved?.gate_instance_id ?? null,
    approved_pack_sha256: p.approved?.pack_sha256 ?? null,
  };
}

type Step = 'none' | 'recorded' | 'completed' | 'x4' | 'rework';

/** Reconciles one PR of a fact. */
async function reconcilePull(
  d: MergeReconcileDeps,
  repo: string,
  projectId: string,
  pull: AgentPull,
): Promise<Result<Step[], CoreError>> {
  const row = await pullRow(d.pool, repo, pull.number);
  if (!row) return ok([]); // not an agent PR of an item: gate-check's concern
  const item = await readItem(d.pool, row.item_id);
  if (!item) return ok([]);
  const s = item.state;
  const approved = await approvedFor(d.pool, row.item_id, row);
  const deps = { pool: d.pool, ...(d.clock ? { clock: d.clock } : {}) };
  const steps: Step[] = [];

  if (pull.merged) {
    // fail closed: a merge with no merge commit is not one the factory can bind anything to
    if (pull.merge_commit_sha === null) return ok([]);
    const prior = (await listMergeReconciled(d.pool, row.item_id)).find(
      (p) =>
        p.pr_number === pull.number &&
        p.repo.toLowerCase() === repo.toLowerCase() &&
        p.merge_commit_sha === pull.merge_commit_sha,
    );
    const c: Conclusion | null = prior
      ? { outcome: prior.outcome, reason: prior.reason }
      : await mergedConclusion(d.pool, s, pull, approved);
    if (c === null) return ok([]);
    const r = await record(d, row, repo, pull, c, approved, s);
    if (!r.ok) return r;
    if (r.value.fresh) steps.push('recorded');
    const p = r.value.payload;
    if (p.outcome === 'post_hoc_review') {
      const x4 = await openMergeX4Once(d.decisions, {
        project_id: projectId,
        requester: null,
        repo: p.repo,
        pr_number: p.pr_number,
        head_sha: p.head_sha,
        merge_commit_sha: p.merge_commit_sha,
        opened_by: ACTOR,
        subject_hash: hashCanonical(p as never),
        facts: reconcileX4Facts(p),
        merger: { links: d.links, login: p.merged_by, known: null },
      });
      if (!x4.ok) return x4;
      if (x4.value.opened) steps.push('x4');
      return ok(steps);
    }
    if (p.outcome !== 'completed' || p.approved === null) return ok(steps);
    // every Unit the approval bound, merged with its approved head: the item leaves 8.2
    const done = (await listMergeReconciled(d.pool, row.item_id)).filter(
      (x) =>
        x.outcome === 'completed' && x.approved?.gate_instance_id === p.approved?.gate_instance_id,
    );
    const all = (approved?.units ?? []).every((u) =>
      done.some((x) => x.pr_number === u.pr_number && x.unit_key === u.unit_key),
    );
    if (!all || approved === null || !atMerge(s)) return ok(steps);
    const w = await ingestItem(deps, row.item_id, {
      type: ITEM_EVENT.merge_observed,
      payload: { merged_sha: p.merge_commit_sha as string },
      actor: ACTOR,
      idempotency_key: `merge:observed:${p.approved.gate_instance_id}`,
    });
    if (!w.ok) return w;
    if (!w.value.duplicate) steps.push('completed');
    return ok(steps);
  }

  const c = await openConclusion(d.pool, s, row, pull, approved);
  if (c === null) return ok([]);
  const r = await record(d, row, repo, pull, c, approved, s);
  if (!r.ok) return r;
  if (r.value.fresh) steps.push('recorded');
  // the back-edge, under the reconciliation's own key: seeing the same fact again asks for nothing new
  const w = await requestRework(deps, row.item_id, {
    edge: 'B15',
    step: null,
    reason_code: c.reason,
    by: ACTOR as PrincipalId,
    variant: c.outcome === 'conflict' ? 'b' : 'a',
    key: r.value.payload.key,
  });
  if (!w.ok) return w;
  if (!w.value.duplicate) steps.push('rework');
  return ok(steps);
}

/** The newest `agent_pulls` fact of every repo. */
async function newestFacts(
  db: Executor,
): Promise<Array<{ stream: string; global_seq: string; body: unknown }>> {
  const q = await db.query<{ stream: string; global_seq: string; body: unknown }>(
    `SELECT DISTINCT ON (stream) stream, global_seq::text AS global_seq, body FROM record.record_event
      WHERE starts_with(stream, $1) AND type = $2 ORDER BY stream, seq DESC`,
    [inboundFactStream('agent_pulls', ''), INBOUND_FACT_EVENT.observed],
  );
  return q.rows;
}

/** One pass: every PR of the newest fact of every repo, reconciled. A fact that does not parse stops the pass. */
export async function reconcileMerges(
  d: MergeReconcileDeps,
): Promise<Result<MergeReconcileReport, CoreError>> {
  let pulls = 0;
  let recorded = 0;
  let completed = 0;
  let x4 = 0;
  let rework = 0;
  for (const f of await newestFacts(d.pool)) {
    const payload = InboundFactPayload.safeParse(f.body);
    const value = payload.success ? AgentPullsFact.safeParse(payload.data.value) : null;
    if (!payload.success || !value?.success) {
      return err(coreError('invalid_input', `agent_pulls fact #${f.global_seq} is malformed`));
    }
    for (const pull of value.data.pulls) {
      pulls += 1;
      const r = await reconcilePull(d, payload.data.repo, payload.data.project_id, pull);
      if (!r.ok) return r;
      for (const st of r.value) {
        if (st === 'recorded') recorded += 1;
        else if (st === 'completed') completed += 1;
        else if (st === 'x4') x4 += 1;
        else if (st === 'rework') rework += 1;
      }
    }
  }
  return ok({ pulls, recorded, completed, x4_opened: x4, rework });
}

/** `merge_reconcile`: 8.2's reconcile of the agent PRs the code host's poll recorded. */
export function mergeReconcileLoop(
  d: MergeReconcileDeps,
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 30_000;
  return {
    name: MERGE_RECONCILE_OBSERVER,
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick() {
      const r = await reconcileMerges(d);
      if (!r.ok) throw new Error(r.error.message);
      return { ok: r.value.recorded };
    },
  };
}
