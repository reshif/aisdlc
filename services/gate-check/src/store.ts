import {
  GATECHECK_EVENT,
  MERGE_EVENT_OF,
  MergeObservedPayload,
  RepoWatchedPayload,
  VerdictRecordedPayload,
  gateCheckRepoStream,
  gateCheckStream,
  type GateCheckVerdict,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { systemClock, type Clock } from '@aisdlc/kernel';
import { appendEvents, type JsonObject } from '@aisdlc/record';
import type pg from 'pg';

// gate-check's record (PLAN M14.5): each verdict it wrote as `aisdlc/gate` is a `gatecheck.verdict_recorded` event and
// each merge it observed a `gatecheck.merge_gated`, `gatecheck.bypass_merge` or `gatecheck.unauthorised_merge` event,
// on the PR's stream `gatecheck:<repo>#<pr>`. The read models `gatecheck.verdict` and `gatecheck.merge` are written in
// the same transaction and rebuilt from the events alone (`rebuildGateCheck`). Core reads the bypass and unauthorised
// merges from the record and raises their X4 review; the portal (M14.6) reads the verdicts.

export const GATE_CHECK_RECORD_ACTOR = 'system.gate-check';

export interface GateCheckStore {
  /** `checkSha`: the verdict written as the run on this head (this PR's own, or a stricter one at the same head). */
  recordVerdict(
    v: GateCheckVerdict,
    sha: string,
    checkSha: string,
    checkRunId: number | null,
    prevSeq: number,
  ): Promise<void>;
  recordMerge(p: MergeObservedPayload): Promise<void>;
  /** Once per repo: the watch start (a second call keeps the first). */
  recordRepoWatch(p: RepoWatchedPayload): Promise<void>;
}

type Row = { global_seq: number; occurred_at: string; seq: number };

async function projectVerdict(tx: pg.PoolClient, p: VerdictRecordedPayload, e: Row): Promise<void> {
  const v = p.verdict;
  await tx.query(
    `INSERT INTO gatecheck.verdict
       (repo_key, pr_number, seq, head_sha, profile, outcome, reason, project_id, item_id, pack_sha256, verdict_sha256,
        check_verdict_sha256, check_run_id, verdict, event_gseq, recorded_at)
     VALUES (lower($1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (repo_key, pr_number, seq) DO NOTHING`,
    [
      v.repo,
      v.pr_number,
      e.seq,
      v.head_sha,
      v.profile,
      v.outcome,
      v.reason,
      v.project_id,
      v.item_id,
      v.pack_sha256,
      p.verdict_sha256,
      p.check_verdict_sha256,
      p.check_run_id,
      JSON.stringify(v),
      e.global_seq,
      e.occurred_at,
    ],
  );
}

async function projectMerge(tx: pg.PoolClient, p: MergeObservedPayload, e: Row): Promise<void> {
  await tx.query(
    `INSERT INTO gatecheck.merge
       (merge_id, repo_key, project_id, pr_number, head_sha, class, merged_by, bypass_principal, item_id, payload,
        event_gseq, recorded_at)
     VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (merge_id) DO NOTHING`,
    [
      p.merge_id,
      p.repo,
      p.project_id,
      p.pr_number,
      p.head_sha,
      p.class,
      p.merged_by,
      p.bypass_person?.principal_id ?? null,
      p.item_id,
      JSON.stringify(p),
      e.global_seq,
      e.occurred_at,
    ],
  );
}

async function projectWatch(tx: pg.PoolClient, p: RepoWatchedPayload, e: Row): Promise<void> {
  await tx.query(
    `INSERT INTO gatecheck.repo_watch (repo_key, project_id, watched_at, default_branch, head_sha, event_gseq)
     VALUES (lower($1), $2, $3, $4, $5, $6) ON CONFLICT (repo_key) DO NOTHING`,
    [p.repo, p.project_id, p.watched_at, p.default_branch, p.head_sha, e.global_seq],
  );
}

const MERGE_TYPES = new Set<string>(Object.values(MERGE_EVENT_OF));

export class RecordGateCheckStore implements GateCheckStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock = systemClock,
  ) {}

  private async append(
    stream: string,
    type: string,
    body: JsonObject,
    key: string,
    project: (tx: pg.PoolClient, e: Row) => Promise<void>,
  ): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      for (let i = 0; i < 8; i++) {
        const head = await tx.query<{ seq: string }>(
          'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
          [stream],
        );
        const a = await appendEvents(
          tx,
          stream,
          Number(head.rows[0]?.seq ?? 0),
          [{ type, body, actor: GATE_CHECK_RECORD_ACTOR, idempotency_key: key }],
          { clock: this.clock },
        );
        if (a.ok) {
          const e = a.value.events[0];
          if (!e) throw new Error('the record appended nothing');
          if (!a.value.duplicate)
            await project(tx, {
              global_seq: e.global_seq,
              occurred_at: e.occurred_at,
              seq: e.stream_seq,
            });
          return;
        }
        if (a.error._tag === 'IdempotencyMismatch') return;
        if (a.error._tag !== 'ConcurrencyConflict')
          throw new Error(`record append refused: ${a.error._tag}`);
      }
      throw new Error('record append: too many conflicts');
    });
  }

  async recordVerdict(
    v: GateCheckVerdict,
    sha: string,
    checkSha: string,
    checkRunId: number | null,
    prevSeq: number,
  ): Promise<void> {
    const p = VerdictRecordedPayload.parse({
      verdict: v,
      verdict_sha256: sha,
      check_verdict_sha256: checkSha,
      check_run_id: checkRunId,
      observed_at: this.clock.now().toISOString(),
    });
    // keyed by the position it follows: the same verdict after another one is a new event
    await this.append(
      gateCheckStream(v.repo, v.pr_number),
      GATECHECK_EVENT.verdict_recorded,
      p as unknown as JsonObject,
      `verdict:${prevSeq}:${sha}`,
      (tx, e) => projectVerdict(tx, p, e),
    );
  }

  async recordRepoWatch(raw: RepoWatchedPayload): Promise<void> {
    const p = RepoWatchedPayload.parse(raw);
    // one key per repo: a second start (another process, a retry) is the first one
    await this.append(
      gateCheckRepoStream(p.repo),
      GATECHECK_EVENT.repo_watched,
      p as unknown as JsonObject,
      `watch:${p.repo.toLowerCase()}`,
      (tx, e) => projectWatch(tx, p, e),
    );
  }

  async recordMerge(raw: MergeObservedPayload): Promise<void> {
    const p = MergeObservedPayload.parse(raw);
    await this.append(
      gateCheckStream(p.repo, p.pr_number),
      MERGE_EVENT_OF[p.class],
      p as unknown as JsonObject,
      `merge:${p.merge_id}`,
      (tx, e) => projectMerge(tx, p, e),
    );
  }
}

/** Rebuilds `gatecheck.verdict` and `gatecheck.merge` from the record alone (as the schema's owner). Returns events. */
export async function rebuildGateCheck(pool: pg.Pool): Promise<number> {
  return withTransaction(pool, async (tx) => {
    await tx.query('DELETE FROM gatecheck.verdict');
    await tx.query('DELETE FROM gatecheck.merge');
    await tx.query('DELETE FROM gatecheck.repo_watch');
    const ev = await tx.query<{
      type: string;
      body: unknown;
      global_seq: string;
      seq: number;
      occurred_at: Date;
    }>(
      `SELECT type, body, global_seq::text, seq, occurred_at FROM record.record_event
        WHERE stream LIKE 'gatecheck:%' ORDER BY global_seq`,
    );
    for (const e of ev.rows) {
      const row = {
        global_seq: Number(e.global_seq),
        occurred_at: e.occurred_at.toISOString(),
        seq: e.seq,
      };
      if (e.type === GATECHECK_EVENT.verdict_recorded) {
        await projectVerdict(tx, VerdictRecordedPayload.parse(e.body), row);
      } else if (e.type === GATECHECK_EVENT.repo_watched) {
        await projectWatch(tx, RepoWatchedPayload.parse(e.body), row);
      } else if (MERGE_TYPES.has(e.type)) {
        await projectMerge(tx, MergeObservedPayload.parse(e.body), row);
      }
    }
    return ev.rows.length;
  });
}

export interface VerdictView {
  readonly seq: number;
  readonly verdict: GateCheckVerdict;
  readonly verdict_sha256: string;
  readonly check_run_id: number | null;
  readonly recorded_at: string;
}

/** The verdicts of a PR (newest first) or of an item, for the portal. */
export async function listVerdicts(
  pool: Pick<pg.Pool, 'query'>,
  q: { repo: string; pr?: number } | { item: string },
): Promise<VerdictView[]> {
  const r =
    'item' in q
      ? await pool.query<{
          seq: number;
          verdict: GateCheckVerdict;
          verdict_sha256: string;
          check_run_id: string | null;
          recorded_at: Date;
        }>(
          `SELECT seq, verdict, verdict_sha256, check_run_id::text AS check_run_id, recorded_at FROM gatecheck.verdict
            WHERE item_id = $1 ORDER BY event_gseq DESC LIMIT 200`,
          [q.item],
        )
      : await pool.query<{
          seq: number;
          verdict: GateCheckVerdict;
          verdict_sha256: string;
          check_run_id: string | null;
          recorded_at: Date;
        }>(
          `SELECT seq, verdict, verdict_sha256, check_run_id::text AS check_run_id, recorded_at FROM gatecheck.verdict
            WHERE repo_key = lower($1) AND ($2::int IS NULL OR pr_number = $2) ORDER BY event_gseq DESC LIMIT 200`,
          [q.repo, q.pr ?? null],
        );
  return r.rows.map((x) => ({
    seq: x.seq,
    verdict: x.verdict,
    verdict_sha256: x.verdict_sha256,
    check_run_id: x.check_run_id === null ? null : Number(x.check_run_id),
    recorded_at: x.recorded_at.toISOString(),
  }));
}

/** The merges of a repo (newest first). */
export async function listMerges(
  pool: Pick<pg.Pool, 'query'>,
  repo: string,
): Promise<MergeObservedPayload[]> {
  const r = await pool.query<{ payload: unknown }>(
    'SELECT payload FROM gatecheck.merge WHERE repo_key = lower($1) ORDER BY event_gseq DESC LIMIT 200',
    [repo],
  );
  return r.rows.map((x) => MergeObservedPayload.parse(x.payload));
}
