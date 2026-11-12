import {
  S0_EVENT,
  cardPayloadHash,
  S0CardAppliedPayload,
  S0SignoffReadyPayload,
  S0SignableLevelPayload,
  levelRank,
  type CardPayloadItem,
  type OnboardingStepId,
  type PrincipalId,
  type S0StepChangedPayload,
} from '@aisdlc/contracts';
import {
  openCard,
  readCardState,
  withdrawCard,
  withdrawGate,
  type CardState,
} from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { PoolClient } from 'pg';
import { coreError, type CoreError } from '../errors.js';
import { isTerminal } from '../fold.js';
import { inCoreTx, type Journal } from '../journal.js';
import {
  applySignableLevel,
  changeStatus,
  changeStep,
  completeStepIn,
  openS0,
  sendBackIn,
} from '../s0.js';
import { approveM4In, ensurePrrProposed } from '../m4.js';
import { lockKeys } from '../journal.js';
import { repoKeyOf } from '@aisdlc/contracts';
import { s0Stream } from '@aisdlc/contracts';
import { proposeProjectSettings } from '../settings.js';
import {
  STEP_OF_CARD,
  SLOT_OF_CARD,
  SYSTEM_CARDS_ACTOR,
  cardKey,
  configFor,
  decisionsFor,
  type CardDeps,
  type HandledCard,
} from './model.js';
import { loadS0, raisesOf, s0Cards, type LoadedS0, type OnboardingCard } from './read.js';
import { c5Context, c5View, evidenceHashOf, settingsOf } from './views.js';
import { ensureLightProposal } from './light.js';

// Keeping the cards and the S0 record in step (PLAN M7.3). `syncCards` is idempotent and safe to
// run from several places (the portal, a loop): it
//   1. applies cards that were decided but not yet applied (a crash between the ledger and the
//      record leaves exactly that),
//   2. opens the card of every `s0.card_required` the record is waiting at,
//   3. withdraws cards nobody can decide any more (the record was parked, withdrawn, superseded or
//      sent back, or a newer card replaced it, or the finding is no longer open).
// Opening and withdrawing write no decision; applying writes none either: the decision is the
// ledger entry the person's own call produced.

export interface SyncReport {
  readonly opened: string[];
  readonly applied: string[];
  readonly withdrawn: string[];
  /** Things that could not be done now (a service down); the next sync tries again. */
  readonly pending: string[];
}

const STEP_CARDS = ['C1', 'C2', 'C4', 'C5'] as const satisfies readonly HandledCard[];

/** The record is waiting at the step's card: the only time a step card can be decided. */
export function waitingAt(s0: LoadedS0['s0'], step: OnboardingStepId): boolean {
  return s0.record.status === 'card' && s0.steps.get(step)?.state === 'card';
}

/** Is the card still one a person can decide? */
export function isLive(loaded: LoadedS0, card: OnboardingCard): boolean {
  const { s0, events } = loaded;
  if (card.occurrence !== raisesOf(events, card.kind)) return false;
  if (card.kind === 'SECR') return !isTerminal(s0.record.status) && s0.record.status !== 'rejected';
  return waitingAt(s0, STEP_OF_CARD[card.kind]);
}

export async function syncCards(
  deps: CardDeps,
  s0Id: string,
): Promise<Result<SyncReport, CoreError>> {
  const report: SyncReport = { opened: [], applied: [], withdrawn: [], pending: [] };
  let loaded = await loadS0(deps.pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));

  // 1. Decided and not applied.
  let cards = await s0Cards(deps.pool, s0Id);
  for (const card of cards) {
    const done = ['decided', 'sent_back', 'rejected'].includes(card.state.status);
    if (!done || appliedCards(loaded).has(card.card_id)) continue;
    const r = await applyCard(deps, card.card_id, {});
    if (r.ok) {
      if (r.value === 'applied') report.applied.push(card.card_id);
    } else report.pending.push(`apply ${card.card_id}: ${r.error.message}`);
  }
  loaded = (await loadS0(deps.pool, s0Id)) as LoadedS0;
  cards = await s0Cards(deps.pool, s0Id);

  // 2. Open what the record waits for.
  const { s0, events } = loaded;
  for (const kind of STEP_CARDS) {
    const n = raisesOf(events, kind);
    if (n === 0 || !waitingAt(s0, STEP_OF_CARD[kind])) continue;
    if (cards.some((c) => c.kind === kind && c.occurrence === n)) continue;
    const r = await openStepCard(deps, loaded, kind, n);
    if (r.ok) report.opened.push(r.value);
    else report.pending.push(`open ${kind}: ${r.error.message}`);
  }
  let openFindings: Set<string> | null = null;
  const secr = raisesOf(events, 'SECR');
  if (secr > 0 && !isTerminal(s0.record.status) && s0.record.status !== 'rejected') {
    const f = await deps.knowledge.openFindings(s0.repo);
    if (!f.ok) report.pending.push(`findings: ${f.error.message}`);
    else {
      openFindings = new Set(f.value.map((x) => x.finding_id));
      for (const id of [...openFindings].sort()) {
        if (cards.some((c) => c.kind === 'SECR' && c.occurrence === secr && c.finding_id === id)) {
          continue;
        }
        const r = await openStepCard(deps, loaded, 'SECR', secr, id);
        if (r.ok) report.opened.push(r.value);
        else report.pending.push(`open SECR: ${r.error.message}`);
      }
    }
  }

  // 3. Close what nobody can decide any more.
  cards = await s0Cards(deps.pool, s0Id);
  for (const card of cards) {
    if (card.state.status !== 'open') continue;
    const gone =
      card.kind === 'SECR' && openFindings !== null && card.finding_id !== null
        ? !openFindings.has(card.finding_id)
        : false;
    if (isLive(loaded, card) && !gone) continue;
    const w = await closeCard(deps, card, gone ? 'finding no longer open' : 'the record moved on');
    if (w.ok) {
      if (w.value) report.withdrawn.push(card.card_id);
    } else report.pending.push(`withdraw ${card.card_id}: ${w.error.message}`);
  }
  return ok(report);
}

/**
 * Closes a card nobody can decide any more: a card without a gate is withdrawn; card 5 carries the
 * M4 gate, which is closed with a `withdraw` decision of the system (never a vote). The PRR it
 * bound to stays `proposed`. `true` when something was closed.
 */
async function closeCard(
  deps: CardDeps,
  card: OnboardingCard,
  reason: string,
): Promise<Result<boolean, CoreError>> {
  if (card.state.gates.length === 0) {
    const w = await withdrawCard(deps.decisions, {
      card_id: card.card_id,
      reason,
      by: SYSTEM_CARDS_ACTOR,
    });
    return w.ok ? ok(w.value.withdrawn) : err(coreError('unavailable', w.error.message));
  }
  let closed = false;
  for (const g of card.state.gates) {
    if (g.state.status !== 'pending') continue;
    const w = await withdrawGate(deps.decisions, {
      gate_instance_id: g.gate_instance_id,
      actor: SYSTEM_CARDS_ACTOR,
      reason,
    });
    if (!w.ok) return err(coreError('unavailable', w.error.message));
    closed = true;
  }
  return ok(closed);
}

/**
 * Card 5 (PLAN M7.5): the PRR is built and proposed first (the record the sign-off is about), then
 * ONE card carries the 0.5 sign-off step and the M4 gate on the S0 record's UUID, whose subject
 * hash is the PRR's `record_hash`. The gate requires a step-up bound to that hash.
 */
async function openSignoffCard(
  deps: CardDeps,
  loaded: LoadedS0,
  occurrence: number,
): Promise<Result<string, CoreError>> {
  const { s0 } = loaded;
  const prr = await ensurePrrProposed(deps, s0.record.s0_id, occurrence);
  if (!prr.ok) return prr;
  const cards = await s0Cards(deps.pool, s0.record.s0_id);
  const ctx = c5Context(loaded, cards, prr.value);
  if (!ctx.ok) return ctx;
  const evidence = evidenceHashOf(c5View(ctx.value));
  const r = await openCard(decisionsFor(deps, s0.record.s0_id), {
    project_id: s0.record.project_id,
    subject_kind: 's0_record',
    subject_id: s0.record.s0_id,
    gates: [
      {
        gate_id: 'M4',
        subject_hash: prr.value.record_hash,
        evidence_pack_hash: evidence,
        facts: {
          s0_ref: s0.record.intake_ref,
          prr_record_id: prr.value.record_id,
          prr_version: prr.value.version,
          level: prr.value.level.signed,
        },
      },
    ],
    steps: [{ step: STEP_OF_CARD.C5, slot: SLOT_OF_CARD.C5 }],
    // The onboarding is not a delivery request: separation of duties here is the slots and the
    // two-person setting, not a "requester" who cannot sign.
    requester: null,
    label: 'C5',
    opened_by: SYSTEM_CARDS_ACTOR,
  });
  return r.ok
    ? ok(r.value.card_id)
    : err(coreError(r.error.code === 'database' ? 'database' : 'unavailable', r.error.message));
}

async function openStepCard(
  deps: CardDeps,
  loaded: LoadedS0,
  kind: HandledCard,
  occurrence: number,
  finding?: string,
): Promise<Result<string, CoreError>> {
  if (kind === 'C5') return openSignoffCard(deps, loaded, occurrence);
  // Card 2 is about a recorded proposal (record-first): it is built and recorded before the card opens.
  if (kind === 'C2') {
    const proposed = await ensureLightProposal(deps, loaded, occurrence);
    if (!proposed.ok) return proposed;
  }
  const { s0 } = loaded;
  const r = await openCard(decisionsFor(deps, s0.record.s0_id), {
    project_id: s0.record.project_id,
    subject_kind: 's0_record',
    subject_id: s0.record.s0_id,
    gates: [],
    key: cardKey(s0.record.s0_id, kind, occurrence, finding),
    steps: [{ step: STEP_OF_CARD[kind], slot: SLOT_OF_CARD[kind] }],
    requester: null,
    label: kind,
    opened_by: SYSTEM_CARDS_ACTOR,
  });
  return r.ok
    ? ok(r.value.card_id)
    : err(coreError(r.error.code === 'database' ? 'database' : 'unavailable', r.error.message));
}

/** Card ids that already have an `s0.card_applied` on the record. */
export function appliedCards(loaded: LoadedS0): Set<string> {
  return new Set(
    loaded.events
      .filter((e) => e.type === S0_EVENT.card_applied)
      .map((e) => (e.payload as { card_id: string }).card_id),
  );
}

// ---------------------------------------------------------------- applying a decided card

/**
 * Applies a decided card to the record, once. What the decision causes outside the record is done
 * first and is idempotent (a config revision proposed, a finding state set); then, in ONE core
 * transaction under the record's lock, `s0.card_applied` is written together with the step
 * transition, so a record never shows a card applied without its effect or the reverse. A card the
 * record no longer waits for is recorded `stale`: the decision stays on the ledger, nothing moves.
 */
export async function applyCard(
  deps: CardDeps,
  cardId: string,
  o: { reason?: string },
): Promise<Result<'applied' | 'noop', CoreError>> {
  const state = await readCardState(deps.pool, cardId);
  if (!state) return err(coreError('not_found', `no card ${cardId}`));
  const s0Id = state.open.subject_id;
  const kind = state.open.label as HandledCard;
  const step = STEP_OF_CARD[kind];
  const stepDecision = state.steps[0];
  if (!stepDecision || stepDecision.decision === null || stepDecision.actor === null) {
    return err(coreError('conflict', 'the card is not decided'));
  }
  const decision = stepDecision.decision;
  const by = stepDecision.actor as PrincipalId;
  // Card 5 is also the M4 gate: it is applied once the whole card is decided, not on the first
  // approval of a two-person M4 (the card stays open until the gate reaches its quorum).
  if (kind === 'C5' && state.status === 'open') {
    return err(coreError('conflict', 'the M4 gate on the card is still waiting for a decision'));
  }
  const payload: CardPayloadItem[] = state.payload?.payload ?? [];
  const payloadHash = (state.payload?.payload_hash ??
    state.decided[0]?.payload_hash ??
    cardPayloadHash([])) as string;

  const before = await loadS0(deps.pool, s0Id);
  if (!before) return err(coreError('not_found', `no S0 record ${s0Id}`));
  if (appliedCards(before).has(cardId)) return ok('noop');

  // ---- effects outside the record (idempotent)
  const refs: Record<string, string> = {};
  let release = false;
  if (decision === 'approve' && kind === 'C4') {
    const settings = payload.find((p) => p.kind === 'settings_decision');
    const report = payload.find((p) => p.kind === 'controls_report');
    if (settings?.kind !== 'settings_decision' || report?.kind !== 'controls_report') {
      return err(coreError('conflict', 'the decided card carries no settings'));
    }
    refs['controls_report_hash'] = report.report_hash;
    // Only on a live card: a stale decision proposes nothing.
    if (waitingAt(before.s0, step)) {
      const config = configFor(deps, s0Id);
      if (!config) return err(coreError('unavailable', 'no decision kernel is configured'));
      const p = await proposeProjectSettings(config, {
        project: before.s0.record.project_id,
        change: {
          role_map: settings.role_map,
          two_person: settings.two_person,
          gating_profile: settings.gating_profile,
          kill_delegations: settings.kill_delegations,
          // M15.5: card 4's release choice rides in the same project-layer revision
          ...(settings.release !== undefined ? { release: settings.release } : {}),
        },
        proposed_by: by,
      });
      if (p.ok) {
        refs['config_rev_hash'] = p.value.rev_hash;
        refs['m1_gate_instance_id'] = p.value.gate_instance_id;
      } else if (!/equals the current revision/.test(p.error.message)) {
        return p;
      } else refs['config'] = 'unchanged';
    }
  }
  if (decision === 'approve' && kind === 'SECR') {
    const row = payload.find((p) => p.kind === 'finding_state');
    if (row?.kind !== 'finding_state') {
      return err(coreError('conflict', 'the decided card carries no finding state'));
    }
    const set = await deps.knowledge.setFindingState(row.finding_id, {
      state: row.state,
      principal_id: by,
      // The person's own words when this runs right after the decision; afterwards a pointer to the ledger.
      reason: o.reason ?? `decided on card ${cardId} (payload ${payloadHash})`,
      // Knowledge accepts the change only on this decision, verified against the ledger (PLAN M7.4).
      decision_ref: {
        card_id: cardId as never,
        ledger_entry_id: stepDecision.ledger_entry_id as never,
      },
    });
    if (!set.ok) return err(coreError('unavailable', `knowledge: ${set.error.message}`));
    release = await shouldRelease(deps, before);
  }

  // ---- the record
  const applied = await inCoreTx(deps, async (j, tx) => {
    // The same order everywhere a record, its project and its repo are locked together.
    await lockKeys(tx, [
      `project:${before.s0.record.project_id}`,
      `repo:${repoKeyOf(before.s0.repo)}`,
      `s0:${s0Id}`,
    ]);
    const opened = await openS0(j, s0Id);
    if (!opened.ok) return opened;
    const s0 = opened.value;
    const events = await j.events(s0Stream(s0Id));
    if (
      events.some(
        (e) =>
          e.type === S0_EVENT.card_applied &&
          (e.payload as { card_id?: string }).card_id === cardId,
      )
    ) {
      return ok('noop' as const);
    }
    const live = kind === 'SECR' ? !isTerminal(s0.record.status) : waitingAt(s0, step);
    let outcome: S0CardAppliedPayload['outcome'] = 'stale';
    if (live) {
      if (kind === 'SECR') {
        outcome = 'finding_resolved';
        if (release && levelRank(s0.record.signable_level) < levelRank(s0.record.requested_level)) {
          const r = await releaseSignableLevel(j, s0, by);
          if (!r.ok) return r;
        }
      } else if (decision === 'approve') {
        if (kind === 'C5') {
          const m4 = await approveSignoff(deps, j, tx, s0, {
            card: state,
            payload,
            payloadHash,
            by,
          });
          if (!m4.ok) return m4;
          outcome = 'm4_approved';
        } else {
          const c = await completeStepIn(j, s0, step, { actor: by });
          if (!c.ok) return c;
          outcome = 'step_done';
        }
      } else {
        const sb = await sendBackIn(j, s0, step, {
          actor: by,
          ...(o.reason ? { reason: o.reason } : {}),
          limit: decision === 'reject' ? 0 : settingsOf(deps).failure.send_backs_per_step,
        });
        if (!sb.ok) return sb;
        outcome = sb.value.outcome === 'rejected' ? 'rejected' : 'sent_back';
      }
    }
    const w = await j.emit(
      s0Stream(s0Id),
      S0_EVENT.card_applied,
      S0CardAppliedPayload.parse({
        card_id: cardId,
        card: kind,
        step,
        decision,
        payload_hash: payloadHash,
        outcome,
        by,
        refs,
      }),
      by,
    );
    return w.ok ? ok('applied' as const) : w;
  });
  return applied;
}

/**
 * An approved card 5 in the record (PLAN M7.5): the sign-off and M4 are both on the ledger. The M4
 * entry must be the decision of the gate that was opened for exactly the PRR the card's payload
 * names; then the record goes active, the repo and project are signed, the held work is fanned
 * out, and the S0 record's step 0.5 and the record itself are done. One transaction, all or none.
 */
async function approveSignoff(
  deps: CardDeps,
  j: Journal,
  tx: PoolClient,
  s0Start: LoadedS0['s0'],
  o: { card: CardState; payload: CardPayloadItem[]; payloadHash: string; by: PrincipalId },
): Promise<Result<true, CoreError>> {
  const pkg = o.payload.find((p) => p.kind === 'm4_package');
  const gate = o.card.gates[0];
  const signoff = o.card.steps[0];
  if (pkg?.kind !== 'm4_package' || !gate || !signoff?.ledger_entry_id) {
    return err(coreError('conflict', 'the decided card carries no package, M4 gate or sign-off'));
  }
  const last = gate.state.effective_seqs.at(-1);
  const deciding = gate.state.decisions.find((d) => d.ledger_seq === last);
  if (gate.state.status !== 'decided' || gate.state.outcome !== 'approve' || !deciding) {
    return err(coreError('conflict', 'the M4 gate was not approved'));
  }
  if (gate.state.open.payload.subject_hash !== pkg.prr_record_hash) {
    return err(coreError('conflict', 'the M4 gate is bound to another record than the card names'));
  }
  const entry = await tx.query<{ entry_hash: string }>(
    'SELECT entry_hash FROM ledger.ledger_entry WHERE entry_id = $1',
    [deciding.entry_id],
  );
  const decisionHash = entry.rows[0]?.entry_hash;
  if (!decisionHash) return err(coreError('conflict', 'the M4 entry is not on the ledger'));

  const m4 = await approveM4In(deps, j, tx, s0Start, {
    prr_hash: pkg.prr_record_hash,
    m4: { ledger_entry_id: deciding.entry_id, decision_hash: decisionHash },
    by: deciding.actor as PrincipalId,
  });
  if (!m4.ok) return m4;
  const ready = await j.emit(
    s0Stream(s0Start.record.s0_id),
    S0_EVENT.signoff_ready,
    S0SignoffReadyPayload.parse({
      card_id: o.card.card_id,
      signoff_entry_id: signoff.ledger_entry_id,
      package: {
        census_hash: pkg.census_hash,
        gap_ledger_hash: pkg.gap_ledger_hash,
        controls_report_hash: pkg.controls_report_hash,
        prr_record_hash: pkg.prr_record_hash,
      },
      payload_hash: o.payloadHash,
      by: o.by,
    }),
    o.by,
  );
  if (!ready.ok) return ready;
  // "running --> done : C5 M4 decision, readiness record active" (DM §6.3).
  const s0 = (await j.s0(s0Start.record.s0_id)) as LoadedS0['s0'];
  const stepDone = await completeStepIn(j, s0, STEP_OF_CARD.C5, { actor: o.by });
  if (!stepDone.ok) return stepDone;
  const done = await changeStatus(j, stepDone.value, 'done', {
    actor: o.by,
    cause: 'm4.approved',
    reason: `PRR ${m4.value.version} is active`,
  });
  return done.ok ? ok(true as const) : done;
}

/**
 * The signable level was lowered to Census by an open secret (B1) and is not yet back: it is
 * released once no finding is open and the scan is complete (B2 met in the census this record
 * holds). Any other reason for the lowering (a person chose it; the scan did not complete) is left.
 */
async function shouldRelease(deps: CardDeps, loaded: LoadedS0): Promise<boolean> {
  const { s0, events } = loaded;
  if (levelRank(s0.record.signable_level) >= levelRank(s0.record.requested_level)) return false;
  const last = [...events].reverse().find((e) => e.type === S0_EVENT.signable_level_set);
  if (!last || S0SignableLevelPayload.parse(last.payload).reason !== 'security.open_secret') {
    return false;
  }
  const open = await deps.knowledge.openFindings(s0.repo);
  if (!open.ok || open.value.length > 0) return false;
  const census = await deps.knowledge.census(s0.repo);
  if (!census.ok || census.value === null || !s0.census) return false;
  if (census.value.census_hash !== s0.census.census_hash) return false;
  return census.value.census.blockers.find((b) => b.id === 'B2')?.status === 'met';
}

async function releaseSignableLevel(j: Journal, s0Start: LoadedS0['s0'], by: PrincipalId) {
  let s0 = s0Start;
  const level = s0.record.requested_level;
  const lifted = await applySignableLevel(j, s0, level, { actor: by, reason: 'security.resolved' });
  if (!lifted.ok) return lifted;
  s0 = lifted.value;
  // Steps that were skipped only because the level had dropped are asked for again.
  const events = await j.events(s0Stream(s0.record.s0_id));
  for (const [step, needs] of [
    ['0.2', 'light'],
    ['0.3', 'full'],
  ] as const) {
    if (s0.steps.get(step)?.state !== 'skip' || levelRank(level) < levelRank(needs)) continue;
    const last = [...events]
      .reverse()
      .find(
        (e) =>
          e.type === S0_EVENT.step_changed && (e.payload as S0StepChangedPayload).step === step,
      );
    if ((last?.payload as S0StepChangedPayload | undefined)?.reason !== 'above_signable_level') {
      continue;
    }
    const c = await changeStep(j, s0, step, 'todo', {
      actor: by,
      reason: 'signable_level_released',
    });
    if (!c.ok) return c;
    s0 = c.value;
  }
  return ok(s0);
}

export type { CardState };
