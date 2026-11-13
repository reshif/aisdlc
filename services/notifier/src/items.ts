import type { CatalogueData } from '@aisdlc/catalogue';
import {
  ITEM_EVENT,
  ItemCreatedPayload,
  S0_DEFAULT_CALENDAR,
  type NotificationContent,
  type PrincipalId,
  type ProjectId,
  type RecordEvent,
  type WorkItemId,
} from '@aisdlc/contracts';
import { addBusinessDays, businessCalendar, type BusinessCalendar } from '@aisdlc/decisions';
import {
  interpret,
  limitValue,
  parkBusinessDays,
  parseItemEvent,
  pinnedCatalogueResolver,
  type CatalogueResolver,
  type ItemState,
} from '@aisdlc/work';
import type { Audience, NotificationIntent } from './sources.js';

// What the factory needs from a requester, and what an item's owners must know (RC-HAI-2, RC-NOT-1), as a pure
// function of an item's state before and after ONE of its events. The state is the work engine's own fold
// (`interpret` over the item's stream, under the catalogue the item pinned), so the notifier says exactly what the
// item page says it waits for; it decides nothing and moves nothing.
//
//   waits for answers (1.5)          questions_waiting   the requester, with the rounds left (B1) and the PARK date
//   waits for Ready (1.6)            ready_waiting       the requester
//   waits for G6                     acceptance_waiting  the requester
//   PARKED (B1)                      item_parked         the requester, with the date it is abandoned
//   a handoff opened (D1, D2, D3)    handoff             the requester (the E4 gate's slot is told by gate.opened)
//   RELEASE HELD (B26)               release_failed      the requester and the project's admins
//   Done                             item_done           the requester and the project's admins
//   any other terminal               item_ended          the requester and the project's admins

/**
 * The calendar the PARK and ABANDON dates are computed on: the factory's default (Saturday and Sunday off, UTC). A
 * configured holiday only moves the real deadline later, so the date said is never later than the real one.
 */
export const NOTIFIER_CALENDAR: BusinessCalendar = businessCalendar({
  weekend: S0_DEFAULT_CALENDAR.weekend,
  holidays: S0_DEFAULT_CALENDAR.holidays,
  utcOffsetMinutes: S0_DEFAULT_CALENDAR.utc_offset_minutes,
});

const base = (s: ItemState, kind: NotificationContent['kind']): NotificationContent => ({
  kind,
  project_id: s.project_id as ProjectId,
  gate_id: null,
  gate_instance_id: null,
  card_id: null,
  kill_id: null,
  due_at: null,
  link_path: `/items/${s.item_id}`,
  item_id: s.item_id as WorkItemId,
});

const requester = (s: ItemState): Audience => ({
  kind: 'principals',
  principals: [s.requester as PrincipalId],
  slot: 'requesters',
  reason: 'requester',
});
const owners = (s: ItemState): Audience[] => [
  requester(s),
  { kind: 'slot', project: s.project_id as ProjectId, slot: 'admin', reason: 'project_admin' },
];

const intent = (content: NotificationContent, audiences: Audience[]): NotificationIntent => ({
  content,
  audiences,
  gate_instance_id: null,
});

function deadline(since: string | undefined, bd: number | null, cal: BusinessCalendar) {
  if (since === undefined || bd === null) return null;
  return addBusinessDays(cal, new Date(since), bd).toISOString();
}

const waitingKind = (s: ItemState | null): string | null => s?.waiting?.kind ?? null;
const waitsFor = (s: ItemState | null, what: string): boolean =>
  s?.waiting?.kind === 'human' && s.waiting.what === what;
const waitsOnGate = (s: ItemState | null, gate: string): boolean =>
  s?.waiting?.kind === 'gates' && s.waiting.gates.includes(gate as never);
const questionIds = (s: ItemState | null): string =>
  s?.waiting?.kind === 'questions' ? [...s.waiting.ids].sort().join(',') : '';

/** The notifications one item event asks for: what the item newly waits for from a person, or that it ended. */
export function itemIntents(
  before: ItemState | null,
  after: ItemState,
  cat: CatalogueData,
  cal: BusinessCalendar = NOTIFIER_CALENDAR,
): NotificationIntent[] {
  const out: NotificationIntent[] = [];
  if (after.terminal !== null) {
    if (before === null || before.terminal === null) {
      const done = after.terminal === 'Done';
      out.push(
        intent(
          { ...base(after, done ? 'item_done' : 'item_ended'), outcome: after.terminal },
          owners(after),
        ),
      );
    }
    return out;
  }
  if (after.waiting?.kind === 'questions' && questionIds(after) !== questionIds(before)) {
    const rounds = limitValue(cat, 'B1', 'rounds') ?? 2;
    out.push(
      intent(
        {
          ...base(after, 'questions_waiting'),
          rounds_left: Math.max(0, rounds - after.rounds),
          // silence parks the item after B1's business days (the clarify timer); the answers stop it
          due_at: deadline(after.clarify?.since, parkBusinessDays(cat), cal),
        },
        [requester(after)],
      ),
    );
  }
  if (waitsFor(after, 'ready') && !waitsFor(before, 'ready')) {
    out.push(intent(base(after, 'ready_waiting'), [requester(after)]));
  }
  if (waitsOnGate(after, 'G6') && !waitsOnGate(before, 'G6')) {
    out.push(intent({ ...base(after, 'acceptance_waiting'), gate_id: 'G6' }, [requester(after)]));
  }
  if (after.waiting?.kind === 'parked' && waitingKind(before) !== 'parked') {
    out.push(
      intent(
        {
          ...base(after, 'item_parked'),
          // PARK -> ABANDONED after B1's business days unless the answers arrive
          due_at: deadline(after.park?.since, parkBusinessDays(cat), cal),
        },
        [requester(after)],
      ),
    );
  }
  if (after.waiting?.kind === 'release_held' && waitingKind(before) !== 'release_held') {
    out.push(intent({ ...base(after, 'release_failed'), release: 'held' }, owners(after)));
  }
  const known = new Set((before?.handoffs ?? []).map((h) => h.handoff_id));
  for (const h of after.handoffs) {
    if (known.has(h.handoff_id) || h.status !== 'open') continue;
    out.push(intent(base(after, 'handoff'), [requester(after)]));
  }
  return out;
}

/** An item's fold at one event: the state just before it and just after it, and the item's catalogue. */
export interface ItemStep {
  readonly before: ItemState | null;
  readonly after: ItemState;
  readonly catalogue: CatalogueData;
}

/**
 * Folds item streams forward, one event at a time, with the interpreter (a pass reads each stream once). A stream
 * that cannot be folded (a catalogue pin this build does not carry, an event it cannot parse) is given up for the pass
 * and raises nothing: the notifier fails quiet, the item page still says what waits.
 */
export class ItemFolds {
  private readonly items = new Map<
    string,
    { state: ItemState | null; seq: number; cat: CatalogueData | null; broken: boolean }
  >();

  constructor(
    private readonly load: (
      stream: string,
      afterSeq: number,
      upToSeq: number,
    ) => Promise<RecordEvent[]>,
    private readonly resolve: CatalogueResolver = pinnedCatalogueResolver,
  ) {}

  /** The step at `seq` of `stream`, or `null` (an earlier seq than folded, or the stream is broken). */
  async step(stream: string, seq: number): Promise<ItemStep | null> {
    let cur = this.items.get(stream);
    if (!cur) {
      cur = { state: null, seq: 0, cat: null, broken: false };
      this.items.set(stream, cur);
    }
    if (cur.broken || seq <= cur.seq) return null;
    try {
      const evs = await this.load(stream, cur.seq, seq);
      let before: ItemState | null = cur.state;
      for (const e of evs) {
        before = cur.state;
        const ev = parseItemEvent(e);
        if (cur.state === null) {
          if (ev.type !== ITEM_EVENT.created)
            throw new Error('an item stream starts with item.created');
          const p = ItemCreatedPayload.parse(ev.payload);
          cur.cat = this.resolve(p.catalogue_ref);
          if (cur.cat === null) throw new Error('catalogue pin unavailable');
          cur.state = interpret(null, ev, cur.cat, p.gating_profile).state;
        } else {
          cur.state = interpret(cur.state, ev, cur.cat as CatalogueData, cur.state.profile).state;
        }
        cur.seq = e.stream_seq;
      }
      if (cur.state === null || cur.cat === null || cur.seq !== seq) {
        cur.broken = true;
        return null;
      }
      return { before, after: cur.state, catalogue: cur.cat };
    } catch {
      cur.broken = true;
      return null;
    }
  }
}
