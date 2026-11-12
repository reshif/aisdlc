import {
  STEP_UP_KEY_ID,
  type Sha256Hex,
  type PrincipalId,
  type StepUpMethod,
} from '@aisdlc/contracts';
import { PortError, type StepUpPort } from '@aisdlc/decisions';
import { err, ok, systemClock, type Clock, type Jwk, type Result } from '@aisdlc/kernel';
import { checkStepUpProof, type KeyCustodyPort } from '@aisdlc/ports';
import type { ProofStore } from './store.js';

// The real `StepUpPort` (PLAN M4.5). `verify(proof, boundHash, principal)` is `Ok` only when the
// proof is one the bff signed, is for exactly this hash and principal, has not expired, uses an
// accepted method, and has never been used. The last check consumes it, so it is the last: a proof
// presented with the wrong hash or principal is refused WITHOUT being burnt (the right decision may
// still use it), and a proof that passes is gone for good, even if the decision then fails later.
// Every failure, including a key that cannot be fetched, is a refusal.

const refuse = (message: string) => err(PortError({ message }));

export interface SignedStepUpOptions {
  /** Only the public key is read; the verifier cannot sign. */
  readonly custody: Pick<KeyCustodyPort, 'publicKey'>;
  readonly store: ProofStore;
  readonly clock?: Clock;
  readonly keyId?: string;
  /**
   * The methods accepted. DEC-11(c-ii) `reconfirm` is the weaker, no-re-authentication form: accept
   * it only where that decision was made. Default: `reauth` only.
   */
  readonly allowedMethods?: readonly StepUpMethod[];
  /** Clock skew tolerated for `issued_at` in the future, in seconds. Default 30. */
  readonly skewSeconds?: number;
}

export class SignedStepUp implements StepUpPort {
  private key: Jwk | null = null;

  constructor(private readonly o: SignedStepUpOptions) {}

  private async publicKey(): Promise<Jwk | null> {
    if (this.key) return this.key;
    const k = await this.o.custody.publicKey(this.o.keyId ?? STEP_UP_KEY_ID);
    if (!k.ok) return null;
    this.key = k.value;
    return this.key;
  }

  async verify(
    proof: string,
    boundHash: Sha256Hex,
    principal: PrincipalId,
  ): Promise<Result<true, PortError>> {
    try {
      const key = await this.publicKey();
      if (!key) return refuse('step-up verification key is unavailable');
      const now = (this.o.clock ?? systemClock).now();
      const checked = await checkStepUpProof(proof, key, {
        bound_hash: boundHash,
        principal,
        now,
        allowedMethods: this.o.allowedMethods ?? ['reauth'],
        skewSeconds: this.o.skewSeconds ?? 30,
      });
      if (!checked.ok) return refuse(checked.error);
      const c = checked.value;

      const used = await this.o.store.consume(c.proof_id, now);
      if (used === 'consumed') return ok(true as const);
      return refuse(
        used === 'replayed'
          ? 'step-up proof was already used'
          : used === 'expired'
            ? 'step-up proof has expired'
            : 'step-up proof was not issued by the bff',
      );
    } catch (e) {
      return refuse(`step-up verification failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
