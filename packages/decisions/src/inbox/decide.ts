import {
  CARD_EVENT,
  CARD_PAYLOAD_MAX_ROWS,
  CARD_STEP_ENTRY_TYPE,
  CardDecidedPayload,
  CardPayloadItem,
  CardPayloadRecordedPayload,
  VoteDecision,
  cardPayloadHash,
  cardPayloadItemKey,
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
import { appendEvents, type NewEvent, type Tx } from '@aisdlc/record';
import { randomBytes } from 'node:crypto';
import { decisionError, type DecisionError } from '../errors.js';
import {
  DEFAULT_NONCE_TTL_MS,
  clockOf,
  inDecisionTx,
  lockKey,
  newEntryId,
  writeDecision,
  enterLedger,
  type DecisionDeps,
  type Written,
} from '../internal.js';
import { isT2 } from '../policy.js';
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
  /**
   * What the principal is to be shown, for a card without a gate (its steps are bound to this hash
   * the way a gate is bound to its evidence pack). Required there, ignored on a card with gates.
   */
  readonly evidence_hash?: Sha256Hex;
}

/** The nonce of a card without a gate. Only its hash is stored. */
export interface PreparedStep {
  readonly nonce: string;
  readonly expires_at: string;
  readonly card_id: string;
  readonly evidence_hash: string;
}

export interface PreparedCard {
  readonly card_id: string;
  /** One per pending gate: hand each nonce to the principal's client once. */
  readonly gates: readonly Prepared[];
  /** A card without a gate: its one nonce. `null` on a card with gates. */
  readonly step_nonce: PreparedStep | null;
  /** Steps still to be decided with the first decision. */
  readonly steps: readonly StepId[];
  /** `cardPayloadHash([])`: what a decision without a list payload binds to. */
  readonly empty_payload_hash: string;
}

const hashOfNonce = (nonce: string): string => sha256Hex(nonce);

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
  let step_nonce: PreparedStep | null = null;
  if (state.gates.length === 0) {
    const st = await prepareStepNonce(deps, input, state);
    if (!st.ok) return st;
    step_nonce = st.value;
  }
  return ok({
    card_id: input.card_id,
    gates,
    step_nonce,
    steps: state.steps.filter((s) => s.decision === null).map((s) => s.step),
    empty_payload_hash: cardPayloadHash([]),
  });
}

async function prepareStepNonce(
  deps: DecisionDeps,
  input: PrepareCardInput,
  state: CardState,
): Promise<Result<PreparedStep, DecisionError>> {
  if (!input.evidence_hash) {
    return err(decisionError('invalid_input', 'a card without a gate needs the evidence hash'));
  }
  const open = state.steps.filter((s) => s.decision === null);
  if (open.length === 0) return err(decisionError('gate_not_pending', 'no step is waiting'));
  // Every undecided step is decided by the same person: they must hold each step's slot.
  for (const st of open) {
    const holders = await deps.eligibility.holders(state.open.project_id, st.slot as never);
    if (!holders.ok) return err(decisionError('eligibility_unavailable', holders.error.message));
    if (!holders.value.includes(input.principal)) {
      return err(decisionError('not_eligible', `${input.principal} does not hold the slot`));
    }
  }
  const clock = clockOf(deps);
  const nonce = randomBytes(32).toString('base64url');
  const created = clock.now();
  const expires = new Date(created.getTime() + (deps.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS));
  const done = await inDecisionTx<PreparedStep>(deps, async (tx) => {
    await tx.query(
      `INSERT INTO decisions.card_nonce
         (nonce_sha256, card_id, principal, evidence_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [hashOfNonce(nonce), input.card_id, input.principal, input.evidence_hash, created, expires],
    );
    return ok({
      value: {
        nonce,
        expires_at: expires.toISOString(),
        card_id: input.card_id,
        evidence_hash: input.evidence_hash as string,
      },
      pending: [],
    });
  });
  return done.ok ? ok(done.value) : done;
}

interface CardNonceRow {
  nonce_sha256: string;
  card_id: string;
  principal: string;
  evidence_hash: string;
  evidence_viewed_at: Date | null;
  expires_at: Date;
  consumed_at: Date | null;
}
const CARD_NONCE_COLUMNS =
  'nonce_sha256, card_id, principal, evidence_hash, evidence_viewed_at, expires_at, consumed_at';

/** Reports the evidence the principal was shown for the nonce of a card without a gate. */
async function recordStepEvidenceViewed(
  deps: DecisionDeps,
  view: { nonce: string; evidence_hash: string },
): Promise<Result<true, DecisionError>> {
  const clock = clockOf(deps);
  const h = hashOfNonce(view.nonce);
  const done = await inDecisionTx<{ ok: true }>(deps, async (tx) => {
    const peek = await tx.query<{ card_id: string }>(
      'SELECT card_id FROM decisions.card_nonce WHERE nonce_sha256 = $1',
      [h],
    );
    const first = peek.rows[0];
    if (!first) return err(decisionError('nonce_unknown', 'unknown nonce'));
    await lockKey(tx, `card:${first.card_id}`);
    const locked = await tx.query<CardNonceRow>(
      `SELECT ${CARD_NONCE_COLUMNS} FROM decisions.card_nonce WHERE nonce_sha256 = $1 FOR UPDATE`,
      [h],
    );
    const row = locked.rows[0] as CardNonceRow;
    if (row.consumed_at) return err(decisionError('nonce_replayed', 'nonce already used'));
    if (!(clock.nowMs() < row.expires_at.getTime())) {
      return err(decisionError('nonce_expired', 'nonce expired'));
    }
    if (row.evidence_hash !== view.evidence_hash) {
      return err(decisionError('evidence_mismatch', 'not the evidence this nonce is bound to'));
    }
    if (!row.evidence_viewed_at) {
      await tx.query(
        'UPDATE decisions.card_nonce SET evidence_viewed_at = $2 WHERE nonce_sha256 = $1',
        [h, clock.now()],
      );
    }
    return ok({ value: { ok: true as const }, pending: [] });
  });
  return done.ok ? ok(true) : done;
}

/** Reports the evidence the principal was shown for each nonce of a prepared card. */
export async function recordCardEvidenceViewed(
  deps: DecisionDeps,
  views: ReadonlyArray<{ nonce: string; evidence_hash: string }>,
): Promise<Result<number, DecisionError>> {
  for (const v of views) {
    const isStep = await deps.pool.query(
      'SELECT 1 FROM decisions.card_nonce WHERE nonce_sha256 = $1',
      [hashOfNonce(v.nonce)],
    );
    const r =
      isStep.rows.length > 0
        ? await recordStepEvidenceViewed(deps, v)
        : await recordEvidenceViewed(deps, v);
    if (!r.ok) return r;
  }
  return ok(views.length);
}

interface ConsumedStepNonce {
  readonly principal: PrincipalId;
  readonly evidence: {
    evidence_hash: Sha256Hex;
    evidence_viewed_at: string;
    nonce_sha256: Sha256Hex;
  };
}

/** Checks and consumes the nonce of a card without a gate; the caller holds the card and ledger locks. */
async function consumeStepNonce(
  tx: Tx,
  deps: DecisionDeps,
  cardId: string,
  nonce: string,
  expectedEvidence: string | undefined,
): Promise<Result<ConsumedStepNonce, DecisionError>> {
  const clock = clockOf(deps);
  const h = hashOfNonce(nonce);
  const locked = await tx.query<CardNonceRow>(
    `SELECT ${CARD_NONCE_COLUMNS} FROM decisions.card_nonce WHERE nonce_sha256 = $1 FOR UPDATE`,
    [h],
  );
  const row = locked.rows[0];
  if (!row) return err(decisionError('nonce_unknown', 'unknown nonce'));
  if (row.card_id !== cardId)
    return err(decisionError('nonce_unknown', 'nonce is bound to another card'));
  if (row.consumed_at) return err(decisionError('nonce_replayed', 'nonce already used'));
  if (!(clock.nowMs() < row.expires_at.getTime())) {
    return err(decisionError('nonce_expired', 'nonce expired'));
  }
  if (!row.evidence_viewed_at) {
    return err(decisionError('evidence_not_viewed', 'evidence_viewed was not recorded'));
  }
  if (expectedEvidence !== undefined && row.evidence_hash !== expectedEvidence) {
    return err(decisionError('evidence_mismatch', 'the card changed since the evidence was shown'));
  }
  await tx.query('UPDATE decisions.card_nonce SET consumed_at = $2 WHERE nonce_sha256 = $1', [
    h,
    clock.now(),
  ]);
  return ok({
    principal: row.principal as PrincipalId,
    evidence: {
      evidence_hash: row.evidence_hash as Sha256Hex,
      evidence_viewed_at: row.evidence_viewed_at.toISOString(),
      nonce_sha256: h as Sha256Hex,
    },
  });
}

/**
 * A step decision relies on a `sod_waiver` when the person is the only holder of the step's slot
 * (the single operator, OB §1B). T2 allows no waiver at all, so a sole holder at T2 cannot decide.
 */
async function stepWaiver(
  deps: DecisionDeps,
  project: CardState['open']['project_id'],
  slot: string,
  actor: PrincipalId,
): Promise<Result<boolean, DecisionError>> {
  const holders = await deps.eligibility.holders(project, slot as never);
  if (!holders.ok) return err(decisionError('eligibility_unavailable', holders.error.message));
  const unique = [...new Set(holders.value)];
  if (!unique.includes(actor)) {
    return err(decisionError('not_eligible', `${actor} does not hold the slot ${slot}`));
  }
  if (unique.length > 1) return ok(false);
  const ctx = await deps.eligibility.policy(project);
  if (!ctx.ok) return err(decisionError('eligibility_unavailable', ctx.error.message));
  if (isT2(ctx.value)) {
    return err(
      decisionError(
        'quorum_infeasible',
        `${slot}: T2 allows no waiver and one person holds the slot`,
      ),
    );
  }
  return ok(true);
}

export interface DecideCardInput {
  readonly card_id: string;
  /** One per pending gate of the card, exactly. */
  readonly votes: ReadonlyArray<{
    readonly nonce: string;
    readonly decision: string;
    readonly step_up?: { readonly proof: string };
  }>;
  /** A card without a gate: the nonce from `prepareCard`. Not allowed on a card with gates. */
  readonly step_nonce?: string;
  /**
   * With `step_nonce`: the evidence the caller holds NOW for the card. The nonce is refused
   * (`evidence_mismatch`) unless it was prepared for exactly this, so a decision on a page that
   * changed since the person saw it is refused.
   */
  readonly step_evidence_hash?: Sha256Hex;
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
  if (decisions.size !== input.votes.length) {
    return err(decisionError('invalid_input', 'one distinct nonce per pending gate'));
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

    // ---- A card with gates is decided by votes; one without, by the nonce of its steps.
    const gateless = state.gates.length === 0;
    if (
      gateless
        ? input.votes.length > 0 || !input.step_nonce
        : input.votes.length === 0 || input.step_nonce
    ) {
      return err(
        decisionError(
          'invalid_input',
          gateless
            ? 'a card without a gate is decided with its step nonce and no votes'
            : 'one distinct nonce per pending gate, at least one',
        ),
      );
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
    let stepEvidence: ConsumedStepNonce['evidence'] | null = null;
    if (gateless) {
      const used = await consumeStepNonce(
        tx,
        deps,
        input.card_id,
        input.step_nonce as string,
        input.step_evidence_hash,
      );
      if (!used.ok) return used;
      principal = used.value.principal;
      stepEvidence = used.value.evidence;
    }
    const actor = principal as PrincipalId;
    const stepDrafts: Array<{ step: StepId; decision: VoteDecision; draft: LedgerEntryDraft }> = [];
    for (const s of undecidedSteps) {
      const holders = await deps.eligibility.holders(state.open.project_id, s.slot as never);
      if (!holders.ok) return err(decisionError('eligibility_unavailable', holders.error.message));
      if (!holders.value.includes(actor)) {
        return err(decisionError('not_eligible', `${actor} does not hold the slot of ${s.step}`));
      }
      const waiver = await stepWaiver(deps, state.open.project_id, s.slot, actor);
      if (!waiver.ok) return waiver;
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
          sod_waiver: waiver.value,
          policy_bundle_version: deps.policyBundleVersion ?? 'decisions-1.0.0',
          body: {
            kind: 'step_decision',
            card_id: input.card_id,
            step: s.step,
            payload_hash: payloadHash,
            ...(stepEvidence ? { evidence: stepEvidence } : {}),
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
    const key = cardPayloadItemKey(p.data);
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
