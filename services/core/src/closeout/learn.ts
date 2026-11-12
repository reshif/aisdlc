import { readLearnConfig } from '@aisdlc/config';
import {
  AutonomyValues,
  LEARN_EVENT,
  LearnProposalBody,
  LearnProposedPayload,
  LearnSettledPayload,
  META_GATE_OF_KIND,
  ModeELiftedPayload,
  learnProposalId,
  learnStream,
  type Autonomy,
  type LearnConfig,
  type LearnEffect,
  type PrincipalId,
  ProjectLearnView,
} from '@aisdlc/contracts';
import { openCards, readGateState, type DecisionDeps } from '@aisdlc/decisions';
import { deterministicId, err, ok, type Result } from '@aisdlc/kernel';
import type { LoopSpec } from '@aisdlc/loops';
import type { Executor, Tx } from '@aisdlc/record';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import {
  auditLockKey,
  emitModeELifted,
  listAuditSamples,
  readSuspensionRow,
  type AuditSampleRow,
} from './audit.js';
import { CLOSEOUT_ACTOR, type CloseOutRow } from './record.js';
import { CloseOutRecord, CLOSEOUT_EVENT } from '@aisdlc/contracts';

// 9.4 Learn (PLAN M15.5; FL "9.4 Learn, A", FIX 12 "learning feeds governance: 9.4 proposes M1/M3 changes"):
//
//   propose  `learnProposals` is pure: over a project's close-out records (9.3), their audits (9.5), escapes (B17) and
//            break-glass merges (X4), the suspension (B19) and the earned autonomy, with the thresholds of
//            `factory.learn`, it says which META proposals the evidence asks for. Each rule reads only the close-outs
//            newer than the newest evidence of the last proposal on the same topic, so one piece of evidence asks once.
//            `recordLearnProposal` opens the proposal's META gate as a card on the project (`learn` subject, the
//            proposal id as subject hash: the decision binds exactly what was proposed) and records `learn.proposed`.
//   settle   `settleLearn` reads each pending proposal's gate from the LEDGER. Its end is recorded as `learn.settled`
//            with the deciding entry. Only an approved M5 changes anything: an `autonomy_promotion` records the earned
//            autonomy (`core.autonomy_earned`), a `mode_e_lift` lifts B19 (`audit.mode_e_lifted`, a new audit window).
//            M1, M3, M6 and M2 approvals record acceptance; the change itself has its own path (a revision and its
//            M1, a catalogue release, a role map revision). A rejection, an expiry or a withdrawal changes nothing.
//
// Every table here is a fold of `learn:<project>` (`rebuildLearn`); the window is the audit stream's.

export const LEARN_OBSERVER = 'learn';
export const learnLockKey = (projectId: string): string => `learn:${projectId}`;
export const learnSubjectId = (proposalId: string): string =>
  deterministicId<'LearnProposal'>(`aisdlc.learn:${proposalId}`);

/** The probation cap an earned autonomy replaces (OB §2.3): promotions start above it. */
const PROBATION: Autonomy = 'A1';
const TOP = AutonomyValues[AutonomyValues.length - 1] as Autonomy;
const arank = (a: Autonomy): number => AutonomyValues.indexOf(a);

// ---------------------------------------------------------------- the pure part

export interface LearnCloseOut {
  readonly closeout_sha256: string;
  readonly gseq: number;
  readonly record: CloseOutRecord;
}

export interface PriorProposal {
  readonly topic: string;
  readonly pending: boolean;
  /** The newest close-out position its evidence named (0: none). */
  readonly newest_gseq: number;
}

export interface LearnInput {
  readonly project_id: string;
  /** Oldest first. */
  readonly closeouts: readonly LearnCloseOut[];
  readonly escaped: ReadonlySet<string>;
  readonly audits: readonly Pick<AuditSampleRow, 'item_id' | 'outcome'>[];
  readonly suspension: { gseq: number; sampled: number; missed: number } | null;
  readonly earned: Autonomy | null;
  readonly prior: readonly PriorProposal[];
  readonly config: LearnConfig;
}

export interface LearnCandidate {
  readonly topic: string;
  readonly body: LearnProposalBody;
}

/** The topic of a proposal: proposals on the same topic follow one another, never overlap. */
export function topicOf(b: LearnProposalBody): string {
  const c = b.change;
  switch (c.kind) {
    case 'config_review':
      return `config_review:${c.key}`;
    case 'variance':
      return `variance:${c.item_id}`;
    case 'catalogue_review':
      return `catalogue_review:${c.edge}`;
    case 'autonomy_promotion':
      return 'autonomy_promotion';
    case 'mode_e_lift':
      return `mode_e_lift:${c.suspension_gseq}`;
    case 'approver_grant':
      return `approver_grant:${c.slot}`;
  }
}

/** Deterministic: the same evidence gives the same proposals (and so the same ids). */
export function learnProposals(i: LearnInput): LearnCandidate[] {
  const cfg = i.config;
  const window = i.closeouts.slice(-cfg.window);
  const missed = new Set(i.audits.filter((a) => a.outcome === 'gate_miss').map((a) => a.item_id));
  const clean = (c: LearnCloseOut) =>
    !i.escaped.has(c.record.item_id) &&
    !missed.has(c.record.item_id) &&
    c.record.break_glass.length === 0 &&
    c.record.rework.total === 0;
  const after = (topic: string): number | null => {
    const ps = i.prior.filter((p) => p.topic === topic);
    if (ps.some((p) => p.pending)) return null; // one open proposal per topic
    return ps.reduce((m, p) => Math.max(m, p.newest_gseq), 0);
  };
  const out: LearnCandidate[] = [];
  const push = (
    signal: LearnProposalBody['signal'],
    evidence: LearnCloseOut[],
    change: LearnProposalBody['change'],
  ) => {
    const body = LearnProposalBody.parse({
      project_id: i.project_id,
      kind: change.kind,
      meta_gate: META_GATE_OF_KIND[change.kind],
      signal,
      evidence: evidence.map((c) => c.closeout_sha256),
      change,
    });
    out.push({ topic: topicOf(body), body });
  };

  // M1: break-glass merges repeat: review the bypass list (a person then proposes the revision, with its own M1)
  {
    const since = after('config_review:codehost.merge_bypass');
    if (since !== null) {
      const ev = window.filter((c) => c.gseq > since && c.record.break_glass.length > 0);
      const n = ev.reduce((t, c) => t + c.record.break_glass.length, 0);
      if (n >= cfg.break_glass) {
        const repos = [
          ...new Set(ev.flatMap((c) => c.record.break_glass.map((b) => b.repo))),
        ].sort();
        push('break_glass_repeat', ev, {
          kind: 'config_review',
          key: 'codehost.merge_bypass',
          repos,
          break_glass: n,
        });
      }
    }
  }
  // M2: an item's rework far above the plan is a variance to explain
  for (const c of window) {
    if (c.record.rework.total < cfg.variance_rework) continue;
    if (after(`variance:${c.record.item_id}`) !== 0) continue; // once per item
    push('rework_variance', [c], {
      kind: 'variance',
      item_id: c.record.item_id,
      lane: c.record.lane,
      rework_total: c.record.rework.total,
      by_edge: c.record.rework.by_edge,
    });
  }
  // M3: a back-edge taken again and again is a question for the next catalogue release (never an edit in place)
  {
    const edges = [...new Set(window.flatMap((c) => Object.keys(c.record.rework.by_edge)))].sort();
    for (const edge of edges) {
      const since = after(`catalogue_review:${edge}`);
      if (since === null) continue;
      const ev = window.filter((c) => c.gseq > since && (c.record.rework.by_edge[edge] ?? 0) > 0);
      if (ev.length < cfg.edge_hotspot) continue;
      const last = ev[ev.length - 1] as LearnCloseOut;
      push('edge_hotspot', ev, {
        kind: 'catalogue_review',
        edge,
        items: ev.length,
        catalogue_version: last.record.catalogue.version,
      });
    }
  }
  // M5: lift a suspension after a clean run since it, or promote autonomy after a clean run (never while suspended)
  const trailingClean = (xs: readonly LearnCloseOut[]): LearnCloseOut[] => {
    const run: LearnCloseOut[] = [];
    for (let k = xs.length - 1; k >= 0; k -= 1) {
      const c = xs[k] as LearnCloseOut;
      if (!clean(c)) break;
      run.unshift(c);
    }
    return run;
  };
  if (i.suspension !== null) {
    const topic = `mode_e_lift:${i.suspension.gseq}`;
    const since = after(topic);
    if (since !== null) {
      const from = Math.max(since, i.suspension.gseq);
      const run = trailingClean(window.filter((c) => c.gseq > from));
      if (run.length >= cfg.clean_streak) {
        push('clean_since_suspension', run, {
          kind: 'mode_e_lift',
          suspension_gseq: i.suspension.gseq,
          sampled: i.suspension.sampled,
          missed: i.suspension.missed,
          clean_since: run.length,
        });
      }
    }
  } else {
    const current = i.earned ?? PROBATION;
    const since = after('autonomy_promotion');
    if (since !== null && arank(current) < arank(TOP)) {
      const run = trailingClean(window.filter((c) => c.gseq > since));
      if (run.length >= cfg.clean_streak) {
        push('clean_streak', run, {
          kind: 'autonomy_promotion',
          from: current,
          to: AutonomyValues[arank(current) + 1] as Autonomy,
          clean_streak: run.length,
        });
      }
    }
  }
  // M6: one person decided every mode-E G4 of a long run: ask for another approver in the g4 slot
  {
    const since = after('approver_grant:g4');
    if (since !== null) {
      const modeE = window.filter((c) => c.gseq > since && c.record.g4?.mode === 'E');
      const run: LearnCloseOut[] = [];
      let who: string | null = null;
      for (let k = modeE.length - 1; k >= 0; k -= 1) {
        const c = modeE[k] as LearnCloseOut;
        const d = c.record.g4?.deciders ?? [];
        if (d.length !== 1 || (who !== null && d[0] !== who)) break;
        who = d[0] as string;
        run.unshift(c);
      }
      if (who !== null && run.length >= cfg.single_approver) {
        push('single_approver', run, {
          kind: 'approver_grant',
          slot: 'g4',
          sole_approver: who as PrincipalId,
          streak: run.length,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- read model

async function applyLearnEvent(
  tx: Tx,
  e: { type: string; payload: unknown; global_seq: number },
  card_id: string | null,
): Promise<void> {
  if (e.type === LEARN_EVENT.proposed) {
    const p = LearnProposedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.learn_proposal (proposal_id, project_id, kind, topic, meta_gate, gate_instance_id, card_id,
         proposal, proposed_at, proposed_gseq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (proposal_id) DO NOTHING`,
      [
        p.proposal_id,
        p.proposal.project_id,
        p.proposal.kind,
        topicOf(p.proposal),
        p.proposal.meta_gate,
        p.gate_instance_id,
        card_id,
        JSON.stringify(p.proposal),
        p.at,
        e.global_seq,
      ],
    );
  } else if (e.type === LEARN_EVENT.settled) {
    const p = LearnSettledPayload.parse(e.payload);
    await tx.query(
      `UPDATE core.learn_proposal SET outcome = $2, effect = $3, ledger_entry_id = $4, settled_gseq = $5
        WHERE proposal_id = $1 AND settled_gseq IS NULL`,
      [p.proposal_id, p.outcome, p.effect, p.ledger_entry_id, e.global_seq],
    );
    if (p.effect === 'autonomy_earned' && p.ledger_entry_id !== null) {
      const q = await tx.query<{ proposal: LearnProposalBody }>(
        'SELECT proposal FROM core.learn_proposal WHERE proposal_id = $1',
        [p.proposal_id],
      );
      const change = q.rows[0]?.proposal.change;
      if (change?.kind === 'autonomy_promotion') {
        await tx.query(
          `INSERT INTO core.autonomy_earned (project_id, level, proposal_id, gate_instance_id, ledger_entry_id, event_gseq)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (project_id) DO UPDATE SET level = EXCLUDED.level, proposal_id = EXCLUDED.proposal_id,
             gate_instance_id = EXCLUDED.gate_instance_id, ledger_entry_id = EXCLUDED.ledger_entry_id,
             event_gseq = EXCLUDED.event_gseq`,
          [
            p.project_id,
            change.to,
            p.proposal_id,
            p.gate_instance_id,
            p.ledger_entry_id,
            e.global_seq,
          ],
        );
      }
    }
  }
}

/** The card a META gate was opened on (the gate's card, from the record). */
async function cardOfGate(db: Executor, gate: string): Promise<string | null> {
  const q = await db.query<{ stream: string }>(
    `SELECT stream FROM record.record_event
      WHERE type = 'card.opened' AND body -> 'targets' @> $1::jsonb ORDER BY global_seq LIMIT 1`,
    [JSON.stringify([{ gate_instance_id: gate }])],
  );
  const s = q.rows[0]?.stream;
  return s ? s.slice(s.indexOf(':') + 1) : null;
}

/** Derives a project's learn tables again from its `learn:<project>` events alone. */
export async function rebuildLearn(d: CoreDeps, projectId: string): Promise<number> {
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string }>(
    `SELECT type, body, global_seq::text AS global_seq FROM record.record_event
      WHERE stream = $1 ORDER BY record_event.global_seq`,
    [learnStream(projectId)],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [learnLockKey(projectId)]);
    await tx.query('DELETE FROM core.learn_proposal WHERE project_id = $1', [projectId]);
    await tx.query('DELETE FROM core.autonomy_earned WHERE project_id = $1', [projectId]);
    for (const e of q.rows) {
      const card =
        e.type === LEARN_EVENT.proposed
          ? await cardOfGate(tx, LearnProposedPayload.parse(e.body).gate_instance_id)
          : null;
      await applyLearnEvent(
        tx,
        { type: e.type, payload: e.body, global_seq: Number(e.global_seq) },
        card,
      );
    }
    return ok(q.rows.length);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

interface ProposalRow {
  proposal_id: string;
  topic: string;
  meta_gate: string;
  gate_instance_id: string;
  card_id: string | null;
  proposal: LearnProposalBody;
  proposed_at: Date;
  outcome: string | null;
  effect: string | null;
}

async function proposalRows(db: Executor, projectId: string): Promise<ProposalRow[]> {
  const q = await db.query<ProposalRow>(
    `SELECT proposal_id, topic, meta_gate, gate_instance_id, card_id, proposal, proposed_at, outcome, effect
       FROM core.learn_proposal WHERE project_id = $1 ORDER BY proposed_gseq`,
    [projectId],
  );
  return q.rows;
}

/** The autonomy a decided M5 earned for the project, or `null`. */
export async function readEarnedAutonomy(
  db: Executor,
  projectId: string,
): Promise<{ level: Autonomy; gate_instance_id: string; ledger_entry_id: string } | null> {
  const q = await db.query<{ level: Autonomy; gate_instance_id: string; ledger_entry_id: string }>(
    'SELECT level, gate_instance_id, ledger_entry_id FROM core.autonomy_earned WHERE project_id = $1',
    [projectId],
  );
  return q.rows[0] ?? null;
}

/** What 9.4 knows of a project (the portal's view). */
export async function projectLearnView(db: Executor, projectId: string): Promise<ProjectLearnView> {
  const rows = await proposalRows(db, projectId);
  return ProjectLearnView.parse({
    project_id: projectId,
    proposals: rows.map((r) => ({
      proposal_id: r.proposal_id,
      proposal: r.proposal,
      gate_instance_id: r.gate_instance_id,
      card_id: r.card_id,
      status: r.outcome === null ? 'pending' : 'settled',
      outcome: r.outcome,
      effect: r.effect,
      proposed_at: r.proposed_at.toISOString(),
    })),
    earned_autonomy: await readEarnedAutonomy(db, projectId),
    mode_e_suspended: (await readSuspensionRow(db, projectId)) !== null,
  });
}

// ---------------------------------------------------------------- propose

export interface LearnDeps extends CoreDeps {
  /** The decision kernel the META gates are opened with (project eligibility). */
  readonly decisions: DecisionDeps;
}

/**
 * Opens the proposal's META gate as a card on the project and records `learn.proposed`. Seeing the same proposal
 * again (the same id) does nothing. `requester`: a person's own request (barred from deciding it like any requester).
 */
export async function recordLearnProposal(
  d: LearnDeps,
  body: LearnProposalBody,
  o: { readonly by: string; readonly requester?: PrincipalId | null },
): Promise<
  Result<{ proposal_id: string; gate_instance_id: string; duplicate: boolean }, CoreError>
> {
  const id = learnProposalId(body);
  const have = await d.pool.query<{ gate_instance_id: string }>(
    'SELECT gate_instance_id FROM core.learn_proposal WHERE proposal_id = $1',
    [id],
  );
  const known = have.rows[0];
  if (known)
    return ok({ proposal_id: id, gate_instance_id: known.gate_instance_id, duplicate: true });
  const cards = await openCards(d.decisions, {
    project_id: body.project_id,
    requester: o.requester ?? null,
    subject_kind: 'learn',
    subject_id: learnSubjectId(id),
    gates: [
      {
        gate_id: body.meta_gate,
        subject_hash: id,
        facts: {
          kind: body.kind,
          signal: body.signal,
          change: body.change as never,
          evidence: body.evidence,
        },
      },
    ],
  });
  if (!cards.ok) return err(coreError('refused', `${cards.error.code}: ${cards.error.message}`));
  const card = cards.value[0];
  const gate = card?.gate_instance_ids[0];
  if (!card || gate === undefined)
    return err(coreError('unavailable', 'the META card opened no gate'));
  const payload = LearnProposedPayload.parse({
    proposal_id: id,
    proposal: body,
    gate_instance_id: gate,
    proposed_by: o.by,
    at: clockOf(d).now().toISOString(),
  });
  const w = await inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [learnLockKey(body.project_id)]);
    const e = await j.emitAll(learnStream(body.project_id), [
      {
        type: LEARN_EVENT.proposed,
        body: payload as unknown as Record<string, unknown>,
        actor: o.by,
        idempotency_key: `learn:proposed:${id}`,
      },
    ]);
    if (!e.ok) return e;
    if (!e.value.duplicate) {
      await applyLearnEvent(
        tx,
        {
          type: LEARN_EVENT.proposed,
          payload,
          global_seq: Number(e.value.events[0]?.global_seq ?? 0),
        },
        card.card_id,
      );
    }
    return ok(e.value.duplicate);
  });
  if (!w.ok) return w;
  return ok({ proposal_id: id, gate_instance_id: gate, duplicate: w.value });
}

/** The evidence 9.4 reads for a project, from the read models (each rebuildable from the record). */
async function learnInput(
  d: CoreDeps,
  projectId: string,
  config: LearnConfig,
): Promise<LearnInput> {
  const c = await d.pool.query<{ closeout_sha256: string; record: unknown; event_gseq: string }>(
    `SELECT closeout_sha256, record, event_gseq::text AS event_gseq FROM core.closeout
      WHERE project_id = $1 ORDER BY event_gseq`,
    [projectId],
  );
  const closeouts: LearnCloseOut[] = c.rows.map((r) => ({
    closeout_sha256: r.closeout_sha256,
    gseq: Number(r.event_gseq),
    record: CloseOutRecord.parse(r.record),
  }));
  const gseqOf = new Map(closeouts.map((x) => [x.closeout_sha256, x.gseq]));
  const esc = await d.pool.query<{ item: string }>(
    `SELECT body ->> 'item_id' AS item FROM record.record_event
      WHERE type = $1 AND body ->> 'project_id' = $2`,
    [CLOSEOUT_EVENT.escape_reported, projectId],
  );
  const prior = (await proposalRows(d.pool, projectId)).map((r) => ({
    topic: r.topic,
    pending: r.outcome === null,
    newest_gseq: LearnProposalBody.parse(r.proposal).evidence.reduce(
      (m, h) => Math.max(m, gseqOf.get(h) ?? 0),
      // a person's request names no close-out: it counts from the suspension it binds
      r.proposal.change.kind === 'mode_e_lift' ? r.proposal.change.suspension_gseq : 0,
    ),
  }));
  const earned = await readEarnedAutonomy(d.pool, projectId);
  return {
    project_id: projectId,
    closeouts,
    escaped: new Set(esc.rows.map((r) => r.item)),
    audits: await listAuditSamples(d.pool, projectId),
    suspension: await readSuspensionRow(d.pool, projectId),
    earned: earned?.level ?? null,
    prior,
    config,
  };
}

/** Runs 9.4 for one project: every proposal the evidence asks for, recorded with its META gate. */
export async function proposeFromCloseOuts(
  d: LearnDeps,
  projectId: string,
): Promise<Result<string[], CoreError>> {
  const cfg = await readLearnConfig(d.pool);
  if (cfg.state !== 'ok') return err(coreError('unavailable', 'factory.learn is unreadable'));
  const input = await learnInput(d, projectId, cfg.value);
  const out: string[] = [];
  for (const cand of learnProposals(input)) {
    const r = await recordLearnProposal(d, cand.body, { by: CLOSEOUT_ACTOR });
    if (!r.ok) return r;
    if (!r.value.duplicate) out.push(r.value.proposal_id);
  }
  return ok(out);
}

/** A person asks for the lift of the project's mode-E suspension: an M5 the project admins decide. */
export async function requestModeELift(
  d: LearnDeps,
  projectId: string,
  by: PrincipalId,
): Promise<
  Result<{ proposal_id: string; gate_instance_id: string; duplicate: boolean }, CoreError>
> {
  const sus = await readSuspensionRow(d.pool, projectId);
  if (!sus) return err(coreError('conflict', 'mode E is not suspended for this project'));
  const body = LearnProposalBody.parse({
    project_id: projectId,
    kind: 'mode_e_lift',
    meta_gate: 'M5',
    signal: 'requested',
    evidence: [],
    change: {
      kind: 'mode_e_lift',
      suspension_gseq: sus.gseq,
      sampled: sus.sampled,
      missed: sus.missed,
      clean_since: 0,
    },
  });
  const pending = await d.pool.query(
    `SELECT 1 FROM core.learn_proposal WHERE project_id = $1 AND topic = $2 AND settled_gseq IS NULL`,
    [projectId, topicOf(body)],
  );
  if (pending.rows.length > 0) {
    const id = learnProposalId(body);
    const same = await d.pool.query<{ gate_instance_id: string }>(
      'SELECT gate_instance_id FROM core.learn_proposal WHERE proposal_id = $1',
      [id],
    );
    const row = same.rows[0];
    if (row)
      return ok({ proposal_id: id, gate_instance_id: row.gate_instance_id, duplicate: true });
    return err(coreError('conflict', 'a lift of this suspension is already proposed'));
  }
  return recordLearnProposal(d, body, { by, requester: by });
}

// ---------------------------------------------------------------- settle (from the ledger)

/**
 * Reads the ledger for every pending proposal of a project and records how its META gate ended. Only an approved M5
 * changes something (the earned autonomy, the lift of B19); expiry never approves.
 */
export async function settleLearn(
  d: LearnDeps,
  projectId: string,
): Promise<Result<string[], CoreError>> {
  const out: string[] = [];
  for (const r of (await proposalRows(d.pool, projectId)).filter((x) => x.outcome === null)) {
    const gs = await readGateState(d.pool, r.gate_instance_id);
    if (!gs || gs.status === 'pending') continue;
    const body = LearnProposalBody.parse(r.proposal);
    const outcome =
      gs.status === 'decided'
        ? (gs.outcome as 'approve' | 'reject' | 'request_changes')
        : gs.status === 'expired'
          ? 'expired'
          : gs.status === 'superseded'
            ? 'superseded'
            : 'withdrawn';
    const ending = gs.decisions.find((x) => x.ledger_seq === gs.ended_ledger_seq) ?? null;
    // the decision must be exactly this proposal's: its META gate, its subject hash
    const binds =
      gs.open.payload.gate_id === body.meta_gate && gs.open.payload.subject_hash === r.proposal_id;
    const approved =
      binds && gs.status === 'decided' && gs.outcome === 'approve' && ending !== null;
    const w = await inCoreTx(d, async (j, tx) => {
      await lockKeys(tx, [learnLockKey(projectId), auditLockKey(projectId)]);
      let effect: LearnEffect = 'none';
      if (approved && body.meta_gate === 'M5' && body.change.kind === 'autonomy_promotion') {
        effect = 'autonomy_earned';
      } else if (approved && body.meta_gate === 'M5' && body.change.kind === 'mode_e_lift') {
        const sus = await readSuspensionRow(tx, projectId);
        if (sus !== null && sus.gseq === body.change.suspension_gseq) {
          const l = await emitModeELifted(
            j,
            tx,
            ModeELiftedPayload.parse({
              project_id: projectId,
              suspension_gseq: sus.gseq,
              proposal_id: r.proposal_id,
              gate_instance_id: r.gate_instance_id,
              ledger_entry_id: ending.entry_id,
              at: clockOf(d).now().toISOString(),
            }),
          );
          if (!l.ok) return l;
          effect = 'mode_e_lifted';
        }
      } else if (approved) {
        effect = 'accepted';
      }
      const payload = LearnSettledPayload.parse({
        proposal_id: r.proposal_id,
        project_id: projectId,
        gate_instance_id: r.gate_instance_id,
        meta_gate: body.meta_gate,
        outcome,
        ledger_entry_id: ending?.entry_id ?? null,
        effect,
        at: clockOf(d).now().toISOString(),
      });
      const e = await j.emitAll(learnStream(projectId), [
        {
          type: LEARN_EVENT.settled,
          body: payload as unknown as Record<string, unknown>,
          actor: CLOSEOUT_ACTOR,
          idempotency_key: `learn:settled:${r.proposal_id}`,
        },
      ]);
      if (!e.ok) return e;
      if (!e.value.duplicate) {
        await applyLearnEvent(
          tx,
          {
            type: LEARN_EVENT.settled,
            payload,
            global_seq: Number(e.value.events[0]?.global_seq ?? 0),
          },
          null,
        );
      }
      return ok(undefined);
    });
    if (!w.ok) return w;
    out.push(r.proposal_id);
  }
  return ok(out);
}

/** 9.4 for one project now: settle what the ledger decided, then propose what the evidence asks for. */
export async function runLearn(
  d: LearnDeps,
  projectId: string,
): Promise<Result<{ proposed: string[]; settled: string[] }, CoreError>> {
  const settled = await settleLearn(d, projectId);
  if (!settled.ok) return settled;
  const proposed = await proposeFromCloseOuts(d, projectId);
  if (!proposed.ok) return proposed;
  return ok({ proposed: proposed.value, settled: settled.value });
}

/** `learn`: 9.4 over every project with close-out records or pending proposals, off the closing chain. */
export function learnLoop(
  d: LearnDeps,
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 60_000;
  return {
    name: LEARN_OBSERVER,
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 120_000) },
    async tick() {
      const q = await d.pool.query<{ project_id: string }>(
        `SELECT DISTINCT project_id FROM core.closeout
         UNION SELECT DISTINCT project_id FROM core.learn_proposal WHERE settled_gseq IS NULL
         ORDER BY project_id`,
      );
      let done = 0;
      let failed = 0;
      for (const p of q.rows) {
        const r = await runLearn(d, p.project_id);
        if (r.ok) done += r.value.proposed.length + r.value.settled.length;
        else failed += 1;
      }
      return { ok: done, failed };
    },
  };
}

export type { CloseOutRow };
