import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

// Server-side sessions (PLAN M4.5). The browser holds an opaque random id in a cookie; this table
// holds who it is. Only sha256(id) is stored, so a read of the table cannot be replayed as a cookie.

export const sha256b64 = (s: string): string => createHash('sha256').update(s).digest('base64url');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export interface SessionRow {
  readonly id_hash: string;
  readonly principal_id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly auth_time: Date | null;
  readonly csrf_token: string;
  readonly created_at: Date;
  readonly last_seen_at: Date;
  readonly absolute_expires_at: Date;
}

export type RevokeReason =
  'logout' | 'idle_timeout' | 'absolute_timeout' | 'replaced' | 'principal_inactive' | 'admin';

export async function createSession(
  pool: pg.Pool,
  i: {
    readonly principal_id: string;
    readonly issuer: string;
    readonly subject: string;
    readonly auth_time: Date | null;
    readonly id_token: string | null;
    readonly now: Date;
    readonly absoluteSeconds: number;
  },
): Promise<{ id: string; row: SessionRow }> {
  const id = randomToken();
  const row: SessionRow = {
    id_hash: sha256b64(id),
    principal_id: i.principal_id,
    issuer: i.issuer,
    subject: i.subject,
    auth_time: i.auth_time,
    csrf_token: randomToken(),
    created_at: i.now,
    last_seen_at: i.now,
    absolute_expires_at: new Date(i.now.getTime() + i.absoluteSeconds * 1000),
  };
  await pool.query(
    `INSERT INTO bff.session (id_hash, principal_id, issuer, subject, auth_time, id_token, csrf_token,
                              created_at, last_seen_at, absolute_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`,
    [
      row.id_hash,
      row.principal_id,
      row.issuer,
      row.subject,
      row.auth_time,
      i.id_token,
      row.csrf_token,
      i.now,
      row.absolute_expires_at,
    ],
  );
  return { id, row };
}

export type SessionLookup =
  | { readonly ok: true; readonly session: SessionRow }
  | {
      readonly ok: false;
      readonly reason: 'unknown' | 'revoked' | 'idle_timeout' | 'absolute_timeout';
    };

/**
 * The live session for a cookie value, with its idle clock advanced. A session that is past its
 * absolute lifetime or has been idle too long is revoked here, so it can never come back.
 */
export async function lookupSession(
  pool: pg.Pool,
  id: string,
  now: Date,
  idleSeconds: number,
): Promise<SessionLookup> {
  const q = await pool.query<SessionRow & { revoked_at: Date | null }>(
    'SELECT * FROM bff.session WHERE id_hash = $1',
    [sha256b64(id)],
  );
  const row = q.rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (row.absolute_expires_at.getTime() <= now.getTime()) {
    await revokeSession(pool, row.id_hash, 'absolute_timeout', now);
    return { ok: false, reason: 'absolute_timeout' };
  }
  if (row.last_seen_at.getTime() + idleSeconds * 1000 <= now.getTime()) {
    await revokeSession(pool, row.id_hash, 'idle_timeout', now);
    return { ok: false, reason: 'idle_timeout' };
  }
  await pool.query(
    'UPDATE bff.session SET last_seen_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL',
    [row.id_hash, now],
  );
  return { ok: true, session: { ...row, last_seen_at: now } };
}

export async function revokeSession(
  pool: pg.Pool,
  idHash: string,
  reason: RevokeReason,
  now: Date,
): Promise<void> {
  await pool.query(
    'UPDATE bff.session SET revoked_at = $2, revoke_reason = $3 WHERE id_hash = $1 AND revoked_at IS NULL',
    [idHash, now, reason],
  );
}

/** Ends every live session of a principal (a disabled principal must not keep a session). */
export async function revokePrincipalSessions(
  pool: pg.Pool,
  principal: string,
  reason: RevokeReason,
  now: Date,
): Promise<number> {
  const r = await pool.query(
    'UPDATE bff.session SET revoked_at = $2, revoke_reason = $3 WHERE principal_id = $1 AND revoked_at IS NULL',
    [principal, now, reason],
  );
  return r.rowCount ?? 0;
}
