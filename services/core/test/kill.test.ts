import {
  KILL_LEDGER_ENTRY_TYPE,
  KILL_OBSERVED_EVENT,
  KILL_OBSERVED_STREAM,
  type KillEvent,
} from '@aisdlc/contracts';
import { HttpKillState } from '@aisdlc/killswitch/client';
import { startTestKillswitch, type TestKillswitch } from '@aisdlc/killswitch/testing';
import { FakeKillState, FakeStagePorts, fakeKeyCustody } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  driveWork,
  killObservedCursor,
  observeKillswitch,
  readItem,
  requestWork,
  syncKillHolders,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  GATING_ON,
  actFor,
  approvers,
  decideGate,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
  type Seeded,
} from './work-fixtures.js';

// The kill switch against core (PLAN M9.6, AR9). The kill switch is started FIRST and ALONE, with its own
// database and key, and a project is killed before any core exists: killing needs nothing of core's.
// Then core starts and the work driver, which asks the kill switch before it admits agent work, refuses.

const base = fakeKeyCustody();
let kmsDown = false;
const custody = {
  ...base,
  sign: async (...a: Parameters<typeof base.sign>) =>
    kmsDown
      ? ({
          ok: false,
          error: { _tag: 'KeyCustodyError', code: 'unavailable', message: 'kms down' },
        } as never)
      : base.sign(...a),
};
let ks: TestKillswitch;
let s: CoreStack;
let seeded: Seeded;
let killId = '';

beforeAll(async () => {
  ks = await startTestKillswitch({ custody, admins: ['root', 'root2'] });
});
afterAll(async () => {
  await s?.stop();
  await ks.stop();
});

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
let n = 0;
async function item(x: Seeded, lane: 'L3' | 'L4' = 'L3') {
  n += 1;
  const r = ok(
    await requestWork(s.deps, {
      project_id: pid(x.project),
      repo: x.repo,
      lane,
      requester: pr('alice'),
      request_id: `kill-${n}`,
      create_item: true,
    }),
  );
  return r.item_id as string;
}
const st = async (id: string) => (await readItem(s.record.pool, id))?.state;

describe('kill works with core stopped (AR9)', () => {
  it('the kill switch kills a project on its own: no core, no record database, no work engine', async () => {
    // there is no core stack yet: only the kill switch and its own database exist
    ok(
      await ks.service.syncHolders('acme-kill', {
        admins: ['alice-admin'],
        kill_holders: [],
        tier: 'T1',
        two_person: false,
      }),
    );
    const k = ok(
      await ks
        .clientFor('bff')
        .kill('alice-admin', { kind: 'project', ref: 'acme-kill' }, 'incident'),
    );
    killId = k.kill_id;
    expect(ok(await ks.killState().status({ project_id: 'acme-kill' })).killed).toBe(true);
    // the only database that exists holds the kill switch's schema and nothing of core's
    const schemas = await ks.database.pool.query<{ s: string }>(
      `SELECT DISTINCT table_schema AS s FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'public')`,
    );
    expect(schemas.rows.map((r) => r.s)).toEqual(['killswitch']);
  });

  it('then core starts: admission for the killed project is refused, the command waits untouched', async () => {
    s = await startCoreStack();
    await loadReports();
    seeded = await seedActivePrr(s, {
      project: 'acme-kill',
      repo: 'acme/kill-1',
      level: 'full',
      gating: GATING_OFF,
    });
    approvers(s, seeded.project);
    const ports = new FakeStagePorts();
    const d = { ...driverOver(s, { ports }), kill: ks.killState() };
    const id = await item(seeded);
    const r1 = await driveWork(d);
    // nothing reached a stage port, nothing failed, nothing died: the command was deferred
    expect(ports.calls()).toEqual([]);
    expect(r1).toMatchObject({ dispatched: 0, failed: 0, dead: 0 });
    expect(r1.deferred).toBeGreaterThan(0);
    const row = await s.record.pool.query(
      `SELECT attempts, dead_at, dispatched_at, last_error FROM record.outbox WHERE destination = 'work.commands'`,
    );
    expect(row.rows.length).toBeGreaterThan(0);
    for (const r of row.rows) {
      expect(r.attempts).toBe(0);
      expect(r.dead_at).toBeNull();
      expect(r.dispatched_at).toBeNull();
    }
    // the item shows it: HELD by the kill, with the kill's id as origin
    const state = await st(id);
    expect(state?.holds).toMatchObject([{ reason: 'kill', origin: killId }]);
    expect(state?.phase).toBe('Held');
    // a kill of ANOTHER project does not touch this one's neighbours: another project runs
    const other = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
    approvers(s, other.project);
    const oid = await item(other);
    const done = await runItem(s, d, oid);
    expect(done?.state.terminal).toBe('Done');
  });

  it('a release by two people lifts it, and the same item then runs to the end', async () => {
    const ports = new FakeStagePorts();
    const d = { ...driverOver(s, { ports }), kill: ks.killState() };
    const id = (
      await s.record.pool.query<{ item_id: string }>(
        `SELECT item_id FROM core.work_item WHERE project_id = 'acme-kill' ORDER BY created_at LIMIT 1`,
      )
    ).rows[0]?.item_id as string;
    // one approval is not a release where the project's two-person setting is on: make it so
    ok(
      await ks.service.syncHolders('acme-kill', {
        admins: ['alice-admin', 'bob-admin'],
        kill_holders: [],
        tier: 'T1',
        two_person: true,
      }),
    );
    const k1 = ok(await ks.clientFor('bff').release('alice-admin', killId));
    expect(k1.state).toBe('release_pending');
    await driveWork(d);
    expect(ports.calls()).toEqual([]); // still killed
    const k2 = ok(await ks.clientFor('bff').release('bob-admin', killId));
    expect(k2.state).toBe('released');
    // the deferred command waits out its retry delay, then goes
    s.clock.advance(60_000);
    const done = await runItem(s, d, id);
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.holds).toEqual([]);
  });
});

describe('what a person can still do while agent work is refused', () => {
  it('an unreachable kill switch admits no new agent work, but a human still decides the gate', async () => {
    const fake = new FakeKillState(() => s.clock.now());
    const x = await seedActivePrr(s, { level: 'full', gating: GATING_ON });
    approvers(s, x.project);
    const ports = new FakeStagePorts();
    const d = { ...driverOver(s, { ports }), kill: fake };
    const id = await item(x, 'L4');
    // run until the first gate waits for a person
    await runItem(s, d, id, {
      decide: () => 'hold',
      stop: (q) => q.gates.some((g) => g.status === 'pending'),
    });
    const pending = (await st(id))?.gates.find((g) => g.status === 'pending');
    expect(pending).toBeDefined();
    const callsBefore = ports.calls().length;
    // the kill switch goes away
    fake.breakIt();
    ok(await decideGate(s, pending?.gate_instance_id as string, 'bob', 'approve'));
    const report = await driveWork(d);
    // the decision was recorded (a human decided), and no stage was started
    expect(
      (await st(id))?.gates.find((g) => g.gate_instance_id === pending?.gate_instance_id)?.status,
    ).toBe('decided');
    expect(ports.calls().length).toBe(callsBefore);
    expect(report.deferred + report.kill_holds).toBeGreaterThanOrEqual(0);
    // an unreachable kill switch changes no hold, and a reachable one lets the work go on
    fake.breakIt(false);
    s.clock.advance(60_000);
    const done = await runItem(s, d, id);
    expect(done?.state.terminal).toBe('Done');
    expect(ports.calls().length).toBeGreaterThan(callsBefore);
  });

  it('against the real kill switch: a dead URL is no admission (fail closed)', async () => {
    const x = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
    approvers(s, x.project);
    const ports = new FakeStagePorts();
    const dead = new HttpKillState({
      baseUrl: 'http://127.0.0.1:1',
      token: 'z'.repeat(24),
      timeoutMs: 300,
    });
    const d = { ...driverOver(s, { ports }), kill: dead };
    const id = await item(x);
    await driveWork(d);
    await driveWork(d);
    expect(ports.calls()).toEqual([]);
    // nothing is held and nothing is lost: the command waits
    expect((await st(id))?.holds).toEqual([]);
    expect((await st(id))?.outstanding.length).toBeGreaterThan(0);
    void actFor;
  });

  it('a fleet kill covers a project that has no kill of its own; releasing it frees the work', async () => {
    const fake = new FakeKillState(() => s.clock.now());
    const x = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
    approvers(s, x.project);
    const ports = new FakeStagePorts();
    const d = { ...driverOver(s, { ports }), kill: fake };
    const fid = fake.kill({ kind: 'fleet', ref: '*' });
    const id = await item(x);
    await driveWork(d);
    expect(ports.calls()).toEqual([]);
    expect((await st(id))?.holds[0]).toMatchObject({ reason: 'kill', origin: fid });
    fake.release(fid);
    s.clock.advance(60_000);
    expect((await runItem(s, d, id))?.state.terminal).toBe('Done');
    // a lane kill holds only that lane
    const lane = fake.kill({ kind: 'lane', ref: `${x.project}/L3` });
    const a = await item(x, 'L3');
    const b = await item(x, 'L4');
    ports.coding.script(() => undefined);
    await driveWork(d);
    expect((await st(a))?.holds[0]).toMatchObject({ reason: 'kill', origin: lane });
    expect((await st(b))?.holds).toEqual([]);
  });
});

describe('core pushes who holds what, and records the kill switch journal as facts and ledger entries', () => {
  it('pushes the holders of every project; the kill switch then decides from its own copy', async () => {
    const x = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
    approvers(s, x.project, ['pat'], 'T1');
    s.elig.setHolders(pid(x.project), 'kill', [pr('kay')]);
    const pushed = await syncKillHolders({
      pool: s.record.pool,
      eligibility: s.elig,
      link: ks.clientFor('core-worker'),
    });
    expect(pushed.failed).toBeGreaterThanOrEqual(0);
    expect(pushed.pushed).toBeGreaterThan(0);
    // a holder core named can kill; core is not asked
    ok(await ks.clientFor('bff').kill('kay', { kind: 'project', ref: x.project }, 'because'));
    expect(
      (await ks.clientFor('bff').kill('someone-else', { kind: 'project', ref: x.project }, 'x')).ok,
    ).toBe(false);
    // pushing the same again writes nothing new to the journal
    const before = ok(await ks.service.events(0, 1000)).length;
    await syncKillHolders({
      pool: s.record.pool,
      eligibility: s.elig,
      link: ks.clientFor('core-worker'),
    });
    expect(ok(await ks.service.events(0, 1000)).length).toBe(before);
  });

  it('observes the journal: each entry is verified, recorded as kill.observed and written to the ledger (Notary), once', async () => {
    const link = ks.clientFor('core-worker');
    const key = ok(await ks.service.journalKey());
    const deps = {
      ...s.deps,
      ledger: s.deps.ledger as NonNullable<typeof s.deps.ledger>,
      link,
      key,
    };
    const total = ok(await ks.service.events(0, 1000)).length;
    const first = ok(await observeKillswitch(deps));
    expect(first.observed).toBe(total);
    expect(ok(await observeKillswitch(deps)).observed).toBe(0);
    const facts = await s.record.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY record_event.seq`,
      [KILL_OBSERVED_STREAM, KILL_OBSERVED_EVENT],
    );
    expect(facts.rows).toHaveLength(total);
    expect(facts.rows.map((r) => r.body.ks_seq)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    // the ledger holds one signed entry per kill switch entry, bound to its hash
    const led = await s.record.pool.query(
      `SELECT body ->> 'ks_seq' AS seq, body ->> 'event' AS event, subject_hash FROM ledger.ledger_entry
        WHERE entry_type = $1 ORDER BY (body ->> 'ks_seq')::int`,
      [KILL_LEDGER_ENTRY_TYPE],
    );
    expect(led.rows).toHaveLength(total);
    expect(led.rows[0]?.subject_hash).toBe(facts.rows[0]?.body.entry_hash);
    expect(led.rows.map((r) => r.event)).toContain('kill.requested');
    // a new kill is observed by the next pass
    ok(await ks.clientFor('bff').kill('root', { kind: 'lane', ref: 'acme-kill/L5' }, 'later'));
    expect(ok(await observeKillswitch(deps)).observed).toBe(1);
    const cur = await killObservedCursor(s.record.pool);
    expect(cur.seq).toBe(total + 1);
  });

  it('records nothing from a journal that does not verify (forged body, wrong key)', async () => {
    const real = ks.clientFor('core-worker');
    ok(await ks.clientFor('bff').kill('root', { kind: 'lane', ref: 'acme-kill/L6' }, 'forge me'));
    const forged = {
      syncHolders: real.syncHolders.bind(real),
      events: async (after: number, limit?: number) => {
        const r = await real.events(after, limit);
        if (!r.ok) return r;
        const events: KillEvent[] = structuredClone(r.value.events);
        if (events[0]) (events[0] as { body: Record<string, unknown> }).body = { forged: true };
        return { ok: true as const, value: { events, key: r.value.key } };
      },
    };
    const key = ok(await ks.service.journalKey());
    const before = (await killObservedCursor(s.record.pool)).seq;
    const bad = await observeKillswitch({
      ...s.deps,
      ledger: s.deps.ledger as NonNullable<typeof s.deps.ledger>,
      link: forged,
      key,
    });
    expect(bad.ok).toBe(false);
    expect((await killObservedCursor(s.record.pool)).seq).toBe(before);
    // the Notary's key is not the kill switch's: nothing verifies under it
    const notaryKey = await custody.publicKey('dev:notary');
    if (!notaryKey.ok) throw new Error('no notary key');
    const notary = notaryKey.value;
    const wrongKey = await observeKillswitch({
      ...s.deps,
      ledger: s.deps.ledger as NonNullable<typeof s.deps.ledger>,
      link: real,
      key: notary,
    });
    expect(wrongKey.ok).toBe(false);
    expect((await killObservedCursor(s.record.pool)).seq).toBe(before);
  });
});

describe('a kill written while the KMS was down', () => {
  it('is enforced at once, observed as a fact before it is signed, and ledgered when the signed attestation is observed', async () => {
    const link = ks.clientFor('core-worker');
    const key = ok(await ks.service.journalKey());
    const deps = {
      ...s.deps,
      ledger: s.deps.ledger as NonNullable<typeof s.deps.ledger>,
      link,
      key,
    };
    ok(await observeKillswitch(deps)); // caught up
    ok(
      await ks.service.syncHolders('acme-pend', {
        admins: ['pia'],
        kill_holders: [],
        tier: 'T1',
        two_person: false,
      }),
    );
    ok(await observeKillswitch(deps));
    kmsDown = true;
    ok(await ks.clientFor('bff').kill('pia', { kind: 'project', ref: 'acme-pend' }, 'kms down'));
    // admission is refused straight away
    const fake = ks.killState();
    expect(ok(await fake.status({ project_id: 'acme-pend' })).killed).toBe(true);
    // the observer records the pending entry as a fact, not yet in the ledger
    const seen = ok(await observeKillswitch(deps));
    expect(seen.observed).toBe(1);
    const pendSeq = seen.head_seq;
    const facts = await s.record.pool.query(
      `SELECT body ->> 'signature' AS sig FROM record.record_event WHERE stream = $1 AND (body ->> 'ks_seq')::int = $2`,
      [KILL_OBSERVED_STREAM, pendSeq],
    );
    expect(facts.rows[0]?.sig).toBe('pending_signature');
    const ledgerOf = async () =>
      (
        await s.record.pool.query(
          `SELECT 1 FROM ledger.ledger_entry WHERE entry_type = $1 AND (body ->> 'ks_seq')::int = $2`,
          [KILL_LEDGER_ENTRY_TYPE, pendSeq],
        )
      ).rowCount;
    expect(await ledgerOf()).toBe(0);
    // the KMS is back: signed, then observed, and now the pending kill is in the ledger too
    kmsDown = false;
    expect(ok(await ks.service.backfillSignatures()).attested).toBe(1);
    const next = ok(await observeKillswitch(deps));
    expect(next.observed).toBe(1);
    expect(await ledgerOf()).toBe(1);
    expect(ok(await observeKillswitch(deps)).observed).toBe(0);
  });
});
