import {
  FindingMachine,
  KNOWLEDGE_EVENT,
  KjobDonePayload,
  KjobErrorPayload,
  KjobQueuedPayload,
  KjobStartedPayload,
  FindingStateChangedPayload,
  findingStream,
  kjobStream,
  type FindingCounts,
  type FindingId,
  type FindingState,
  type IntakeResult,
  type KnowledgeJob,
  type KnowledgeJobId,
  type RecordEvent,
  type RepoFullName,
  type ScanCoverage,
  type ScanStatus,
  type SecurityFinding,
  type SetFindingStateRequest,
  type StartCensusIntakeRequest,
  FindingDetectedPayload,
  CensusAssembledPayload,
  censusStream,
  type CensusRecord,
  type CoverageItem,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import {
  err,
  hashCanonical,
  newId,
  ok,
  systemClock,
  type Clock,
  type Result,
} from '@aisdlc/kernel';
import {
  appendEvents,
  runProjection,
  type Executor,
  type Projection,
  type Tx,
} from '@aisdlc/record';
import type pg from 'pg';
import { knowledgeError, type KnowledgeError } from './errors.js';
import type { PrincipalDirectory } from './principals.js';
import type { ScannedFinding } from './scan.js';
import { censusProjection } from './census/store.js';

// The job store and the Security-only findings store (PLAN M6.1, M6.2).
//
//  - Jobs: record streams `kjob:<id>` (queued, started, done | error). `knowledge.knowledge_job` is
//    a projection folded from them; the done event carries the whole result (counts only).
//  - Findings: written ONLY to `security_findings` (fingerprints and locations never reach the
//    record, the job table, a log or a result). The record gets events without them: `finding.detected`
//    (id, rule) and `finding.state_changed` (who, from, to, the hash of the human's reason).
//
// LOCK ORDER (no ledger write here): finding rows are locked before the record's global counter,
// which the first append takes, in every writer (finish, set state).

export const KNOWLEDGE_ACTOR = 'system:knowledge';

export interface StoreDeps {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
}
const clockOf = (d: StoreDeps): Clock => d.clock ?? systemClock;
const iso = (d: Date): string => d.toISOString();

// ---------------------------------------------------------------- job projection

interface JobRow {
  job_id: string;
  kind: string;
  repo: string;
  state: string;
  refs_requested: string;
  base_sha_requested: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  result: IntakeResult | null;
  result_sha256: string | null;
}

export const knowledgeJobs: Projection<KnowledgeJob[]> = {
  name: 'knowledge-jobs',
  version: 1,
  tables: ['knowledge.knowledge_job'],
  async apply(tx: Tx, e: RecordEvent) {
    if (!e.stream_id.startsWith('kjob:')) return;
    if (e.type === KNOWLEDGE_EVENT.job_queued) {
      const p = KjobQueuedPayload.parse(e.payload);
      await tx.query(
        `INSERT INTO knowledge.knowledge_job
           (job_id, kind, repo, state, refs_requested, base_sha_requested, created_at)
         VALUES ($1, $2, $3, 'queued', $4, $5, $6) ON CONFLICT (job_id) DO NOTHING`,
        [p.job_id, p.kind, p.repo, p.refs_requested, p.base_sha_requested, e.occurred_at],
      );
    } else if (e.type === KNOWLEDGE_EVENT.job_started) {
      const p = KjobStartedPayload.parse(e.payload);
      await tx.query(
        `UPDATE knowledge.knowledge_job SET state = 'running', started_at = $2
          WHERE job_id = $1 AND state = 'queued'`,
        [p.job_id, e.occurred_at],
      );
    } else if (e.type === KNOWLEDGE_EVENT.job_done) {
      const p = KjobDonePayload.parse(e.payload);
      await tx.query(
        `UPDATE knowledge.knowledge_job
            SET state = 'done', finished_at = $2, result = $3::jsonb, result_sha256 = $4
          WHERE job_id = $1 AND state = 'running'`,
        [p.job_id, e.occurred_at, JSON.stringify(p.result), p.result_sha256],
      );
    } else if (e.type === KNOWLEDGE_EVENT.job_error) {
      const p = KjobErrorPayload.parse(e.payload);
      await tx.query(
        `UPDATE knowledge.knowledge_job SET state = 'error', finished_at = $2, error = $3
          WHERE job_id = $1 AND state IN ('queued', 'running')`,
        [p.job_id, e.occurred_at, p.error],
      );
    }
  },
  async reset(tx: Tx) {
    await tx.query('DELETE FROM knowledge.knowledge_job');
  },
  async snapshot(db: Executor) {
    const r = await db.query<JobRow>('SELECT * FROM knowledge.knowledge_job ORDER BY job_id');
    return r.rows.map(toJob);
  },
};

const toJob = (r: JobRow): KnowledgeJob => ({
  job_id: r.job_id as KnowledgeJobId,
  kind: r.kind as KnowledgeJob['kind'],
  repo: r.repo as RepoFullName,
  state: r.state as KnowledgeJob['state'],
  refs_requested: r.refs_requested as KnowledgeJob['refs_requested'],
  base_sha_requested: r.base_sha_requested as KnowledgeJob['base_sha_requested'],
  created_at: iso(r.created_at),
  started_at: r.started_at ? iso(r.started_at) : null,
  finished_at: r.finished_at ? iso(r.finished_at) : null,
  error: r.error,
  result: r.result,
  result_sha256: r.result_sha256 as KnowledgeJob['result_sha256'],
});

/** Folds any new `kjob:` events into the table. Called after every commit that appended one. */
async function catchUp(pool: pg.Pool): Promise<void> {
  const r = await runProjection(pool, knowledgeJobs);
  if (!r.ok)
    throw new Error(
      `knowledge-jobs projection: version mismatch (${r.error.stored_version} != ${r.error.code_version})`,
    );
  const c = await runProjection(pool, censusProjection);
  if (!c.ok)
    throw new Error(
      `knowledge-census projection: version mismatch (${c.error.stored_version} != ${c.error.code_version})`,
    );
}

export async function getJob(db: Executor, id: string): Promise<KnowledgeJob | null> {
  const r = await db.query<JobRow>('SELECT * FROM knowledge.knowledge_job WHERE job_id = $1', [id]);
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

/** The newest `done` job of a repo (the census reads this), or null. */
export async function latestDoneJob(db: Executor, repo: string): Promise<KnowledgeJob | null> {
  const r = await db.query<JobRow>(
    `SELECT * FROM knowledge.knowledge_job WHERE repo = $1 AND state = 'done'
      ORDER BY finished_at DESC, job_id DESC LIMIT 1`,
    [repo],
  );
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

// ---------------------------------------------------------------- job transitions

/** Thrown inside a transaction to roll it back with a typed refusal. */
class Refuse extends Error {
  constructor(readonly refusal: KnowledgeError) {
    super(refusal.message);
  }
}

const db = (e: unknown): KnowledgeError =>
  e instanceof Refuse
    ? e.refusal
    : knowledgeError('database', e instanceof Error ? e.message : String(e));

export async function enqueueJob(
  deps: StoreDeps,
  req: StartCensusIntakeRequest,
): Promise<Result<KnowledgeJob, KnowledgeError>> {
  const clock = clockOf(deps);
  const job_id = newId<'KnowledgeJob'>() as KnowledgeJobId;
  try {
    await withTransaction(deps.pool, async (tx) => {
      const a = await appendEvents(
        tx,
        kjobStream(job_id),
        0,
        [
          {
            type: KNOWLEDGE_EVENT.job_queued,
            actor: KNOWLEDGE_ACTOR,
            idempotency_key: `queued:${job_id}`,
            body: {
              job_id,
              kind: 'census_intake',
              repo: req.repo,
              refs_requested: req.refs ?? 'all',
              base_sha_requested: req.base_sha ?? null,
            },
          },
        ],
        { clock },
      );
      if (!a.ok) throw new Error(`append failed: ${a.error._tag}`);
    });
    await catchUp(deps.pool);
    const job = await getJob(deps.pool, job_id);
    return job ? ok(job) : err(knowledgeError('database', 'the queued job was not folded'));
  } catch (e) {
    return err(db(e));
  }
}

export async function markRunning(deps: StoreDeps, id: KnowledgeJobId): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    const a = await appendEvents(
      tx,
      kjobStream(id),
      1,
      [
        {
          type: KNOWLEDGE_EVENT.job_started,
          actor: KNOWLEDGE_ACTOR,
          idempotency_key: `started:${id}`,
          body: { job_id: id },
        },
      ],
      { clock: clockOf(deps) },
    );
    if (!a.ok) throw new Error(`append failed: ${a.error._tag}`);
  });
  await catchUp(deps.pool);
}

/** `error` from `queued` (a restart found it) or `running`. The text is a reason, never repo content. */
export async function failJob(
  deps: StoreDeps,
  id: KnowledgeJobId,
  fromSeq: 1 | 2,
  error: string,
): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    const a = await appendEvents(
      tx,
      kjobStream(id),
      fromSeq,
      [
        {
          type: KNOWLEDGE_EVENT.job_error,
          actor: KNOWLEDGE_ACTOR,
          idempotency_key: `error:${id}`,
          body: { job_id: id, error: error.slice(0, 500) },
        },
      ],
      { clock: clockOf(deps) },
    );
    if (!a.ok) throw new Error(`append failed: ${a.error._tag}`);
  });
  await catchUp(deps.pool);
}

// ---------------------------------------------------------------- findings

export async function countFindings(db: Executor, repo: string): Promise<FindingCounts> {
  const r = await db.query<{ state: FindingState; n: number }>(
    'SELECT state, count(*)::int AS n FROM security_findings.finding WHERE repo = $1 GROUP BY state',
    [repo],
  );
  const c: FindingCounts = { open: 0, rotated: 0, false_positive: 0, accepted_test_fixture: 0 };
  for (const row of r.rows) c[row.state] = row.n;
  return c;
}

/** The PRR's own shape, counts only. Nothing here can name a rule, path, commit or fingerprint. */
export function securitySummary(
  status: ScanStatus,
  cov: ScanCoverage,
  c: FindingCounts,
): IntakeResult['security_summary'] {
  return {
    history_scan: {
      status,
      refs_covered: cov.refs_covered,
      commits_scanned: cov.commits_scanned,
      truncated: cov.truncated,
      open: c.open,
      rotated: c.rotated,
      false_positive: c.false_positive,
      accepted_test_fixture: c.accepted_test_fixture,
      rules_version: cov.rules_version,
    },
  };
}

export interface JobOutput {
  readonly base: Omit<IntakeResult, 'security_summary' | 'finding_counts'>;
  readonly findings: readonly ScannedFinding[];
}

/**
 * Ends a job in `done`: in ONE transaction the findings are upserted into the Security store,
 * `finding.detected` is appended for each new one, the counts are read back (so they include
 * decisions made on earlier scans), and `kjob.done` is appended with the finished result.
 * Returns the stored job.
 */
export async function finishJob(
  deps: StoreDeps,
  id: KnowledgeJobId,
  out: JobOutput,
  /**
   * Assembles the census from the finished result (PLAN M6.5). It runs in the same transaction, so
   * a job is `done` with its census or not at all, and it sees the counts that include earlier
   * human decisions. A throw rolls the whole job back; the caller then fails the job.
   */
  assemble?: (result: IntakeResult) => CensusRecord,
): Promise<KnowledgeJob> {
  const clock = clockOf(deps);
  await withTransaction(deps.pool, async (tx) => {
    const repo = out.base.repo;
    const detected: Array<{ finding_id: string; rule_id: string }> = [];
    for (const f of out.findings) {
      const finding_id = newId<'SecurityFinding'>();
      const ins = await tx.query<{ finding_id: string }>(
        `INSERT INTO security_findings.finding
           (finding_id, repo, rule_id, fingerprint, state, first_job_id, first_commit, detected_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $6, $7)
         ON CONFLICT (repo, rule_id, fingerprint) DO NOTHING RETURNING finding_id`,
        [finding_id, repo, f.rule_id, f.fingerprint, id, f.first_commit, iso(clock.now())],
      );
      let fid = ins.rows[0]?.finding_id;
      if (fid !== undefined) detected.push({ finding_id: fid, rule_id: f.rule_id });
      else {
        const ex = await tx.query<{ finding_id: string }>(
          'SELECT finding_id FROM security_findings.finding WHERE repo = $1 AND rule_id = $2 AND fingerprint = $3',
          [repo, f.rule_id, f.fingerprint],
        );
        fid = ex.rows[0]?.finding_id as string;
      }
      for (const l of f.locations) {
        await tx.query(
          `INSERT INTO security_findings.finding_location (finding_id, blob_id, line, paths, first_commit, job_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6) ON CONFLICT (finding_id, blob_id, line) DO NOTHING`,
          [fid, l.blob_id, l.line, JSON.stringify(l.paths), l.first_commit, id],
        );
      }
    }
    const counts = await countFindings(tx, repo);
    const result: IntakeResult = {
      ...out.base,
      security_summary: securitySummary(out.base.scan_status, out.base.scan_coverage, counts),
      finding_counts: counts,
    };
    const result_sha256 = hashCanonical(result);
    for (const d of detected) {
      const a = await appendEvents(
        tx,
        findingStream(d.finding_id),
        0,
        [
          {
            type: KNOWLEDGE_EVENT.finding_detected,
            actor: KNOWLEDGE_ACTOR,
            idempotency_key: `detected:${d.finding_id}`,
            body: FindingDetectedPayload.parse({
              finding_id: d.finding_id,
              job_id: id,
              repo,
              rule_id: d.rule_id,
            }),
          },
        ],
        { clock },
      );
      if (!a.ok) throw new Error(`append failed: ${a.error._tag}`);
    }
    const done = await appendEvents(
      tx,
      kjobStream(id),
      2,
      [
        {
          type: KNOWLEDGE_EVENT.job_done,
          actor: KNOWLEDGE_ACTOR,
          idempotency_key: `done:${id}`,
          body: KjobDonePayload.parse({ job_id: id, result, result_sha256 }),
        },
      ],
      { clock },
    );
    if (!done.ok) throw new Error(`append failed: ${done.error._tag}`);
    if (assemble !== undefined) {
      const census = assemble(result);
      const stream = censusStream(census.repo.repo_id, census.baseline_sha);
      const head = await tx.query<{ seq: string }>(
        'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
        [stream],
      );
      const a = await appendEvents(
        tx,
        stream,
        Number(head.rows[0]?.seq ?? 0),
        [
          {
            type: KNOWLEDGE_EVENT.census_assembled,
            actor: KNOWLEDGE_ACTOR,
            idempotency_key: `census:${id}`,
            body: CensusAssembledPayload.parse({
              job_id: id,
              repo,
              census_hash: census.census_hash,
              census,
            }),
          },
        ],
        { clock },
      );
      if (!a.ok) throw new Error(`append failed: ${a.error._tag}`);
    }
  });
  await catchUp(deps.pool);
  const job = await getJob(deps.pool, id);
  if (!job) throw new Error('the finished job was not folded');
  return job;
}

// ---------------------------------------------------------------- Security-only reads and the state change

interface FindingRow {
  finding_id: string;
  repo: string;
  rule_id: string;
  fingerprint: string;
  state: FindingState;
  first_job_id: string;
  first_commit: string | null;
  detected_at: Date;
  state_changed_by: string | null;
  state_changed_at: Date | null;
  state_reason: string | null;
}

async function withLocations(db: Executor, rows: FindingRow[]): Promise<SecurityFinding[]> {
  if (rows.length === 0) return [];
  const locs = await db.query<{
    finding_id: string;
    blob_id: string;
    line: number;
    paths: string[];
    first_commit: string | null;
  }>(
    `SELECT finding_id, blob_id, line, paths, first_commit FROM security_findings.finding_location
      WHERE finding_id = ANY($1::uuid[]) ORDER BY finding_id, blob_id, line`,
    [rows.map((r) => r.finding_id)],
  );
  return rows.map((r) => ({
    finding_id: r.finding_id as FindingId,
    repo: r.repo as RepoFullName,
    rule_id: r.rule_id,
    fingerprint: r.fingerprint as SecurityFinding['fingerprint'],
    state: r.state,
    first_job_id: r.first_job_id as KnowledgeJobId,
    first_commit: r.first_commit as SecurityFinding['first_commit'],
    locations: locs.rows
      .filter((l) => l.finding_id === r.finding_id)
      .map((l) => ({
        blob_id: l.blob_id as SecurityFinding['locations'][number]['blob_id'],
        paths: l.paths,
        line: l.line,
        first_commit: l.first_commit as SecurityFinding['first_commit'],
      })),
    state_changed_by: r.state_changed_by as SecurityFinding['state_changed_by'],
    state_changed_at: r.state_changed_at ? iso(r.state_changed_at) : null,
    state_reason: r.state_reason,
    detected_at: iso(r.detected_at),
  }));
}

export async function listFindings(
  db: Executor,
  filter: { repo?: string | undefined; state?: FindingState | undefined } = {},
): Promise<SecurityFinding[]> {
  const r = await db.query<FindingRow>(
    `SELECT * FROM security_findings.finding
      WHERE ($1::text IS NULL OR repo = $1) AND ($2::text IS NULL OR state = $2)
      ORDER BY repo, detected_at, finding_id`,
    [filter.repo ?? null, filter.state ?? null],
  );
  return withLocations(db, r.rows);
}

export async function getFinding(db: Executor, id: string): Promise<SecurityFinding | null> {
  const r = await db.query<FindingRow>(
    'SELECT * FROM security_findings.finding WHERE finding_id = $1',
    [id],
  );
  return (await withLocations(db, r.rows))[0] ?? null;
}

/**
 * The human-only state change (OB §5.3 items 6 and 11). The acting principal must be a known,
 * active HUMAN: a service principal, an unknown one, or a directory that cannot answer is refused.
 * The edge must be one of the machine (`open -> rotated | false_positive | accepted_test_fixture`).
 * The state change and its record event are one transaction; the event carries who and the hash of
 * the reason, never the reason. (The ledger entry for it comes with the ledger writer, later.)
 */
export async function setFindingState(
  deps: StoreDeps & { readonly principals: PrincipalDirectory },
  id: string,
  req: SetFindingStateRequest,
): Promise<Result<SecurityFinding, KnowledgeError>> {
  const who = await deps.principals.lookup(req.principal_id);
  if (!who.ok) return who;
  if (who.value === null) return err(knowledgeError('principal_refused', 'no such principal'));
  if (who.value.kind !== 'human') {
    return err(
      knowledgeError(
        'principal_refused',
        'finding states are set by a human, not a service principal',
      ),
    );
  }
  if (who.value.status !== 'active') {
    return err(knowledgeError('principal_refused', 'the principal is not active'));
  }
  const clock = clockOf(deps);
  try {
    return ok(
      await withTransaction(deps.pool, async (tx): Promise<SecurityFinding> => {
        const cur = await tx.query<FindingRow>(
          'SELECT * FROM security_findings.finding WHERE finding_id = $1 FOR UPDATE',
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new Refuse(knowledgeError('not_found', 'no such finding'));
        const edge = FindingMachine.assertTransition(row.state, req.state);
        if (!edge.ok) {
          throw new Refuse(
            knowledgeError(
              'conflict',
              `a finding in state ${row.state} cannot become ${req.state}`,
            ),
          );
        }
        const now = clock.now();
        await tx.query(
          `UPDATE security_findings.finding
            SET state = $2, state_changed_by = $3, state_changed_at = $4, state_reason = $5
          WHERE finding_id = $1`,
          [id, req.state, req.principal_id, iso(now), req.reason],
        );
        const head = await tx.query<{ seq: string }>(
          'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
          [findingStream(id)],
        );
        const a = await appendEvents(
          tx,
          findingStream(id),
          Number(head.rows[0]?.seq ?? 0),
          [
            {
              type: KNOWLEDGE_EVENT.finding_state_changed,
              actor: req.principal_id,
              occurred_at: now,
              idempotency_key: `state:${id}:${row.state}->${req.state}`,
              body: FindingStateChangedPayload.parse({
                finding_id: id,
                repo: row.repo,
                from: row.state,
                to: req.state,
                principal_id: req.principal_id,
                reason_sha256: hashCanonical(req.reason),
              }),
            },
          ],
          { clock },
        );
        if (!a.ok)
          throw new Refuse(knowledgeError('conflict', `record append refused: ${a.error._tag}`));
        const f = await getFinding(tx, id);
        if (!f) throw new Error('the finding vanished');
        return f;
      }),
    );
  } catch (e) {
    return err(db(e));
  }
}

export type { CoverageItem };
