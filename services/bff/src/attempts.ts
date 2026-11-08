import { newId } from '@aisdlc/kernel';
import type pg from 'pg';
import { sha256b64 } from './sessions.js';

// Pending OIDC transactions, kept on the server (not in a cookie): the `state` the IdP echoes
// finds the row, and the `binder` cookie ties the callback to the browser that started it, so a
// link an attacker started cannot be completed by a victim (login CSRF).

export interface AttemptRow {
  readonly attempt_id: string;
  readonly purpose: 'login' | 'step_up';
  readonly nonce: string;
  readonly code_verifier: string;
  readonly binder_hash: string;
  readonly return_to: string;
  readonly session_hash: string | null;
  readonly bound_hash: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
}

export const ATTEMPT_TTL_SECONDS = 600;

export async function createAttempt(
  pool: pg.Pool,
  i: {
    readonly purpose: 'login' | 'step_up';
    readonly state: string;
    readonly nonce: string;
    readonly code_verifier: string;
    readonly binder: string;
    readonly return_to: string;
    readonly session_hash?: string;
    readonly bound_hash?: string;
    readonly now: Date;
  },
): Promise<string> {
  const id = newId<'OidcAttempt'>(i.now.getTime());
  await pool.query(
    `INSERT INTO bff.oidc_attempt (attempt_id, state_hash, purpose, nonce, code_verifier, binder_hash,
                                   return_to, session_hash, bound_hash, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      sha256b64(i.state),
      i.purpose,
      i.nonce,
      i.code_verifier,
      sha256b64(i.binder),
      i.return_to,
      i.session_hash ?? null,
      i.bound_hash ?? null,
      i.now,
      new Date(i.now.getTime() + ATTEMPT_TTL_SECONDS * 1000),
    ],
  );
  return id;
}

/**
 * Takes the attempt for a callback: found by `state`, unexpired, never used, and started by the
 * browser holding `binder`. The use is recorded in the same statement, so a callback can be played
 * once. Anything else is `null` (and a binder mismatch does not burn the attempt for its owner).
 */
export async function takeAttempt(
  pool: pg.Pool,
  state: string,
  binder: string,
  now: Date,
): Promise<AttemptRow | null> {
  const q = await pool.query<AttemptRow>(
    `UPDATE bff.oidc_attempt SET consumed_at = $3
      WHERE state_hash = $1 AND binder_hash = $2 AND consumed_at IS NULL AND expires_at > $3
      RETURNING attempt_id, purpose, nonce, code_verifier, binder_hash, return_to, session_hash,
                bound_hash, created_at, expires_at`,
    [sha256b64(state), sha256b64(binder), now],
  );
  return q.rows[0] ?? null;
}

export async function storeProof(
  pool: pg.Pool,
  attemptId: string,
  proofId: string,
  token: string,
): Promise<void> {
  await pool.query(
    'UPDATE bff.oidc_attempt SET proof_id = $2, proof_token = $3 WHERE attempt_id = $1',
    [attemptId, proofId, token],
  );
}

/** Hands the proof to the session that started the step-up, once; afterwards the token is gone. */
export async function collectProof(
  pool: pg.Pool,
  attemptId: string,
  sessionHash: string,
  now: Date,
): Promise<{ token: string; bound_hash: string } | null> {
  // RETURNING would give the NEW row (token already null), so the old values are read under a
  // row lock in the same statement that clears them: two collectors cannot both get the token.
  const q = await pool.query<{ proof_token: string; bound_hash: string }>(
    `WITH old AS (
       SELECT attempt_id, proof_token, bound_hash FROM bff.oidc_attempt
        WHERE attempt_id = $1 AND session_hash = $2 AND purpose = 'step_up'
          AND proof_token IS NOT NULL AND proof_delivered_at IS NULL
        FOR UPDATE)
     UPDATE bff.oidc_attempt a SET proof_delivered_at = $3, proof_token = NULL
       FROM old WHERE a.attempt_id = old.attempt_id
     RETURNING old.proof_token, old.bound_hash`,
    [attemptId, sessionHash, now],
  );
  return q.rows[0] ? { token: q.rows[0].proof_token, bound_hash: q.rows[0].bound_hash } : null;
}
