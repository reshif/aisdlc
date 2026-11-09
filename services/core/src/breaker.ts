import { CATALOGUE, type CatalogueData } from '@aisdlc/catalogue';
import {
  BREAKER_EVENT,
  BreakerPayloads,
  BreakerState,
  ITEM_EVENT,
  S0_DEFAULT_CALENDAR,
  breakerStream,
  type BreakerSource,
  type EligibilityReason,
  type Lane,
  type LaneEligibility,
  type PrincipalId,
  type ProjectId,
  type RecordEvent,
  type SpawnOrigin,
} from '@aisdlc/contracts';
import {
  addBusinessDays,
  businessCalendar,
  openCards,
  readGateState,
  type BusinessCalendar,
  type DecisionDeps,
} from '@aisdlc/decisions';
import { deterministicId, err, hashCanonical, ok, type Result } from '@aisdlc/kernel';
import { EVENT_COLUMNS, toRecordEvent, type EventRow, type Executor } from '@aisdlc/record';
import { foldItem, pinnedCatalogueResolver } from '@aisdlc/work';
import { coreError, type CoreError } from './errors.js';
import { inCoreTx, lockKeys, type CoreDeps } from './journal.js';

// R3 and R4 in core (PLAN M9.5; FL FIX 3).
//
// R3, the circuit breaker ET14, per project x lane. What counts toward it (Q1, E4 abandon or
// takeover, the rework budget) arrives as `breaker_signal` commands from the items and is appended to
// the stream `breaker:<project>:<lane>` once per key. When the count since the last reset reaches the
// catalogue's `trip` threshold the breaker TRIPS: new items for that project and lane route to L8 (the
// 1.4 rule). The state is a fold of the stream, never a counter. The RESET is a human decision: an
// M5 gate (autonomy promotion: the project's agent lane is promoted again) on subject kind `breaker`,
// and `breaker.reset` is written only once that decision is read from the ledger.
//
// R4, the hotfix follow-up: an L0 item that completes S8b makes an L1 item (the interpreter says so).
// Here is what the overdue clock blocks: while a follow-up is open past the catalogue's overdue limit
// (5 business days), the project's NEW agent items route to L8, like R3. The follow-up itself is
// exempt (it is how the block ends).

export const BREAKER_ACTOR = 'system.breaker';

/** The catalogue's R3 threshold (ET14 `trip`), or `null` when it gives none: then the breaker never trips. */
export const breakerThreshold = (cat: CatalogueData = CATALOGUE): number | null => {
  const v = cat.triggers.ET14.thresholds.find((t) => t.key === 'trip')?.value ?? null;
  return v !== null && v >= 1 ? v : null;
};

export const breakerSubjectId = (project: string, lane: string): string =>
  deterministicId<'Breaker'>(`aisdlc.breaker:${project}:${lane}`);

// ---------------------------------------------------------------- The fold

export interface BreakerFold {
  readonly counts: Partial<Record<BreakerSource, number>>;
  readonly total: number;
  readonly tripped: boolean;
  readonly tripped_at: string | null;
  readonly pending_reset: { gate_instance_id: string; subject_hash: string } | null;
  readonly resets: number;
  /** The stream seq of the last count, which an open reset gate is bound to. */
  readonly last_count_seq: number;
}

/** The breaker of one project and lane from its stream. Pure. */
export function foldBreaker(events: readonly RecordEvent[]): BreakerFold {
  let counts: Partial<Record<BreakerSource, number>> = {};
  let total = 0;
  let tripped = false;
  let tripped_at: string | null = null;
  let pending: BreakerFold['pending_reset'] = null;
  let resets = 0;
  let last = 0;
  for (const e of events) {
    switch (e.type) {
      case BREAKER_EVENT.counted: {
        const p = BreakerPayloads[BREAKER_EVENT.counted].parse(e.payload);
        counts = { ...counts, [p.source]: (counts[p.source] ?? 0) + 1 };
        total += 1;
        last = e.stream_seq;
        break;
      }
      case BREAKER_EVENT.tripped:
        tripped = true;
        tripped_at = e.occurred_at;
        break;
      case BREAKER_EVENT.reset_requested: {
        const p = BreakerPayloads[BREAKER_EVENT.reset_requested].parse(e.payload);
        pending = { gate_instance_id: p.gate_instance_id, subject_hash: p.subject_hash };
        break;
      }
      case BREAKER_EVENT.reset:
        counts = {};
        total = 0;
        tripped = false;
        tripped_at = null;
        pending = null;
        resets += 1;
        break;
      default:
        break;
    }
  }
  return {
    counts,
    total,
    tripped,
    tripped_at,
    pending_reset: pending,
    resets,
    last_count_seq: last,
  };
}

export function stateOf(
  project_id: string,
  lane: Lane,
  f: BreakerFold,
  threshold: number | null,
): BreakerState {
  return BreakerState.parse({
    project_id,
    lane,
    counts: f.counts,
    total: f.total,
    threshold,
    tripped: f.tripped,
    tripped_at: f.tripped_at,
    pending_reset: f.pending_reset?.gate_instance_id ?? null,
    resets: f.resets,
  });
}

export async function readBreakerEvents(
  db: Executor,
  project: string,
  lane: string,
): Promise<RecordEvent[]> {
  const q = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [breakerStream(project, lane)],
  );
  return q.rows.map(toRecordEvent);
}

export async function readBreaker(
  db: Executor,
  project: string,
  lane: Lane,
  threshold: number | null = breakerThreshold(),
): Promise<BreakerState> {
  return stateOf(project, lane, foldBreaker(await readBreakerEvents(db, project, lane)), threshold);
}

/** Every breaker that has a stream, tripped or not (the floor's and the ops view's list). */
export async function listBreakers(
  db: Executor,
  threshold: number | null = breakerThreshold(),
): Promise<BreakerState[]> {
  const q = await db.query<{ stream: string }>(
    `SELECT DISTINCT stream FROM record.record_event WHERE stream LIKE 'breaker:%' ORDER BY stream`,
  );
  const out: BreakerState[] = [];
  for (const { stream } of q.rows) {
    const [, project, lane] = stream.split(':');
    if (project === undefined || lane === undefined) continue;
    out.push(await readBreaker(db, project, lane as Lane, threshold));
  }
  return out;
}

// ---------------------------------------------------------------- Counting and tripping

export interface BreakerDeps extends CoreDeps {
  /** Overrides the catalogue's threshold (tests); absent, ET14 `trip` of the current catalogue. */
  readonly threshold?: number | null;
}

/**
 * One count toward a breaker. Once per `signal_key`; a repeat is a no-op. Trips the breaker in the
 * same transaction when the count reaches the threshold (and writes nothing more once it is tripped).
 */
export async function recordBreakerSignal(
  deps: BreakerDeps,
  s: {
    project_id: ProjectId | string;
    lane: Lane;
    source: BreakerSource;
    item_id: string | null;
    signal_key: string;
  },
): Promise<Result<BreakerState, CoreError>> {
  const stream = breakerStream(s.project_id, s.lane);
  const threshold = deps.threshold === undefined ? breakerThreshold() : deps.threshold;
  return inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [stream]);
    const w = await j.emitAll(stream, [
      {
        type: BREAKER_EVENT.counted,
        body: BreakerPayloads[BREAKER_EVENT.counted].parse({
          project_id: s.project_id,
          lane: s.lane,
          source: s.source,
          item_id: s.item_id,
          signal_key: s.signal_key,
        }),
        actor: BREAKER_ACTOR,
        idempotency_key: `count:${s.signal_key}`,
      },
    ]);
    if (!w.ok) return w;
    const fold = foldBreaker(await j.events(stream));
    if (!w.value.duplicate && !fold.tripped && threshold !== null && fold.total >= threshold) {
      const t = await j.emitAll(stream, [
        {
          type: BREAKER_EVENT.tripped,
          body: BreakerPayloads[BREAKER_EVENT.tripped].parse({
            project_id: s.project_id,
            lane: s.lane,
            count: fold.total,
            threshold,
          }),
          actor: BREAKER_ACTOR,
          idempotency_key: `trip:${s.project_id}:${s.lane}:${fold.resets}`,
        },
      ]);
      if (!t.ok) return t;
    }
    return ok(stateOf(s.project_id, s.lane, foldBreaker(await j.events(stream)), threshold));
  });
}

// ---------------------------------------------------------------- The human reset (M5)

export interface BreakerResetDeps extends BreakerDeps {
  readonly decisions: DecisionDeps;
}

/**
 * Asks for the reset: opens an M5 gate on the breaker (a card in the project admin's inbox), bound to
 * the count it would clear. A breaker that is not tripped has nothing to reset. A second request while
 * the gate is pending is the same gate; more counts since supersede it (the hash changes).
 */
export async function requestBreakerReset(
  deps: BreakerResetDeps,
  o: { project_id: ProjectId; lane: Lane; requested_by: PrincipalId },
): Promise<Result<{ gate_instance_id: string; state: BreakerState }, CoreError>> {
  const stream = breakerStream(o.project_id, o.lane);
  const threshold = deps.threshold === undefined ? breakerThreshold() : deps.threshold;
  const pre = await readBreaker(deps.pool, o.project_id, o.lane, threshold);
  if (!pre.tripped)
    return err(coreError('conflict', 'the breaker is not tripped: nothing to reset'));
  const fold = foldBreaker(await readBreakerEvents(deps.pool, o.project_id, o.lane));
  const subject_hash = hashCanonical({
    kind: 'breaker_reset',
    project_id: o.project_id,
    lane: o.lane,
    resets: fold.resets,
    last_count_seq: fold.last_count_seq,
    total: fold.total,
  });
  const cards = await openCards(deps.decisions, {
    project_id: o.project_id,
    requester: o.requested_by,
    subject_kind: 'breaker',
    subject_id: breakerSubjectId(o.project_id, o.lane),
    gates: [
      {
        gate_id: 'M5',
        subject_hash,
        facts: {
          kind: 'breaker_reset',
          project_id: o.project_id,
          lane: o.lane,
          counts: fold.counts,
          total: fold.total,
          threshold,
        },
      },
    ],
  });
  if (!cards.ok) return err(coreError('refused', `${cards.error.code}: ${cards.error.message}`));
  const gate = cards.value[0]?.gate_instance_ids[0];
  if (gate === undefined) return err(coreError('unavailable', 'the reset card opened no gate'));
  const recorded = await inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [stream]);
    return j.emitAll(stream, [
      {
        type: BREAKER_EVENT.reset_requested,
        body: BreakerPayloads[BREAKER_EVENT.reset_requested].parse({
          project_id: o.project_id,
          lane: o.lane,
          gate_instance_id: gate,
          subject_hash,
          count: fold.total,
          requested_by: o.requested_by,
        }),
        actor: o.requested_by,
        idempotency_key: `reset_requested:${gate}`,
      },
    ]);
  });
  if (!recorded.ok) return recorded;
  return ok({
    gate_instance_id: gate,
    state: await readBreaker(deps.pool, o.project_id, o.lane, threshold),
  });
}

/**
 * Reads the ledger for every breaker with a reset gate open and records `breaker.reset` for the ones
 * whose M5 decision is an approval. A rejection, an expiry or a withdrawal changes nothing: the
 * breaker stays tripped (expiry never approves) and a new request may be made.
 */
export async function settleBreakerResets(
  deps: BreakerResetDeps,
): Promise<{ reset: Array<{ project_id: string; lane: string }> }> {
  const reset: Array<{ project_id: string; lane: string }> = [];
  for (const b of await listBreakers(deps.pool)) {
    if (b.pending_reset === null) continue;
    const gs = await readGateState(deps.pool, b.pending_reset);
    if (!gs || gs.status !== 'decided' || gs.outcome !== 'approve') continue;
    const stream = breakerStream(b.project_id, b.lane);
    const done = await inCoreTx(deps, async (j, tx) => {
      await lockKeys(tx, [stream]);
      const fold = foldBreaker(await j.events(stream));
      if (fold.pending_reset?.gate_instance_id !== b.pending_reset) return ok(false);
      const entry =
        gs.decisions.find((d) => d.ledger_seq === gs.ended_ledger_seq)?.entry_id ?? null;
      const w = await j.emitAll(stream, [
        {
          type: BREAKER_EVENT.reset,
          body: BreakerPayloads[BREAKER_EVENT.reset].parse({
            project_id: b.project_id,
            lane: b.lane,
            gate_instance_id: b.pending_reset,
            ledger_entry_id: entry,
            count_cleared: fold.total,
          }),
          actor: BREAKER_ACTOR,
          idempotency_key: `reset:${b.pending_reset}`,
        },
      ]);
      if (!w.ok) return w;
      return ok(!w.value.duplicate);
    });
    if (!done.ok) throw new Error(done.error.message);
    if (done.value) reset.push({ project_id: b.project_id, lane: b.lane });
  }
  return { reset };
}

// ---------------------------------------------------------------- R4: the overdue follow-up

const defaultCalendar = (): BusinessCalendar =>
  businessCalendar({
    weekend: S0_DEFAULT_CALENDAR.weekend,
    holidays: S0_DEFAULT_CALENDAR.holidays,
    utcOffsetMinutes: S0_DEFAULT_CALENDAR.utc_offset_minutes,
  });

/**
 * The open hotfix follow-ups (R4 items) of a project that are past their limit: made more than the
 * L0 lane's `follow_up.overdue` business days ago and still open (not finished, declined or
 * abandoned: a person's decision to end one is a decision).
 */
export async function overdueFollowUps(
  db: Executor,
  project_id: string,
  now: Date,
  calendar: BusinessCalendar = defaultCalendar(),
  cat: CatalogueData = CATALOGUE,
): Promise<string[]> {
  const limit = cat.lanes.L0.follow_up?.overdue.value ?? null;
  if (limit === null) return [];
  const q = await db.query<{ stream: string; occurred_at: Date }>(
    `SELECT stream, occurred_at FROM record.record_event
      WHERE type = $1 AND seq = 1 AND body ->> 'project_id' = $2 AND body -> 'origin' ->> 'edge' = 'R4'`,
    [ITEM_EVENT.created, project_id],
  );
  const out: string[] = [];
  for (const row of q.rows) {
    const r = await db.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
      [row.stream],
    );
    const f = foldItem(r.rows.map(toRecordEvent), pinnedCatalogueResolver);
    if (!f || f.state.terminal !== null) continue;
    const due = addBusinessDays(calendar, new Date(f.state.created_at), limit);
    if (now.getTime() > due.getTime()) out.push(f.state.item_id);
  }
  return out;
}

// ---------------------------------------------------------------- What a new item meets

export type ProjectGuard = Extract<EligibilityReason, 'circuit_breaker' | 'followup_overdue'>;

/**
 * Why a NEW item of `lane` for the project must not start agent work: a tripped breaker (R3) or an
 * overdue hotfix follow-up (R4), or `null`. L8 itself is human work and never blocked; a follow-up
 * item (R4) is exempt from R4 (it ends the block). Fail closed on R3: the stream is read, never guessed.
 */
export async function projectGuard(
  db: Executor,
  o: {
    project_id: string;
    lane: Lane;
    now: Date;
    calendar?: BusinessCalendar;
    origin?: SpawnOrigin | null;
  },
): Promise<ProjectGuard | null> {
  if (o.lane === 'L8') return null;
  const fold = foldBreaker(await readBreakerEvents(db, o.project_id, o.lane));
  if (fold.tripped) return 'circuit_breaker';
  if (o.origin?.edge === 'R4') return null;
  const overdue = await overdueFollowUps(db, o.project_id, o.now, o.calendar);
  return overdue.length > 0 ? 'followup_overdue' : null;
}

/** The 1.4 verdict with the guard applied: a normal route that a guard closes goes to L8. */
export function applyGuard(v: LaneEligibility, guard: ProjectGuard | null): LaneEligibility {
  if (guard === null || v.route !== 'normal') return v;
  return { ...v, eligible: false, route: 'l8', reason: guard };
}
