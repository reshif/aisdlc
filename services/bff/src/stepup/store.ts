import type { StepUpClaims } from '@aisdlc/contracts';
import type pg from 'pg';

// The single-use ledger of step-up proofs. A proof is registered when it is issued and consumed
// when a decision verifies it; the consume succeeds exactly once, and only for a proof this store
// issued and that has not expired.

export type ConsumeOutcome = 'consumed' | 'replayed' | 'unknown' | 'expired';

export interface ProofStore {
  /** Records an issued proof. */
  register(claims: StepUpClaims): Promise<void>;
  /** Marks it used. `replayed`: used before. `unknown`: never issued here. */
  consume(proofId: string, now: Date): Promise<ConsumeOutcome>;
}

/** Proofs in the bff schema, so the bff and core (which verifies) see one ledger. */
export class PgProofStore implements ProofStore {
  constructor(private readonly pool: pg.Pool) {}

  async register(c: StepUpClaims): Promise<void> {
    await this.pool.query(
      `INSERT INTO bff.step_up_proof (proof_id, principal_id, bound_hash, method, auth_time, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c.proof_id, c.principal, c.bound_hash, c.method, c.auth_time, c.issued_at, c.expires_at],
    );
  }

  async consume(proofId: string, now: Date): Promise<ConsumeOutcome> {
    // One statement decides: the row is taken only if it is unused and unexpired.
    const taken = await this.pool.query(
      `UPDATE bff.step_up_proof SET consumed_at = $2
        WHERE proof_id = $1 AND consumed_at IS NULL AND expires_at > $2`,
      [proofId, now],
    );
    if (taken.rowCount === 1) return 'consumed';
    const row = await this.pool.query<{ consumed_at: Date | null; expires_at: Date }>(
      'SELECT consumed_at, expires_at FROM bff.step_up_proof WHERE proof_id = $1',
      [proofId],
    );
    const r = row.rows[0];
    if (!r) return 'unknown';
    return r.consumed_at !== null ? 'replayed' : 'expired';
  }
}

/** In memory, for unit tests of the verifier. */
export class MemoryProofStore implements ProofStore {
  private readonly rows = new Map<string, { expires: number; used: boolean }>();

  async register(c: StepUpClaims): Promise<void> {
    this.rows.set(c.proof_id, { expires: Date.parse(c.expires_at), used: false });
  }

  async consume(proofId: string, now: Date): Promise<ConsumeOutcome> {
    const r = this.rows.get(proofId);
    if (!r) return 'unknown';
    if (r.used) return 'replayed';
    if (r.expires <= now.getTime()) return 'expired';
    r.used = true;
    return 'consumed';
  }
}
