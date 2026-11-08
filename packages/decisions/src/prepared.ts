import {
  GATE_EVENT,
  VoteDecision,
  gatePolicy,
  type PrincipalId,
  type Sha256Hex,
} from '@aisdlc/contracts';
import { err, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import type { Tx } from '@aisdlc/record';
import { randomBytes } from 'node:crypto';
import { decisionError, type DecisionError } from './errors.js';
import {
  DEFAULT_NONCE_TTL_MS,
  appendGateEvents,
  clockOf,
  inDecisionTx,
  inMaintenance,
  lockKey,
  type DecisionDeps,
  type Written,
} from './internal.js';
import { applyVote, enterGate, requirePending, type VoteResult } from './vote.js';
import { readGateState, type GateState } from './state.js';

// PreparedDecision (PLAN M3.3, DM `PreparedDecision` and `GateNonce`). A decision is two calls:
//
//   prepare(gate, principal)              -> a single-use server nonce, bound to the gate's
//                                            subject_hash and to the evidence hash the principal is
//                                            to be shown. Stored (as a hash), expires in 10 minutes.
//   recordEvidenceViewed(nonce, hash)     -> the principal's client reports the evidence it showed;
//                                            a hash other than the bound one is refused.
//   decide(nonce, decision, step_up?)     -> checks everything below, then writes exactly one ledger
//                                            entry through the Notary.
//
// `decide` refuses: an unknown, replayed or expired nonce; a nonce for a gate whose subject has been
// superseded (or any gate no longer pending); a nonce whose evidence was not recorded as viewed; and,
// where the gate needs a step-up (G5, M4, or opened with `step_up`), a missing proof or one that
// `StepUpPort.verify(proof, bound_hash, principal)` rejects. The nonce is consumed in the same
// transaction as the decision, so a refused attempt leaves it usable (until it expires) and a
// successful one cannot be replayed.

const hashOfNonce = (nonce: string): string => sha256Hex(nonce);

export interface PrepareInput {
  readonly gate_instance_id: string;
  readonly principal: PrincipalId;
}

export interface Prepared {
  /** Hand to the principal's client once; only its hash is stored. */
  readonly nonce: string;
  readonly expires_at: string;
  readonly gate_instance_id: string;
  readonly subject_hash: string;
  /** What the principal has to be shown: the evidence pack hash, or the subject hash if there is no pack. */
  readonly evidence_hash: string;
  readonly step_up: { required: boolean; bound_hash: string };
}

/** Issues a nonce for a pending gate to a principal who holds its slot. */
export async function prepare(
  deps: DecisionDeps,
  input: PrepareInput,
): Promise<Result<Prepared, DecisionError>> {
  const clock = clockOf(deps);
  const done = await inDecisionTx<Prepared>(deps, async (tx) => {
    const state = await readGateState(tx, input.gate_instance_id);
    if (!state) return err(decisionError('gate_not_found', `no gate ${input.gate_instance_id}`));
    const refusal = requirePending(deps, state);
    if (refusal) return err(refusal);
    const p = state.open.payload;
    const holders = await deps.eligibility.holders(p.project_id, gatePolicy(p.gate_id).slot);
    if (!holders.ok) return err(decisionError('eligibility_unavailable', holders.error.message));
    if (!holders.value.includes(input.principal)) {
      return err(decisionError('not_eligible', `${input.principal} does not hold the slot`));
    }
    const nonce = randomBytes(32).toString('base64url');
    const created = clock.now();
    const expires = new Date(created.getTime() + (deps.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS));
    const evidence = p.evidence_pack_hash ?? p.subject_hash;
    await tx.query(
      `INSERT INTO decisions.gate_nonce
         (nonce_sha256, gate_instance_id, principal, subject_hash, evidence_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        hashOfNonce(nonce),
        input.gate_instance_id,
        input.principal,
        p.subject_hash,
        evidence,
        created,
        expires,
      ],
    );
    return ok({
      value: {
        nonce,
        expires_at: expires.toISOString(),
        gate_instance_id: input.gate_instance_id,
        subject_hash: p.subject_hash,
        evidence_hash: evidence,
        step_up: p.step_up,
      },
      pending: [],
    });
  });
  return done.ok ? ok(done.value) : done;
}

interface NonceRow {
  nonce_sha256: string;
  gate_instance_id: string;
  principal: string;
  subject_hash: string;
  evidence_hash: string;
  evidence_viewed_at: Date | null;
  expires_at: Date;
  consumed_at: Date | null;
}

const NONCE_COLUMNS = `nonce_sha256, gate_instance_id, principal, subject_hash, evidence_hash,
  evidence_viewed_at, expires_at, consumed_at`;

export interface EvidenceViewedInput {
  readonly nonce: string;
  readonly evidence_hash: string;
}

/**
 * Records that the principal was shown the evidence bound to the nonce (in the nonce row and as a
 * `gate.evidence_viewed` record event). Idempotent. A different hash is `evidence_mismatch`.
 */
export async function recordEvidenceViewed(
  deps: DecisionDeps,
  input: EvidenceViewedInput,
): Promise<Result<{ evidence_viewed_at: string }, DecisionError>> {
  const clock = clockOf(deps);
  const h = hashOfNonce(input.nonce);
  const done = await inDecisionTx<{ evidence_viewed_at: string }>(deps, async (tx) => {
    const peek = await tx.query<NonceRow>(
      `SELECT ${NONCE_COLUMNS} FROM decisions.gate_nonce WHERE nonce_sha256 = $1`,
      [h],
    );
    const first = peek.rows[0];
    if (!first) return err(decisionError('nonce_unknown', 'unknown nonce'));
    await lockKey(tx, `gate:${first.gate_instance_id}`);
    const locked = await tx.query<NonceRow>(
      `SELECT ${NONCE_COLUMNS} FROM decisions.gate_nonce WHERE nonce_sha256 = $1 FOR UPDATE`,
      [h],
    );
    const row = locked.rows[0] as NonceRow;
    if (row.consumed_at) return err(decisionError('nonce_replayed', 'nonce already used'));
    if (!(clock.nowMs() < row.expires_at.getTime())) {
      return err(decisionError('nonce_expired', 'nonce expired'));
    }
    if (row.evidence_hash !== input.evidence_hash) {
      return err(decisionError('evidence_mismatch', 'not the evidence this nonce is bound to'));
    }
    if (row.evidence_viewed_at) {
      return ok({
        value: { evidence_viewed_at: row.evidence_viewed_at.toISOString() },
        pending: [],
      });
    }
    const at = clock.now();
    await tx.query(
      'UPDATE decisions.gate_nonce SET evidence_viewed_at = $2 WHERE nonce_sha256 = $1',
      [h, at],
    );
    const ev = await appendGateEvents(tx, deps, row.gate_instance_id, [
      {
        type: GATE_EVENT.evidence_viewed,
        actor: row.principal,
        idempotency_key: `evidence_viewed:${h}`,
        body: { principal: row.principal, evidence_hash: row.evidence_hash, nonce_sha256: h },
      },
    ]);
    if (!ev.ok) return ev;
    return ok({ value: { evidence_viewed_at: at.toISOString() }, pending: [] });
  });
  return done.ok ? ok(done.value) : done;
}

/** A nonce that passed every check of `decide` and is consumed. */
export interface ConsumedNonce {
  readonly row: {
    readonly principal: string;
    readonly evidence_hash: string;
    readonly evidence_viewed_at: Date;
  };
  readonly stepUp: { bound_hash: Sha256Hex; proof_sha256: Sha256Hex } | null;
}

/**
 * Every check `decide` makes between the gate state and the vote, and the consume: the nonce is
 * known, unused and unexpired; it is bound to this gate's current subject hash; the gate is
 * pending; the evidence was recorded as viewed; and a gate that needs a step-up has a valid proof.
 * Call after `enterGate` (gate lock, ledger lock). The nonce row is locked FOR UPDATE here and
 * consumed in the caller's transaction, so a refusal anywhere rolls the consume back.
 */
export async function consumeNonce(
  tx: Tx,
  deps: DecisionDeps,
  nonce: string,
  state: GateState,
  stepUpInput: { readonly proof: string } | undefined,
): Promise<Result<ConsumedNonce, DecisionError>> {
  const clock = clockOf(deps);
  const h = hashOfNonce(nonce);
  const locked = await tx.query<NonceRow>(
    `SELECT ${NONCE_COLUMNS} FROM decisions.gate_nonce WHERE nonce_sha256 = $1 FOR UPDATE`,
    [h],
  );
  const row = locked.rows[0];
  if (!row) return err(decisionError('nonce_unknown', 'unknown nonce'));
  if (row.gate_instance_id !== state.open.gate_instance_id) {
    return err(decisionError('nonce_unknown', 'nonce is bound to another gate'));
  }
  if (row.consumed_at) return err(decisionError('nonce_replayed', 'nonce already used'));
  if (!(clock.nowMs() < row.expires_at.getTime())) {
    return err(decisionError('nonce_expired', 'nonce expired'));
  }
  const p = state.open.payload;
  if (state.status === 'superseded' || row.subject_hash !== p.subject_hash) {
    return err(decisionError('subject_superseded', 'the gate was reopened for a new subject hash'));
  }
  const refusal = requirePending(deps, state);
  if (refusal) return err(refusal);
  if (!row.evidence_viewed_at) {
    return err(decisionError('evidence_not_viewed', 'evidence_viewed was not recorded'));
  }
  let stepUp: ConsumedNonce['stepUp'] = null;
  if (p.step_up.required) {
    if (!stepUpInput?.proof) {
      return err(decisionError('step_up_required', `${p.gate_id} needs a step-up proof`));
    }
    const v = await deps.stepUp.verify(
      stepUpInput.proof,
      p.step_up.bound_hash,
      row.principal as PrincipalId,
    );
    if (!v.ok) return err(decisionError('step_up_invalid', v.error.message));
    stepUp = {
      bound_hash: p.step_up.bound_hash,
      proof_sha256: sha256Hex(stepUpInput.proof) as Sha256Hex,
    };
  }
  await tx.query('UPDATE decisions.gate_nonce SET consumed_at = $2 WHERE nonce_sha256 = $1', [
    h,
    clock.now(),
  ]);
  return ok({
    row: {
      principal: row.principal,
      evidence_hash: row.evidence_hash,
      evidence_viewed_at: row.evidence_viewed_at,
    },
    stepUp,
  });
}

export interface DecideInput {
  readonly nonce: string;
  /** `approve`, `reject` or `request_changes`; supersede, expire and withdraw are not votes. */
  readonly decision: string;
  /** The step-up proof, bound to `Prepared.step_up.bound_hash`. */
  readonly step_up?: { readonly proof: string };
}

/** Applies a prepared decision: one transaction, one ledger entry (the last write), then confirm. */
export async function decide(
  deps: DecisionDeps,
  input: DecideInput,
): Promise<Result<Written<VoteResult>, DecisionError>> {
  const decision = VoteDecision.safeParse(input.decision);
  if (!decision.success) {
    return err(decisionError('invalid_input', `${input.decision} is not a vote decision`));
  }
  if (await inMaintenance(deps)) {
    return err(decisionError('maintenance', 'maintenance mode MM-2: decisions are disabled'));
  }
  const h = hashOfNonce(input.nonce);
  return inDecisionTx(deps, async (tx) => {
    const peek = await tx.query<{ gate_instance_id: string }>(
      'SELECT gate_instance_id FROM decisions.gate_nonce WHERE nonce_sha256 = $1',
      [h],
    );
    const gateId = peek.rows[0]?.gate_instance_id;
    if (!gateId) return err(decisionError('nonce_unknown', 'unknown nonce'));

    // Lock order: gate, then ledger (enterGate), then the nonce row; the entry is written last.
    const entered = await enterGate(tx, deps, gateId);
    if (!entered.ok) return entered;
    const { state } = entered.value;
    const used = await consumeNonce(tx, deps, input.nonce, state, input.step_up);
    if (!used.ok) return used;
    const { row, stepUp } = used.value;
    const voted = await applyVote(tx, deps, state, {
      gate_instance_id: gateId,
      voter: row.principal as PrincipalId,
      decision: decision.data,
      evidence: {
        evidence_hash: row.evidence_hash as Sha256Hex,
        evidence_viewed_at: row.evidence_viewed_at.toISOString(),
        nonce_sha256: h as Sha256Hex,
        step_up: stepUp,
      },
    });
    if (!voted.ok) return voted;
    return ok({
      value: { entry: voted.value.entry, after: voted.value.after },
      pending: [...entered.value.pending, ...voted.value.pending],
    });
  });
}
