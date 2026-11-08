import type { PrincipalSummary, Team } from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';

// Lookups over the directory read models, for pickers and name resolution. A lookup of something
// the directory does not hold is `null` or absent, never a guess.

interface PrincipalRow {
  principal_id: string;
  handle: string;
  display: string;
  kind: string;
  status: string;
}

const toSummary = (r: PrincipalRow): PrincipalSummary =>
  ({
    principal_id: r.principal_id,
    display_handle: r.handle,
    display_name: r.display,
    kind: r.kind,
    status: r.status,
  }) as PrincipalSummary;

export async function getPrincipal(db: Executor, id: string): Promise<PrincipalSummary | null> {
  const q = await db.query<PrincipalRow>(
    'SELECT * FROM directory.principal WHERE principal_id = $1',
    [id],
  );
  return q.rows[0] ? toSummary(q.rows[0]) : null;
}

/** Handles compare without case. */
export async function findPrincipalByHandle(
  db: Executor,
  handle: string,
): Promise<PrincipalSummary | null> {
  const q = await db.query<PrincipalRow>(
    'SELECT * FROM directory.principal WHERE lower(handle) = lower($1) ORDER BY principal_id LIMIT 1',
    [handle],
  );
  return q.rows[0] ? toSummary(q.rows[0]) : null;
}

/** Name resolution for many ids at once; ids the directory does not know are absent from the map. */
export async function getPrincipals(
  db: Executor,
  ids: readonly string[],
): Promise<Map<string, PrincipalSummary>> {
  if (ids.length === 0) return new Map();
  const q = await db.query<PrincipalRow>(
    'SELECT * FROM directory.principal WHERE principal_id = ANY($1::text[])',
    [[...ids]],
  );
  return new Map(q.rows.map((r) => [r.principal_id, toSummary(r)]));
}

export interface PrincipalFilter {
  readonly kind?: PrincipalSummary['kind'];
  readonly status?: PrincipalSummary['status'];
  /** Case-insensitive prefix of the handle or of the display name. */
  readonly q?: string;
  /** Default 50, at most 200. */
  readonly limit?: number;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A picker's list: ordered by handle. Disabled and deleted principals are listed only when asked for by status. */
export async function listPrincipals(
  db: Executor,
  f: PrincipalFilter = {},
): Promise<PrincipalSummary[]> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const prefix = f.q === undefined ? null : `${escapeLike(f.q.toLowerCase())}%`;
  const q = await db.query<PrincipalRow>(
    `SELECT * FROM directory.principal
      WHERE ($1::text IS NULL OR kind = $1)
        AND ($2::text IS NULL AND status = 'active' OR status = $2)
        AND ($3::text IS NULL OR lower(handle) LIKE $3 OR lower(display) LIKE $3)
      ORDER BY lower(handle), principal_id LIMIT $4`,
    [f.kind ?? null, f.status ?? null, prefix, limit],
  );
  return q.rows.map(toSummary);
}

interface TeamRow {
  team_id: string;
  name: string;
  classification: string;
  idp_group: string | null;
}

const toTeam = (r: TeamRow): Team => r as Team;

export async function getTeam(db: Executor, id: string): Promise<Team | null> {
  const q = await db.query<TeamRow>('SELECT * FROM directory.team WHERE team_id = $1', [id]);
  return q.rows[0] ? toTeam(q.rows[0]) : null;
}

export async function listTeams(db: Executor): Promise<Team[]> {
  const q = await db.query<TeamRow>('SELECT * FROM directory.team ORDER BY lower(name), team_id');
  return q.rows.map(toTeam);
}

/** The team an IdP group maps to, or `null`. */
export async function teamByIdpGroup(db: Executor, group: string): Promise<Team | null> {
  const q = await db.query<TeamRow>(
    'SELECT * FROM directory.team WHERE idp_group = $1 ORDER BY team_id LIMIT 1',
    [group],
  );
  return q.rows[0] ? toTeam(q.rows[0]) : null;
}
