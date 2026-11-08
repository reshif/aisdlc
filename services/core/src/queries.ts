import {
  S0_EVENT,
  projectStream,
  repoKeyOf,
  repoStream,
  type OnboardingStepId,
  type Project,
  type ProjectDetail,
  type ProjectSummary,
  type RegisteredRepo,
  type Repo,
  type S0Overview,
} from '@aisdlc/contracts';
import { EVENT_COLUMNS, runProjection, toRecordEvent, type EventRow } from '@aisdlc/record';
import type pg from 'pg';
import {
  foldProject,
  foldRepo,
  REGISTERED_STATUSES,
  STEPS,
  type ProjectState,
  type S0State,
} from './fold.js';
import { readS0 } from './journal.js';
import { coreProjection } from './projection.js';

/** Catches the `core` read model up with the record, so a write that has committed is visible. */
export async function catchUp(pool: pg.Pool): Promise<void> {
  const r = await runProjection(pool, coreProjection);
  if (!r.ok) throw new Error('the core read model needs a rebuild');
}

async function stream(pool: pg.Pool, name: string) {
  const q = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [name],
  );
  return q.rows.map(toRecordEvent);
}

/** The Project and its folded attestations, from the authoritative stream. */
export async function getProjectState(pool: pg.Pool, id: string): Promise<ProjectState | null> {
  return foldProject(await stream(pool, projectStream(id)));
}

export async function getProject(pool: pg.Pool, id: string): Promise<Project | null> {
  return (await getProjectState(pool, id))?.project ?? null;
}

export async function getRepo(pool: pg.Pool, ref: string): Promise<Repo | null> {
  return foldRepo(await stream(pool, repoStream(ref)));
}

/** `S0Overview` of a folded record: the record, its steps, what it waits for, the counters. */
export function overviewOf(s0: S0State): S0Overview {
  const steps = STEPS.map(
    (id) => s0.steps.get(id) as NonNullable<ReturnType<S0State['steps']['get']>>,
  );
  const by = (f: (s: (typeof steps)[number]) => number) =>
    Object.fromEntries(steps.map((s) => [s.step, f(s)])) as Record<OnboardingStepId, number>;
  return {
    record: s0.record,
    steps: steps.map((s) => ({
      s0_id: s0.record.s0_id,
      step: s.step,
      state: s.state,
      blocked_cause: s.blocked_cause as never,
      started_at: s.started_at,
      finished_at: s.finished_at,
    })),
    waiting: s0.waiting,
    send_backs: by((s) => s.send_backs),
    failures: by((s) => s.failures),
  };
}

export async function getS0Overview(pool: pg.Pool, s0Id: string): Promise<S0Overview | null> {
  const s0 = await readS0(pool, s0Id);
  return s0 ? overviewOf(s0) : null;
}

/** Every S0 record of a repo, newest first (the authoritative streams). */
export async function listS0ForRepo(pool: pg.Pool, repo: string): Promise<S0Overview[]> {
  const q = await pool.query<{ s0_id: string }>(
    `SELECT body ->> 's0_id' AS s0_id FROM record.record_event
      WHERE type = $1 AND lower(body ->> 'repo') = $2 ORDER BY global_seq DESC`,
    [S0_EVENT.requested, repoKeyOf(repo)],
  );
  const out: S0Overview[] = [];
  for (const r of q.rows) {
    const o = await getS0Overview(pool, r.s0_id);
    if (o) out.push(o);
  }
  return out;
}

/** The S0 records the driver has something to do for: `app`, `running` and `card`. */
export async function activeS0Ids(pool: pg.Pool): Promise<string[]> {
  await catchUp(pool);
  const q = await pool.query<{ s0_id: string }>(
    `SELECT s0_id FROM core.s0_record WHERE status IN ('app', 'running', 'card') ORDER BY created_at, s0_id`,
  );
  return q.rows.map((r) => r.s0_id);
}

/**
 * The repos that have an S0 record or request, with their project (P-MUST-3): every record that is
 * live or finished. A withdrawn or superseded record registers nothing (a newer one, if any, does).
 */
export async function registeredRepos(pool: pg.Pool): Promise<RegisteredRepo[]> {
  await catchUp(pool);
  const q = await pool.query<{ project_id: string; repo_ref: string }>(
    `SELECT DISTINCT r.project_id, r.repo_ref
       FROM core.s0_record s JOIN core.repo r ON r.repo_key = s.repo_key
      WHERE s.status = ANY($1::text[]) ORDER BY r.repo_ref`,
    [REGISTERED_STATUSES],
  );
  return q.rows.map((r) => ({ project_id: r.project_id, repo: r.repo_ref })) as RegisteredRepo[];
}

/** Every project the record knows, by id, with its repos and its newest S0 record (the read model, caught up). */
export async function listProjects(pool: pg.Pool): Promise<ProjectSummary[]> {
  await catchUp(pool);
  const ids = await pool.query<{ project_id: string }>(
    'SELECT project_id FROM core.project ORDER BY project_id',
  );
  const out: ProjectSummary[] = [];
  for (const { project_id } of ids.rows) {
    const d = await getProjectDetail(pool, project_id);
    if (!d) continue;
    const s0 = d.s0[0];
    out.push({
      project: d.project,
      repos: d.repos,
      latest_s0: s0
        ? {
            s0_id: s0.record.s0_id,
            repo: (await repoRefOfRecord(pool, s0.record.s0_id)) as never,
            status: s0.record.status,
            requested_level: s0.record.requested_level,
            signable_level: s0.record.signable_level,
            waiting: s0.waiting,
            updated_at: s0.record.updated_at,
          }
        : null,
    });
  }
  return out;
}

async function repoRefOfRecord(pool: pg.Pool, s0Id: string): Promise<string> {
  const q = await pool.query<{ repo_ref: string }>(
    `SELECT r.repo_ref FROM core.s0_record s JOIN core.repo r ON r.repo_key = s.repo_key
      WHERE s.s0_id = $1`,
    [s0Id],
  );
  return q.rows[0]?.repo_ref ?? '';
}

/** One project with its repos and every S0 record of those repos, newest first, from the authoritative streams. */
export async function getProjectDetail(pool: pg.Pool, id: string): Promise<ProjectDetail | null> {
  const project = await getProject(pool, id);
  if (!project) return null;
  await catchUp(pool);
  const repos = await pool.query<{ repo_ref: string }>(
    'SELECT repo_ref FROM core.repo WHERE project_id = $1 ORDER BY repo_ref',
    [id],
  );
  const repoList: Repo[] = [];
  const s0: S0Overview[] = [];
  for (const { repo_ref } of repos.rows) {
    const r = await getRepo(pool, repo_ref);
    if (r) repoList.push(r);
    s0.push(...(await listS0ForRepo(pool, repo_ref)));
  }
  // Stable: records created in the same instant keep the per-repo order (newest event first).
  s0.sort((a, b) =>
    a.record.created_at === b.record.created_at
      ? 0
      : a.record.created_at < b.record.created_at
        ? 1
        : -1,
  );
  return { project, repos: repoList, s0 };
}
