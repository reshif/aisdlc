import {
  CARD_EVENT,
  CardOpenedPayload,
  GATE_POLICIES,
  SOLO_CARDS,
  cardStream,
  gatePolicy,
  soloCardOf,
  type CardGroup,
  type CardKind,
  type GateId,
  type JsonObject,
  type PrincipalId,
  type ProjectId,
  type RoleSlot,
  type StepId,
  type SubjectKind,
} from '@aisdlc/contracts';
import { deterministicId, err, ok, type Result } from '@aisdlc/kernel';
import type { PendingConfirm } from '@aisdlc/ledger';
import { appendEvents, type Tx } from '@aisdlc/record';
import { decisionError, type DecisionError } from '../errors.js';
import {
  clockOf,
  enterLedger,
  inDecisionTx,
  lockKey,
  type DecisionDeps,
  type Written,
} from '../internal.js';
import { openGate, type OpenGateInput } from '../lifecycle.js';
import { readOpened } from '../state.js';
import { DEFAULT_CALENDAR, addBusinessDays } from './calendar.js';
import { readCardOpened } from './state.js';

// Opening cards (PLAN M3.4). Consolidation follows FL PROFILES (`SOLO_CARDS` in the contracts) and
// the gate policies: only `consolidatable` gates of one SOLO card share a card, X, E, M, Q and SECT
// always have a card of their own, and the single operator (one person holds every deciding slot)
// is what makes consolidation apply. Opening a card never decides anything.

/** One gate of a card: `openGate` input without the subject and project the card supplies. */
export type CardGateInput = Omit<
  OpenGateInput,
  'project_id' | 'subject_kind' | 'subject_id' | 'requester'
>;

export interface OpenCardInput {
  readonly project_id: ProjectId;
  readonly subject_kind: SubjectKind;
  readonly subject_id: string;
  /**
   * At least one gate, or none when the card carries step decisions only (the S0 step cards of
   * onboarding, PLAN M7.3). Several only if they are consolidatable gates of one SOLO card.
   */
  readonly gates: readonly CardGateInput[];
  /**
   * Makes the card id unique among cards over the same targets. Required for a card without a gate
   * (its id would otherwise be the same for every record); not allowed with one (its gate
   * instances already say which card it is).
   */
  readonly key?: string;
  /**
   * Step decisions that ride on the card (card 5 of onboarding: the 0.5 sign-off with M4). They are
   * decided in the same transaction as the gates, each as its own ledger entry.
   */
  readonly steps?: ReadonlyArray<{ readonly step: StepId; readonly slot: RoleSlot }>;
  readonly requester?: PrincipalId | null;
  /** The onboarding card (C1..C5, SECR, BATCH, X2) this is the decision of. */
  readonly label?: CardKind | null;
  readonly opened_by?: string;
}

export interface OpenCardResult {
  readonly card_id: string;
  readonly group: CardGroup;
  /** False when the card already existed (same gate instances): nothing was written. */
  readonly opened: boolean;
  readonly gate_instance_ids: readonly string[];
  /** Pending instances the new subject hashes replaced; their cards become `superseded`. */
  readonly superseded: readonly string[];
}

/** Refuses a set of gates that may not share a card. */
export function checkConsolidation(gates: readonly GateId[]): DecisionError | null {
  if (gates.length < 2) return null;
  const groups = new Set(gates.map((g) => soloCardOf(g)));
  const first = [...groups][0] ?? null;
  if (groups.size !== 1 || first === null) {
    return decisionError('invalid_input', `${gates.join('+')} are not one SOLO card`);
  }
  for (const g of gates) {
    if (!GATE_POLICIES[g].consolidatable) {
      return decisionError('invalid_input', `${g} is not consolidatable: it has a card of its own`);
    }
  }
  if (new Set(gates).size !== gates.length) {
    return decisionError('invalid_input', 'a gate appears twice on one card');
  }
  return null;
}

/** The card id of a set of targets: stable, so reopening the same gates is a no-op. */
export const cardIdOf = (
  gateInstanceIds: readonly string[],
  steps: readonly string[],
  key?: string,
): string =>
  deterministicId<'Card'>(
    `aisdlc.card:${[...gateInstanceIds].sort().join(',')}|${[...steps].sort().join(',')}${
      key === undefined ? '' : `|${key}`
    }`,
  );

/**
 * Opens the gates and the card that carries them. Each gate is an ordinary `openGate` (same
 * supersede, quorum and eligibility rules); then the card is recorded under an id derived from its
 * gate instances. A crash between the two is repaired by calling again: the gates are found, and the
 * card is written once.
 */
export async function openCard(
  deps: DecisionDeps,
  input: OpenCardInput,
): Promise<Result<Written<OpenCardResult>, DecisionError>> {
  const steps = input.steps ?? [];
  if (input.gates.length === 0 && steps.length === 0) {
    return err(decisionError('invalid_input', 'a card has a gate or a step'));
  }
  if (input.gates.length === 0 && input.key === undefined) {
    return err(decisionError('invalid_input', 'a card without a gate needs a key'));
  }
  if (input.gates.length > 0 && input.key !== undefined) {
    return err(decisionError('invalid_input', 'a key is for a card without a gate'));
  }
  const bad = checkConsolidation(input.gates.map((g) => g.gate_id));
  if (bad) return err(bad);
  if (new Set(steps.map((s) => s.step)).size !== steps.length) {
    return err(decisionError('invalid_input', 'a step appears twice on one card'));
  }

  const opened: Array<{ gate: CardGateInput; id: string }> = [];
  const superseded: string[] = [];
  let confirmed = true;
  for (const g of input.gates) {
    const r = await openGate(deps, {
      ...g,
      project_id: input.project_id,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      requester: input.requester ?? null,
      ...(input.opened_by ? { opened_by: input.opened_by } : {}),
    });
    if (!r.ok) return r;
    opened.push({ gate: g, id: r.value.gate_instance_id });
    superseded.push(...r.value.superseded);
    confirmed &&= r.value.confirmed;
  }
  const cardId = cardIdOf(
    opened.map((o) => o.id),
    steps.map((s) => s.step),
    input.key,
  );
  const first = input.gates[0] as CardGateInput | undefined;
  const group: CardGroup = first ? (soloCardOf(first.gate_id) ?? 'single') : 'single';
  const role = first ? gatePolicy(first.gate_id).slot : (steps[0] as { slot: RoleSlot }).slot;

  const wrote = await inDecisionTx<{ opened: boolean }>(deps, async (tx) => {
    await lockKey(tx, `card:${cardId}`);
    // Lock order as everywhere: gate/card keys, then the ledger lock, then record appends.
    const entered = await enterLedger(tx, deps);
    if (!entered.ok) return entered;
    if (await readCardOpened(tx, cardId)) {
      return ok({ value: { opened: false }, pending: entered.value });
    }
    const slaDue = await slaDueOf(
      tx,
      deps,
      opened.map((o) => o.id),
    );
    const payload = CardOpenedPayload.safeParse({
      card_id: cardId,
      project_id: input.project_id,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      group,
      label: input.label ?? null,
      role,
      targets: [
        ...opened.map((o) => ({
          target: 'gate' as const,
          gate_instance_id: o.id,
          gate_id: o.gate.gate_id,
          subject_hash: o.gate.subject_hash,
        })),
        ...steps.map((s) => ({ target: 'step' as const, step: s.step, slot: s.slot })),
      ],
      requester: input.requester ?? null,
      sla_due_at: slaDue,
      opened_by: input.opened_by ?? 'system.gate',
      key: input.key ?? null,
    });
    if (!payload.success) return err(decisionError('invalid_input', payload.error.message));
    const w = await appendEvents(
      tx,
      cardStream(cardId),
      0,
      [
        {
          type: CARD_EVENT.opened,
          actor: input.opened_by ?? 'system.gate',
          idempotency_key: `card.opened:${cardId}`,
          body: payload.data as unknown as JsonObject,
        },
      ],
      { clock: clockOf(deps) },
    );
    if (!w.ok) return err(decisionError('conflict', JSON.stringify(w.error)));
    return ok({ value: { opened: true }, pending: entered.value as readonly PendingConfirm[] });
  });
  if (!wrote.ok) return wrote;
  return ok({
    card_id: cardId,
    group,
    opened: wrote.value.opened,
    gate_instance_ids: opened.map((o) => o.id),
    superseded,
    confirmed: confirmed && wrote.value.confirmed,
  });
}

/** B21: the earliest `opened_at` of the card's gates plus the SLA, on the business calendar. */
async function slaDueOf(tx: Tx, deps: DecisionDeps, gateIds: readonly string[]): Promise<string> {
  let earliest = clockOf(deps).nowMs();
  for (const id of gateIds) {
    const o = await readOpened(tx, id);
    if (o) earliest = Math.min(earliest, Date.parse(o.opened_at));
  }
  const due = addBusinessDays(
    deps.calendar ?? DEFAULT_CALENDAR,
    new Date(earliest),
    deps.slaBusinessDays ?? 1,
  );
  return due.toISOString();
}

// ---------------------------------------------------------------- Consolidation planner

export interface PlanCardsInput {
  readonly project_id: ProjectId;
  readonly requester?: PrincipalId | null;
  readonly gates: readonly CardGateInput[];
}

/**
 * Splits the gates that are due for one subject into cards. A SOLO card group becomes one card only
 * when a single person holds every slot that decides its gates (the single operator, OB §1B), and
 * for card 5 only when that person is also the requester. Otherwise each gate gets its own card.
 * Gates outside every group (X, E, M, Q, SECT, G1f) and G4 are always alone. The identity port
 * failing is a refusal, not "consolidate anyway".
 */
export async function planCards(
  deps: DecisionDeps,
  input: PlanCardsInput,
): Promise<Result<CardGateInput[][], DecisionError>> {
  const buckets = new Map<string, CardGateInput[]>();
  const order: string[] = [];
  const push = (key: string, g: CardGateInput) => {
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)?.push(g);
  };
  for (const g of input.gates) {
    const solo = GATE_POLICIES[g.gate_id].consolidatable ? soloCardOf(g.gate_id) : null;
    push(solo ?? `alone:${g.gate_id}`, g);
  }
  const plan: CardGateInput[][] = [];
  for (const key of order) {
    const gates = buckets.get(key) as CardGateInput[];
    if (gates.length === 1 || !(key in SOLO_CARDS)) {
      for (const g of gates) plan.push([g]);
      continue;
    }
    const def = SOLO_CARDS[key as keyof typeof SOLO_CARDS];
    const operators = new Set<string>();
    let single = true;
    for (const slot of new Set(gates.map((g) => gatePolicy(g.gate_id).slot))) {
      const h = await deps.eligibility.holders(input.project_id, slot);
      if (!h.ok) return err(decisionError('eligibility_unavailable', h.error.message));
      const holders = [...new Set(h.value)];
      if (holders.length !== 1) single = false;
      else operators.add(holders[0] as string);
    }
    const operator = operators.size === 1 ? [...operators][0] : undefined;
    const consolidate =
      single &&
      operator !== undefined &&
      (!def.requester_is_operator || (input.requester ?? null) === operator);
    if (consolidate) plan.push(gates);
    else for (const g of gates) plan.push([g]);
  }
  return ok(plan);
}

/** `planCards`, then `openCard` for each card of the plan. */
export async function openCards(
  deps: DecisionDeps,
  input: PlanCardsInput & Pick<OpenCardInput, 'subject_kind' | 'subject_id' | 'opened_by'>,
): Promise<Result<Written<OpenCardResult>[], DecisionError>> {
  const plan = await planCards(deps, input);
  if (!plan.ok) return plan;
  const out: Written<OpenCardResult>[] = [];
  for (const gates of plan.value) {
    const r = await openCard(deps, {
      project_id: input.project_id,
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      gates,
      requester: input.requester ?? null,
      ...(input.opened_by ? { opened_by: input.opened_by } : {}),
    });
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}
