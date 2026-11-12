import {
  GATECHECK_EVENT,
  MergeObservedPayload,
  type MergeObservedPayload as Merge,
} from '@aisdlc/contracts';
import { openCards, type DecisionDeps } from '@aisdlc/decisions';
import { err, hashCanonical, ok, type Result } from '@aisdlc/kernel';
import type { LoopSpec } from '@aisdlc/loops';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
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
    const cards = await openCards(d.decisions, {
      project_id: p.data.project_id,
      requester: (p.data.bypass_person?.principal_id ?? null) as never,
      subject_kind: 'merge',
      subject_id: p.data.merge_id,
      opened_by: 'system.gate-check',
      gates: [
        {
          gate_id: 'X4',
          subject_hash: hashCanonical(p.data as never),
          facts: x4FactsOf(p.data) as never,
        },
      ],
    });
    if (!cards.ok) {
      return err(coreError('unavailable', `X4 for ${p.data.merge_id}: ${cards.error.message}`));
    }
    if (cards.value.some((c) => c.opened)) opened += 1;
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
