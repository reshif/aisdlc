import { readLineage } from '@aisdlc/config';
import {
  S0BootstrapGrantedPayload,
  S0_EVENT,
  type PrincipalId,
  type RecordEvent,
} from '@aisdlc/contracts';
import { EVENT_COLUMNS, toRecordEvent, type EventRow, type Executor } from '@aisdlc/record';
import { foldS0, isTerminal } from './fold.js';

// The bootstrap grant of a project's first onboarding (PLAN M7.4; user decision 2026-11-08), read
// from the record. It lives here, below core and the bff, because both ask the same question: core
// for the decision kernel's eligibility (`BootstrapEligibility`), core and the bff for the PDP
// (`BootstrapPdpEntities`). One definition of "live", so the two can never disagree.

export interface LiveBootstrap {
  readonly s0_id: string;
  readonly grantee: PrincipalId;
}

const projectLineage = (project: string) =>
  ({ layer: 'project', scope: { kind: 'project', ref: project } }) as const;

/** Has a project-layer revision (its role map among the settings) been published for the project? */
export async function hasPublishedSettings(db: Executor, project: string): Promise<boolean> {
  return (await readLineage(db, projectLineage(project))).published.length > 0;
}

async function stream(db: Executor, name: string): Promise<RecordEvent[]> {
  const q = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [name],
  );
  return q.rows.map(toRecordEvent);
}

/**
 * The provisional grant that is in force for a project: a granted S0 record that has not ended,
 * while no revision is published. `except` lists records that are about to end in the same
 * transaction (older requests for the repo that a new request supersedes).
 */
export async function liveBootstrap(
  db: Executor,
  project: string,
  except: readonly string[] = [],
): Promise<LiveBootstrap | null> {
  const granted = await db.query<{ body: unknown }>(
    `SELECT body FROM record.record_event
      WHERE type = $1 AND body ->> 'project_id' = $2 ORDER BY global_seq`,
    [S0_EVENT.bootstrap_granted, project],
  );
  for (const row of granted.rows) {
    const g = S0BootstrapGrantedPayload.safeParse(row.body);
    if (!g.success || except.includes(g.data.s0_id)) continue;
    const s0 = foldS0(await stream(db, `s0:${g.data.s0_id}`));
    if (!s0 || isTerminal(s0.record.status)) continue;
    if (await hasPublishedSettings(db, project)) return null;
    return { s0_id: g.data.s0_id, grantee: g.data.grantee };
  }
  return null;
}
