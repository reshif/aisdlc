import {
  GATE_EVENT,
  pdpResource,
  gatePolicy,
  type AdminOverrideRule,
  type CardId,
  type LedgerEntry,
  type LedgerEntryDraft,
  type PrincipalId,
  type Sha256Hex,
  type VoteDecision,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { PendingConfirm } from '@aisdlc/ledger';
import type { NewEvent, Tx } from '@aisdlc/record';
import { decisionError, type DecisionError } from './errors.js';
import {
  appendGateEvents,
  clockOf,
  decisionDraft,
  enterLedger,
  inDecisionTx,
  inMaintenance,
  lockKey,
  newEntryId,
  writeDecision,
  type DecisionDeps,
  type Written,
} from './internal.js';
import { evaluateVote } from './policy.js';
import {
  OVERRIDE_RULE_OF_REFUSAL,
  appendOverrideEvent,
  type AcceptedOverride,
  type OverrideFacts,
} from './override.js';
import { gateHolders } from './ports.js';
import {
  decisionRowOf,
  foldDecisions,
  readGateState,
  type FoldedGate,
  type GateState,
} from './state.js';

// Votes: policy check plus persistence (PLAN M3.2). `castVoteTx` is what `decide` (M3.3) runs after
// its nonce, evidence and step-up checks. It is exported from this module for the tests of the
// policy and persistence and is NOT part of the package's public surface: a caller that skipped
// `prepare` and `decide` would skip the evidence and step-up rules.

/** What the vote carries into the ledger body (`DecisionBody.vote`). */
export interface VoteEvidence {
  readonly evidence_hash: Sha256Hex;
  readonly evidence_viewed_at: string;
  readonly nonce_sha256: Sha256Hex;
  readonly step_up: { bound_hash: Sha256Hex; proof_sha256: Sha256Hex } | null;
}

export interface VoteRequest {
  readonly gate_instance_id: string;
  readonly voter: PrincipalId;
  readonly decision: VoteDecision;
  readonly evidence: VoteEvidence;
  /** The card decision this vote is part of; goes into the ledger body (PLAN M3.4). */
  readonly card?: { readonly card_id: CardId; readonly payload_hash: Sha256Hex };
  /**
   * An override the kernel accepted (`acceptOverride`), with the rules already bypassed before the vote (the step-up).
   * The vote then decides the gate whatever the slot, two-person and own-request rules say, and is recorded as such.
   */
  readonly override?: AcceptedOverride & { readonly bypassed: readonly AdminOverrideRule[] };
}

export interface VoteResult {
  readonly entry: LedgerEntry;
  /** The instance after this entry. */
  readonly after: FoldedGate;
}

/**
 * Takes the gate lock and the ledger lock, imports stranded Notary entries and loads the
 * authoritative state of a gate, whatever its status. See `enterLedger` for the lock order.
 */
export async function enterGate(
  tx: Tx,
  deps: DecisionDeps,
  gateInstanceId: string,
): Promise<Result<{ state: GateState; pending: readonly PendingConfirm[] }, DecisionError>> {
  await lockKey(tx, `gate:${gateInstanceId}`);
  const entered = await enterLedger(tx, deps);
  if (!entered.ok) return entered;
  const state = await readGateState(tx, gateInstanceId);
  if (!state) return err(decisionError('gate_not_found', `no gate instance ${gateInstanceId}`));
  return ok({ state, pending: entered.value });
}

/**
 * Refuses a gate that has left `pending` or is past `facts.expires_at`. Expiry never approves: a
 * vote after the deadline is refused even before the sweep has written the `expire` entry.
 */
export function requirePending(deps: DecisionDeps, state: GateState): DecisionError | null {
  const id = state.open.gate_instance_id;
  if (state.status !== 'pending') {
    return decisionError('gate_not_pending', `gate ${id} is ${state.status}, not pending`);
  }
  const expires = Date.parse(String(state.open.payload.facts['expires_at']));
  if (!(clockOf(deps).nowMs() < expires)) {
    return decisionError('gate_expired', `gate ${id} is past its expires_at`);
  }
  return null;
}

/** A vote that passed the policy: what to write, not yet written. */
export interface PlannedVote {
  readonly state: GateState;
  /** The marker record event for the gate stream. */
  readonly marker: NewEvent;
  readonly draft: LedgerEntryDraft;
  readonly entry_id: string;
  /** The `admin.override` record event to append with the marker, when the vote is an override. */
  readonly override: OverrideFacts | null;
}

/**
 * Evaluates the vote under the project's policy and builds the marker event and the ledger draft.
 * Writes nothing, so a card decision can plan every gate first and write only if all of them pass.
 */
export async function planVote(
  deps: DecisionDeps,
  state: GateState,
  req: VoteRequest,
): Promise<Result<PlannedVote, DecisionError>> {
  const p = state.open.payload;
  const holders = await gateHolders(
    deps.eligibility,
    p.project_id,
    gatePolicy(p.gate_id).slot,
    p.deciders,
  );
  const ctx = await deps.eligibility.policy(p.project_id);
  if (!holders.ok || !ctx.ok) {
    const why = !holders.ok ? holders.error.message : !ctx.ok ? ctx.error.message : '';
    return err(decisionError('eligibility_unavailable', why));
  }
  const verdict = evaluateVote({
    key: p.gate_id,
    ctx: ctx.value,
    holders: holders.value,
    requester: p.requester,
    authors: p.authors ?? [],
    voter: req.voter,
    decision: req.decision,
    approvers: state.approvers as PrincipalId[],
    frozenQuorum: p.quorum.required,
  });
  // The override: whatever the rules say, this vote decides. What they would have said is recorded.
  const o = req.override;
  if (!verdict.ok && !o) return err(decisionError(verdict.error.code, verdict.error.message));
  const bypassed: AdminOverrideRule[] = [...(o?.bypassed ?? [])];
  if (o) {
    if (!verdict.ok) bypassed.push(OVERRIDE_RULE_OF_REFUSAL[verdict.error.code]);
    else if (req.decision === 'approve' && verdict.value.outcome === 'pending') {
      bypassed.push('two_person');
    }
  }
  const sodWaiver = o
    ? bypassed.length > 0 || (verdict.ok && verdict.value.sod_waiver)
    : verdict.ok && verdict.value.sod_waiver;
  const approvalsAfter = verdict.ok
    ? verdict.value.approvals_after
    : state.approvers.length +
      (req.decision === 'approve' && !state.approvers.includes(req.voter) ? 1 : 0);

  const entryId = newEntryId(deps);
  const marker: NewEvent = {
    type: GATE_EVENT.vote,
    actor: req.voter,
    idempotency_key: `vote:${entryId}`,
    body: { ledger_entry_id: entryId, approver: req.voter, decision: req.decision },
  };
  const draft = decisionDraft(deps, {
    entry_id: entryId,
    gate_instance_id: state.open.gate_instance_id,
    gate_id: p.gate_id,
    subject_kind: p.subject_kind,
    subject_id: p.subject_id,
    subject_hash: p.subject_hash,
    decision: req.decision,
    actor: req.voter,
    sod_waiver: sodWaiver,
    body: {
      kind: 'vote',
      evidence_hash: req.evidence.evidence_hash,
      evidence_viewed_at: req.evidence.evidence_viewed_at,
      nonce_sha256: req.evidence.nonce_sha256,
      step_up: req.evidence.step_up,
      quorum_required: p.quorum.required,
      approvals_after: approvalsAfter,
      ...(req.card ? { card: req.card } : {}),
      ...(o ? { override: { override_id: o.override_id, reason: o.reason, bypassed } } : {}),
    },
  });
  const override: OverrideFacts | null = o
    ? {
        override_id: o.override_id,
        actor: req.voter,
        action: 'gate.decide',
        resource: pdpResource.gate(p.project_id, state.open.gate_instance_id, p.gate_id),
        gate: { gate_instance_id: state.open.gate_instance_id, gate_id: p.gate_id },
        reason: o.reason,
        bypassed,
        decision_entry_id: entryId,
      }
    : null;
  return ok({ state, marker, draft, entry_id: entryId, override });
}

/** The gate state after `entry` joined its decisions. */
export function stateAfter(state: GateState, entry: LedgerEntry): FoldedGate {
  const p = state.open.payload;
  return foldDecisions({ subject_hash: p.subject_hash, quorum_required: p.quorum.required }, [
    ...state.decisions,
    decisionRowOf(entry),
  ]);
}

/**
 * Plans the vote and, if allowed, writes the marker record event and then the ledger entry (the
 * last write). Must run in a transaction that called `enterGate` and `requirePending`.
 */
export async function applyVote(
  tx: Tx,
  deps: DecisionDeps,
  state: GateState,
  req: VoteRequest,
): Promise<Result<VoteResult & { pending: PendingConfirm[] }, DecisionError>> {
  const planned = await planVote(deps, state, req);
  if (!planned.ok) return planned;
  const marker = await appendGateEvents(tx, deps, state.open.gate_instance_id, [
    planned.value.marker,
  ]);
  if (!marker.ok) return marker;
  if (planned.value.override) {
    const ov = await appendOverrideEvent(tx, deps, planned.value.override);
    if (!ov.ok) return ov;
  }
  const w = await writeDecision(tx, deps, planned.value.draft);
  if (!w.ok) return w;
  return ok({
    entry: w.value.entry,
    after: stateAfter(state, w.value.entry),
    pending: w.value.pending,
  });
}

/** Policy and persistence of one vote, in its own transaction (see the module note). */
export async function castVote(
  deps: DecisionDeps,
  req: VoteRequest,
): Promise<Result<Written<VoteResult>, DecisionError>> {
  if (await inMaintenance(deps)) {
    return err(decisionError('maintenance', 'maintenance mode MM-2: decisions are disabled'));
  }
  return inDecisionTx(deps, async (tx) => {
    const loaded = await enterGate(tx, deps, req.gate_instance_id);
    if (!loaded.ok) return loaded;
    const refusal = requirePending(deps, loaded.value.state);
    if (refusal) return err(refusal);
    const voted = await applyVote(tx, deps, loaded.value.state, req);
    if (!voted.ok) return voted;
    return ok({
      value: { entry: voted.value.entry, after: voted.value.after },
      pending: [...loaded.value.pending, ...voted.value.pending],
    });
  });
}
