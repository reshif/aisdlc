import { runProjection } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IdentityEligibility,
  addMember,
  createGroup,
  explainGate,
  identityProjection,
  reconcileProject,
  setCodeownerMembers,
} from '../src/index.js';
import {
  pid,
  pr,
  seedPrincipals,
  settingsOf,
  startIdentityStack,
  type IdentityStack,
} from '../src/testing.js';

// Two M4.4 faults found while building the code owner feed (PLAN M5.2):
//  1. a re-add of an existing membership moved `active_from` and so wrote a `member_added` event
//     (and an access ledger entry) on every reconcile;
//  2. a slot that became `codeowners` kept its old `role_map` members until a code owner sync ran.

let s: IdentityStack;
beforeAll(async () => {
  s = await startIdentityStack();
  await seedPrincipals(s.deps, ['alice', 'bob', 'carol']);
});
afterAll(async () => {
  await s.stop();
});

const count = async (sql: string): Promise<number> =>
  Number((await s.record.pool.query<{ n: string }>(sql)).rows[0]?.n);
const events = () => count('SELECT count(*)::text AS n FROM record.record_event');
const accessEntries = () =>
  count("SELECT count(*)::text AS n FROM ledger.ledger_entry WHERE entry_type LIKE 'access.%'");
const deps = () => ({ ...s.deps, settings: s.settings });

async function membership(group: string, principal: string) {
  await runProjection(s.record.pool, identityProjection);
  const q = await s.record.pool.query<{
    active_from: Date;
    active_until: Date | null;
    via: string;
    source: string;
  }>(
    'SELECT active_from, active_until, via, source FROM identity.membership WHERE group_id = $1 AND principal_id = $2',
    [group, principal],
  );
  return q.rows[0];
}

describe('a membership asked for again is unchanged', () => {
  it('reconcile twice with an advancing clock: the second run writes no event and no access entry', async () => {
    s.settings.set(settingsOf('clk', { admin: ['alice'], intent: ['bob', 'carol'] }), 'T1');
    const first = await reconcileProject(deps(), { project_id: pid('clk') });
    expect(first.ok && first.value.members_added).toBe(3);
    await s.sync();
    const e1 = await events();
    const l1 = await accessEntries();
    const started = (await membership('rm.clk.intent', 'bob'))?.active_from.toISOString();

    s.clock.advance(6 * 3600_000);
    const second = await reconcileProject(deps(), { project_id: pid('clk') });
    expect(second.ok && second.value).toMatchObject({ events: 0, members_added: 0 });
    await s.sync();
    expect(await events()).toBe(e1);
    expect(await accessEntries()).toBe(l1);
    expect((await membership('rm.clk.intent', 'bob'))?.active_from.toISOString()).toBe(started);
  });

  it('the same holds for the codeowners and plain sources', async () => {
    s.settings.set(settingsOf('clk2', { admin: ['alice'] }), 'T1');
    await reconcileProject(deps(), { project_id: pid('clk2') });
    const set = () =>
      setCodeownerMembers(deps(), {
        project_id: pid('clk2'),
        principals: [pr('alice'), pr('bob')],
        source_ref: 'a/b@1',
      });
    expect((await set()).ok).toBe(true);
    const e = await events();
    s.clock.advance(3600_000);
    const again = await set();
    expect(again.ok && again.value).toMatchObject({ added: [], removed: [] });
    expect(await events()).toBe(e);

    const g = { group_id: 'plain', display: 'plain', pim_managed: false, protected: false };
    await createGroup(s.deps, g, 'system.test');
    const add = (extra: object = {}) =>
      addMember(s.deps, { group_id: 'plain', principal_id: 'alice', ...extra }, 'system.test');
    expect((await add()).ok && (await add()).ok).toBe(true);
    const e2 = await events();
    s.clock.advance(3600_000);
    const same = await add();
    expect(same.ok && same.value.changed).toBe(false);
    expect(await events()).toBe(e2);
  });

  it('an explicit change of active_until or via is still a change, and keeps the original start', async () => {
    const g = { group_id: 'timed', display: 'timed', pim_managed: false, protected: false };
    await createGroup(s.deps, g, 'system.test');
    const add = (extra: object) =>
      addMember(s.deps, { group_id: 'timed', principal_id: 'bob', ...extra }, 'system.test');
    const first = await add({});
    expect(first.ok && first.value.changed).toBe(true);
    const started = (await membership('timed', 'bob'))?.active_from.toISOString();

    s.clock.advance(3600_000);
    const until = new Date(s.clock.now().getTime() + 86_400_000).toISOString();
    const withUntil = await add({ active_until: until });
    expect(withUntil.ok && withUntil.value.changed).toBe(true);
    const m = await membership('timed', 'bob');
    expect(m?.active_until?.toISOString()).toBe(until);
    expect(m?.active_from.toISOString()).toBe(started);

    s.clock.advance(3600_000);
    expect((await add({ active_until: until })).ok && true).toBe(true);
    const e = await events();
    await add({ active_until: until });
    expect(await events()).toBe(e);

    const viaChange = await add({ active_until: until, via: 'pim_activation' });
    expect(viaChange.ok && viaChange.value.changed).toBe(true);
    expect((await membership('timed', 'bob'))?.via).toBe('pim_activation');
    const cleared = await add({ via: 'pim_activation' });
    expect(cleared.ok && cleared.value.changed).toBe(true);
    expect((await membership('timed', 'bob'))?.active_until).toBeNull();
  });
});

describe('a slot that becomes codeowners drops its role_map members at once', () => {
  it('alice, g4 holder by the role map, is not eligible for G4 after the switch and before any sync', async () => {
    const real = new IdentityEligibility({
      pool: s.record.pool,
      settings: s.settings,
      clock: s.clock,
    });
    s.settings.set(settingsOf('sw', { admin: ['carol'], g4: ['alice'] }), 'T1');
    await reconcileProject(deps(), { project_id: pid('sw') });
    await runProjection(s.record.pool, identityProjection);
    const before = await real.holders(pid('sw'), 'g4');
    expect(before.ok && before.value).toEqual(['alice']);
    const explainBefore = await explainGate(
      { pool: s.record.pool, settings: s.settings, clock: s.clock },
      pid('sw'),
      'G4',
    );
    expect(explainBefore.ok && explainBefore.value.deciders.map((d) => d.principal_id)).toEqual([
      'alice',
    ]);

    s.settings.set(settingsOf('sw', { admin: ['carol'], g4: 'codeowners' }), 'T1');
    const r = await reconcileProject(deps(), { project_id: pid('sw') });
    expect(r.ok && r.value.members_removed).toBe(1);
    await runProjection(s.record.pool, identityProjection);
    const after = await real.holders(pid('sw'), 'g4');
    expect(after.ok && after.value).toEqual([]);
    const explainAfter = await explainGate(
      { pool: s.record.pool, settings: s.settings, clock: s.clock },
      pid('sw'),
      'G4',
    );
    expect(explainAfter.ok && explainAfter.value.deciders).toEqual([]);
    expect(await membership('rm.sw.g4', 'alice')).toBeUndefined();

    // Then a code owner sync sets the mapped owners; a later reconcile leaves them alone.
    const sync = await setCodeownerMembers(deps(), {
      project_id: pid('sw'),
      principals: [pr('bob')],
      source_ref: 'acme/app@1',
    });
    expect(sync.ok && sync.value.members).toEqual(['bob']);
    const again = await reconcileProject(deps(), { project_id: pid('sw') });
    expect(again.ok && again.value.events).toBe(0);
    expect((await membership('rm.sw.g4', 'bob'))?.source).toBe('codeowners');
    const holders = await real.holders(pid('sw'), 'g4');
    expect(holders.ok && holders.value).toEqual(['bob']);
  });

  it('switching back to named principals replaces the code owners with them', async () => {
    s.settings.set(settingsOf('sw', { admin: ['carol'], g4: ['alice'] }), 'T1');
    const r = await reconcileProject(deps(), { project_id: pid('sw') });
    expect(r.ok && r.value).toMatchObject({ members_added: 1, members_removed: 1 });
    expect(await membership('rm.sw.g4', 'bob')).toBeUndefined();
    expect((await membership('rm.sw.g4', 'alice'))?.source).toBe('role_map');
  });
});
