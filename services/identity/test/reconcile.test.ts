import { ACCESS_ENTRY_TYPES, bindingIdFor, roleForSlot } from '@aisdlc/contracts';
import { runProjection } from '@aisdlc/record';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createGroup,
  identityProjection,
  reconcileProject,
  removeMember,
  revokeBinding,
  setPrincipalStatus,
  type ReconcileDeps,
} from '../src/index.js';
import {
  pid,
  pr,
  seedPrincipals,
  settingsOf,
  startIdentityStack,
  type IdentityStack,
} from '../src/testing.js';

let s: IdentityStack;
let deps: ReconcileDeps;
beforeAll(async () => {
  s = await startIdentityStack();
  deps = { ...s.deps, settings: s.settings };
  await seedPrincipals(s.deps, ['alice', 'bob', 'carol', 'dave', 'erin']);
});
afterAll(async () => {
  await s.stop();
});

const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const errCode = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await s.record.pool.query<{ n: string }>(sql, values)).rows[0]?.n);
}
const eventCount = () => count('SELECT count(*)::text AS n FROM record.record_event');

async function holdersOf(project: string, slot: string): Promise<string[]> {
  await runProjection(s.record.pool, identityProjection);
  const role = roleForSlot(slot as never);
  const q = await s.record.pool.query<{ principal_id: string }>(
    `SELECT m.principal_id FROM identity.binding b JOIN identity.membership m ON m.group_id = b.group_id
      WHERE b.role_id = $1 AND b.scope_kind = 'project' AND b.scope_ref = $2 ORDER BY 1`,
    [role, project],
  );
  return q.rows.map((r) => r.principal_id);
}

describe('reconcileProject', () => {
  it('generates one binding per slot, a generated group each, and membership from the role map', async () => {
    s.settings.set(
      settingsOf('acme', {
        admin: ['alice'],
        requesters: ['alice', 'bob'],
        intent: ['bob'],
        design: ['bob'],
        g5: ['carol'],
        x: ['alice', 'carol'],
        sec: ['carol'],
        m4: ['alice', 'carol'],
        kill: ['alice'],
      }),
      'T1',
    );
    const r = must(await reconcileProject(deps, { project_id: pid('acme'), config_rev: 'rev-1' }));
    expect(r).toMatchObject({
      groups_created: 10,
      bindings_created: 10,
      bindings_updated: 0,
      bindings_revoked: 0,
      members_added: 12,
    });
    expect(r.events).toBe(10 + 10 + 12);
    expect(await holdersOf('acme', 'requesters')).toEqual(['alice', 'bob']);
    expect(await holdersOf('acme', 'g4')).toEqual([]); // code owners: membership is not generated
    const gens = await s.record.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM identity.binding WHERE config_rev = 'rev-1'`,
    );
    expect(Number(gens.rows[0]?.n)).toBe(10);
  });

  it('is idempotent: a second run writes nothing', async () => {
    const before = await eventCount();
    const r = must(await reconcileProject(deps, { project_id: pid('acme') }));
    expect(r.events).toBe(0);
    expect(await eventCount()).toBe(before);
  });

  it('applies only the difference when the role map changes, and ledgers it', async () => {
    await s.sync();
    const ledgered = await count(
      `SELECT count(*)::text AS n FROM ledger.ledger_entry WHERE entry_type LIKE 'access.%'`,
    );
    s.settings.set(
      settingsOf('acme', {
        admin: ['alice'],
        requesters: ['bob', 'dave'], // alice out, dave in
        intent: ['bob'],
        design: ['bob'],
        g5: ['carol'],
        x: ['alice', 'carol'],
        sec: ['carol'],
        m4: ['alice', 'carol'],
        kill: ['alice'],
      }),
      'T1',
    );
    const r = must(await reconcileProject(deps, { project_id: pid('acme'), config_rev: 'rev-2' }));
    expect(r).toMatchObject({
      members_added: 1,
      members_removed: 1,
      groups_created: 0,
      bindings_created: 0,
      events: 2,
    });
    expect(await holdersOf('acme', 'requesters')).toEqual(['bob', 'dave']);
    const report = await s.sync();
    expect(report.written).toBe(2);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ledger.ledger_entry WHERE entry_type LIKE 'access.%'`,
      ),
    ).toBe(ledgered + 2);
    const types = await s.record.pool.query<{ entry_type: string; actor: string }>(
      `SELECT entry_type, actor FROM ledger.ledger_entry WHERE entry_type LIKE 'access.%' ORDER BY ledger_seq DESC LIMIT 2`,
    );
    expect(types.rows.map((t) => t.entry_type).sort()).toEqual([
      'access.membership_added',
      'access.membership_removed',
    ]);
    expect(types.rows.every((t) => t.actor === 'system.role_map')).toBe(true);
  });

  it('stamps two_person on the slots it covers and updates it when the setting changes', async () => {
    const m4 = bindingIdFor('rm.acme.m4' as never, roleForSlot('m4'), {
      kind: 'project',
      ref: 'acme',
    });
    const binding = async () =>
      (
        await s.record.pool.query<{ constraints: Record<string, unknown> }>(
          'SELECT constraints FROM identity.binding WHERE binding_id = $1',
          [m4],
        )
      ).rows[0]?.constraints;
    await runProjection(s.record.pool, identityProjection);
    expect((await binding())?.['two_person']).toBe(true);
    s.settings.set(
      settingsOf(
        'acme',
        {
          admin: ['alice'],
          requesters: ['bob', 'dave'],
          intent: ['bob'],
          design: ['bob'],
          g5: ['carol'],
          x: ['alice', 'carol'],
          sec: ['carol'],
          m4: ['alice', 'carol'],
          kill: ['alice'],
        },
        { two_person: false },
      ),
      'T1',
    );
    const r = must(await reconcileProject(deps, { project_id: pid('acme') }));
    expect(r).toMatchObject({ bindings_updated: 3, events: 3 }); // m4, x, kill
    await runProjection(s.record.pool, identityProjection);
    expect((await binding())?.['two_person']).toBe(false);
  });

  it('kill delegation: a project-scope delegate joins the kill group; a lane delegation gets its own binding; revoking removes it', async () => {
    const base = settingsOf(
      'acme',
      {
        admin: ['alice'],
        requesters: ['bob', 'dave'],
        intent: ['bob'],
        design: ['bob'],
        g5: ['carol'],
        x: ['alice', 'carol'],
        sec: ['carol'],
        m4: ['alice', 'carol'],
        kill: ['alice'],
      },
      { two_person: false },
    );
    const del = (
      delegate: string,
      scope: { kind: 'project' | 'lane'; ref: string },
      revoked: string | null = null,
    ) => ({
      delegate: pr(delegate),
      scope,
      granted_by: pr('alice'),
      granted_at: '2026-11-09T10:00:00Z',
      revoked_at: revoked,
    });
    s.settings.set(
      {
        ...base,
        kill_delegations: [
          del('bob', { kind: 'project', ref: 'acme' }),
          del('erin', { kind: 'lane', ref: 'acme/L4' }),
        ],
      },
      'T1',
    );
    const r = must(await reconcileProject(deps, { project_id: pid('acme') }));
    expect(r).toMatchObject({ groups_created: 1, bindings_created: 1, members_added: 2 });
    expect(await holdersOf('acme', 'kill')).toEqual(['alice', 'bob']);
    const lane = await s.record.pool.query<{ principal_id: string }>(
      `SELECT m.principal_id FROM identity.binding b JOIN identity.membership m ON m.group_id = b.group_id
        WHERE b.scope_kind = 'lane' AND b.scope_ref = 'acme/L4'`,
    );
    expect(lane.rows.map((x) => x.principal_id)).toEqual(['erin']);

    s.settings.set(
      {
        ...base,
        kill_delegations: [
          del('bob', { kind: 'project', ref: 'acme' }, '2026-11-10T00:00:00Z'),
          del('erin', { kind: 'lane', ref: 'acme/L4' }, '2026-11-10T00:00:00Z'),
        ],
      },
      'T1',
    );
    const back = must(await reconcileProject(deps, { project_id: pid('acme') }));
    expect(back).toMatchObject({ members_removed: 2, bindings_revoked: 1 });
    expect(await holdersOf('acme', 'kill')).toEqual(['alice']);
    await runProjection(s.record.pool, identityProjection);
    const left = await s.record.pool.query(
      `SELECT 1 FROM identity.binding WHERE scope_kind = 'lane'`,
    );
    expect(left.rows).toHaveLength(0);
  });

  it('refuses without writing: unknown principal, delegation outside the project, T2 unlocked, settings unavailable', async () => {
    const before = await eventCount();
    s.settings.set(settingsOf('beta', { admin: ['alice', 'ghost'] }), 'T0');
    const unknown = await reconcileProject(deps, { project_id: pid('beta') });
    expect(errCode(unknown)).toBe('unknown_principal');

    s.settings.set(settingsOf('beta', { admin: ['alice'] }), 'T2'); // T2 but two-person not locked
    expect(errCode(await reconcileProject(deps, { project_id: pid('beta') }))).toBe('refused');

    const out = settingsOf(
      'beta',
      { admin: ['alice'] },
      {
        delegations: [
          {
            delegate: pr('bob'),
            scope: { kind: 'project', ref: 'other' },
            granted_by: pr('alice'),
            granted_at: '2026-11-09T10:00:00Z',
            revoked_at: null,
          },
        ],
      },
    );
    s.settings.set(out, 'T1');
    expect(errCode(await reconcileProject(deps, { project_id: pid('beta') }))).toBe('refused');

    expect(errCode(await reconcileProject(deps, { project_id: pid('nope') }))).toBe('unavailable');
    s.settings.breakProject(pid('beta'));
    expect(errCode(await reconcileProject(deps, { project_id: pid('beta') }))).toBe('unavailable');
    expect(await eventCount()).toBe(before);
  });

  it('T2 with two-person locked on reconciles', async () => {
    s.settings.set(
      settingsOf('gamma', { admin: ['alice'], m4: ['alice', 'bob'] }, { locked: true }),
      'T2',
    );
    const r = must(await reconcileProject(deps, { project_id: pid('gamma') }));
    expect(r.bindings_created).toBe(10);
  });

  it('a disabled principal stays in the role map but no longer counts (effective access reads status)', async () => {
    must(await setPrincipalStatus(s.deps, 'dave', 'disabled', 'left', 'system.test'));
    const r = must(await reconcileProject(deps, { project_id: pid('acme') }));
    expect(r.events).toBe(0);
  });

  it('manual edits of generated groups and bindings are refused', async () => {
    expect(
      errCode(
        await addMember(s.deps, { group_id: 'rm.acme.admin', principal_id: 'erin' }, 'system.test'),
      ),
    ).toBe('protected_group');
    expect(errCode(await removeMember(s.deps, 'rm.acme.admin', 'alice', 'x', 'system.test'))).toBe(
      'protected_group',
    );
    expect(
      errCode(
        await createGroup(
          s.deps,
          { group_id: 'rm.acme.extra', display: 'x', pim_managed: false, protected: true },
          'system.test',
        ),
      ),
    ).toBe('protected_group');
    const id = bindingIdFor('rm.acme.admin' as never, roleForSlot('admin'), {
      kind: 'project',
      ref: 'acme',
    });
    expect(errCode(await revokeBinding(s.deps, id, 'no', 'system.test'))).toBe('generated_only');
  });

  it('every membership and binding change is an access event with a ledger entry; rebuild equals live', async () => {
    await s.sync();
    const events = await count(
      `SELECT count(*)::text AS n FROM record.record_event WHERE type = ANY($1::text[])`,
      [
        [
          'group.member_added',
          'group.member_removed',
          'binding.created',
          'binding.updated',
          'binding.revoked',
          'principal.status_changed',
          'principal.qualification_granted',
          'principal.qualification_revoked',
        ],
      ],
    );
    const entries = await count(
      `SELECT count(*)::text AS n FROM ledger.ledger_entry WHERE entry_type = ANY($1::text[])`,
      [[...ACCESS_ENTRY_TYPES]],
    );
    expect(entries).toBe(events);
    await expectRebuildEqualsLive(s.record.pool, identityProjection);
  });
});
