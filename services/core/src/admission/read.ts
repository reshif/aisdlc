import { AdmissionGrant, Lease, LeaseHistoryEntry, type UnitState } from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';

// Reads of the Unit, Lease and AdmissionGrant read models (PLAN M13.1).

interface GrantRow {
  grant_id: string;
  item_id: string;
  unit_id: string;
  project_id: string;
  lease_epoch: number;
  slot: unknown;
  envelope: unknown;
  status: string;
  release_cause: string | null;
  granted_at: Date;
  released_at: Date | null;
  snapshot_ref: string | null;
  paused_ms: string;
  paused_since: Date | null;
  resumes_grant_id: string | null;
}

const toGrant = (r: GrantRow): AdmissionGrant =>
  AdmissionGrant.parse({
    grant_id: r.grant_id,
    item_id: r.item_id,
    unit_id: r.unit_id,
    project_id: r.project_id,
    lease_epoch: r.lease_epoch,
    slot: r.slot,
    envelope: r.envelope,
    status: r.status,
    release_cause: r.release_cause,
    granted_at: r.granted_at.toISOString(),
    released_at: r.released_at?.toISOString() ?? null,
    snapshot_ref: r.snapshot_ref,
    clock: {
      paused_ms: Number(r.paused_ms),
      paused_since: r.paused_since?.toISOString() ?? null,
    },
    resumes_grant_id: r.resumes_grant_id,
  });

const GRANT_COLS = `grant_id, item_id, unit_id, project_id, lease_epoch, slot, envelope, status, release_cause,
  granted_at, released_at, snapshot_ref, paused_ms::text AS paused_ms, paused_since, resumes_grant_id`;

/** The grants of an item, oldest first. */
export async function listGrants(db: Executor, itemId: string): Promise<AdmissionGrant[]> {
  const q = await db.query<GrantRow>(
    `SELECT ${GRANT_COLS} FROM core.admission_grant WHERE item_id = $1 ORDER BY granted_at, grant_id`,
    [itemId],
  );
  return q.rows.map(toGrant);
}

/** The grants (of every item) in a status, oldest first. */
export async function grantsWithStatus(
  db: Executor,
  status: 'active' | 'waiting',
): Promise<AdmissionGrant[]> {
  const q = await db.query<GrantRow>(
    `SELECT ${GRANT_COLS} FROM core.admission_grant WHERE status = $1 ORDER BY granted_at, grant_id`,
    [status],
  );
  return q.rows.map(toGrant);
}

/** The SQL that counts the coding sessions that may run now: an active grant whose lease is held. */
export const ACTIVE_SESSIONS_SQL = `SELECT count(*)::text AS n FROM core.admission_grant g
    JOIN core.lease l ON l.unit_id = g.unit_id AND l.status = 'held' AND l.holder_kind = 'agent'
   WHERE g.status = 'active'`;

/**
 * How many coding sessions hold a slot now: an `active` grant whose lease is still held. A waiting grant
 * released its slot (HUMAN-WAIT), and a grant that outlives S6 (kept until G4 is decided, DM §6.4) has no
 * session any more.
 */
export async function activeGrantCount(db: Executor): Promise<number> {
  const q = await db.query<{ n: string }>(ACTIVE_SESSIONS_SQL);
  return Number(q.rows[0]?.n ?? 0);
}

interface LeaseRow {
  unit_id: string;
  item_id: string;
  branch: string;
  epoch: number;
  holder_kind: string;
  holder_ref: string | null;
  status: string;
}

/** The leases of an item's Units, with their histories. */
export async function listLeases(db: Executor, itemId: string): Promise<Lease[]> {
  const q = await db.query<LeaseRow>(
    `SELECT unit_id, item_id, branch, epoch, holder_kind, holder_ref, status
       FROM core.lease WHERE item_id = $1 ORDER BY unit_id`,
    [itemId],
  );
  const out: Lease[] = [];
  for (const r of q.rows) {
    const h = await db.query<{
      epoch: number;
      holder_kind: string;
      holder_ref: string | null;
      status: string;
      cause: string;
      at: Date;
    }>(
      `SELECT epoch, holder_kind, holder_ref, status, cause, at FROM core.lease_history
        WHERE unit_id = $1 ORDER BY n`,
      [r.unit_id],
    );
    out.push(
      Lease.parse({
        ...r,
        history: h.rows.map((x) => LeaseHistoryEntry.parse({ ...x, at: x.at.toISOString() })),
      }),
    );
  }
  return out;
}

/** The Unit whose lease changed last: the one the item's lease events (takeover, hand-back) are about. */
export async function currentLease(
  db: Executor,
  itemId: string,
): Promise<{
  unit_id: string;
  epoch: number;
  holder_kind: string;
  status: string;
  state: UnitState;
} | null> {
  const q = await db.query<{
    unit_id: string;
    epoch: number;
    holder_kind: string;
    status: string;
    state: UnitState;
  }>(
    `SELECT l.unit_id, l.epoch, l.holder_kind, l.status, u.state
       FROM core.lease l JOIN core.unit u USING (unit_id)
      WHERE l.item_id = $1 ORDER BY l.event_gseq DESC LIMIT 1`,
    [itemId],
  );
  return q.rows[0] ?? null;
}
