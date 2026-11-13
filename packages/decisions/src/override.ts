import {
  ADMIN_OVERRIDE_ENTRY_TYPE,
  ADMIN_OVERRIDE_EVENT,
  AdminOverrideBody,
  AdminOverrideReason,
  adminOverrideStream,
  type AdminOverrideRule,
  type GateId,
  type JsonObject,
  type LedgerEntry,
  type LedgerEntryDraft,
  type PdpResource,
  type PrincipalId,
} from '@aisdlc/contracts';
import { err, newId, ok, type Result } from '@aisdlc/kernel';
import type { PendingConfirm } from '@aisdlc/ledger';
import { appendEvents, type NewEvent, type Tx } from '@aisdlc/record';
import { decisionError, type DecisionError } from './errors.js';
import {
  DEFAULT_POLICY_BUNDLE_VERSION,
  clockOf,
  enterLedger,
  inDecisionTx,
  newEntryId,
  writeDecision,
  type DecisionDeps,
  type Written,
} from './internal.js';
import type { PolicyRefusalCode } from './policy.js';

// The factory admin's override in the decision kernel (owner decision 2026-11-13; docs/specs/deletion.md §8). A
// caller that passes `override: {reason}` asks the kernel to decide outside the slot, two-person, own-request and
// step-up rules. The kernel asks `DecisionDeps.admins` itself whether the principal is a factory admin (a caller's word
// is not enough; no port: refused), and records every override: the decision entry carries `body.override` and an
// `admin.override` record event names the rules it bypassed; an override that is not a gate decision is its own
// `admin.override` ledger entry. The override never skips what is physical rather than a rule: the gate must be
// pending and not expired, MM-2 refuses, and the nonce binds the decision to the evidence shown.

/** What a caller passes to act as the factory admin outside a rule. */
export interface OverrideInput {
  readonly reason: string;
}

/** An override the kernel accepted: its id and the trimmed reason. */
export interface AcceptedOverride {
  readonly override_id: string;
  readonly reason: string;
}

/** The rule a policy refusal is. */
export const OVERRIDE_RULE_OF_REFUSAL: Readonly<Record<PolicyRefusalCode, AdminOverrideRule>> = {
  not_eligible: 'slot',
  own_request: 'own_request',
  already_voted: 'already_voted',
  quorum_infeasible: 'quorum_infeasible',
  policy_changed: 'policy_changed',
};

/**
 * Accepts an override for `principal` only when the reason is not blank AND the admin port says the principal is a
 * factory admin. Fail closed: no port, a port error or "no" is a refusal.
 */
export async function acceptOverride(
  deps: DecisionDeps,
  principal: PrincipalId | string,
  input: OverrideInput,
): Promise<Result<AcceptedOverride, DecisionError>> {
  const reason = AdminOverrideReason.safeParse(input.reason);
  if (!reason.success) {
    return err(decisionError('invalid_input', 'an override needs a reason'));
  }
  if (!deps.admins) {
    return err(decisionError('not_eligible', 'the factory admin override is not available here'));
  }
  const is = await deps.admins.isFactoryAdmin(principal as PrincipalId);
  if (!is.ok) return err(decisionError('eligibility_unavailable', is.error.message));
  if (!is.value) {
    return err(decisionError('not_eligible', `${principal} is not a factory admin: no override`));
  }
  return ok({ override_id: newId<'AdminOverride'>(clockOf(deps).nowMs()), reason: reason.data });
}

export interface OverrideFacts {
  readonly override_id: string;
  readonly actor: PrincipalId | string;
  readonly action: string;
  readonly resource: PdpResource | null;
  readonly gate: { readonly gate_instance_id: string; readonly gate_id: GateId } | null;
  readonly reason: string;
  readonly bypassed: readonly AdminOverrideRule[];
  readonly decision_entry_id: string | null;
}

/** The `admin.override` record event (on its own stream `admin_override:<id>`). */
export function overrideEvent(deps: DecisionDeps, f: OverrideFacts): NewEvent {
  const body = AdminOverrideBody.parse({
    override_id: f.override_id,
    actor: f.actor,
    action: f.action,
    resource: f.resource,
    gate: f.gate,
    reason: f.reason,
    bypassed: [...new Set(f.bypassed)],
    decision_entry_id: f.decision_entry_id,
    at: clockOf(deps).now().toISOString(),
  });
  return {
    type: ADMIN_OVERRIDE_EVENT,
    actor: String(f.actor),
    idempotency_key: `${ADMIN_OVERRIDE_EVENT}:${f.override_id}`,
    body: body as unknown as JsonObject,
  };
}

/** Appends the override event. Call inside a decision transaction, after the ledger lock. */
export async function appendOverrideEvent(
  tx: Tx,
  deps: DecisionDeps,
  f: OverrideFacts,
): Promise<Result<void, DecisionError>> {
  const r = await appendEvents(
    tx,
    adminOverrideStream(f.override_id),
    0,
    [overrideEvent(deps, f)],
    {
      clock: clockOf(deps),
    },
  );
  return r.ok ? ok(undefined) : err(decisionError('conflict', JSON.stringify(r.error)));
}

/**
 * Records an override that is not a gate decision (a settings change applied alone, a kill released alone, a delete,
 * an action only the override permitted): the record event, then its `admin.override` ledger entry, LAST. Call in a
 * transaction that already holds the ledger lock (`enterLedger`), after the caller's own record appends.
 */
export async function recordOverrideTx(
  tx: Tx,
  deps: DecisionDeps,
  f: Omit<OverrideFacts, 'decision_entry_id'>,
): Promise<Result<{ entry: LedgerEntry; pending: PendingConfirm[] }, DecisionError>> {
  const ev = await appendOverrideEvent(tx, deps, { ...f, decision_entry_id: null });
  if (!ev.ok) return ev;
  const body = AdminOverrideBody.parse({
    override_id: f.override_id,
    actor: f.actor,
    action: f.action,
    resource: f.resource,
    gate: f.gate,
    reason: f.reason,
    bypassed: [...new Set(f.bypassed)],
    decision_entry_id: null,
    at: clockOf(deps).now().toISOString(),
  });
  const draft = {
    entry_id: newEntryId(deps),
    entry_type: ADMIN_OVERRIDE_ENTRY_TYPE,
    gate_instance_id: null,
    gate_id: null,
    subject_kind: null,
    subject_id: null,
    subject_hash: null,
    decision: null,
    actor: f.actor,
    sod_waiver: f.bypassed.length > 0,
    policy_bundle_version: deps.policyBundleVersion ?? DEFAULT_POLICY_BUNDLE_VERSION,
    body: body as unknown as JsonObject,
    created_at: clockOf(deps).now().toISOString(),
  } as LedgerEntryDraft;
  return writeDecision(tx, deps, draft);
}

/** `recordOverrideTx` in its own transaction (lock order: the ledger lock, the event, the entry last). */
export async function recordOverride(
  deps: DecisionDeps,
  f: Omit<OverrideFacts, 'decision_entry_id' | 'override_id'> & { override_id?: string },
): Promise<Result<Written<{ entry: LedgerEntry; override_id: string }>, DecisionError>> {
  const override_id = f.override_id ?? newId<'AdminOverride'>(clockOf(deps).nowMs());
  return inDecisionTx(deps, async (tx) => {
    const entered = await enterLedger(tx, deps);
    if (!entered.ok) return entered;
    const w = await recordOverrideTx(tx, deps, { ...f, override_id });
    if (!w.ok) return w;
    return ok({
      value: { entry: w.value.entry, override_id },
      pending: [...entered.value, ...w.value.pending],
    });
  });
}
