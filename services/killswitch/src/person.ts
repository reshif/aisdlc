import {
  STEP_UP_KEY_ID,
  killActHash,
  type KillAct,
  type PrincipalId,
  type StepUpMethod,
} from '@aisdlc/contracts';
import { err, ok, systemClock, type Clock, type Jwk, type Result } from '@aisdlc/kernel';
import { checkStepUpProof, decodeStepUpToken, type KeyCustodyPort } from '@aisdlc/ports';
import type pg from 'pg';
import { killswitchError, type KillswitchError } from './errors.js';

// Who acts at the kill switch (RC-SEC-3). A service token says which PROCESS calls; it never says which
// person acts. Every act (kill, release approval, delegation, revocation) carries a step-up proof the
// bff signed after that person authenticated again at the identity provider, bound to exactly this act
// (`killActHash`). The kill switch checks it itself, with the bff's PUBLIC key read from key custody (it
// imports nothing of the bff or core: AR9), and keeps its own single-use ledger
// (`killswitch.person_proof`). The actor is the proof's principal: a caller holding one token and one
// person's proof is one person, so two approvals of a two-person release need two people's proofs.
// Every failure, an unreachable key included, is a refusal.

export interface PersonVerifierOptions {
  readonly pool: pg.Pool;
  /** Only `publicKey` is used: the kill switch cannot mint a proof. */
  readonly custody: Pick<KeyCustodyPort, 'publicKey'>;
  readonly clock?: Clock;
  /** The bff's step-up key. Default `dev:bff-stepup`. */
  readonly keyId?: string;
  /** Default `reauth` only: a kill-switch act is never a plain confirm. */
  readonly allowedMethods?: readonly StepUpMethod[];
  readonly skewSeconds?: number;
}

export class PersonVerifier {
  private key: Jwk | null = null;
  private readonly clock: Clock;

  constructor(private readonly o: PersonVerifierOptions) {
    this.clock = o.clock ?? systemClock;
  }

  /**
   * Reads the bff's public key once, at start (boot refuses to start without it): from then on a kill
   * never waits for key custody, so stopping still works while the KMS is away.
   */
  async load(): Promise<Result<true, KillswitchError>> {
    return (await this.publicKey())
      ? ok(true as const)
      : err(killswitchError('unavailable', 'cannot read the step-up verification key'));
  }

  private async publicKey(): Promise<Jwk | null> {
    if (this.key) return this.key;
    const k = await this.o.custody.publicKey(this.o.keyId ?? STEP_UP_KEY_ID);
    if (!k.ok) return null;
    this.key = k.value;
    return this.key;
  }

  /**
   * The authenticated person behind `act`, or a refusal (`unauthenticated`). A proof that passes is
   * consumed here, before the act is decided: a refused act burns it (the person steps up again).
   */
  async authenticate(proof: string, act: KillAct): Promise<Result<PrincipalId, KillswitchError>> {
    const refuse = (why: string) => err(killswitchError('unauthenticated', why));
    const decoded = decodeStepUpToken(proof);
    if (!decoded) return refuse('step-up proof is malformed');
    const key = await this.publicKey();
    if (!key) return refuse('step-up verification key is unavailable');
    const now = this.clock.now();
    const checked = await checkStepUpProof(proof, key, {
      bound_hash: killActHash(act),
      // the principal the proof names; it becomes the actor only once every check has passed
      principal: decoded.claims.principal,
      now,
      allowedMethods: this.o.allowedMethods ?? ['reauth'],
      skewSeconds: this.o.skewSeconds ?? 30,
    });
    if (!checked.ok) return refuse(checked.error);
    const c = checked.value;
    try {
      const used = await this.o.pool.query(
        `INSERT INTO killswitch.person_proof (proof_id, principal, action, bound_hash, method, auth_time, used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (proof_id) DO NOTHING`,
        [c.proof_id, c.principal, act.action, c.bound_hash, c.method, c.auth_time, now],
      );
      if (used.rowCount !== 1) return refuse('step-up proof was already used');
    } catch (e) {
      return err(killswitchError('unavailable', e instanceof Error ? e.message : String(e)));
    }
    return ok(c.principal);
  }
}
