import {
  ITEM_EVENT,
  ItemCommand,
  WORK_COMMAND_DESTINATION,
  WORK_EVENT,
  WorkRequestedPayload,
  workStream,
  type JsonObject,
  type PrincipalId,
  type ProjectId,
  type StageOutcome,
} from '@aisdlc/contracts';
import {
  openCards,
  readGateState,
  readOpened,
  withdrawGate,
  type DecisionDeps,
} from '@aisdlc/decisions';
import { err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import type { LoopSpec, WorkInFlightPort } from '@aisdlc/loops';
import { WorkInFlightError } from '@aisdlc/loops';
import {
  admitAgentWork,
  type AgentKeyPort,
  type CapacityPort,
  type KillStatePort,
  type StagePorts,
} from '@aisdlc/ports';
import {
  DeferDelivery,
  PermanentDeliveryError,
  dispatchOutbox,
  type OutboxRow,
} from '@aisdlc/record';
import {
  catalogueOfItem,
  itemAgeLimitBd,
  pinnedCatalogueResolver,
  type ItemState,
} from '@aisdlc/work';
import type pg from 'pg';
import type { CoreError } from './errors.js';
import { governingPrr } from './fold.js';
import { inCoreTx, lockKeys, type CoreDeps } from './journal.js';
import { laneEligibility, routeLane } from './lane-eligibility.js';
import { repoIdentity } from './prr-store.js';
import { questionIdOf } from './requests.js';
import {
  WORK_ACTOR,
  ingestItem,
  readItem,
  reconcileItemOutbox,
  type ItemDraft,
} from './work-items.js';
import {
  DEFAULT_WORK_SETTINGS,
  fireTimers,
  releaseAdmissionHolds,
  releaseN8Holds,
  syncMaintenance,
  type WorkSettings,
  workSettings,
} from './work-control.js';
import { applyGuard, projectGuard, recordBreakerSignal, settleBreakerResets } from './breaker.js';
import {
  activeControls,
  clampRoom,
  clampedCapacity,
  controlRefusal,
  syncControlHolds,
} from './controls.js';
import { syncKillHolds } from './kill.js';
import { catchUpWork } from './work-projection.js';
import { dispatchAgent, recordFailure } from './agent-dispatch.js';
import { foldWork, makeItemForRequest, readWork, requestWork } from './work.js';

// The work driver (PLAN M9.2; ADR-0001 "Departure from the runtime review"): what replaces Temporal.
// The interpreter (`@aisdlc/work`) is pure; this is the side that makes it happen, in four moves a
// loop repeats, each of them safe to run twice and none of them holding state of its own:
//
//   1. ensure items   a request that was admitted, or released by an M4, gets its item
//   2. watch gates    a gate instance the item waits on that has left `pending` in the LEDGER
//                     becomes an `item.gate_decided` event (never read from a projection)
//   3. reconcile      the commands the stream says are outstanding are put in the outbox
//   4. dispatch       the outbox is drained: each command is executed through its port, and what
//                     the port answered is committed as an event, which may cause the next command
//
// INBOX FIRST: an event is committed (with its commands in the outbox, in the same transaction)
// before any port is called. IDEMPOTENCY: every command has a key; a port, the decision kernel and
// the event stream each refuse to do or record the same key twice. REBUILD: wipe the outbox, the
// jobs and the read model and the next pass derives it all again from the record (step 3).

export interface WorkDriverDeps {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
  readonly ports: StagePorts;
  /**
   * The decision kernel, to open and withdraw gates. Absent, a command that needs it fails (and is
   * retried with backoff, then dead-lettered): nothing is ever approved without it.
   */
  readonly decisions?: DecisionDeps;
  /** Commands taken from the outbox per claim. */
  readonly batch?: number;
  /** The business calendar of the timers and MM-2 (the config reader's). Default: weekends off, MM-2 off. */
  readonly settings?: () => WorkSettings;
  /** Who says how many HELD items may go on (M9.3). Absent, no held item is ever released by the driver. */
  readonly capacity?: CapacityPort;
  /**
   * The kill switch (M9.6, AR9). With it, no stage command is dispatched for a killed scope, and an
   * unreachable kill switch is a kill (fail closed): `admitAgentWork`. Gate decisions never ask it.
   * core-worker requires it whenever the driver runs; a driver built without one (tests of other
   * things) enforces no kill.
   */
  readonly kill?: KillStatePort;
  /** How long a stage command refused by the kill switch or a control waits before it is offered again (ms). */
  readonly refusedRetryMs?: number;
  /**
   * Where per-Unit virtual keys come from (M11.2: the gateway's admin API). With it, a stage command
   * whose step is agent-acted gets a key minted from the agent's contract (exactly its tools, data class
   * and budget) before the port is called, and no key means no run. core-worker requires it whenever the
   * driver runs; a driver built without one (tests of other things) mints nothing and records `vkey_id: null`.
   */
  readonly keys?: AgentKeyPort;
}

const clockOf = (d: { readonly clock?: Clock }): Clock => d.clock ?? systemClock;
const coreDeps = (d: WorkDriverDeps): CoreDeps => ({
  pool: d.pool,
  ...(d.clock ? { clock: d.clock } : {}),
});

// ---------------------------------------------------------------- 1. ensure items

const ITEM_READY_EVENTS = [WORK_EVENT.admitted, WORK_EVENT.released, WORK_EVENT.routed_l8];

/**
 * Makes the item of every request that has none: those admitted by the minimal intake, those an M4
 * released from the N8 hold, and those routed to L8. The item pins the catalogue and the PRR's
 * gating profile as they are when it is made.
 */
export async function ensureItems(d: WorkDriverDeps): Promise<{ created: string[] }> {
  const q = await d.pool.query<{ request_id: string }>(
    `SELECT DISTINCT e.body ->> 'request_id' AS request_id
       FROM record.record_event e
      WHERE e.type = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM record.record_event m
           WHERE m.type = $2 AND m.body ->> 'request_id' = e.body ->> 'request_id')
      LIMIT 200`,
    [ITEM_READY_EVENTS, WORK_EVENT.item_created],
  );
  const created: string[] = [];
  for (const { request_id } of q.rows) {
    const w = await readWork(d.pool, request_id);
    if (!w || w.item_id !== null) continue;
    if (w.state !== 'admitted' && w.state !== 'released' && w.state !== 'routed_l8') continue;
    const r = await inCoreTx(coreDeps(d), async (j, tx) => {
      const request = w.request;
      await lockKeys(tx, [`repo:${request.repo.toLowerCase()}`, `work:${request_id}`]);
      const cur = foldWork(await j.events(workStream(request_id)));
      if (!cur || cur.item_id !== null) return ok(null);
      const id = await repoIdentity(tx, request.repo);
      if (!id) return ok(null);
      const prr = governingPrr(await j.prr(id.project_id, id.repo_id));
      const verdict = applyGuard(
        routeLane(request.repo, request.lane, prr, clockOf(d).now()),
        await projectGuard(tx, {
          project_id: id.project_id,
          lane: request.lane,
          now: clockOf(d).now(),
          calendar: workSettings(d).calendar,
          origin: null,
        }),
      );
      if (verdict.route === 'n8_hold') return ok(null);
      const made = await makeItemForRequest(j, tx, coreDeps(d), {
        request: WorkRequestedPayload.parse(request),
        prr,
        lane: request.lane,
        verdict,
        text: request.request_text ?? null,
        actor: WORK_ACTOR,
      });
      return made.ok ? ok(made.value.item_id) : made;
    });
    if (!r.ok) throw new Error(r.error.message);
    if (r.value) created.push(r.value);
  }
  return { created };
}

// ---------------------------------------------------------------- 2. watch gates

/**
 * Reads, from the ledger, every gate instance the item waits on, and records the ones that are no
 * longer pending. A decision is only ever learned from the ledger entries (`readGateState` folds
 * them): the read model of gates is not consulted on this path.
 */
export async function watchGates(d: WorkDriverDeps, itemId: string): Promise<number> {
  const item = await readItem(d.pool, itemId);
  if (!item || item.state.terminal !== null) return 0;
  let recorded = 0;
  for (const g of item.state.gates.filter((x) => x.status === 'pending')) {
    const gs = await readGateState(d.pool, g.gate_instance_id);
    if (!gs || gs.status === 'pending') continue;
    const outcome =
      gs.status === 'decided'
        ? (gs.outcome ?? 'reject') // a decided gate always has an outcome; none is a refusal
        : gs.status; // expired, superseded, closed
    const entry = gs.decisions.find((x) => x.ledger_seq === gs.ended_ledger_seq)?.entry_id ?? null;
    const w = await ingestItem(coreDeps(d), itemId, {
      type: ITEM_EVENT.gate_decided,
      payload: {
        gate_instance_id: g.gate_instance_id,
        gate: g.gate,
        outcome,
        ledger_entry_id: entry,
      },
      actor: WORK_ACTOR,
      idempotency_key: `decided:${g.gate_instance_id}`,
    });
    if (!w.ok) throw new Error(w.error.message);
    if (!w.value.duplicate) recorded += 1;
  }
  return recorded;
}

// ---------------------------------------------------------------- 4. execute a command

interface CommandRow {
  readonly item_id: string;
  readonly command: ItemCommand;
}

const parseRow = (row: OutboxRow): CommandRow => {
  const p = row.payload as { item_id?: unknown; command?: unknown };
  const command = ItemCommand.safeParse(p.command);
  if (typeof p.item_id !== 'string' || !command.success) {
    throw new PermanentDeliveryError('the outbox row is not a work command');
  }
  return { item_id: p.item_id, command: command.data };
};

const must = <T>(r: Result<T, CoreError>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

function resultDraft(
  state: ItemState,
  c: Extract<ItemCommand, { type: 'run_stage' }>,
  out: StageOutcome,
): ItemDraft {
  const key = `result:${c.key}`;
  switch (out.outcome) {
    case 'completed':
      return {
        type: ITEM_EVENT.stage_completed,
        actor: WORK_ACTOR,
        idempotency_key: key,
        payload: {
          command_key: c.key,
          step: c.step,
          output_hash: out.output_hash,
          ...(out.lease_epoch ? { lease_epoch: out.lease_epoch } : {}),
          ...(out.assumptions ? { assumptions: out.assumptions } : {}),
        },
      };
    case 'held':
      return {
        type: ITEM_EVENT.stage_held,
        actor: WORK_ACTOR,
        idempotency_key: key,
        payload: { command_key: c.key, step: c.step, reason: out.reason },
      };
    case 'rework':
      return {
        type: ITEM_EVENT.rework_requested,
        actor: WORK_ACTOR,
        idempotency_key: key,
        payload: {
          command_key: c.key,
          step: c.step,
          edge: out.edge,
          ...(out.variant ? { variant: out.variant } : {}),
          ...(out.loop ? { loop: out.loop } : {}),
          ...(out.observed !== undefined ? { observed: out.observed } : {}),
          reason_code: out.reason_code,
        },
      };
    case 'relane':
      return {
        type: ITEM_EVENT.relane_requested,
        actor: WORK_ACTOR,
        idempotency_key: key,
        payload: {
          command_key: c.key,
          step: c.step,
          edge: out.edge,
          trigger: out.trigger,
          to_lane: out.to_lane,
          reason_code: out.reason_code,
        },
      };
    case 'trigger':
      return {
        type: ITEM_EVENT.trigger_fired,
        actor: WORK_ACTOR,
        idempotency_key: key,
        payload: {
          command_key: c.key,
          step: c.step,
          trigger: out.trigger,
          reason_code: out.reason_code,
        },
      };
    case 'classified':
      return {
        type: ITEM_EVENT.stage_completed,
        actor: WORK_ACTOR,
        idempotency_key: key,
        payload: {
          command_key: c.key,
          step: c.step,
          output_hash: out.output_hash,
          lane: out.lane,
        },
      };
    case 'questions':
      return {
        type: ITEM_EVENT.questions_raised,
        actor: WORK_ACTOR,
        idempotency_key: key,
        payload: {
          command_key: c.key,
          step: c.step,
          round: state.rounds + 1,
          questions: out.questions.map((q, i) => ({
            question_id: questionIdOf(c.key, i),
            text: q.text,
            material: q.material,
          })),
        },
      };
    case 'gate_needed':
      return {
        type: ITEM_EVENT.stage_gate_needed,
        actor: WORK_ACTOR,
        idempotency_key: key,
        payload: {
          command_key: c.key,
          step: c.step,
          gate: out.gate,
          reason_code: out.reason_code,
        },
      };
    case 'failed':
      return {
        type: ITEM_EVENT.stage_failed,
        actor: WORK_ACTOR,
        idempotency_key: key,
        payload: { command_key: c.key, step: c.step, code: out.code },
      };
  }
}

/**
 * Executes one command of an item. It does nothing for a command the stream no longer lists as
 * outstanding (it was answered, or the item ended): that is what makes a redelivery harmless. It
 * throws when the work could not be done or recorded, and the outbox delivers the same command (same
 * key) again after a backoff.
 */
export async function executeCommand(d: WorkDriverDeps, row: OutboxRow): Promise<void> {
  const { item_id, command: c } = parseRow(row);
  const item = await readItem(d.pool, item_id);
  if (!item || !item.state.outstanding.some((x) => x.key === c.key)) return;
  const s = item.state;
  const cd = coreDeps(d);

  switch (c.type) {
    case 'run_stage': {
      // AR9: agent work is admitted only while the kill switch answers and says no kill covers it. The
      // command is DEFERRED, not failed: it waits untouched (no attempt counted, never dead-lettered)
      // and goes out when the kill is released, in the same order.
      if (d.kill) {
        const a = await admitAgentWork(d.kill, { project_id: s.project_id, lane: c.lane });
        if (!a.admitted)
          throw new DeferDelivery(`agent work refused: ${a.message}`, d.refusedRetryMs ?? 15_000);
      }
      // Controls (M9.6): a hold or maintenance control stops every stage command in its scope, a halt
      // the release steps; a clamp limits how many sessions 6.0 admits. Deferred like a kill.
      const controls = await activeControls(d.pool, clockOf(d).now());
      const scope = { project_id: s.project_id, lane: c.lane };
      const stop = controlRefusal(controls, scope, c.port);
      if (stop) {
        throw new DeferDelivery(
          `held by control ${stop.kind} ${stop.control_id}`,
          d.refusedRetryMs ?? 15_000,
        );
      }
      if (c.step === '6.0') {
        const clamp = await clampRoom(d.pool, controls, scope);
        if (clamp !== null && clamp.room <= 0) {
          // no room: the admission says HELD (WIP), as the port itself would; the release loop frees it
          must(
            await ingestItem(cd, item_id, resultDraft(s, c, { outcome: 'held', reason: 'WIP' })),
          );
          return;
        }
      }
      // M11.2: the agent that acts at this step, its key minted from its contract, recorded before the call
      const bound = await dispatchAgent({ ...cd, ...(d.keys ? { keys: d.keys } : {}) }, s, c);
      if (!bound.ok) throw new Error(bound.error.message);
      const agent = bound.value;
      const port = d.ports[c.port];
      const r = await port.run({
        command_key: c.key,
        item_id: s.item_id as never,
        project_id: s.project_id as never,
        repo: s.repo as never,
        lane: c.lane,
        step: c.step,
        attempt: c.attempt,
        approved_gates: c.approved_gates,
        denied_gates: c.denied_gates,
        catalogue_ref: s.catalogue_ref,
        ...(agent ? { agent } : {}),
      });
      if (!r.ok) {
        if (agent) await recordFailure(cd, s, c, agent, 'port_error', r.error.message);
        throw new Error(`${c.port} port: ${r.error.message}`);
      }
      must(await ingestItem(cd, item_id, resultDraft(s, c, r.value)));
      return;
    }

    case 'check_eligibility': {
      const base = await laneEligibility(
        d.pool,
        s.repo,
        c.lane,
        clockOf(d),
        catalogueOfItem(s).eligibility,
      );
      // R3 and R4: a tripped breaker or an overdue hotfix follow-up sends a NEW item to L8. The same
      // check also answers R1 ("may this project run the lane the work needs"), which is no new item.
      const v = c.key.includes('/relane/')
        ? base
        : applyGuard(
            base,
            await projectGuard(d.pool, {
              project_id: s.project_id,
              lane: c.lane,
              now: clockOf(d).now(),
              calendar: workSettings(d).calendar,
              origin: s.origin,
            }),
          );
      must(
        await ingestItem(cd, item_id, {
          type: ITEM_EVENT.eligibility_checked,
          actor: WORK_ACTOR,
          idempotency_key: `result:${c.key}`,
          payload: {
            command_key: c.key,
            lane: c.lane,
            route: v.route,
            eligible: v.eligible,
            reason: v.reason,
            prr_version: v.prr?.version ?? null,
          },
        }),
      );
      return;
    }

    case 'open_gates': {
      if (!d.decisions) throw new Error('the decision kernel is not configured: gates cannot open');
      const cards = await openCards(d.decisions, {
        project_id: s.project_id as ProjectId,
        requester: s.requester as PrincipalId,
        subject_kind: 'item',
        subject_id: s.item_id,
        gates: c.gates.map((g) => ({
          gate_id: g,
          subject_hash: c.subject_hash,
          facts: c.facts as JsonObject,
        })),
      });
      if (!cards.ok) throw new Error(`${cards.error.code}: ${cards.error.message}`);
      const gates: Array<{ gate: (typeof c.gates)[number]; gate_instance_id: string }> = [];
      for (const card of cards.value) {
        for (const id of card.gate_instance_ids) {
          const opened = await readOpened(d.pool, id);
          if (!opened) throw new Error(`gate ${id} has no open event`);
          gates.push({ gate: opened.payload.gate_id, gate_instance_id: id });
        }
      }
      must(
        await ingestItem(cd, item_id, {
          type: ITEM_EVENT.gates_opened,
          actor: WORK_ACTOR,
          idempotency_key: `opened:${c.key}`,
          payload: {
            command_key: c.key,
            gates,
            card_ids: cards.value.map((x) => x.card_id),
            subject_hash: c.subject_hash,
          },
        }),
      );
      return;
    }

    case 'withdraw_gates': {
      if (!d.decisions)
        throw new Error('the decision kernel is not configured: gates cannot close');
      for (const id of c.gate_instance_ids) {
        const w = await withdrawGate(d.decisions, {
          gate_instance_id: id,
          actor: 'system.gate',
          reason: c.reason,
        });
        // Already ended (decided, expired, withdrawn) is the state we want.
        if (!w.ok && w.error.code !== 'gate_not_pending' && w.error.code !== 'gate_not_found') {
          throw new Error(`${w.error.code}: ${w.error.message}`);
        }
      }
      must(
        await ingestItem(cd, item_id, {
          type: ITEM_EVENT.command_done,
          actor: WORK_ACTOR,
          idempotency_key: `done:${c.key}`,
          payload: { command_key: c.key },
        }),
      );
      return;
    }

    case 'breaker_signal': {
      // One count toward the ET14 breaker of this item's project and lane (R3). Appended under the
      // command's key, so a redelivery counts once; then the item is told it was carried out.
      must(
        await recordBreakerSignal(cd, {
          project_id: s.project_id,
          lane: c.lane,
          source: c.source,
          item_id: s.item_id,
          signal_key: c.key,
        }),
      );
      must(
        await ingestItem(cd, item_id, {
          type: ITEM_EVENT.command_done,
          actor: WORK_ACTOR,
          idempotency_key: `done:${c.key}`,
          payload: { command_key: c.key },
        }),
      );
      return;
    }

    case 'spawn_item': {
      // A NEW linked item (B16-B19, RELHOLD, R4): its own request on the factory-raised channel N6,
      // its own item, pinned to the PRR and profile as they are now; the origin keeps the SpawnLink.
      const r = await requestWork(cd, {
        project_id: s.project_id as ProjectId,
        repo: s.repo,
        lane: c.lane,
        requester: s.requester as PrincipalId,
        channel: 'N6',
        request_id: `spawn:${c.key}`,
        create_item: true,
        origin: {
          origin_item_id: s.item_id as never,
          origin_seq: c.origin_seq,
          index: c.index,
          edge: c.edge,
          kind: c.kind,
        },
      });
      const made = must(r);
      if (made.item_id === null || made.item_id === undefined) {
        throw new Error(`the linked request is ${made.state} and has no item yet`);
      }
      must(
        await ingestItem(cd, item_id, {
          type: ITEM_EVENT.spawned,
          actor: WORK_ACTOR,
          idempotency_key: `spawned:${c.key}`,
          payload: {
            command_key: c.key,
            link: {
              item_id: made.item_id,
              origin_item_id: s.item_id,
              origin_seq: c.origin_seq,
              index: c.index,
              edge: c.edge,
              kind: c.kind,
              lane: c.lane,
              status: 'open',
            },
          },
        }),
      );
      return;
    }
  }
}

// ---------------------------------------------------------------- One pass

export interface WorkPassReport {
  readonly items_created: number;
  readonly gates_recorded: number;
  readonly enqueued: number;
  /** MM-2: items put under, or released from, the maintenance hold. */
  readonly maintenance_holds: number;
  readonly timers_fired: number;
  readonly holds_released: number;
  /** M9.6: items put under, or released from, a `kill` hold. */
  readonly kill_holds: number;
  /** Commands the kill switch (or a control) made wait this pass. */
  readonly deferred: number;
  /** The maintenance flag was on during the pass. */
  readonly maintenance: boolean;
  readonly dispatched: number;
  readonly failed: number;
  readonly dead: number;
}

/** What the read model says of an item the driver looks at: enough to know which items need a closer look. */
export interface DriverRow {
  readonly item_id: string;
  readonly terminal: string | null;
  readonly holds: number;
  readonly underlying: string;
  readonly created_at: Date;
  readonly catalogue_version: string;
  readonly catalogue_hash: string;
}

/** The items the driver looks at: active ones, and finished ones that still have a command out. */
export async function driverItemRows(pool: pg.Pool): Promise<DriverRow[]> {
  await catchUpWork(pool);
  const q = await pool.query<DriverRow>(
    `SELECT item_id, terminal, holds, underlying, created_at, catalogue_version, catalogue_hash
       FROM core.work_item
      WHERE terminal IS NULL OR outstanding > 0 ORDER BY created_at, item_id`,
  );
  return q.rows;
}

export async function driverItemIds(pool: pg.Pool): Promise<string[]> {
  return (await driverItemRows(pool)).map((r) => r.item_id);
}

/**
 * One pass of the four moves. `rounds` bounds how often the outbox is drained in a pass (a result
 * causes the next command, which the next round delivers).
 */
export async function driveWork(
  d: WorkDriverDeps,
  o: { readonly onItemError?: (item: string, e: unknown) => void; readonly rounds?: number } = {},
): Promise<WorkPassReport> {
  const settings = (d.settings ?? (() => DEFAULT_WORK_SETTINGS))();
  const mm = settings.maintenance();
  // MM-2: no new item is made while it is on (the request waits, admitted); everything already in
  // flight is held, its timers frozen, its drafts kept.
  const created = mm ? { created: [] as string[] } : await ensureItems(d);
  const rows = await driverItemRows(d.pool);
  const ids = rows.map((r) => r.item_id);
  const active = rows.filter((r) => r.terminal === null);
  let gates_recorded = 0;
  let enqueued = 0;
  let maintenance_holds = 0;
  let timers_fired = 0;
  let holds_released = 0;
  let kill_holds = 0;
  if (d.kill) {
    try {
      // A kill is a hold on the items it covers (and its release lifts it), whether or not MM-2 is on.
      const k = await syncKillHolds(
        { ...coreDeps(d), kill: d.kill },
        active.map((r) => r.item_id),
      );
      kill_holds = k.placed + k.released;
    } catch (e) {
      if (o.onItemError) o.onItemError('kill', e);
      else throw e;
    }
  }
  try {
    // Operator controls (hold, maintenance) are holds on the items their scope covers.
    const c = await syncControlHolds(
      coreDeps(d),
      active.map((r) => r.item_id),
    );
    kill_holds += c.placed + c.released;
  } catch (e) {
    if (o.onItemError) o.onItemError('controls', e);
    else throw e;
  }
  try {
    // Only items that can change need a closer look: with MM-2 off, the ones that carry a hold.
    const m = await syncMaintenance(
      d,
      (mm ? active : active.filter((r) => r.holds > 0)).map((r) => r.item_id),
      mm,
    );
    maintenance_holds = m.placed + m.released;
  } catch (e) {
    if (o.onItemError) o.onItemError('maintenance', e);
    else throw e;
  }
  if (!mm) {
    try {
      // A timer is due for an item that is parked or clarifying, or that is old enough that its age
      // limit may have passed (the limit's business days are at least as many calendar days).
      // The limit is the one of the catalogue the item pinned, not the current one.
      const nowMs = clockOf(d).nowMs();
      const ageOf = (r: DriverRow): number | null => {
        const cat = pinnedCatalogueResolver({
          version: r.catalogue_version,
          hash: r.catalogue_hash,
        });
        return cat === null ? null : itemAgeLimitBd(cat);
      };
      const timed = active.filter((r) => {
        const ageDays = ageOf(r);
        return (
          r.underlying === 'Parked' ||
          r.underlying === 'Clarifying' ||
          ageDays === null ||
          r.created_at.getTime() <= nowMs - ageDays * 86_400_000
        );
      });
      timers_fired = (
        await fireTimers(
          d,
          timed.map((r) => r.item_id),
        )
      ).fired;
      const held = active.filter((r) => r.holds > 0).map((r) => r.item_id);
      holds_released =
        (await releaseN8Holds(d, held)).released.length +
        (
          await releaseAdmissionHolds(
            {
              ...d,
              ...(d.capacity
                ? { capacity: clampedCapacity(d.pool, d.capacity, clockOf(d)) as CapacityPort }
                : {}),
            },
            held,
          )
        ).released.length;
      // R3: a reset gate (M5) that was decided in the ledger clears its breaker.
      if (d.decisions) await settleBreakerResets({ ...coreDeps(d), decisions: d.decisions });
    } catch (e) {
      if (o.onItemError) o.onItemError('control', e);
      else throw e;
    }
  }
  for (const id of ids) {
    try {
      gates_recorded += await watchGates(d, id);
      const r = await reconcileItemOutbox(coreDeps(d), id);
      enqueued += must(r).enqueued;
    } catch (e) {
      if (o.onItemError) o.onItemError(id, e);
      else throw e;
    }
  }
  let dispatched = 0;
  let failed = 0;
  let dead = 0;
  let deferred = 0;
  for (let round = 0; round < (o.rounds ?? 20); round++) {
    const out = await dispatchOutbox(
      d.pool,
      WORK_COMMAND_DESTINATION,
      d.batch ?? 20,
      (row) => executeCommand(d, row),
      { clock: clockOf(d) },
    );
    dispatched += out.dispatched;
    failed += out.failed;
    dead += out.dead;
    deferred += out.deferred ?? 0;
    if (out.dispatched === 0) break;
  }
  return {
    items_created: created.created.length,
    gates_recorded,
    enqueued,
    maintenance_holds,
    timers_fired,
    holds_released,
    kill_holds,
    deferred,
    maintenance: mm,
    dispatched,
    failed,
    dead,
  };
}

// ---------------------------------------------------------------- The loop

export interface WorkDriverLoopOptions {
  readonly intervalMs?: number;
  readonly startDelayMs?: number;
  readonly onPass?: (r: WorkPassReport) => void;
}

export const WORK_DRIVER_INTERVAL_MS = 5_000;

/** The `work_driver` loop hosted by core-worker. */
export function workDriverLoop(d: WorkDriverDeps, o: WorkDriverLoopOptions = {}): LoopSpec {
  const intervalMs = o.intervalMs ?? WORK_DRIVER_INTERVAL_MS;
  return {
    name: 'work_driver',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick(ctx) {
      let failedItems = 0;
      const r = await driveWork(d, {
        onItemError: (item, e) => {
          failedItems += 1;
          ctx.log.warn('item failed', { item, error: e instanceof Error ? e.message : String(e) });
        },
      });
      o.onPass?.(r);
      // A command that failed (and will be retried) counts, so a stuck port shows on /healthz.
      return { ok: r.dispatched, failed: r.failed + r.dead + failedItems };
    },
  };
}

// ---------------------------------------------------------------- WorkInFlightPort

/**
 * The real `WorkInFlightPort` (PLAN M9.2, replacing the M5.4 fake): a repo has agent work in flight
 * when one of its items is in S6 or S7 with an open lease or an agent session (a coding or verify
 * command out). Read from the `work_item` read model, caught up first. An error is never "no
 * work": the poll loop then polls at the faster rate.
 */
export class DbWorkInFlight implements WorkInFlightPort {
  constructor(private readonly pool: pg.Pool) {}

  async hasWorkInFlight(repo: string) {
    try {
      await catchUpWork(this.pool);
      const q = await this.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM core.work_item
          WHERE repo_key = $1 AND terminal IS NULL AND in_flight`,
        [repo.toLowerCase()],
      );
      return ok(Number(q.rows[0]?.n ?? 0) > 0);
    } catch (e) {
      return err(WorkInFlightError({ message: e instanceof Error ? e.message : String(e) }));
    }
  }
}
