import { CORE_STREAM_PREFIXES, repoKeyOf, type RecordEvent } from '@aisdlc/contracts';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import type { Executor, Projection, Tx } from '@aisdlc/record';
import { foldProject, foldRepo, foldS0 } from './fold.js';

// The `core` read model (PLAN M7.1): Project, Repo, S0 record and step rows, folded from the
// `project:`, `repo:` and `s0:` record streams alone. `apply` folds the stream up to the event with
// the same pure functions the writers use and writes the aggregate's rows, so the tables are a
// function of the record and a rebuild gives the same rows.

async function streamUpTo(tx: Tx, stream: string, seq: number): Promise<RecordEvent[]> {
  const q = await tx.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event
      WHERE stream = $1 AND seq <= $2 ORDER BY record_event.seq`,
    [stream, seq],
  );
  return q.rows.map(toRecordEvent);
}

export interface CoreSnapshot {
  projects: unknown[];
  repos: unknown[];
  s0_records: unknown[];
  s0_steps: unknown[];
}

export const coreProjection: Projection<CoreSnapshot> = {
  name: 'core',
  version: 1,
  tables: ['core.s0_step', 'core.s0_record', 'core.repo', 'core.project'],

  async apply(tx: Tx, e: RecordEvent) {
    if (!CORE_STREAM_PREFIXES.some((p) => e.stream_id.startsWith(p))) return;
    const events = await streamUpTo(tx, e.stream_id, e.stream_seq);
    if (e.stream_id.startsWith('project:')) {
      const st = foldProject(events);
      if (!st) return;
      const p = st.project;
      await tx.query(
        `INSERT INTO core.project
           (project_id, name, team_id, classification, stack, deploys, tier, level, owner,
            attestations, version, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
         ON CONFLICT (project_id) DO UPDATE SET
           name = EXCLUDED.name, team_id = EXCLUDED.team_id,
           classification = EXCLUDED.classification, stack = EXCLUDED.stack,
           deploys = EXCLUDED.deploys, tier = EXCLUDED.tier, level = EXCLUDED.level,
           owner = EXCLUDED.owner, attestations = EXCLUDED.attestations,
           version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
        [
          p.project_id,
          p.name,
          p.team_id,
          p.classification,
          p.stack,
          p.deploys,
          p.tier,
          p.level,
          p.owner,
          JSON.stringify(st.attestations),
          p.version,
          p.updated_at,
        ],
      );
    } else if (e.stream_id.startsWith('repo:')) {
      const r = foldRepo(events);
      if (!r) return;
      await tx.query(
        `INSERT INTO core.repo
           (repo_key, repo_id, repo_ref, project_id, host, owner, name, visibility, owner_type,
            plan, default_branch, stack, onboarding_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (repo_key) DO UPDATE SET
           visibility = EXCLUDED.visibility, owner_type = EXCLUDED.owner_type,
           plan = EXCLUDED.plan, default_branch = EXCLUDED.default_branch,
           stack = EXCLUDED.stack, onboarding_level = EXCLUDED.onboarding_level`,
        [
          repoKeyOf(r.repo_ref),
          r.repo_id,
          r.repo_ref,
          r.project_id,
          r.host,
          r.owner,
          r.name,
          r.visibility,
          r.owner_type,
          r.plan,
          r.default_branch,
          r.stack,
          r.onboarding_level,
        ],
      );
    } else {
      const s = foldS0(events);
      if (!s) return;
      const r = s.record;
      await tx.query(
        `INSERT INTO core.s0_record
           (s0_id, project_id, repo_key, repo_id, status, requested_level, signable_level,
            intake_ref, rejected_at, readiness_version, catalogue_version, catalogue_hash,
            waiting, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (s0_id) DO UPDATE SET
           status = EXCLUDED.status, signable_level = EXCLUDED.signable_level,
           rejected_at = EXCLUDED.rejected_at, readiness_version = EXCLUDED.readiness_version,
           waiting = EXCLUDED.waiting, version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at`,
        [
          r.s0_id,
          r.project_id,
          repoKeyOf(s.repo),
          r.repo_id,
          r.status,
          r.requested_level,
          r.signable_level,
          r.intake_ref,
          r.rejected_at,
          r.readiness_version,
          r.catalogue_ref.version,
          r.catalogue_ref.hash,
          s.waiting,
          r.version,
          r.created_at,
          r.updated_at,
        ],
      );
      for (const st of s.steps.values()) {
        await tx.query(
          `INSERT INTO core.s0_step
             (s0_id, step, state, blocked_cause, started_at, finished_at, send_backs, failures)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (s0_id, step) DO UPDATE SET
             state = EXCLUDED.state, blocked_cause = EXCLUDED.blocked_cause,
             started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
             send_backs = EXCLUDED.send_backs, failures = EXCLUDED.failures`,
          [
            r.s0_id,
            st.step,
            st.state,
            st.blocked_cause,
            st.started_at,
            st.finished_at,
            st.send_backs,
            st.failures,
          ],
        );
      }
    }
  },

  async reset(tx) {
    await tx.query('DELETE FROM core.s0_step');
    await tx.query('DELETE FROM core.s0_record');
    await tx.query('DELETE FROM core.repo');
    await tx.query('DELETE FROM core.project');
  },

  async snapshot(db: Executor) {
    const q = async (sql: string) => (await db.query(sql)).rows;
    return {
      projects: await q('SELECT * FROM core.project ORDER BY project_id'),
      repos: await q('SELECT * FROM core.repo ORDER BY repo_key'),
      s0_records: await q('SELECT * FROM core.s0_record ORDER BY s0_id'),
      s0_steps: await q('SELECT * FROM core.s0_step ORDER BY s0_id, step'),
    };
  },
};
