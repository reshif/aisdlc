import {
  ADMISSION_HOLD_PREFIX,
  ITEM_EVENT,
  LaneValues,
  MAINTENANCE_HOLD_ID,
  MAINTENANCE_HOLD_ORIGIN,
  S0Calendar,
  S0_CONFIG_KEYS,
  S0_DEFAULT_CALENDAR,
  type AdmissionHold,
} from '@aisdlc/contracts';
import type { ConfigReader } from '@aisdlc/config';
import { addBusinessDays, businessCalendar, type BusinessCalendar } from '@aisdlc/decisions';
import { systemClock, type Clock } from '@aisdlc/kernel';
import type { CapacityPort } from '@aisdlc/ports';
import {
  catalogueOfItem,
  pinnedCatalogueResolver,
  itemAgeLimitBd,
  parkBusinessDays,
  type ItemState,
} from '@aisdlc/work';
import type pg from 'pg';
import { laneEligibility } from './lane-eligibility.js';
import { maintenanceFrom } from './settings.js';
import { WORK_ACTOR, ingestItem, readItem, readItemEvents } from './work-items.js';

// What the work driver does besides executing commands (PLAN M9.3): MM-2 maintenance, the business-day
// timers (PARK, clarifying silence, item age), the release of HELD items in FIFO order by priority, and
// the release of N8 when an M4 makes a PRR active. Each is a function of the record alone and safe to
// run twice: every signal it writes has an idempotency key, and none of them holds state of its own.

export interface WorkSettings {
  /** The calendar the timers count business days on (the S0 calendar: one calendar for the factory). */
  readonly calendar: BusinessCalendar;
  /** MM-2 is on. */
  readonly maintenance: () => boolean;
}

export const DEFAULT_WORK_SETTINGS: WorkSettings = {
  calendar: businessCalendar({
    weekend: S0_DEFAULT_CALENDAR.weekend,
    holidays: S0_DEFAULT_CALENDAR.holidays,
    utcOffsetMinutes: S0_DEFAULT_CALENDAR.utc_offset_minutes,
  }),
  maintenance: () => false,
};

/** The settings in force from a config reader: the S0 calendar (a value that no longer fits keeps the default), and MM-2. */
export function workSettingsFrom(reader: ConfigReader): () => WorkSettings {
  const maintenance = maintenanceFrom(reader);
  return () => {
    const cal = S0Calendar.safeParse(reader.current().get(S0_CONFIG_KEYS.calendar));
    return {
      maintenance,
      calendar: cal.success
        ? businessCalendar({
            weekend: cal.data.weekend,
            holidays: cal.data.holidays,
            utcOffsetMinutes: cal.data.utc_offset_minutes,
          })
        : DEFAULT_WORK_SETTINGS.calendar,
    };
  };
}

export interface ControlDeps {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
  readonly settings?: () => WorkSettings;
  readonly capacity?: CapacityPort;
}

const clockOf = (d: ControlDeps): Clock => d.clock ?? systemClock;
export const workSettings = (d: ControlDeps): WorkSettings =>
  (d.settings ?? (() => DEFAULT_WORK_SETTINGS))();
const coreDeps = (d: ControlDeps) => ({ pool: d.pool, ...(d.clock ? { clock: d.clock } : {}) });

// ---------------------------------------------------------------- MM-2

/**
 * Maintenance mode MM-2 as holds: while the flag is on, every active item carries the `mm2` hold (reason
 * `maintenance`), so nothing new starts for it and the interpreter keeps counting the time it spent
 * frozen; when the flag goes off the holds are released and every item resumes the phase it was in.
 * Drafts (open gates, prepared decisions) are untouched. A signal per (item, nth maintenance) is
 * idempotent.
 */
export async function syncMaintenance(
  d: ControlDeps,
  itemIds: readonly string[],
  on: boolean,
): Promise<{ placed: number; released: number }> {
  let placed = 0;
  let released = 0;
  for (const id of itemIds) {
    const item = await readItem(d.pool, id);
    if (!item || item.state.terminal !== null) continue;
    const has = item.state.holds.some((h) => h.hold_id === MAINTENANCE_HOLD_ID);
    if (on === has) continue;
    const events = await readItemEvents(d.pool, id);
    const nth = events.filter(
      (e) =>
        e.type === ITEM_EVENT.hold_placed &&
        (e.payload as { hold_id?: string }).hold_id === MAINTENANCE_HOLD_ID,
    ).length;
    const w = await ingestItem(
      coreDeps(d),
      id,
      on
        ? {
            type: ITEM_EVENT.hold_placed,
            payload: {
              hold_id: MAINTENANCE_HOLD_ID,
              reason: 'maintenance',
              origin: MAINTENANCE_HOLD_ORIGIN,
            },
            actor: WORK_ACTOR,
            idempotency_key: `mm2:placed:${nth + 1}`,
          }
        : {
            type: ITEM_EVENT.hold_released,
            payload: { hold_id: MAINTENANCE_HOLD_ID },
            actor: WORK_ACTOR,
            idempotency_key: `mm2:released:${nth}`,
          },
    );
    if (!w.ok) throw new Error(w.error.message);
    if (!w.value.duplicate) {
      if (on) placed += 1;
      else released += 1;
    }
  }
  return { placed, released };
}

// ---------------------------------------------------------------- Timers

/** The ms the item was frozen (MM-2) since a timer's base. */
const frozenSince = (s: ItemState, base: number): number => s.clock.frozen_ms - base;

/**
 * The business-day timers of the item: PARK (5 bd: Parked -> Abandoned), the silence of a requester who
 * was asked (Clarifying -> Parked, by the same B1 limit) and the item's age (B28: straight to E4). The
 * deadline is the start plus the catalogue's business days on the calendar, plus the time frozen by
 * MM-2 since the start; the event carries it, so the fold stays a function of the stream. A frozen
 * item (MM-2 on) fires nothing.
 */
export async function fireTimers(
  d: ControlDeps,
  itemIds: readonly string[],
): Promise<{ fired: number }> {
  const cfg = workSettings(d);
  const now = clockOf(d).now();
  let fired = 0;
  for (const id of itemIds) {
    const item = await readItem(d.pool, id);
    if (!item) continue;
    const s = item.state;
    if (s.terminal !== null || s.clock.frozen_since !== null) continue;
    const cat = pinnedCatalogueResolver(s.catalogue_ref);
    if (cat === null) continue;
    const due = (since: string, bd: number | null, frozen: number): Date | null =>
      bd === null
        ? null
        : new Date(addBusinessDays(cfg.calendar, new Date(since), bd).getTime() + frozen);
    const fire = async (
      timer: 'park' | 'clarify_silence' | 'item_age',
      since: string,
      dueAt: Date | null,
      frozen: number,
    ) => {
      if (dueAt === null || now < dueAt) return;
      const w = await ingestItem(coreDeps(d), id, {
        type: ITEM_EVENT.timer_fired,
        payload: { timer, since, due_at: dueAt.toISOString(), frozen_ms: frozen },
        actor: WORK_ACTOR,
        idempotency_key: `timer:${timer}:${since}:${frozen}`,
      });
      if (!w.ok) throw new Error(w.error.message);
      if (!w.value.duplicate) fired += 1;
    };
    if (s.underlying === 'Parked' && s.park !== null) {
      const f = frozenSince(s, s.park.frozen_base);
      await fire('park', s.park.since, due(s.park.since, parkBusinessDays(cat), f), f);
    } else if (s.underlying === 'Clarifying' && s.clarify !== null) {
      const f = frozenSince(s, s.clarify.frozen_base);
      await fire(
        'clarify_silence',
        s.clarify.since,
        due(s.clarify.since, parkBusinessDays(cat), f),
        f,
      );
    }
    if (!s.clock.age_exceeded) {
      await fire(
        'item_age',
        s.created_at,
        due(s.created_at, itemAgeLimitBd(cat), s.clock.frozen_ms),
        s.clock.frozen_ms,
      );
    }
  }
  return { fired };
}

// ---------------------------------------------------------------- Holds

/** Lower is sooner: the lane's place in the catalogue's order (L0 hotfix first). */
export const lanePriority = (lane: string): number => LaneValues.indexOf(lane as never);

const ADMISSION_REASONS: readonly AdmissionHold[] = ['H1', 'H2', 'H3', 'WIP'];

/**
 * Releases the items HELD at admission (H1 approver pool, H2 capacity, H3 environment, WIP): FIFO by
 * priority, strictly: per reason the items are ordered by lane priority, then by when they were held,
 * and the capacity port is asked for one item at a time in that order; the first refusal (or an
 * error) stops that reason, so no later item overtakes an earlier one. A released item asks for
 * admission again at its next attempt. Only holds the engine placed at admission are released: a kill
 * or MM-2 hold is never touched.
 */
export async function releaseAdmissionHolds(
  d: ControlDeps,
  itemIds: readonly string[],
): Promise<{ released: string[] }> {
  if (!d.capacity) return { released: [] };
  const held: Array<{
    id: string;
    reason: AdmissionHold;
    hold_id: string;
    placed_at: string;
    priority: number;
    project_id: string;
    repo: string;
  }> = [];
  for (const id of itemIds) {
    const item = await readItem(d.pool, id);
    if (!item || item.state.terminal !== null) continue;
    for (const h of item.state.holds) {
      if (!h.hold_id.startsWith(ADMISSION_HOLD_PREFIX)) continue;
      if (!(ADMISSION_REASONS as readonly string[]).includes(h.reason)) continue;
      held.push({
        id,
        reason: h.reason as AdmissionHold,
        hold_id: h.hold_id,
        placed_at: h.placed_at,
        priority: lanePriority(item.state.lane ?? item.state.proposed_lane),
        project_id: item.state.project_id,
        repo: item.state.repo,
      });
    }
  }
  const released: string[] = [];
  for (const reason of ADMISSION_REASONS) {
    const queue = held
      .filter((h) => h.reason === reason)
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          Date.parse(a.placed_at) - Date.parse(b.placed_at) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    for (const h of queue) {
      const got = await d.capacity.take(reason, { project_id: h.project_id, repo: h.repo }, 1);
      if (!got.ok || got.value < 1) break;
      const w = await ingestItem(coreDeps(d), h.id, {
        type: ITEM_EVENT.hold_released,
        payload: { hold_id: h.hold_id },
        actor: WORK_ACTOR,
        idempotency_key: `released:${h.hold_id}`,
      });
      if (!w.ok) throw new Error(w.error.message);
      released.push(h.id);
    }
  }
  return { released };
}

/**
 * N8 (no active Project Readiness Record) is released when the repo has one: the M4 that activates a
 * PRR lets the held item go on, and its 1.4 runs again against the record that is now active.
 */
export async function releaseN8Holds(
  d: ControlDeps,
  itemIds: readonly string[],
): Promise<{ released: string[] }> {
  const released: string[] = [];
  for (const id of itemIds) {
    const item = await readItem(d.pool, id);
    if (!item || item.state.terminal !== null) continue;
    for (const h of item.state.holds.filter((x) => x.reason === 'N8')) {
      const v = await laneEligibility(
        d.pool,
        item.state.repo,
        item.state.proposed_lane,
        clockOf(d),
        catalogueOfItem(item.state).eligibility,
      );
      if (v.route === 'n8_hold') continue;
      const w = await ingestItem(coreDeps(d), id, {
        type: ITEM_EVENT.hold_released,
        payload: { hold_id: h.hold_id },
        actor: WORK_ACTOR,
        idempotency_key: `released:${h.hold_id}`,
      });
      if (!w.ok) throw new Error(w.error.message);
      released.push(id);
    }
  }
  return { released };
}
