import {
  GateCardPrepared,
  GateCardView,
  GateOpenedPayload,
  VoteDecision,
  gatePolicy,
  type GateCardDecideRequest,
  type GateId,
  type PrincipalId,
} from '@aisdlc/contracts';
import {
  decideCard,
  gateHolders,
  prepareCard,
  readCardOpened,
  readCardState,
  recordCardEvidenceViewed,
  type DecisionDeps,
} from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import type pg from 'pg';
import { z } from 'zod';
import { decisionRefusal } from './cards/api.js';
import { coreError, type CoreError } from './errors.js';

// Deciding a work-item gate card in the portal (Gap B). A card the work engine opened (G0 and G1, G1f, G2, G3d,
// G3 with G3s, E1, E2 ...) is decided with the same decision kernel as every card: prepare (one single-use
// nonce per pending gate, bound to the gate's subject hash), tell the factory the evidence was shown, decide
// (one ledger entry per gate, the person's reason bound into each by the card payload's hash). Nothing here
// approves anything: a decision is a person's request, the PDP (`card.decide`, `gate.decide`) is asked by the
// HTTP layer first, the kernel checks the slot, two-person, own-request and step-up rules, and a card whose
// subject changed since the nonce was issued is refused.

export interface ItemCardHead {
  readonly project_id: string;
  /** `null` for a project's META card (9.4 Learn, M15.5): its subject is a proposal, not an item. */
  readonly item_id: string | null;
  readonly subject_kind: 'item' | 'learn';
  readonly gates: ReadonlyArray<{ gate_instance_id: string; gate: GateId }>;
}

/** The project, item and gates of a work-item card; `null` for anything that is not one. */
export async function itemCardHead(pool: pg.Pool, cardId: string): Promise<ItemCardHead | null> {
  const o = await readCardOpened(pool, cardId);
  // M15.5: a 9.4 META card (subject `learn`) is decided the same way, on its project
  if (!o || (o.open.subject_kind !== 'item' && o.open.subject_kind !== 'learn')) return null;
  const kind = o.open.subject_kind;
  const gates: Array<{ gate_instance_id: string; gate: GateId }> = [];
  for (const t of o.open.targets) {
    if (t.target !== 'gate') continue;
    const g = await pool.query<{ body: unknown }>(
      `SELECT body FROM record.record_event WHERE stream = $1 AND seq = 1`,
      [`gate:${t.gate_instance_id}`],
    );
    const p = g.rows[0] ? GateOpenedPayload.parse(g.rows[0].body) : null;
    if (p) gates.push({ gate_instance_id: t.gate_instance_id, gate: p.gate_id });
  }
  return gates.length === 0
    ? null
    : {
        project_id: o.open.project_id,
        item_id: kind === 'item' ? o.open.subject_id : null,
        subject_kind: kind,
        gates,
      };
}

const Facts = z.looseObject({
  proposed_lane: z.string().optional(),
  base_sha: z.string().optional(),
  injection: z.looseObject({ suspected: z.boolean().optional() }).optional(),
});

/** What a card is, as something to decide. */
export async function gateCardView(
  d: Pick<DecisionDeps, 'pool' | 'eligibility'>,
  cardId: string,
): Promise<Result<GateCardView, CoreError>> {
  const head = await itemCardHead(d.pool, cardId);
  if (!head) return err(coreError('not_found', `${cardId} is not a work item card`));
  const state = await readCardState(d.pool, cardId);
  if (!state) return err(coreError('not_found', `no card ${cardId}`));
  const gates = state.gates.map((g) => {
    const p = g.state.open.payload;
    return {
      gate_instance_id: g.gate_instance_id,
      gate: p.gate_id,
      slot: gatePolicy(p.gate_id).slot,
      status: g.state.status,
      outcome: g.state.outcome,
      step_up_required: p.step_up.required,
    };
  });
  const first = state.gates[0]?.state.open.payload;
  if (!first) return err(coreError('not_found', 'the card has no gate'));
  const facts = Facts.safeParse(first.facts);
  const slots = [...new Set(gates.map((g) => g.slot))];
  const holders = new Set<string>();
  // per gate: a gate opened with deciders (G4 mode C: the code owners of the changed paths) narrows its slot
  for (const g of state.gates) {
    const p = g.state.open.payload;
    const h = await gateHolders(
      d.eligibility,
      head.project_id as never,
      gatePolicy(p.gate_id).slot,
      p.deciders,
    );
    if (!h.ok) return err(coreError('unavailable', 'who holds the role could not be read'));
    for (const x of h.value) holders.add(x);
  }
  const reason = state.payload?.payload.find((i) => i.kind === 'decision_reason');
  return ok(
    GateCardView.parse({
      card_id: cardId,
      project_id: head.project_id,
      item_id: head.item_id,
      subject_kind: head.subject_kind,
      status: state.status,
      gates,
      subject_hash: first.subject_hash,
      proposed_lane: facts.success ? (facts.data.proposed_lane ?? null) : null,
      base_sha: facts.success ? (facts.data.base_sha ?? null) : null,
      injection_suspected: facts.success ? (facts.data.injection?.suspected ?? false) : false,
      deciders: { slots, holders: [...holders].sort() },
      decisions_allowed: VoteDecision.options,
      decision_reason: reason?.kind === 'decision_reason' ? reason.text : null,
    }),
  );
}

export async function prepareGateCard(
  d: DecisionDeps,
  o: { card_id: string; principal: PrincipalId },
): Promise<Result<GateCardPrepared, CoreError>> {
  if (!(await itemCardHead(d.pool, o.card_id))) {
    return err(coreError('not_found', `${o.card_id} is not a work item card`));
  }
  const p = await prepareCard(d, { card_id: o.card_id, principal: o.principal });
  if (!p.ok) return err(decisionRefusal(p.error));
  const state = await readCardState(d.pool, o.card_id);
  return ok(
    GateCardPrepared.parse({
      card_id: o.card_id,
      gates: p.value.gates.map((g) => ({
        gate_instance_id: g.gate_instance_id,
        gate: state?.gates.find((x) => x.gate_instance_id === g.gate_instance_id)?.state.open
          .payload.gate_id,
        nonce: g.nonce,
        expires_at: g.expires_at,
        subject_hash: g.subject_hash,
        evidence_hash: g.evidence_hash,
        step_up: g.step_up,
      })),
    }),
  );
}

export async function recordGateCardEvidence(
  d: DecisionDeps,
  o: { card_id: string; views: ReadonlyArray<{ nonce: string; evidence_hash: string }> },
): Promise<Result<{ evidence_viewed: true }, CoreError>> {
  if (!(await itemCardHead(d.pool, o.card_id))) {
    return err(coreError('not_found', `${o.card_id} is not a work item card`));
  }
  const r = await recordCardEvidenceViewed(d, o.views);
  return r.ok ? ok({ evidence_viewed: true as const }) : err(decisionRefusal(r.error));
}

/**
 * One decision on every pending gate of the card. A rejection and a request for changes need a reason, which
 * is recorded as the card's `decision_reason` payload row (its hash is bound into every ledger entry).
 * `on_behalf_of` has already passed the PDP.
 */
export async function decideGateCard(
  d: DecisionDeps,
  o: { card_id: string; principal: PrincipalId } & Pick<
    GateCardDecideRequest,
    'decision' | 'reason' | 'votes'
  >,
) {
  const head = await itemCardHead(d.pool, o.card_id);
  if (!head) return err(coreError('not_found', `${o.card_id} is not a work item card`));
  const reason = o.reason?.trim() ?? '';
  if (o.decision !== 'approve' && reason === '') {
    return err(coreError('invalid_input', 'a rejection and a request for changes need a reason'));
  }
  const r = await decideCard(d, {
    card_id: o.card_id,
    votes: o.votes.map((v) => ({
      nonce: v.nonce,
      decision: o.decision,
      ...(v.step_up ? { step_up: { proof: v.step_up.proof } } : {}),
    })),
    ...(reason === '' ? {} : { payload: [{ kind: 'decision_reason', text: reason }] }),
  });
  return r.ok ? ok(r.value) : err(decisionRefusal(r.error));
}
