import {
  C1DecisionContent,
  gatePolicy,
  C4DecisionContent,
  C5DecisionContent,
  S0_EVENT,
  S0ControlsCheckedPayload,
  S0CardRequiredPayload,
  S0RequestedPayload,
  SecrDecisionContent,
  VoteDecision,
  s0Stream,
  type CardPayloadItem,
  type OnboardingCardSummary,
  type PrincipalId,
  type Sha256Hex,
} from '@aisdlc/contracts';
import {
  decideCard,
  prepareCard,
  recordCardEvidenceViewed,
  readCardOpened,
  type CardDecisionResult,
} from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import { z } from 'zod';
import { prrByHash, recordControlsSeen } from '../m4.js';
import { coreError, type CoreError } from '../errors.js';
import { inCoreTx } from '../journal.js';
import { openS0 } from '../s0.js';
import { planC1, planC4, planC5, planSecr } from './content.js';
import {
  SLOT_OF_CARD,
  STEP_OF_CARD,
  decisionsFor,
  isHandled,
  type CardDeps,
  type HandledCard,
} from './model.js';
import { loadS0, s0Cards, type LoadedS0, type OnboardingCard } from './read.js';
import {
  c1Context,
  c1View,
  c4Context,
  c4View,
  c5Context,
  c5View,
  decidersOf,
  evidenceHashOf,
  secrView,
  settingsOf,
  type C1Ctx,
  type C4Ctx,
  type C5Ctx,
  type Deciders,
} from './views.js';
import { applyCard, isLive } from './sync.js';
import { clockOf } from '../journal.js';

// What the portal does with an onboarding card (PLAN M7.3): list, read, prepare, report the
// evidence viewed, decide, re-check. Deciding delegates to the decision kernel (`decideCard`); the
// PDP's `card.decide` is asked by the HTTP layer before any of this runs.

type Ctx =
  | { kind: 'C1'; c: C1Ctx }
  | { kind: 'C4'; c: C4Ctx; reduced: boolean; requestedBy: PrincipalId }
  | { kind: 'C5'; c: C5Ctx }
  | { kind: 'SECR' };

interface Resolved {
  readonly loaded: LoadedS0;
  readonly cards: OnboardingCard[];
  readonly card: OnboardingCard;
}

async function resolve(deps: CardDeps, cardId: string): Promise<Result<Resolved, CoreError>> {
  const opened = await readCardOpened(deps.pool, cardId);
  if (!opened) return err(coreError('not_found', `no card ${cardId}`));
  const s0Id = opened.open.subject_id;
  if (opened.open.subject_kind !== 's0_record' || !isHandled(opened.open.label)) {
    return err(coreError('not_found', `${cardId} is not an onboarding card`));
  }
  const loaded = await loadS0(deps.pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const cards = await s0Cards(deps.pool, s0Id);
  const card = cards.find((c) => c.card_id === cardId);
  return card ? ok({ loaded, cards, card }) : err(coreError('not_found', `no card ${cardId}`));
}

/** The project and S0 record of a card, for the caller's policy check. */
export async function cardHeader(
  deps: Pick<CardDeps, 'pool'>,
  cardId: string,
): Promise<{ project_id: string; s0_id: string } | null> {
  const o = await readCardOpened(deps.pool, cardId);
  return o && o.open.subject_kind === 's0_record'
    ? { project_id: o.open.project_id, s0_id: o.open.subject_id }
    : null;
}

async function contextOf(
  deps: CardDeps,
  r: Resolved,
): Promise<Result<{ ctx: Ctx; view: object }, CoreError>> {
  const { loaded, cards, card } = r;
  switch (card.kind) {
    case 'C1': {
      const c = await c1Context(deps, loaded);
      return c.ok ? ok({ ctx: { kind: 'C1', c: c.value }, view: c1View(c.value, loaded.s0) }) : c;
    }
    case 'C4': {
      const raised = [...loaded.events]
        .reverse()
        .find(
          (e) =>
            e.type === S0_EVENT.card_required &&
            S0CardRequiredPayload.parse(e.payload).card === 'C4',
        );
      const reduced = raised ? S0CardRequiredPayload.parse(raised.payload).reduced : false;
      const intake = loaded.events.find((e) => e.type === S0_EVENT.requested);
      const requestedBy = S0RequestedPayload.parse(intake?.payload).requested_by;
      const c = await c4Context(deps, loaded, cards, requestedBy, reduced);
      return c.ok
        ? ok({ ctx: { kind: 'C4', c: c.value, reduced, requestedBy }, view: c4View(c.value) })
        : c;
    }
    case 'C5': {
      // The M4 gate on this card binds to a proposed PRR: that record is what the card shows.
      const hash = card.state.gates[0]?.state.open.payload.subject_hash;
      const found = hash
        ? await prrByHash(deps.pool, loaded.s0.record.project_id, loaded.s0.record.repo_id, hash)
        : null;
      if (!found) return err(coreError('not_found', 'the record this card binds to is gone'));
      const c = c5Context(loaded, cards, found.prr);
      return c.ok ? ok({ ctx: { kind: 'C5', c: c.value }, view: c5View(c.value) }) : c;
    }
    case 'SECR': {
      const v = await secrView(deps, loaded.s0, card, cards);
      return v.ok ? ok({ ctx: { kind: 'SECR' }, view: v.value }) : v;
    }
  }
}

const SCHEMAS: Readonly<Record<HandledCard, z.ZodType>> = {
  C1: C1DecisionContent,
  C4: C4DecisionContent,
  C5: C5DecisionContent,
  SECR: SecrDecisionContent,
};

const summaryOf = (r: Resolved): OnboardingCardSummary => ({
  card_id: r.card.card_id as never,
  s0_id: r.loaded.s0.record.s0_id,
  project_id: r.card.state.open.project_id,
  card: r.card.kind,
  step: STEP_OF_CARD[r.card.kind],
  status: r.card.state.status,
  slot: SLOT_OF_CARD[r.card.kind],
  opened_at: r.card.state.opened_at,
  payload_hash: (r.card.state.payload?.payload_hash ?? null) as Sha256Hex | null,
  actionable: r.card.state.status === 'open' && isLive(r.loaded, r.card),
});

/** The cards of an S0 record, oldest first. */
export async function listCards(
  deps: CardDeps,
  s0Id: string,
): Promise<Result<OnboardingCardSummary[], CoreError>> {
  const loaded = await loadS0(deps.pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const cards = await s0Cards(deps.pool, s0Id);
  return ok(cards.map((card) => summaryOf({ loaded, cards, card })));
}

/** The summary of one card (no view built): what the portal's list shows, for one id. */
export async function cardSummary(
  deps: CardDeps,
  cardId: string,
): Promise<Result<OnboardingCardSummary, CoreError>> {
  const r = await resolve(deps, cardId);
  return r.ok ? ok(summaryOf(r.value)) : r;
}

export interface CardDetail {
  readonly summary: OnboardingCardSummary;
  /** What the person is shown. Its hash is the evidence a decision is bound to. */
  readonly view: object;
  readonly evidence_hash: string;
  /** Who decides, from the project's role map; whether the decision rests on a `sod_waiver`. */
  readonly deciders: Deciders;
  /** Card 5 only: who decides its M4 gate (the `m4` slot), and whether that rests on a `sod_waiver`. */
  readonly m4_deciders: Deciders | null;
  /** JSON Schema of the `content` a decision sends (absent for a send-back or a rejection). */
  readonly decision_schema: object;
  readonly decisions_allowed: readonly string[];
  readonly send_backs: { readonly used: number; readonly limit: number };
}

export async function cardDetail(
  deps: CardDeps,
  cardId: string,
): Promise<Result<CardDetail, CoreError>> {
  const r = await resolve(deps, cardId);
  if (!r.ok) return r;
  const built = await contextOf(deps, r.value);
  if (!built.ok) return built;
  const s = settingsOf(deps);
  return ok({
    summary: summaryOf(r.value),
    view: built.value.view,
    evidence_hash: evidenceHashOf(built.value.view),
    deciders: await decidersOf(
      deps,
      r.value.card.state.open.project_id,
      SLOT_OF_CARD[r.value.card.kind],
      r.value.loaded.s0.record.s0_id,
    ),
    m4_deciders:
      r.value.card.kind === 'C5'
        ? await decidersOf(
            deps,
            r.value.card.state.open.project_id,
            gatePolicy('M4').slot,
            r.value.loaded.s0.record.s0_id,
          )
        : null,
    decision_schema: z.toJSONSchema(SCHEMAS[r.value.card.kind], {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    }),
    decisions_allowed:
      r.value.card.kind === 'SECR' ? ['approve'] : ['approve', 'request_changes', 'reject'],
    send_backs: {
      used: r.value.loaded.s0.steps.get(STEP_OF_CARD[r.value.card.kind])?.send_backs ?? 0,
      limit: s.failure.send_backs_per_step,
    },
  });
}

const needsOpenLive = (r: Resolved): CoreError | null =>
  r.card.state.status !== 'open'
    ? coreError('conflict', `the card is ${r.card.state.status}, not open`)
    : !isLive(r.loaded, r.card)
      ? coreError('conflict', 'the record no longer waits for this card')
      : null;

export interface PreparedOnboardingCard {
  readonly nonce: string;
  readonly expires_at: string;
  readonly evidence_hash: string;
  /** Card 5: the M4 gate needs a step-up proof bound to this hash (the PRR's `record_hash`). */
  readonly step_up: { readonly required: boolean; readonly bound_hash: string } | null;
}

export async function prepareOnboardingCard(
  deps: CardDeps,
  input: { card_id: string; principal: PrincipalId },
): Promise<Result<PreparedOnboardingCard, CoreError>> {
  const r = await resolve(deps, input.card_id);
  if (!r.ok) return r;
  const refused = needsOpenLive(r.value);
  if (refused) return err(refused);
  const built = await contextOf(deps, r.value);
  if (!built.ok) return built;
  const evidence = evidenceHashOf(built.value.view);
  const decisions = decisionsFor(deps, r.value.loaded.s0.record.s0_id);
  const p = await prepareCard(decisions, {
    card_id: input.card_id,
    principal: input.principal,
    evidence_hash: evidence as Sha256Hex,
  });
  if (!p.ok) return err(decisionRefusal(p.error));
  if (r.value.card.kind === 'C5') {
    // A card with a gate: the nonce is the M4 gate's, bound to the evidence pack opened with it.
    const g = p.value.gates[0];
    if (!g) return err(coreError('conflict', 'the card has no M4 gate waiting'));
    if (g.evidence_hash !== evidence) {
      return err(coreError('conflict', 'the card changed since it was opened: reopen it'));
    }
    return ok({
      nonce: g.nonce,
      expires_at: g.expires_at,
      evidence_hash: g.evidence_hash,
      step_up: g.step_up,
    });
  }
  const n = p.value.step_nonce;
  if (!n) return err(coreError('conflict', 'the card has no step to decide'));
  return ok({ nonce: n.nonce, expires_at: n.expires_at, evidence_hash: evidence, step_up: null });
}

export async function recordOnboardingEvidence(
  deps: CardDeps,
  input: { nonce: string; evidence_hash: string },
): Promise<Result<true, CoreError>> {
  const r = await recordCardEvidenceViewed(deps.decisions, [input]);
  return r.ok ? ok(true) : err(decisionRefusal(r.error));
}

export function decisionRefusal(e: { code: string; message: string }): CoreError {
  const code =
    e.code === 'invalid_input'
      ? 'invalid_input'
      : e.code === 'gate_not_found'
        ? 'not_found'
        : e.code === 'not_eligible' || e.code === 'nonce_principal_mismatch'
          ? 'forbidden'
          : e.code === 'database' || e.code === 'ledger' || e.code === 'eligibility_unavailable'
            ? 'unavailable'
            : e.code === 'gate_not_pending' || e.code === 'conflict' || e.code === 'nonce_replayed'
              ? 'conflict'
              : 'refused';
  return coreError(code, `${e.code}: ${e.message}`);
}

export interface OnboardingDecision {
  readonly card_id: string;
  readonly decision: CardDecisionResult;
  /** `pending`: the decision is on the ledger, its effect on the record is retried by the next sync. */
  readonly applied: 'applied' | 'pending';
  readonly apply_error: string | null;
}

export async function decideOnboardingCard(
  deps: CardDeps,
  input: {
    card_id: string;
    principal: PrincipalId;
    nonce: string;
    decision: string;
    content?: unknown;
    reason?: string;
    /** Card 5: the step-up proof the M4 gate needs, bound to the PRR's `record_hash`. */
    step_up?: { proof: string };
  },
): Promise<Result<OnboardingDecision, CoreError>> {
  const vote = VoteDecision.safeParse(input.decision);
  if (!vote.success) return err(coreError('invalid_input', `${input.decision} is not a decision`));
  const r = await resolve(deps, input.card_id);
  if (!r.ok) return r;
  const refused = needsOpenLive(r.value);
  if (refused) return err(refused);
  const { card } = r.value;
  const built = await contextOf(deps, r.value);
  if (!built.ok) return built;

  // The list payload: every choice of an approval; a send-back or a rejection carries none.
  let payload: CardPayloadItem[] = [];
  let findingReason: string | undefined;
  if (vote.data === 'approve') {
    const now = clockOf(deps).now();
    const ctx = built.value.ctx;
    const planned =
      ctx.kind === 'C1'
        ? planC1(ctx.c, input.content, now)
        : ctx.kind === 'C4'
          ? planC4(ctx.c, input.content, {
              project: card.state.open.project_id,
              actor: input.principal,
              now,
            })
          : ctx.kind === 'C5'
            ? planC5(ctx.c, input.content)
            : (() => {
                const s = planSecr(card.finding_id as string, input.content);
                if (!s.ok) return s;
                findingReason = s.value.reason;
                return ok(s.value.payload);
              })();
    if (!planned.ok) return planned;
    payload = planned.value;
  } else if (card.kind === 'SECR') {
    return err(
      coreError(
        'refused',
        'a finding is decided by setting its state; leave the card open until then',
      ),
    );
  }
  const evidence = evidenceHashOf(built.value.view);
  const s0Id = r.value.loaded.s0.record.s0_id;
  // What card 4 was decided on is recorded in full: the PRR's `controls` are read from it.
  if (vote.data === 'approve' && built.value.ctx.kind === 'C4') {
    const seen = await recordControlsSeen(deps, s0Id, {
      report: built.value.ctx.c.report,
      collaborators_read: built.value.ctx.c.proposal.basis.collaborators_read,
      by: input.principal,
    });
    if (!seen.ok) return seen;
  }
  const decisions = decisionsFor(deps, s0Id);
  const d =
    card.kind === 'C5'
      ? // Card 5 carries two decisions: the 0.5 sign-off and the M4 gate, as two ledger entries
        // in one transaction, sign-off first (DEC-6(c)). The gate's nonce is the one prepared.
        await decideCard(decisions, {
          card_id: input.card_id,
          votes: [
            {
              nonce: input.nonce,
              decision: vote.data,
              ...(input.step_up ? { step_up: input.step_up } : {}),
            },
          ],
          // The sign-off is decided with the first decision; a second approver of a two-person
          // M4 decides the gate only.
          steps: card.state.steps
            .filter((x) => x.decision === null)
            .map((x) => ({ step: x.step, decision: vote.data })),
          ...(payload.length > 0 ? { payload } : {}),
          steps_first: true,
        })
      : await decideCard(decisions, {
          card_id: input.card_id,
          votes: [],
          step_nonce: input.nonce,
          step_evidence_hash: evidence as Sha256Hex,
          steps: [{ step: STEP_OF_CARD[card.kind], decision: vote.data }],
          ...(payload.length > 0 ? { payload } : {}),
        });
  if (!d.ok) return err(decisionRefusal(d.error));

  const reason = findingReason ?? input.reason;
  const applied = await applyCard(deps, input.card_id, reason === undefined ? {} : { reason });
  return ok({
    card_id: input.card_id,
    decision: d.value,
    applied: applied.ok ? 'applied' : 'pending',
    apply_error: applied.ok ? null : applied.error.message,
  });
}

/**
 * Card 4's "re-check": reads the code host again and records that it did. The factory fixes
 * nothing; the person fixed it on GitHub. Returns the card as it reads now.
 */
export async function recheckControls(
  deps: CardDeps,
  input: { card_id: string; principal: PrincipalId },
): Promise<Result<CardDetail, CoreError>> {
  const r = await resolve(deps, input.card_id);
  if (!r.ok) return r;
  if (r.value.card.kind !== 'C4') {
    return err(coreError('invalid_input', 'only card 4 has a re-check'));
  }
  const refused = needsOpenLive(r.value);
  if (refused) return err(refused);
  const holders = await decisionsFor(deps, r.value.loaded.s0.record.s0_id).eligibility.holders(
    r.value.card.state.open.project_id,
    SLOT_OF_CARD.C4,
  );
  if (!holders.ok) return err(coreError('unavailable', holders.error.message));
  if (!holders.value.includes(input.principal)) {
    return err(
      coreError('forbidden', `${input.principal} does not hold the slot that decides card 4`),
    );
  }
  const built = await contextOf(deps, r.value);
  if (!built.ok) return built;
  if (built.value.ctx.kind !== 'C4') return err(coreError('conflict', 'not card 4'));
  const report = built.value.ctx.c.report;
  const s0Id = r.value.loaded.s0.record.s0_id;
  const w = await inCoreTx(deps, async (j) => {
    const opened = await openS0(j, s0Id);
    if (!opened.ok) return opened;
    return j.emit(
      s0Stream(s0Id),
      S0_EVENT.controls_checked,
      S0ControlsCheckedPayload.parse({
        step: '0.4',
        report_hash: report.report_hash,
        blocking_open: report.blocking_open,
        by: input.principal,
      }),
      input.principal,
    );
  });
  if (!w.ok) return w;
  return cardDetail(deps, input.card_id);
}
