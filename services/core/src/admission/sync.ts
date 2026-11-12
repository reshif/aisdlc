import {
  HUMAN_WAIT_GATES,
  ITEM_EVENT,
  UNIT_EVENT,
  type GrantReleaseCause,
  type HumanWaitGate,
} from '@aisdlc/contracts';
import { ok } from '@aisdlc/kernel';
import type { ItemState } from '@aisdlc/work';
import { itemWorkHold, type AgentWorkHold } from '../drift/hold.js';
import { inCoreTx, lockKeys } from '../journal.js';
import { readItem, readItemEvents } from '../work-items.js';
import type { AdmissionDeps } from './admit.js';
import { emitUnitEvent } from './events.js';
import { unitLockKey } from './fold.js';
import { currentLease, listGrants } from './read.js';

// What keeps the Unit, Lease and AdmissionGrant rows true to the item (PLAN M13.1), as a function of the item's
// state (the interpreter's, folded from its stream) and of the rows. Each move is one `unit.*` event with an
// idempotency key, so a pass run twice does nothing the second time; none of them holds state of its own.
//
//   - the grant ends (GrantReleased, DM §6.4) on a handoff, when the item ends, or when G4 is decided;
//   - the lease ends when the item leaves S6 (the session is over; the grant lives on to G4);
//   - TAKEOVER (E4) and D4 hand-back: the engine says who holds the lease now and at what epoch; the Unit
//     bumps its own epoch to match and never below its own: the epoch only increases. The agent's rows of the
//     Unit are not dropped here: the lease is the human's from that epoch, and a write at the old epoch is stale;
//   - HUMAN-WAIT: a pending G3o, X1, X3 or E6 while the item is in S6 releases the lease and the slot, keeps a
//     snapshot reference, and pauses the envelope clock; the next S6 command re-admits it (`ensureAdmitted`).
//     M16 part 3 (OB §8): a hold on the item's repo does the same (its readiness record suspended for drift:
//     `agentWorkHold`); no re-admission happens while it lasts, and the restore lets the next S6 command re-admit.

export interface UnitSyncReport {
  readonly grants_released: number;
  readonly leases_changed: number;
  readonly waits_entered: number;
}

const IN_S6 = ['S6', 'Scheduling'];

export async function syncUnits(
  d: AdmissionDeps,
  itemIds: readonly string[],
): Promise<UnitSyncReport> {
  const r = { grants_released: 0, leases_changed: 0, waits_entered: 0 };
  for (const id of itemIds) {
    const item = await readItem(d.pool, id);
    if (!item) continue;
    const s = item.state;
    const grants = await listGrants(d.pool, id);
    const live =
      grants.find((g) => g.status === 'active') ?? grants.find((g) => g.status === 'waiting');

    // ---- the grant ends
    if (live) {
      let cause: GrantReleaseCause | null = null;
      if (s.terminal !== null) cause = 'item_ended';
      else if (s.underlying === 'Handoff') cause = 'handoff';
      else if (s.underlying === 'Quarantined') cause = 'quarantined';
      else if (live.status === 'active') {
        const ev = await readItemEvents(d.pool, id);
        const decided = ev.some(
          (e) =>
            e.type === ITEM_EVENT.gate_decided &&
            (e.payload as { gate?: string }).gate === 'G4' &&
            Date.parse(e.occurred_at) >= Date.parse(live.granted_at),
        );
        if (decided) cause = 'g4_decided';
      }
      if (cause !== null) {
        const c = cause;
        const w = await inCoreTx(d, async (j, tx) => {
          await lockKeys(tx, [unitLockKey(id)]);
          const e = await emitUnitEvent(
            j,
            tx,
            id,
            UNIT_EVENT.grant_released,
            { grant_id: live.grant_id, unit_id: live.unit_id, item_id: id as never, cause: c },
            `grant:released:${live.grant_id}`,
          );
          return e.ok ? ok(!e.value.duplicate) : e;
        });
        if (!w.ok) throw new Error(w.error.message);
        if (w.value) r.grants_released += 1;
      }
    }

    // ---- the lease follows the engine
    const lease = await currentLease(d.pool, id);
    if (lease) {
      const holder = s.lane === 'L8' && s.takeover !== null ? 'human' : 'agent';
      if (s.lease === null) {
        // the session is over: leaving S6, a handoff or the end of the item
        if (lease.status === 'held' && !IN_S6.includes(s.underlying)) {
          const cause =
            s.terminal !== null ? 'item_ended' : s.underlying === 'Handoff' ? 'handoff' : 'left_s6';
          r.leases_changed += await changeLease(d, id, lease.unit_id, {
            epoch: lease.epoch,
            holder_kind: lease.holder_kind === 'human' ? 'human' : 'agent',
            status: 'released',
            cause,
            key: `lease:released:${id}:${lease.unit_id}:${lease.epoch}`,
          });
        }
      } else if (
        (holder !== lease.holder_kind || s.lease.epoch > lease.epoch || lease.status !== 'held') &&
        // the first admission's own epoch is the engine's after 6.0 completes: nothing to align
        !(holder === 'agent' && s.lease.epoch === lease.epoch && lease.status === 'held') &&
        // a waiting grant released the lease on purpose: only the re-admission takes it back
        !(live?.status === 'waiting' && holder === 'agent')
      ) {
        r.leases_changed += await changeLease(d, id, lease.unit_id, {
          // never below the Unit's own: the epoch only increases
          epoch: Math.max(s.lease.epoch, lease.epoch + 1),
          holder_kind: holder,
          status: 'held',
          cause:
            holder === 'human'
              ? 'takeover'
              : lease.holder_kind === 'human'
                ? 'hand_back'
                : 'new_session',
          key: `lease:${id}:${s.lease.epoch}:${holder}:${lease.epoch}`,
        });
      }
    }

    // ---- HUMAN-WAIT (a pending gate, or a hold on the repo: OB §8)
    if (s.underlying === 'S6' && live?.status === 'active' && s.terminal === null) {
      const pending = s.gates.find(
        (g) => g.status === 'pending' && (HUMAN_WAIT_GATES as readonly string[]).includes(g.gate),
      );
      if (pending) r.waits_entered += await enterWait(d, s, live, pending);
      else {
        const hold = await itemWorkHold(d.pool, s);
        if (hold) r.waits_entered += await enterWait(d, s, live, hold);
      }
    }
  }
  return r;
}

async function changeLease(
  d: AdmissionDeps,
  itemId: string,
  unitId: string,
  c: {
    epoch: number;
    holder_kind: 'agent' | 'human';
    status: 'held' | 'released';
    cause: 'takeover' | 'hand_back' | 'new_session' | 'left_s6' | 'handoff' | 'item_ended';
    key: string;
  },
): Promise<number> {
  const w = await inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [unitLockKey(itemId)]);
    const e = await emitUnitEvent(
      j,
      tx,
      itemId,
      UNIT_EVENT.lease_changed,
      {
        unit_id: unitId,
        item_id: itemId as never,
        lease_epoch: c.epoch,
        holder_kind: c.holder_kind,
        holder_ref: null,
        status: c.status,
        cause: c.cause,
      },
      c.key,
    );
    return e.ok ? ok(e.value.duplicate ? 0 : 1) : e;
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

async function enterWait(
  d: AdmissionDeps,
  s: ItemState,
  grant: { grant_id: string; unit_id: string; lease_epoch: number },
  on: { gate: string; gate_instance_id: string } | AgentWorkHold,
): Promise<number> {
  const hold = 'cause' in on ? on : null;
  const gate = hold === null ? (on as { gate: string; gate_instance_id: string }) : null;
  // the wait's key: the gate instance, or the hold's record reference
  const key = gate ? gate.gate_instance_id : `hold:${hold?.ref ?? ''}`;
  const snap = await d.snapshots.keep({
    unit_id: grant.unit_id,
    item_id: s.item_id,
    lease_epoch: grant.lease_epoch,
    gate: gate ? (gate.gate as HumanWaitGate) : null,
    gate_instance_id: key,
  });
  // no snapshot, no wait: the session keeps its lease and slot until one can be kept (fail closed)
  if (!snap.ok) return 0;
  const w = await inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [unitLockKey(s.item_id)]);
    const e = await emitUnitEvent(
      j,
      tx,
      s.item_id,
      UNIT_EVENT.wait_entered,
      {
        grant_id: grant.grant_id,
        unit_id: grant.unit_id,
        item_id: s.item_id as never,
        ...(hold ? { cause: hold.cause, hold_ref: hold.ref } : {}),
        gate: gate ? (gate.gate as HumanWaitGate) : null,
        gate_instance_id: gate ? gate.gate_instance_id : null,
        lease_epoch: grant.lease_epoch,
        snapshot_ref: snap.value.snapshot_ref,
      },
      // one wait per grant and gate (or hold): the same suspension never waits a grant twice
      gate ? `wait:${gate.gate_instance_id}` : `wait:${key}:${grant.grant_id}`,
    );
    return e.ok ? ok(e.value.duplicate ? 0 : 1) : e;
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}
