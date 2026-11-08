import { ACCESS_EVENT_TYPES, ACCESS_SYNC_SLO_SECONDS, AccessLedgerBody } from '@aisdlc/contracts';
import { appendLedgerEntryTx, inTransaction, lockLedger, verifyLedger } from '@aisdlc/ledger';
import { err } from '@aisdlc/kernel';
import type { NotaryPort } from '@aisdlc/ports';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessDraft,
  accessSyncLagSeconds,
  accessSyncStatus,
  addMember,
  createGroup,
  createPrincipal,
  startAccessSyncLoop,
  syncAccessLedger,
  updatePrincipal,
} from '../src/index.js';
import { pr, seedPrincipals, startIdentityStack, type IdentityStack } from '../src/testing.js';

let s: IdentityStack;
beforeAll(async () => {
  s = await startIdentityStack();
});
afterAll(async () => {
  await s.stop();
});

const A = 'system.test';
const count = async (sql: string, v: unknown[] = []) =>
  Number((await s.record.pool.query<{ n: string }>(sql, v)).rows[0]?.n);
const entries = () =>
  count(`SELECT count(*)::text AS n FROM ledger.ledger_entry WHERE entry_type LIKE 'access.%'`);
const lag = () => accessSyncLagSeconds(s.record.pool, s.clock);

async function makeGroup(id: string, members: string[]) {
  await createGroup(s.deps, { group_id: id, display: id, pim_managed: false, protected: false }, A);
  for (const m of members) await addMember(s.deps, { group_id: id, principal_id: m }, A);
}

/** A notary that fails on demand. */
function flaky(inner: NotaryPort, f: { reserve: boolean; confirm: number }): NotaryPort {
  return {
    reserve: async (r) =>
      f.reserve ? err({ code: 'unavailable', message: 'notary down' } as never) : inner.reserve(r),
    sign: (r) => inner.sign(r),
    confirm: async (r) => {
      if (f.confirm > 0) {
        f.confirm -= 1;
        return err({ code: 'unavailable', message: 'confirm lost' } as never);
      }
      return inner.confirm(r);
    },
    unconfirmed: () => inner.unconfirmed(),
    signCheckpoint: (r) => inner.signCheckpoint(r),
    verify: (e) => inner.verify(e),
  };
}

describe('the access-sync loop', () => {
  it('identity writes never touch the ledger; the lag metric counts the wait', async () => {
    await seedPrincipals(s.deps, ['a1', 'a2', 'a3']);
    await makeGroup('g1', ['a1', 'a2']);
    expect(await entries()).toBe(0);
    expect(await lag()).toBe(0); // the memberships were just written: no time has passed
  });

  it('the lag grows with the clock, breaches the SLO, and clears after a sync', async () => {
    s.clock.advance(31_000);
    expect(await lag()).toBeGreaterThanOrEqual(30);
    expect((await accessSyncStatus(s.record.pool, s.clock)).breached).toBe(false);
    s.clock.advance((ACCESS_SYNC_SLO_SECONDS + 1) * 1000);
    const st = await accessSyncStatus(s.record.pool, s.clock);
    expect(st.breached).toBe(true);
    expect(st.slo_seconds).toBe(60);
    const r = await s.sync();
    expect(r).toMatchObject({ written: 2, already: 0, caught_up: true, lag_seconds: 0 });
    expect(await lag()).toBe(0);
  });

  it('is idempotent: another pass finds nothing, nothing is signed twice', async () => {
    const before = await entries();
    const r = await s.sync();
    expect(r.written).toBe(0);
    expect(await entries()).toBe(before);
  });

  it('writes one access.* entry per event, with the event named in the body, and the ledger verifies offline', async () => {
    const q = await s.record.pool.query<{ entry_type: string; body: unknown; entry_id: string }>(
      `SELECT entry_type, body, entry_id FROM ledger.ledger_entry WHERE entry_type LIKE 'access.%' ORDER BY ledger_seq`,
    );
    expect(q.rows.map((r) => r.entry_type)).toEqual([
      'access.membership_added',
      'access.membership_added',
    ]);
    for (const r of q.rows) {
      const body = AccessLedgerBody.parse(r.body);
      const ev = await s.record.pool.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE event_id = $1`,
        [body.access_event_id],
      );
      expect(toRecordEvent(ev.rows[0] as EventRow).stream_id).toBe('group:g1');
    }
    const v = await verifyLedger(s.record.pool, s.keys, { allowUncoveredTail: true });
    expect(v.ok && v.value.entries).toBe(2);
  });

  it('does not ledger events that are not access changes', async () => {
    await updatePrincipal(s.deps, 'a1', { display_name: 'Renamed' }, A);
    await createPrincipal(
      s.deps,
      { principal_id: pr('a4'), kind: 'human', display_handle: 'a4', display_name: 'A4' },
      A,
    );
    const before = await entries();
    expect(await lag()).toBe(0);
    expect((await s.sync()).written).toBe(0);
    expect(await entries()).toBe(before);
  });

  it('two concurrent passes write exactly one entry per event', async () => {
    await makeGroup('g2', ['a1', 'a2', 'a3']);
    const before = await entries();
    const deps = { pool: s.record.pool, ledger: s.ledger, clock: s.clock };
    const [x, y] = await Promise.all([syncAccessLedger(deps), syncAccessLedger(deps)]);
    expect(x.ok && y.ok).toBe(true);
    expect((x.ok ? x.value.written : 0) + (y.ok ? y.value.written : 0)).toBe(3);
    expect(await entries()).toBe(before + 3);
    const dup = await count(
      `SELECT count(*)::text AS n FROM (SELECT body ->> 'access_event_id' FROM ledger.ledger_entry
        WHERE entry_type LIKE 'access.%' GROUP BY 1 HAVING count(*) > 1) d`,
    );
    expect(dup).toBe(0);
  });

  it('works in small batches and honours max', async () => {
    await makeGroup('g3', ['a1', 'a2', 'a3']);
    const deps = { pool: s.record.pool, ledger: s.ledger, clock: s.clock };
    const part = await syncAccessLedger(deps, { batch: 2, max: 2 });
    expect(part.ok && part.value).toMatchObject({ written: 2, caught_up: false });
    expect(await lag()).toBeGreaterThanOrEqual(0);
    const rest = await syncAccessLedger(deps, { batch: 2 });
    expect(rest.ok && rest.value).toMatchObject({ written: 1, caught_up: true, lag_seconds: 0 });
  });

  it('a Notary outage changes nothing and leaves the lag growing; the next pass catches up', async () => {
    await makeGroup('g4', ['a1']);
    const knobs = { reserve: true, confirm: 0 };
    const deps = {
      pool: s.record.pool,
      ledger: { ...s.ledger, notary: flaky(s.ledger.notary, knobs) },
      clock: s.clock,
    };
    const before = await entries();
    const r = await syncAccessLedger(deps);
    expect(!r.ok && r.error.code).toBe('ledger');
    expect(await entries()).toBe(before);
    s.clock.advance(5000);
    expect(await lag()).toBeGreaterThanOrEqual(5);
    knobs.reserve = false;
    const ok2 = await syncAccessLedger(deps);
    expect(ok2.ok && ok2.value.written).toBe(1);
  });

  it('a lost confirm is finished by the next pass, without a second entry', async () => {
    await makeGroup('g5', ['a2']);
    const knobs = { reserve: false, confirm: 1 };
    const deps = {
      pool: s.record.pool,
      ledger: { ...s.ledger, notary: flaky(s.ledger.notary, knobs) },
      clock: s.clock,
    };
    const before = await entries();
    const first = await syncAccessLedger(deps);
    expect(first.ok).toBe(false); // committed, but the confirm was lost
    expect(await entries()).toBe(before + 1);
    const stuck = await s.ledger.notary.unconfirmed();
    expect(stuck.ok && stuck.value.length).toBeGreaterThan(0);
    const second = await syncAccessLedger(deps);
    expect(second.ok && second.value.written).toBe(0);
    const un = await s.ledger.notary.unconfirmed();
    expect(un.ok && un.value).toEqual([]);
    expect(await entries()).toBe(before + 1);
  });

  it('an entry the Notary signed whose transaction rolled back is imported, not signed twice', async () => {
    await makeGroup('g6', ['a3']);
    const row = await s.record.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = 'group:g6' AND type = 'group.member_added'`,
    );
    const ev = toRecordEvent(row.rows[0] as EventRow);
    const rolled = await inTransaction(
      s.record.pool,
      async (tx) => {
        await lockLedger(tx);
        const w = await appendLedgerEntryTx(tx, s.ledger, accessDraft(ev, s.clock));
        if (!w.ok) throw new Error(w.error.message);
        return err('caller transaction rolled back');
      },
      (e) => String(e),
    );
    expect(rolled.ok).toBe(false);
    const stranded = await s.ledger.notary.unconfirmed();
    expect(stranded.ok && stranded.value).toHaveLength(1);
    const before = await entries();
    const r = await s.sync();
    expect(r.written).toBe(0);
    expect(r.already).toBe(1);
    expect(await entries()).toBe(before + 1);
    const un = await s.ledger.notary.unconfirmed();
    expect(un.ok && un.value).toEqual([]);
    const v = await verifyLedger(s.record.pool, s.keys, { allowUncoveredTail: true });
    expect(v.ok).toBe(true);
  });

  it('the loop function keeps the ledger within the SLO on its own', async () => {
    // Wait for the real invariant (every access event has its entry), not for lag: lag is in
    // seconds on a manual clock, so it reads 0 while an event is still unledgered, and a
    // runOnce racing the loop's own tick is correctly skipped (single flight).
    const events = () =>
      count(`SELECT count(*)::text AS n FROM record.record_event WHERE type = ANY($1::text[])`, [
        [...ACCESS_EVENT_TYPES],
      ]);
    const loop = startAccessSyncLoop(
      { pool: s.record.pool, ledger: s.ledger, clock: s.clock },
      { intervalMs: 30 },
    );
    try {
      await makeGroup('g7', ['a1', 'a2']);
      const deadline = Date.now() + 10_000;
      while ((await entries()) !== (await events()) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(await lag()).toBe(0);
    } finally {
      await loop.stop();
    }
    expect(await entries()).toBe(await events());
  });
});
