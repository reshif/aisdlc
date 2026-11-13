import {
  ONBOARDING_AGENT_ACTOR,
  ONBOARDING_AGENT_EVENT,
  OnboardingSignOffStartedPayload,
  onboardingAgentStream,
  type PrincipalId,
  type SignOffRequest,
  type SignOffResult,
} from '@aisdlc/contracts';
import type { OverrideInput } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import { boundHashOf } from '@aisdlc/onboarding';
import {
  cardDetail,
  decideOnboardingCard,
  prepareOnboardingCard,
  recordOnboardingEvidence,
} from '../cards/api.js';
import { loadS0, s0Cards } from '../cards/read.js';
import { syncCards } from '../cards/sync.js';
import { coreError, type CoreError } from '../errors.js';
import { inCoreTx, lockKeys } from '../journal.js';
import {
  decideRevision,
  prepareRevision,
  publishRevision,
  recordRevisionEvidence,
  revisionOfS0,
} from '../portal-reads.js';
import { readGateState } from '@aisdlc/decisions';
import {
  liveCards,
  onboardingSummary,
  signOffStateOf,
  startedBy,
  type SummaryDeps,
} from './summary.js';
import { latestProposal } from './agent.js';

// The one sign-off (portal v2, N13; intent §4): a person signs the onboarding summary ONCE, and the cards underneath
// are decided as that person, one by one, as the S0 driver opens them. Nothing is weakened:
//
//   - the person's sign-off is recorded first (`onboarding_agent.sign_off_started`), bound to the summary hash they
//     read and holding the content they adjusted; a summary that changed since it was read is refused;
//   - each card (C1, C2, C4, C5) is decided through the decision kernel exactly as its card page would: prepare (the
//     PDP and the slot, separation of duties, the bootstrap grant), evidence viewed (the card's own view hash), decide
//     (a ledger entry with the payload hash); card 4's settings revision (M1) the same way, then published;
//   - card 2 and card 5 need the person to confirm it's them (D37, M4), each proof bound to that card's own hash: the
//     sign-off stops and says so, and the page sends the proof with the next call;
//   - a card 4 opened on a controls report other than the one the summary showed stops the sign-off (read it again);
//   - the onboarding agent never signs: a principal that is not a person is refused (the session that proposed cannot
//     sign off), and the factory admin's override is the existing `x-aisdlc-override-reason` path, recorded;
//   - the factory never merges anything here; the fix PR is merged, or not, by a person on GitHub.
//
// The page calls again while the state is `in_progress` (the driver opens the next card in its own time); every call
// is the person's own authenticated request, checked by the PDP each time.

const NOT_A_PERSON = /^(agent|system)[.:]/;

export type SignOffDeps = SummaryDeps;

const seqsOf = (x: { decision: { entries: ReadonlyArray<{ ledger_seq: number }> } }) =>
  x.decision.entries.map((e) => e.ledger_seq);

export async function signOff(
  d: SignOffDeps,
  s0Id: string,
  input: SignOffRequest & { override?: OverrideInput | undefined },
): Promise<Result<SignOffResult, CoreError>> {
  const who = input.on_behalf_of as PrincipalId;
  if (who === ONBOARDING_AGENT_ACTOR || NOT_A_PERSON.test(who)) {
    return err(
      coreError(
        'forbidden',
        'only a person signs off an onboarding; the agent that proposed it cannot',
      ),
    );
  }
  const pool = d.cards.pool;
  const first = await loadS0(pool, s0Id);
  if (!first) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const proposal = first.s0.census
    ? await latestProposal(pool, s0Id, first.s0.census.census_hash)
    : null;
  if (!proposal)
    return err(coreError('conflict', 'the onboarding agent has not proposed anything yet'));

  // 1. the start: the summary read, the content adjusted, recorded first
  let started = await startedBy(d.cards, s0Id, who);
  const restart =
    input.summary_hash !== undefined && input.c1 !== undefined && input.c4 !== undefined;
  if (restart && started?.summary_hash !== input.summary_hash) {
    const now = await onboardingSummary(d, s0Id, who);
    if (!now.ok) return now;
    if (now.value.sign_off.state === 'not_ready') {
      return err(
        coreError('conflict', now.value.sign_off.note ?? 'the summary is not ready to sign'),
      );
    }
    if (now.value.summary_hash !== input.summary_hash) {
      return err(
        coreError(
          'conflict',
          'summary_changed: the summary changed since you read it; read it again',
        ),
      );
    }
    const payload = OnboardingSignOffStartedPayload.parse({
      s0_id: s0Id,
      summary_hash: input.summary_hash,
      by: who,
      override_reason: input.override?.reason ?? null,
      content: { c1: input.c1, c4: input.c4, ...(input.c2 ? { c2: input.c2 } : {}) },
    });
    const w = await inCoreTx(d.cards, async (j, tx) => {
      await lockKeys(tx, [onboardingAgentStream(s0Id)]);
      return j.emit(
        onboardingAgentStream(s0Id),
        ONBOARDING_AGENT_EVENT.sign_off_started,
        payload,
        who,
      );
    });
    if (!w.ok) return w;
    started = payload;
  }
  if (!started) {
    return err(
      coreError(
        'invalid_input',
        'start the sign-off with the summary hash and the content of cards 1 and 4',
      ),
    );
  }
  const content = started.content;
  const override = input.override;
  const decided: SignOffResult['decided'] = [];
  let stop: {
    state: SignOffResult['state'];
    note: string;
    step_up?: SignOffResult['step_up'];
  } | null = null;

  // 2. decide what is open, in order, until nothing more can be decided in this call
  for (let round = 0; round < 8 && stop === null; round += 1) {
    await syncCards(d.cards, s0Id).catch(() => undefined);
    const loaded = await loadS0(pool, s0Id);
    if (!loaded) break;
    const live = liveCards(loaded, await s0Cards(pool, s0Id)).filter(
      (x) => x.live && ['C1', 'C2', 'C4', 'C5'].includes(x.card.kind),
    );
    const next = live[0];
    if (!next) {
      // card 4's settings revision (M1), decided and published by the same person
      if (!d.config) break;
      const rev = await revisionOfS0({ pool, config: d.config }, s0Id);
      if (!rev.ok || !rev.value.revision || rev.value.revision.published) break;
      const gate = rev.value.revision.gate_instance_id;
      const st = await readGateState(pool, gate);
      if (st?.status === 'decided') {
        if (st.outcome !== 'approve') break;
        const p = await publishRevision({ pool, config: d.config }, gate);
        if (!p.ok)
          stop = {
            state: 'waiting',
            note: `The settings could not be published: ${p.error.message}`,
          };
        continue;
      }
      const prep = await prepareRevision({ config: d.config }, { gate, principal: who, override });
      if (!prep.ok) return prep;
      if (prep.value.step_up?.required) {
        const proof =
          input.step_up?.bound_hash === prep.value.step_up.bound_hash
            ? input.step_up.proof
            : undefined;
        if (!proof) {
          stop = {
            state: 'needs_step_up',
            note: 'Confirm it’s you to put who decides what into force.',
            step_up: { bound_hash: prep.value.step_up.bound_hash as never, card: 'C4' },
          };
          break;
        }
      }
      const ev = await recordRevisionEvidence(
        { config: d.config },
        { nonce: prep.value.nonce, evidence_hash: prep.value.evidence_hash },
      );
      if (!ev.ok) return ev;
      const dec = await decideRevision(
        { pool, config: d.config },
        {
          nonce: prep.value.nonce,
          decision: 'approve',
          ...(prep.value.step_up?.required && input.step_up
            ? { step_up: { proof: input.step_up.proof } }
            : {}),
          override,
        },
      );
      if (!dec.ok) return dec;
      decided.push({ card: 'M1', card_id: gate, ledger_seqs: [dec.value.entry.ledger_seq] });
      continue;
    }

    const card = next.card;
    const prep = await prepareOnboardingCard(d.cards, {
      card_id: card.card_id,
      principal: who,
      override,
    });
    if (!prep.ok) return prep;
    let cardContent: unknown = {};
    let stepUp: { proof: string } | undefined;
    if (card.kind === 'C1') cardContent = content.c1;
    if (card.kind === 'C4') {
      cardContent = content.c4;
      // the controls the person was shown; a card opened on another report stops here (read it again)
      const det = await cardDetail(d.cards, card.card_id);
      const shown = content.c4.controls_report_hash;
      const now = det.ok
        ? ((det.value.view as { controls_report?: { report_hash?: string } }).controls_report
            ?.report_hash ?? null)
        : null;
      if (now !== shown) {
        stop = {
          state: 'waiting',
          note: 'GitHub changed since you read the summary (branch protection, the App or CODEOWNERS). Read the summary again and sign again.',
        };
        break;
      }
    }
    if (card.kind === 'C2') {
      if (!content.c2) {
        stop = {
          state: 'waiting',
          note: 'Answer the questions about the repo on the summary, then sign again.',
        };
        break;
      }
      cardContent = content.c2;
      const bound = boundHashOf(content.c2);
      if (input.step_up?.bound_hash !== bound) {
        stop = {
          state: 'needs_step_up',
          note: 'Confirm it’s you to approve the agent instructions.',
          step_up: { bound_hash: bound as never, card: 'C2' },
        };
        break;
      }
      stepUp = { proof: input.step_up.proof };
    }
    if (card.kind === 'C5' && prep.value.step_up?.required) {
      if (input.step_up?.bound_hash !== prep.value.step_up.bound_hash) {
        stop = {
          state: 'needs_step_up',
          note: 'Confirm it’s you to sign the readiness scorecard.',
          step_up: { bound_hash: prep.value.step_up.bound_hash as never, card: 'C5' },
        };
        break;
      }
      stepUp = { proof: input.step_up.proof };
    }
    const ev = await recordOnboardingEvidence(d.cards, {
      nonce: prep.value.nonce,
      evidence_hash: prep.value.evidence_hash,
    });
    if (!ev.ok) return ev;
    const dec = await decideOnboardingCard(d.cards, {
      card_id: card.card_id,
      principal: who,
      nonce: prep.value.nonce,
      decision: 'approve',
      content: cardContent,
      ...(stepUp ? { step_up: stepUp } : {}),
      override,
    });
    if (!dec.ok) return dec;
    decided.push({ card: card.kind, card_id: card.card_id, ledger_seqs: seqsOf(dec.value) });
  }

  // 3. where it stands now
  const loaded = await loadS0(pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const now = await signOffStateOf(
    d,
    loaded,
    liveCards(loaded, await s0Cards(pool, s0Id)),
    who,
    true,
  );
  if (stop) {
    return ok({ state: stop.state, note: stop.note, decided, step_up: stop.step_up ?? null });
  }
  return ok({ state: now.state, note: now.note, decided, step_up: now.step_up });
}
