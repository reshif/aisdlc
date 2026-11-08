import {
  STEP_UP_KEY_ID,
  STEP_UP_TTL_SECONDS,
  StepUpClaims,
  type PrincipalId,
  type StepUpMethod,
} from '@aisdlc/contracts';
import { err, newId, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import type { KeyCustodyPort } from '@aisdlc/ports';
import { digestOf, encodeToken, signingInput } from './token.js';
import type { ProofStore } from './store.js';

// Issues step-up proofs (PLAN M4.5). The private key never reaches this process: signing is a
// call to key custody (kms-local), whose allow-list lets only the bff use `dev:bff-stepup`.

export interface IssueInput {
  readonly principal: PrincipalId;
  /** `subject_hash` or `text_sha256` the proof is for. */
  readonly bound_hash: string;
  readonly method: StepUpMethod;
  /** When the principal authenticated (reauth) or confirmed (reconfirm). */
  readonly auth_time: Date;
}

export interface IssuedProof {
  readonly proof: string;
  readonly claims: StepUpClaims;
}

export class StepUpIssuer {
  constructor(
    private readonly o: {
      readonly custody: KeyCustodyPort;
      readonly store: ProofStore;
      readonly clock?: Clock;
      readonly keyId?: string;
      readonly ttlSeconds?: number;
    },
  ) {}

  async issue(i: IssueInput): Promise<Result<IssuedProof, string>> {
    const now = (this.o.clock ?? systemClock).now();
    const claims = StepUpClaims.parse({
      v: 1,
      proof_id: newId<'StepUpProof'>(now.getTime()),
      principal: i.principal,
      bound_hash: i.bound_hash,
      method: i.method,
      auth_time: i.auth_time.toISOString(),
      issued_at: now.toISOString(),
      expires_at: new Date(
        now.getTime() + (this.o.ttlSeconds ?? STEP_UP_TTL_SECONDS) * 1000,
      ).toISOString(),
    });
    const sig = await this.o.custody.sign(
      this.o.keyId ?? STEP_UP_KEY_ID,
      digestOf(signingInput(claims)),
    );
    if (!sig.ok) return err(`cannot sign the proof: ${sig.error.message}`);
    // Registered after signing and before it is handed out: a proof nobody can use is harmless,
    // a proof that can be used and is not registered would be refused as unknown.
    await this.o.store.register(claims);
    return ok({ proof: encodeToken(claims, sig.value), claims });
  }
}
