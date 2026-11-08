import { prrStream, repoStream, type RecordEvent } from '@aisdlc/contracts';
import { EVENT_COLUMNS, toRecordEvent, type EventRow, type Executor } from '@aisdlc/record';
import { foldPrr, foldRepo, governingPrr, type PrrState, type PrrVersion } from './fold.js';

// Reading Project Readiness Records from their record streams (`prr:<project>:<repo_id>`). The
// stream is the authority; nothing here reads a projection, so a lagging read model can neither
// release work nor hold it.

async function stream(db: Executor, name: string): Promise<RecordEvent[]> {
  const q = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [name],
  );
  return q.rows.map(toRecordEvent);
}

export async function readPrrState(
  db: Executor,
  project: string,
  repoId: string,
): Promise<PrrState> {
  return foldPrr(await stream(db, prrStream(project, repoId)));
}

/** A repo's project and repo id, from the repo's own stream; `null` for a repo core never registered. */
export async function repoIdentity(
  db: Executor,
  repo: string,
): Promise<{ project_id: string; repo_id: string; repo_ref: string } | null> {
  const r = foldRepo(await stream(db, repoStream(repo)));
  return r ? { project_id: r.project_id, repo_id: r.repo_id, repo_ref: r.repo_ref } : null;
}

/** The version that governs a repo, or `null` when no M4 has ever made one active (N8). */
export async function readGoverning(
  db: Executor,
  repo: string,
): Promise<{ repo_ref: string; project_id: string; governing: PrrVersion | null } | null> {
  const id = await repoIdentity(db, repo);
  if (!id) return null;
  const state = await readPrrState(db, id.project_id, id.repo_id);
  return { repo_ref: id.repo_ref, project_id: id.project_id, governing: governingPrr(state) };
}
