import {
  CARD_EVENT,
  CARD_PAYLOAD_MAX_ROWS,
  CARD_STEP_ENTRY_TYPE,
  CardDecidedPayload,
  CardPayloadItem,
  CardPayloadRecordedPayload,
  VoteDecision,
  cardPayloadHash,
  cardStream,
  gateStream,
  type JsonObject,
  type LedgerEntry,
  type LedgerEntryDraft,
  type PrincipalId,
  type Sha256Hex,
  type StepId,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { PendingConfirm } from '@aisdlc/ledger';
import { appendEvents, type NewEvent } from '@aisdlc/record';
import { decisionError, type DecisionError } from '../errors.js';
import {
  clockOf,
  inDecisionTx,
  lockKey,
  newEntryId,
  writeDecision,
  enterLedger,
  type DecisionDeps,
  type Written,
} from '../internal.js';
import { consumeNonce, prepare, recordEvidenceViewed, type Prepared } from '../prepared.js';
import {
  requirePending,
  planVote,
  stateAfter,
  type PlannedVote,
  type VoteResult,
} from '../vote.js';
import { gateIdsOf, readCardOpened, readCardState, type CardState } from './state.js';
import { sha256Hex } from '@aisdlc/kernel';

// Deciding a card (PLAN M3.4, OB §7). A card is decided with the same PreparedDecision machinery as
// a gate: `prepareCard` issues one nonce per pending gate, `recordCardEvidenceViewed` reports what
// was shown, and `decideCard` consumes all the nonces in ONE transaction and writes one ledger entry
// per contained decision (a gate vote each, plus one `card.step_decision` entry per step). Nothing
// is decided unless every pending gate of the card is given a decision, and a gate that stays
// pending (quorum two, say) keeps the card open: a card never approves what nobody decided.
//
// Atomicity. Every check, every record event and every ledger DRAFT is made before the first
// ledger entry is written, so a refusal leaves nothing behind. The only thing that can still fail
// is the Notary: if it fails after the first entry was signed, that entry is not lost (M2.3, the
// reconciler imports it) and the card simply stays open for the gates that did not get one.

export interface PrepareCardInput {
  readonly card_id: string;
  readonly principal: PrincipalId;
}

export interface PreparedCard {
  readonly card_id: string;
  /** One per pending gate: hand each nonce to the principal's client once. */
  readonly gates: readonly Prepared[];
  /** Steps still to be decided with the first decision. */
  readonly steps: readonly StepId[];
  /** `cardPayloadHash([])`: what a decision without a list payload binds to. */
  readonly empty_payload_hash: string;
}

export async function prepareCard(
  deps: DecisionDeps,
  input: PrepareCardInput,
): Promise<Result<PreparedCard, DecisionError>> {
  const state = await readCardState(deps.pool, input.card_id);
  if (!state) return err(decisionError('gate_not_found', `no card ${input.card_id}`));
  if (state.status !== 'open') {
    return err(decisionError('gate_not_pending', `card is ${state.status}, not open`));
  }
  const gates: Prepared[] = [];
  for (const g of state.gates) {
    if (g.state.status !== 'pending') continue;
    const p = await prepare(deps, {
      gate_instance_id: g.gate_instance_id,
      principal: input.principal,
    });
    if (!p.ok) return p;
    gates.push(p.value);
  }
  return ok({
    card_id: input.card_id,
    gates,
    steps: state.steps.filter((s) => s.decision === null).map((s) => s.step),
    empty_payload_hash: cardPayloadHash([]),
  });
}

/** Reports the evidence the principal was shown for each nonce of a prepared card. */
export async function recordCardEvidenceViewed(
  deps: DecisionDeps,
  views: ReadonlyArray<{ nonce: string; evidence_hash: string }>,
): Promise<Result<number, DecisionError>> {
  for (const v of views) {
    const r = await recordEvidenceViewed(deps, v);
    if (!r.ok) return r;
  }
  return ok(views.length);
}

export interface DecideCardInput {
  readonly card_id: string;
  /** One per pending gate of the card, exactly. */
  readonly votes: ReadonlyArray<{
    readonly nonce: string;
    readonly decision: string;
    readonly step_up?: { readonly proof: string };
  }>;
  /** One per step still undecided, exactly (all in the first decision that carries any vote). */
  readonly steps?: ReadonlyArray<{ readonly step: StepId; readonly decision: string }>;
  /** A list payload (per-gap disposition, per-claim affirm). Its hash goes into every entry. */
  readonly payload?: readonly unknown[];
}

export interface CardDecisionResult {
  readonly card_id: string;
  readonly payload_hash: string;
  /** One per gate vote, then one per step decision. */
  readonly entries: readonly LedgerEntry[];
  readonly votes: readonly VoteResult[];
  readonly status: CardState['status'];
}

export async function decideCard(
  deps: DecisionDeps,
  input: DecideCardInput,
): Promise<Result<Written<CardDecisionResult>, DecisionError>> {
  // ---- Input shape, before any database work.
  const payload = input.payload === undefined ? null : parsePayload(input.payload);
  if (payload && !payload.ok) return payload;
  const items = payload?.ok ? payload.value : [];
  const payloadHash = cardPayloadHash(items) as Sha256Hex;
  const decisions = new Map<string, VoteDecision>();
  for (const v of input.votes) {
    const d = VoteDecision.safeParse(v.decision);
    if (!d.success) return err(decisionError('invalid_input', `${v.decision} is not a vote`));
    decisions.set(v.nonce, d.data);
  }
  if (decisions.size !== input.votes.length || input.votes.length === 0) {
    return err(decisionError('invalid_input', 'one distinct nonce per pending gate, at least one'));
  }
  const stepDecisions = new Map<string, VoteDecision>();
  for (const s of input.steps ?? []) {
    const d = VoteDecision.safeParse(s.decision);
    if (!d.success) return err(decisionError('invalid_input', `${s.decision} is not a vote`));
    if (stepDecisions.has(s.step)) return err(decisionError('invalid_input', 'step twice'));
    stepDecisions.set(s.step, d.data);
  }

  return inDecisionTx<CardDecisionResult>(deps, async (tx) => {
    // ---- Locks: card key, every gate key of the card (sorted), then the ledger.
    const opened = await readCardOpened(tx, input.card_id);
    if (!opened) return err(decisionError('gate_not_found', `no card ${input.card_id}`));
    await lockKey(tx, `card:${input.card_id}`);
    for (const id of [...gateIdsOf(opened.open)].sort()) await lockKey(tx, `gate:${id}`);
    const entered = await enterLedger(tx, deps);
    if (!entered.ok) return entered;
    const state = await readCardState(tx, input.card_id);
    if (!state) return err(decisionError('gate_not_found', `no card ${input.card_id}`));
    if (state.status !== 'open') {
      return err(decisionError('gate_not_pending', `card is ${state.status}, not open`));
    }

    // ---- Coverage: every pending gate, each exactly once, and the undecided steps.
    const pendingGates = state.gates.filter((g) => g.state.status === 'pending');
    const byNonce = new Map<string, string>();
    for (const n of decisions.keys()) {
      const row = await tx.query<{ gate_instance_id: string }>(
        'SELECT gate_instance_id FROM decisions.gate_nonce WHERE nonce_sha256 = $1',
        [sha256Hex(n)],
      );
      const gid = row.rows[0]?.gate_instance_id;
      if (!gid) return err(decisionError('nonce_unknown', 'unknown nonce'));
      byNonce.set(n, gid);
    }
    const covered = [...byNonce.values()].sort();
    const want = pendingGates.map((g) => g.gate_instance_id).sort();
    if (covered.length !== want.length || covered.some((id, i) => id !== want[i])) {
      return err(
        decisionError(
          'invalid_input',
          `a card is decided gate by gate for every pending gate: expected ${want.length}, got ${covered.length}`,
        ),
      );
    }
    const undecidedSteps = state.steps.filter((s) => s.decision === null);
    const stepsGiven = [...stepDecisions.keys()].sort();
    const stepsWant = undecidedSteps.map((s) => s.step as string).sort();
    if (stepsGiven.join() !== stepsWant.join()) {
      return err(
        decisionError('invalid_input', `the undecided steps are ${stepsWant.join(',') || 'none'}`),
      );
    }

    // ---- Nonces (consumed in this transaction), then the plans. Nothing written yet.
    const planned: PlannedVote[] = [];
    let principal: PrincipalId | null = null;
    // Card order, so the entries land on the ledger as the card reads (G0, then G1).
    const position = (n: string) =>
      state.gates.findIndex((x) => x.gate_instance_id === byNonce.get(n));
    const votes = [...input.votes].sort((a, b) => position(a.nonce) - position(b.nonce));
    for (const v of votes) {
      const gid = byNonce.get(v.nonce) as string;
      const g = state.gates.find((x) => x.gate_instance_id === gid);
      if (!g) return err(decisionError('invalid_input', 'nonce for a gate not on this card'));
      const refusal = requirePending(deps, g.state);
      if (refusal) return err(refusal);
      const used = await consumeNonce(tx, deps, v.nonce, g.state, v.step_up);
      if (!used.ok) return used;
      const who = used.value.row.principal as PrincipalId;
      if (principal !== null && principal !== who) {
        return err(decisionError('nonce_principal_mismatch', 'one principal decides a card'));
      }
      principal = who;
      const plan = await planVote(deps, g.state, {
        gate_instance_id: gid,
        voter: who,
        decision: decisions.get(v.nonce) as VoteDecision,
        evidence: {
          evidence_hash: used.value.row.evidence_hash as Sha256Hex,
          evidence_viewed_at: used.value.row.evidence_viewed_at.toISOString(),
          nonce_sha256: sha256Hex(v.nonce) as Sha256Hex,
          step_up: used.value.stepUp,
        },
        card: { card_id: input.card_id as never, payload_hash: payloadHash },
      });
      if (!plan.ok) return plan;
      planned.push(plan.value);
    }
    const actor = principal as PrincipalId;
    const stepDrafts: Array<{ step: StepId; decision: VoteDecision; draft: LedgerEntryDraft }> = [];
    for (const s of undecidedSteps) {
      const holders = await deps.eligibility.holders(state.open.project_id, s.slot as never);
      if (!holders.ok) return err(decisionError('eligibility_unavailable', holders.error.message));
      if (!holders.value.includes(actor)) {
        return err(decisionError('not_eligible', `${actor} does not hold the slot of ${s.step}`));
      }
      const entry_id = newEntryId(deps);
      const decision = stepDecisions.get(s.step) as VoteDecision;
      stepDrafts.push({
        step: s.step,
        decision,
        draft: {
          entry_id,
          entry_type: CARD_STEP_ENTRY_TYPE,
          gate_instance_id: null,
          gate_id: null,
          subject_kind: state.open.subject_kind,
          subject_id: state.open.subject_id,
          subject_hash: null,
          decision,
          actor,
          sod_waiver: false,
          policy_bundle_version: deps.policyBundleVersion ?? 'decisions-1.0.0',
          body: {
            kind: 'step_decision',
            card_id: input.card_id,
            step: s.step,
            payload_hash: payloadHash,
          },
          created_at: clockOf(deps).now().toISOString(),
        } as LedgerEntryDraft,
      });
    }

    // ---- Record events: the payload and the marker on the card stream, a marker on each gate.
    const decidedBody = CardDecidedPayload.parse({
      card_id: input.card_id,
      actor,
      decisions: [
        ...planned.map((p) => ({
          target: 'gate',
          gate_instance_id: p.state.open.gate_instance_id,
          step: null,
          decision: p.draft.decision,
          ledger_entry_id: p.entry_id,
        })),
        ...stepDrafts.map((s) => ({
          target: 'step',
          gate_instance_id: null,
          step: s.step,
          decision: s.decision,
          ledger_entry_id: s.draft.entry_id,
        })),
      ],
      payload_hash: payload ? payloadHash : null,
    });
    const cardEvents: NewEvent[] = [];
    if (payload) {
      cardEvents.push({
        type: CARD_EVENT.payload_recorded,
        actor,
        idempotency_key: `card.payload:${payloadHash}:${input.card_id}`,
        body: CardPayloadRecordedPayload.parse({
          card_id: input.card_id,
          payload: items,
          payload_hash: payloadHash,
          recorded_by: actor,
        }) as unknown as JsonObject,
      });
    }
    cardEvents.push({
      type: CARD_EVENT.decided,
      actor,
      idempotency_key: `card.decided:${decidedBody.decisions.map((d) => d.ledger_entry_id).join(',')}`,
      body: decidedBody as unknown as JsonObject,
    });
    const head = await tx.query<{ seq: string }>(
      'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
      [cardStream(input.card_id)],
    );
    const ce = await appendEvents(
      tx,
      cardStream(input.card_id),
      Number(head.rows[0]?.seq),
      cardEvents,
      {
        clock: clockOf(deps),
      },
    );
    if (!ce.ok) return err(decisionError('conflict', JSON.stringify(ce.error)));
    for (const p of planned) {
      const gid = p.state.open.gate_instance_id;
      const gh = await tx.query<{ seq: string }>(
        'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
        [gateStream(gid)],
      );
      const r = await appendEvents(tx, gateStream(gid), Number(gh.rows[0]?.seq), [p.marker], {
        clock: clockOf(deps),
      });
      if (!r.ok) return err(decisionError('conflict', JSON.stringify(r.error)));
    }

    // ---- Ledger entries LAST: gates in id order, then steps.
    const pending: PendingConfirm[] = [...entered.value];
    const entries: LedgerEntry[] = [];
    const results: VoteResult[] = [];
    for (const p of planned) {
      const w = await writeDecision(tx, deps, p.draft);
      if (!w.ok) return w;
      pending.push(...w.value.pending);
      entries.push(w.value.entry);
      results.push({ entry: w.value.entry, after: stateAfter(p.state, w.value.entry) });
    }
    for (const s of stepDrafts) {
      const w = await writeDecision(tx, deps, s.draft);
      if (!w.ok) return w;
      pending.push(...w.value.pending);
      entries.push(w.value.entry);
    }
    const statusAfter = results.some((r) => r.after.status === 'pending')
      ? 'open'
      : ((await readCardState(tx, input.card_id))?.status ?? 'open');
    return ok({
      value: {
        card_id: input.card_id,
        payload_hash: payloadHash,
        entries,
        votes: results,
        status: statusAfter,
      },
      pending,
    });
  });
}

function parsePayload(raw: readonly unknown[]): Result<CardPayloadItem[], DecisionError> {
  if (raw.length > CARD_PAYLOAD_MAX_ROWS) {
    return err(
      decisionError('invalid_input', `a payload has at most ${CARD_PAYLOAD_MAX_ROWS} rows`),
    );
  }
  const rows: CardPayloadItem[] = [];
  const seen = new Set<string>();
  for (const [i, r] of raw.entries()) {
    const p = CardPayloadItem.safeParse(r);
    if (!p.success)
      return err(decisionError('invalid_input', `payload row ${i}: ${p.error.message}`));
    const key =
      p.data.kind === 'gap_disposition' ? `gap:${p.data.gap_id}` : `claim:${p.data.claim_id}`;
    if (seen.has(key)) return err(decisionError('invalid_input', `payload row ${i}: ${key} twice`));
    seen.add(key);
    rows.push(p.data);
  }
  return ok(rows);
}

// ---------------------------------------------------------------- Payload integrity

export type PayloadCheck =
  { ok: true; payload_hash: string; rows: number; entries: number } | { ok: false; reason: string };

/**
 * Checks that the stored list payload of a card is the one that was decided: it re-hashes the
 * `card.payload_recorded` body with `cardPayloadHash` and compares with the hash in the event, and
 * with the hash every ledger entry of the card carries. A payload changed after the decision (the
 * event store is append-only, but a superuser can edit a row) no longer matches the signed hash.
 */
export async function verifyCardPayload(deps: DecisionDeps, cardId: string): Promise<PayloadCheck> {
  const state = await readCardState(deps.pool, cardId);
  if (!state) return { ok: false, reason: 'no such card' };
  const ev = await deps.pool.query<{ body: unknown }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq DESC LIMIT 1`,
    [cardStream(cardId), CARD_EVENT.payload_recorded],
  );
  if (!ev.rows[0]) return { ok: false, reason: 'no payload was recorded' };
  const parsed = CardPayloadRecordedPayload.safeParse(ev.rows[0].body);
  if (!parsed.success) return { ok: false, reason: 'the stored payload is not a valid payload' };
  const actual = cardPayloadHash(parsed.data.payload);
  if (actual !== parsed.data.payload_hash) {
    return { ok: false, reason: 'stored payload does not match the hash recorded with it' };
  }
  const entries = [
    ...state.gates.flatMap((g) => g.state.decisions),
    ...(await stepEntries(deps, cardId)),
  ].filter(
    (d) =>
      (d.body['card'] as { card_id?: string } | undefined)?.card_id === cardId ||
      d.body['card_id'] === cardId,
  );
  if (entries.length === 0) return { ok: false, reason: 'no ledger entry carries this card' };
  for (const d of entries) {
    const h =
      (d.body['card'] as { payload_hash?: string } | undefined)?.payload_hash ??
      d.body['payload_hash'];
    if (h !== actual) {
      return { ok: false, reason: `ledger entry ${d.entry_id} binds a different payload hash` };
    }
  }
  return {
    ok: true,
    payload_hash: actual,
    rows: parsed.data.payload.length,
    entries: entries.length,
  };
}

async function stepEntries(deps: DecisionDeps, cardId: string) {
  const q = await deps.pool.query<{ entry_id: string; body: Record<string, unknown> }>(
    `SELECT entry_id, body FROM ledger.ledger_entry WHERE entry_type = $1 AND body ->> 'card_id' = $2`,
    [CARD_STEP_ENTRY_TYPE, cardId],
  );
  return q.rows;
}
