import {
  GATECHECK_EVENT,
  GATE_EVENT,
  MergeObservedPayload,
  mergeSubjectId,
  type MergeObservedPayload as Merge,
} from '@aisdlc/contracts';
import { openCards, type DecisionDeps } from '@aisdlc/decisions';
import { err, hashCanonical, ok, type Result } from '@aisdlc/kernel';
import type { LoopSpec } from '@aisdlc/loops';
import { EVENT_COLUMNS, toRecordEvent, type EventRow, type Executor } from '@aisdlc/record';
import { coreError, type CoreError } from './errors.js';
import { clockOf } from './journal.js';

// X4 for the merges gate-check observed without `aisdlc/gate` passing (PLAN M14.5; DEC-10 as refined 2026-11-11; FL
// X4 "Break-glass post-hoc review"). gate-check records every merge it sees on the record (`gatecheck.bypass_merge`
// when the merger is on the repo's bypass list, `gatecheck.unauthorised_merge` when not) and has no route to core
// (AR9). This is core's side: it reads those events after its cursor and opens an X4 card for each, through the
// decision kernel like any gate (slot `x`, its own card, never consolidated, always required). The subject is the merge
// (`subject_kind: merge`, its id the merge id), the subject hash binds the whole recorded payload, and the merger is the
// requester, so the SoD rule keeps them from reviewing their own bypass. An unauthorised merge's card says so in its
// facts (`security: true`): protect-main was not effective for that merge, which the spec's posture rules treat as a
// security finding (onboarding-roadmap §8 "protect-main loosened ... PRR suspended"; §6.6 residual risk "a bypass
// actor added without weakening any rule is invisible": this makes it visible).
//
// Exactly once: the gate instance is derived from its subject and hash (opening it again is a no-op), and the cursor
// moves only past events that were handled.

export const MERGE_REVIEW_OBSERVER = 'gatecheck_merges';

const TYPES = [GATECHECK_EVENT.bypass_merge, GATECHECK_EVENT.unauthorised_merge];

export interface MergeReviewDeps {
  readonly decisions: DecisionDeps;
}

export interface MergeReviewReport {
  readonly seen: number;
  readonly opened: number;
}

async function cursor(d: MergeReviewDeps): Promise<number> {
  const q = await d.decisions.pool.query<{ global_seq: string }>(
    'SELECT global_seq::text FROM core.observer_cursor WHERE name = $1',
    [MERGE_REVIEW_OBSERVER],
  );
  return Number(q.rows[0]?.global_seq ?? 0);
}

/** What the X4 card shows: ids, the class and what the check said; never repo text. */
export function x4FactsOf(p: Merge): Record<string, unknown> {
  return {
    kind: 'bypass_merge_review',
    class: p.class,
    security: p.class === 'unauthorised',
    repo: p.repo,
    pr_number: p.pr_number,
    head_sha: p.head_sha,
    merge_commit_sha: p.merge_commit_sha,
    merged_by: p.merged_by,
    merged_at: p.merged_at,
    bypass_principal: p.bypass_person?.principal_id ?? null,
    last_verdict: p.last_verdict,
    host_check: p.host_check,
    item_id: p.item_id,
  };
}

/** What an X4 post-hoc review of one merge is opened with. */
export interface MergeX4 {
  readonly project_id: string;
  readonly requester: string | null;
  readonly repo: string;
  readonly pr_number: number;
  /** The merged head: with repo and PR it is the merge's id (`mergeSubjectId`), the gate's subject. */
  readonly head_sha: string;
  readonly merge_commit_sha: string | null;
  readonly opened_by: string;
  readonly subject_hash: string;
  readonly facts: Record<string, unknown>;
}

/**
 * The merge's X4 already opened, by gate-check's observer or by 8.2's reconcile (M15.2): an X4 on the same merge id
 * (repo, PR, merged head), or one whose facts name the same repo, PR and merge commit. Whichever saw the merge first
 * opened it; the other opens nothing.
 */
export async function mergeX4Exists(db: Executor, m: MergeX4): Promise<boolean> {
  const q = await db.query(
    `SELECT 1 FROM record.record_event
      WHERE type = $1 AND seq = 1 AND body ->> 'gate_id' = 'X4' AND body ->> 'subject_kind' = 'merge'
        AND (body ->> 'subject_id' = $2
             OR ($4::text IS NOT NULL AND lower(body -> 'facts' ->> 'repo') = $3
                 AND body -> 'facts' ->> 'pr_number' = $5 AND body -> 'facts' ->> 'merge_commit_sha' = $4))
      LIMIT 1`,
    [
      GATE_EVENT.opened,
      mergeSubjectId(m.repo, m.pr_number, m.head_sha),
      m.repo.toLowerCase(),
      m.merge_commit_sha,
      String(m.pr_number),
    ],
  );
  return q.rows.length > 0;
}

/**
 * Opens one merge's X4 unless it is open already (`mergeX4Exists`). The check and the open run under one advisory lock
 * per repo and PR, so the two observers never both open one.
 */
export async function openMergeX4Once(
  decisions: DecisionDeps,
  m: MergeX4,
): Promise<Result<{ opened: boolean }, CoreError>> {
  const c = await decisions.pool.connect();
  const key = `aisdlc.core:x4-merge:${m.repo.toLowerCase()}#${m.pr_number}`;
  try {
    await c.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    try {
      if (await mergeX4Exists(c, m)) return ok({ opened: false });
      const mergeId = mergeSubjectId(m.repo, m.pr_number, m.head_sha);
      const cards = await openCards(decisions, {
        project_id: m.project_id as never,
        requester: m.requester as never,
        subject_kind: 'merge',
        subject_id: mergeId,
        opened_by: m.opened_by,
        gates: [{ gate_id: 'X4', subject_hash: m.subject_hash, facts: m.facts as never }],
      });
      if (!cards.ok) {
        return err(coreError('unavailable', `X4 for ${mergeId}: ${cards.error.message}`));
      }
      return ok({ opened: cards.value.some((x) => x.opened) });
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    }
  } finally {
    c.release();
  }
}

/** Reads the bypass and unauthorised merges after the cursor and opens each one's X4 review. */
export async function observeBypassMerges(
  d: MergeReviewDeps,
  o: { batch?: number } = {},
): Promise<Result<MergeReviewReport, CoreError>> {
  const pool = d.decisions.pool;
  const after = await cursor(d);
  const q = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event
      WHERE type = ANY($1::text[]) AND stream LIKE 'gatecheck:%' AND global_seq > $2::bigint
      ORDER BY record_event.global_seq LIMIT $3`,
    [TYPES, String(after), o.batch ?? 50],
  );
  let opened = 0;
  for (const row of q.rows) {
    const e = toRecordEvent(row);
    const p = MergeObservedPayload.safeParse(e.payload);
    // a merge event that does not parse stops the run so it is looked at; it is never skipped past
    if (!p.success) {
      return err(coreError('invalid_input', `${e.type} #${e.global_seq} is malformed`));
    }
    const cards = await openMergeX4Once(d.decisions, {
      project_id: p.data.project_id,
      requester: p.data.bypass_person?.principal_id ?? null,
      repo: p.data.repo,
      pr_number: p.data.pr_number,
      head_sha: p.data.head_sha,
      merge_commit_sha: p.data.merge_commit_sha,
      opened_by: 'system.gate-check',
      subject_hash: hashCanonical(p.data as never),
      facts: x4FactsOf(p.data),
    });
    if (!cards.ok) return cards;
    if (cards.value.opened) opened += 1;
    await pool.query(
      `INSERT INTO core.observer_cursor (name, global_seq, updated_at) VALUES ($1, $2::bigint, $3)
       ON CONFLICT (name) DO UPDATE SET global_seq = greatest(core.observer_cursor.global_seq, excluded.global_seq),
                                        updated_at = excluded.updated_at`,
      [MERGE_REVIEW_OBSERVER, String(e.global_seq), clockOf(d.decisions).now().toISOString()],
    );
  }
  return ok({ seen: q.rows.length, opened });
}

/** `gatecheck_merges`: the X4 reviews of the merges gate-check recorded. */
export function mergeReviewLoop(
  d: MergeReviewDeps,
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 10_000;
  return {
    name: MERGE_REVIEW_OBSERVER,
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick() {
      let n = 0;
      for (let i = 0; i < 20; i++) {
        const r = await observeBypassMerges(d);
        if (!r.ok) throw new Error(r.error.message);
        n += r.value.opened;
        if (r.value.seen < 50) break;
      }
      return { ok: n, failed: 0 };
    },
  };
}
